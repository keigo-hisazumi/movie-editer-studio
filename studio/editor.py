"""トピックの編集画面：確認用の動画を見ながら、カット（残す区間）と字幕をフレーム単位で直して、edit.json の新しい版として保存する。

右側は2枚のタブ：
- カット：文ごとに残す・外すを切り替え、区間の頭と終わりを詰める
- 字幕：字幕の文字と、出す・消すフレームを直す（分ける・つなぐ・足す・消す）
再生は2通り：
- ショート：残す区間だけを、並びの順につないで再生する（外した所は飛ばす）
- 元動画：外した所も含めてそのまま再生する（外した文を戻すか決めるとき）
キー（共通）：Space 再生・停止／← → 1 フレーム（Shift で 10 フレーム）／Tab ショートと元動画の切り替え／
             Ctrl(⌘)+Z 取り消し／Ctrl(⌘)+S 保存
キー（カット）：X 選んだ文を外す・戻す／[ ] いまの位置を区間の頭・終わりにする
キー（字幕）：I O いまの位置を字幕の頭・終わりにする／/ いまの位置で分ける／N いまの位置に足す／Delete 消す
再生中・フレーム送り・タイムラインのクリックで位置が動くと、字幕の一覧の選択がその位置の字幕に付いていく
（字幕の文字を入力している間は動かさない）
"""
from __future__ import annotations

import copy
import os
from typing import Any

from PySide6.QtCore import QElapsedTimer, QEvent, QObject, QPointF, QRectF, Qt, QTimer, QUrl, Signal
from PySide6.QtGui import (
    QBrush,
    QColor,
    QFont,
    QFontMetricsF,
    QImage,
    QKeyEvent,
    QKeySequence,
    QPainter,
    QPainterPath,
    QPaintEvent,
    QPen,
    QShortcut,
)
from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer, QVideoFrame, QVideoSink
from PySide6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QSizePolicy,
    QSplitter,
    QStyledItemDelegate,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from . import timeline as tl
from .api import Api, ApiError
from .fmt import clock, frames
from .track import TrackView, timecode
from .track import caption_pieces as _pieces

MAX_CHARS = 9  # 字幕 1 行の文字数の目安（movie-editer の subtitle.max_chars_per_line）
NEW_CAPTION_SEC = 1  # 足す字幕の長さ（秒）
TICK_MS = 15  # 再生中に位置を見る間隔
FRAME_MS = 30  # 動画のコマを絵にする間隔の下限（ミリ秒。30fps ほど）
SEEK_WAIT_MS = 300  # 区間の頭へ飛んだ後、位置が届くのを待つ長さ
PEEK_MS = 1500  # 止めている間に飛んだとき、その位置のコマが届くのを待つ長さ


def validate(doc: dict[str, Any]) -> list[str]:
    """movie-editer-schema の EditDoc として正しいか（入っていなければ検査しない）"""
    try:
        from movie_editer_schema import errors
    except ImportError:
        return []
    return errors("EditDoc", doc)


class VideoView(QWidget):
    shown = Signal(float)  # コマが届いた（その時刻、秒）

    """動画と、その上に重ねる字幕・知らせ。

    動画の1コマずつを QVideoSink で受け取り、自分で描く（Mac・Windows・Linux で同じ描き方にする。
    QVideoWidget・QGraphicsVideoItem は OS ごとに描き方が違い、映像が出ないことがある）。
    """

    def __init__(self) -> None:
        super().__init__()
        self.sink = QVideoSink(self)
        self.sink.videoFrameChanged.connect(self._frame)
        # コマを絵にする（toImage）のは 1 秒に FRAME_RATE_MAX 回まで。元動画（1206x2622・最大 60fps）をそのまま再生すると、
        # 全部のコマを絵にするのは重いので、間のコマは飛ばす（最後に届いたコマは必ず描く）
        self.pending: QVideoFrame | None = None
        self.last = QElapsedTimer()
        self.draw_timer = QTimer(self)
        self.draw_timer.setSingleShot(True)
        self.draw_timer.timeout.connect(self._draw_pending)
        self.image: QImage | None = None
        self.text = ""  # 字幕
        self.message = ""  # 動画が無い・再生できないときの知らせ
        self.setMinimumWidth(240)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)

    def _frame(self, frame: QVideoFrame) -> None:
        if not frame.isValid():
            return
        self.pending = frame
        if self.draw_timer.isActive():
            return
        wait = 0 if not self.last.isValid() else max(0, FRAME_MS - self.last.elapsed())
        if wait == 0:
            self._draw_pending()
        else:
            self.draw_timer.start(wait)

    def _draw_pending(self) -> None:
        frame, self.pending = self.pending, None
        if frame is not None:
            self.last.restart()
            img = frame.toImage()
            if not img.isNull():
                self.image = img
                self.update()
                self.shown.emit(frame.startTime() / 1e6 if frame.startTime() >= 0 else -1.0)

    def set_sub(self, text: str) -> None:
        if self.text != text:
            self.text = text
            self.update()

    def set_message(self, text: str) -> None:
        if self.message != text:
            self.message = text
            self.update()

    def paintEvent(self, e: QPaintEvent) -> None:  # noqa: N802
        g = QPainter(self)
        g.setRenderHint(QPainter.RenderHint.Antialiasing)
        g.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        w, h = self.width(), self.height()
        g.fillRect(0, 0, w, h, QColor("#000"))
        area = QRectF(0, 0, w, h)
        if self.image is not None:
            iw, ih = self.image.width(), self.image.height()
            scale = min(w / iw, h / ih)
            area = QRectF((w - iw * scale) / 2, (h - ih * scale) / 2, iw * scale, ih * scale)
            g.drawImage(area, self.image)
        if self.text:
            f = QFont()
            f.setBold(True)
            f.setPixelSize(max(14, round(area.height() * 0.045)))
            path = QPainterPath()
            fm = QFontMetricsF(f)
            x = area.center().x() - fm.horizontalAdvance(self.text) / 2
            y = area.top() + area.height() * 0.76 + fm.ascent() / 2
            path.addText(QPointF(x, y), f, self.text)
            g.setPen(QPen(QColor("#000"), max(3.0, f.pixelSize() / 6), Qt.PenStyle.SolidLine,
                          Qt.PenCapStyle.RoundCap, Qt.PenJoinStyle.RoundJoin))
            g.drawPath(path)  # 縁取り
            g.fillPath(path, QColor("#fff"))
        if self.message:
            g.setPen(QColor("#ddd"))
            g.drawText(QRectF(12, 12, w - 24, h - 24), Qt.AlignmentFlag.AlignCenter | Qt.TextFlag.TextWordWrap,
                       self.message)
        g.end()


class CaretDelegate(QStyledItemDelegate):
    """字幕の文字の欄：入力中のカーソルの位置を覚える（分ける位置に使う）"""

    caret = Signal(int, int)

    def createEditor(self, parent, option, index):  # noqa: N802
        ed = QLineEdit(parent)
        row = index.row()
        ed.cursorPositionChanged.connect(lambda _old, new: self.caret.emit(row, new))
        return ed


class Editor(QWidget):
    back = Signal()

    def __init__(self, api: Api, name: str, topic: int, data: dict[str, Any], peaks: dict[str, Any] | None):
        super().__init__()
        self.api, self.name, self.topic, self.data = api, name, topic, data
        self.peaks: list[int] = (peaks or {}).get("peaks") or []
        # 波形の 1 フレームあたりの数（movie-editer の peaks.json の rate。前の 1 フレームごとのものには rate が無い）
        p = peaks or {}
        self.peak_spf = float(p.get("rate") or p.get("fps") or 30) / float(p.get("fps") or 30)
        self.doc: dict[str, Any] = copy.deepcopy(data["edit"])
        self.doc["captions"] = tl.sort_captions(self.doc["captions"])
        self.base: int = self.doc["revision"]
        self.fps = float(self.doc["fps"])
        self.undo: list[tuple[list, list]] = []
        self.keeps_changed = False
        self.dirty = False
        self.mode = "short"
        self.src = self.doc["keeps"][0]["start"] if self.doc["keeps"] else 0
        self.cap = -1  # 字幕：選んだ字幕
        self.caret: tuple[int, int] | None = None
        self.typing = False
        self.playing = False
        self.play_keep = -1
        self.seek_target: int | None = None  # 区間の頭へ飛んでいる間（古い位置で次の区間へ進まないように）
        self.seek_clock = QElapsedTimer()
        self.seek_clock.start()
        # 止めている間に飛んだときは、音を消して少しだけ再生し、その位置のコマが届いたら止める
        # （QMediaPlayer は止めている間に位置を変えてもコマを出さない OS があり、プレビューが黒いままになる）
        self.peeking = False
        self.loaded = False  # 動画を読み込んだか
        self.peek_timer = QTimer(self)
        self.peek_timer.setSingleShot(True)
        self.peek_timer.timeout.connect(self._end_peek)
        self._filling = False
        self._build()
        self._load_media()
        self.render()

    # ------------------------------------------------------------ 画面

    def _build(self) -> None:
        cut = self.data.get("cut") or {}
        top = QHBoxLayout()
        back = QPushButton("← 一覧")
        back.clicked.connect(lambda: self.back.emit())
        title = QLabel(f"<b>{self.name} topic_{self.topic:02d}</b> {cut.get('title') or ''}")
        self.rev = QLabel()
        self.rev.setStyleSheet("color: gray;")
        self.undo_btn = QPushButton("取り消し")
        self.undo_btn.clicked.connect(self.do_undo)
        self.save_btn = QPushButton("保存")
        self.save_btn.setDefault(True)
        self.save_btn.clicked.connect(lambda: self.save())  # clicked は checked（bool）を渡すので、メモとして受けない
        for w in (back, title):
            top.addWidget(w)
        top.addStretch(1)
        self.export_btn = QPushButton("XML に書き出す")
        self.export_btn.setToolTip("いまのカットと字幕を、Filmora・Premiere 用の XML（_studio.xml）と studio.srt に"
                                   "書き出し直す（保存していない変更は先に保存する）")
        self.export_btn.clicked.connect(lambda: self.export())
        for w in (self.rev, self.undo_btn, self.save_btn, self.export_btn):
            top.addWidget(w)

        # 左：動画と再生
        self.view = VideoView()
        self.player = QMediaPlayer(self)
        # 音の出ない環境（CI など）では音声の出力を作らない（音の装置が無いと落ちることがある）
        self.audio = None if os.environ.get("STUDIO_NO_AUDIO") else QAudioOutput(self)
        if self.audio:
            self.player.setAudioOutput(self.audio)
        self.player.setVideoOutput(self.view.sink)
        self.view.shown.connect(self._on_shown)
        self.player.errorOccurred.connect(self._on_error)
        self.player.positionChanged.connect(self._on_position)
        self.player.mediaStatusChanged.connect(self._on_status)
        self.play_btn = QPushButton("再生")
        self.play_btn.clicked.connect(self.toggle)
        prev_btn, next_btn = QPushButton("◀︎|"), QPushButton("|▶︎")
        prev_btn.setToolTip("1 フレーム戻る（←）")
        next_btn.setToolTip("1 フレーム進む（→）")
        prev_btn.clicked.connect(lambda: self.step(-1))
        next_btn.clicked.connect(lambda: self.step(1))
        self.mode_btn = QPushButton()
        self.mode_btn.setToolTip("Tab")
        self.mode_btn.clicked.connect(lambda: self.set_mode("source" if self.mode == "short" else "short"))
        self.tc = QLabel()
        mono = QFont("Menlo")
        mono.setStyleHint(QFont.StyleHint.Monospace)
        self.tc.setFont(mono)
        self.pos = QLabel()
        self.pos.setTextFormat(Qt.TextFormat.RichText)
        self.pos.setStyleSheet("color: gray;")
        ctl = QHBoxLayout()
        for w in (prev_btn, next_btn, self.play_btn):
            w.setFocusPolicy(Qt.FocusPolicy.NoFocus)
            ctl.addWidget(w)
        ctl.addSpacing(8)
        ctl.addWidget(self.tc)
        ctl.addStretch(1)
        ctl.addWidget(self.mode_btn)
        self.mode_btn.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        left = QWidget()
        lv = QVBoxLayout(left)
        lv.setContentsMargins(0, 0, 0, 0)
        lv.addWidget(self.view, 1)
        lv.addLayout(ctl)
        lv.addWidget(self.pos)

        # 右：字幕の一覧
        self.summary = QLabel()
        self.caps = QTableWidget(0, 4)
        self.caps.setHorizontalHeaderLabels(["タイムコード", "字幕", "文字数", "操作"])
        self._table(self.caps, stretch=1)
        self.caps.setWordWrap(True)
        self.caps.verticalHeader().setDefaultSectionSize(52)
        # 文字を直し始めるのはダブルクリックのときだけ（クリックして選んだだけ・キーを押しただけでは直さない）
        self.caps.setEditTriggers(QAbstractItemView.EditTrigger.DoubleClicked)
        # Qt は選んだ行が変わるたびに日本語入力を使える状態に戻す（Mac で Space などが変換に取られる）ので、また切る
        self.caps.currentCellChanged.connect(
            lambda *_: self.caps.setAttribute(Qt.WidgetAttribute.WA_InputMethodEnabled, False))
        delegate = CaretDelegate(self.caps)
        delegate.caret.connect(lambda row, pos: setattr(self, "caret", (row, pos)))
        self.caps.setItemDelegateForColumn(1, delegate)
        self.caps.cellClicked.connect(self._click_cap)
        self.caps.itemChanged.connect(self._cap_text)

        cap_page = QWidget()
        cv = QVBoxLayout(cap_page)
        cv.setContentsMargins(0, 4, 0, 0)
        tools = QHBoxLayout()
        for label, key, fn in (("頭をいまの位置に", "I", lambda: self.cap_edge("start")),
                               ("終わりをいまの位置に", "O", lambda: self.cap_edge("end")),
                               ("次とつなぐ", "", self.cap_merge), ("いまの位置に足す", "N", self.cap_add)):
            b = QPushButton(label)
            b.setToolTip(key)
            b.setFocusPolicy(Qt.FocusPolicy.NoFocus)
            b.clicked.connect(fn)
            tools.addWidget(b)
        tools.addStretch(1)
        cv.addLayout(tools)
        cv.addWidget(self.caps)
        right = QWidget()
        rv = QVBoxLayout(right)
        rv.setContentsMargins(0, 0, 0, 0)
        rv.addWidget(self.summary)
        rv.addWidget(cap_page, 1)

        upper = QSplitter(Qt.Orientation.Horizontal)
        upper.addWidget(left)
        upper.addWidget(right)
        upper.setStretchFactor(0, 1)
        upper.setStretchFactor(1, 1)
        upper.setSizes([620, 700])

        # 下：タイムライン
        self.timeline = TrackView(self.seek_click, lambda i: self._click_cap(i, 0), self.trim)
        self.timeline.on_caption_edit = self.edit_caption
        self.help = QLabel()
        self.help.setWordWrap(True)
        self.help.setStyleSheet("color: gray; font-size: 11px;")
        lower = QWidget()
        bv = QVBoxLayout(lower)
        bv.setContentsMargins(0, 0, 0, 0)
        bv.addWidget(self.timeline, 1)
        bv.addWidget(self.help)

        split = QSplitter(Qt.Orientation.Vertical)
        split.addWidget(upper)
        split.addWidget(lower)
        split.setStretchFactor(0, 1)
        split.setStretchFactor(1, 0)
        split.setSizes([560, 260])
        lay = QVBoxLayout(self)
        lay.addLayout(top)
        lay.addWidget(split, 1)

        self.timer = QTimer(self)
        self.timer.setInterval(TICK_MS)
        self.timer.timeout.connect(self._tick)
        QShortcut(QKeySequence.StandardKey.Save, self, lambda: self.save())
        QShortcut(QKeySequence.StandardKey.Undo, self, self.do_undo)
        # 日本語入力がオンのとき、入力を受け付ける部品にはキーが「変換中の文字」として届き、Space（変換）や
        # T・R が効かない。文字を入力する所（字幕の文字を直す入力欄）以外は、日本語入力を使わない
        for w in (self, self.caps, self.caps.viewport(), self.timeline, self.timeline.canvas, self.view):
            w.setAttribute(Qt.WidgetAttribute.WA_InputMethodEnabled, False)
        QApplication.instance().installEventFilter(self)

    def _table(self, t: QTableWidget, stretch: int) -> None:
        t.verticalHeader().hide()
        t.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        t.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        t.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        t.setWordWrap(False)
        h = t.horizontalHeader()
        for c in range(t.columnCount()):
            h.setSectionResizeMode(c, QHeaderView.ResizeMode.Stretch if c == stretch
                                   else QHeaderView.ResizeMode.ResizeToContents)

    def _load_media(self) -> None:
        # 元動画をそのまま再生する。確認用の動画（shorts proxy で作る。元動画が重いとき用）があればそちらを使う
        media = self.data.get("media") or {}
        url = media.get("proxy.mp4") or media.get("video")
        if url:
            self.player.setSource(QUrl(self.api.url(url)))
        else:
            self.view.set_message("元動画が見つかりません（topic_XX/cut.json の場所。動画を動かしたなら /cut で作り直す）")

    def destroy_editor(self) -> None:
        QApplication.instance().removeEventFilter(self)
        self.peeking = False
        self.peek_timer.stop()
        self.pause()
        self.player.stop()
        self.player.setSource(QUrl())

    @property
    def keeps(self) -> list[tl.Keep]:
        return self.doc["keeps"]

    @property
    def captions(self) -> list[tl.Caption]:
        return self.doc["captions"]

    def render(self) -> None:
        k = self.keeps
        self.rev.setText(f"版 {self.base}{'（未保存の変更あり）' if self.dirty else ''}")
        self.mode_btn.setText("表示：ショート" if self.mode == "short" else "表示：元動画")
        self.help.setText("Space 再生・停止／← → 1 フレーム（Shift で 10）／Return 頭へ／B いまの位置で分割／"
                          "T R 拡大・縮小／Shift+Z 全体／クリップをダブルクリック → Delete で消す／"
                          "[ ] いまの位置を区間の頭・終わりに／I O いまの位置を字幕の頭・終わりに／N 字幕を足す／"
                          "Tab ショート・元動画")
        shown = sum(1 for c in self.captions if tl.kept_frames(k, c) > 0)
        self.summary.setText(f"ショートの長さ <b>{tl.total_frames(k) / self.fps:.1f} 秒</b>（区間 {len(k)} 個）"
                             f"　字幕 {len(self.captions)} 個（ショートに出るもの {shown} 個）")
        self._fill_caps()
        self.update_pos()

    def _fill_caps(self) -> None:
        self._filling = True
        gray, warn = QBrush(QColor("gray")), QBrush(QColor("#b26b00"))
        self.caps.setRowCount(len(self.captions))
        for i, c in enumerate(self.captions):
            kept = tl.kept_frames(self.keeps, c)
            state = "out" if kept == 0 else "in" if kept >= c["end"] - c["start"] else "part"
            pieces = [(a, b) for a, b in _pieces(self.keeps, c)]
            if pieces:
                at = f"{timecode(pieces[0][0], self.fps)}\n{timecode(pieces[-1][1], self.fps)}"
            else:
                at = "外した所"
            n = len(c["text"])
            cells = [at, c["text"], str(n)]
            for col, text in enumerate(cells):
                it = QTableWidgetItem(text)
                if col != 1:
                    it.setFlags(it.flags() & ~Qt.ItemFlag.ItemIsEditable)
                    it.setForeground(gray)
                if col == 0 and state == "part":
                    it.setForeground(warn)
                if col == 1 and state == "out":
                    f = it.font()
                    f.setStrikeOut(True)
                    it.setFont(f)
                    it.setForeground(gray)
                if col == 2 and n > MAX_CHARS:
                    f = it.font()
                    f.setBold(True)
                    it.setFont(f)
                    it.setForeground(warn)
                self.caps.setItem(i, col, it)
            self.caps.setCellWidget(i, 3, self._cap_ops(i))
        if 0 <= self.cap < len(self.captions):
            self.caps.selectRow(self.cap)
        else:
            self.caps.clearSelection()
        self._filling = False

    def _cap_ops(self, i: int) -> QWidget:
        """字幕の行の操作（Filmora の字幕の編集と同じく、いまの位置で分ける・消す）"""
        w = QWidget()
        h = QHBoxLayout(w)
        h.setContentsMargins(2, 0, 2, 0)
        for label, tip, fn in (("分ける", "いまの位置（文字を入力中ならカーソルの所）で分ける（/）", self.cap_split),
                               ("消す", "消す（Delete）", self.cap_del)):
            b = QPushButton(label)
            b.setToolTip(tip)
            b.setFocusPolicy(Qt.FocusPolicy.NoFocus)
            b.clicked.connect(lambda _=False, fn=fn: self._row_op(i, fn))
            h.addWidget(b)
        return w

    def _row_op(self, i: int, fn) -> None:
        self.cap = i
        fn()

    def update_pos(self) -> None:
        out = tl.src_to_out(self.keeps, self.src)
        where = "　<span style='color:#b26b00'>外した所</span>" if out is None else f"　ショート {frames(out, self.fps)}"
        self.pos.setText(f"元動画 {clock(self.src / self.fps)}（{self.src}f）{where}")
        self.play_btn.setText("❚❚ 停止" if self.playing else "▶︎ 再生")
        i = tl.caption_at(self.captions, self.src)
        visible = i >= 0 and (self.mode == "source" or out is not None)
        self.view.set_sub(self.captions[i]["text"] if visible else "")
        total = tl.total_frames(self.keeps)
        self.tc.setText(f"{timecode(out if out is not None else self._nearest_out(), self.fps)}"
                        f" / {timecode(total, self.fps)}")
        lo, hi = self.data["range"]
        self.timeline.set_data(self.mode, self.fps, self.keeps, self.captions, self.cap, self.peaks,
                               (int(lo * self.fps), int(hi * self.fps) + 1), self.src, self.playing, self.peak_spf)

    # ------------------------------------------------------------ 位置と再生

    def seek(self, f: float, from_playback: bool = False, follow: bool = False) -> None:
        """元動画のフレーム f へ。再生中と follow のときは、字幕の一覧の選択をその位置の字幕に付いていかせる"""
        self.src = max(0, round(f))
        if not from_playback:
            self.seek_target = self.src
            self.seek_clock.restart()
            self.player.setPosition(int((self.src + 0.5) / self.fps * 1000))  # フレームの真ん中に合わせる
            if not self.playing:
                self._peek()
        if self.playing or follow:
            self.follow_caption()
        self.update_pos()

    def editing_text(self) -> bool:
        """字幕の文字を入力している最中か"""
        w = QApplication.focusWidget()
        return (self.caps.state() == QAbstractItemView.State.EditingState
                or isinstance(w, QLineEdit) and self.caps.isAncestorOf(w))

    def follow_caption(self) -> None:
        """いまの位置に出ている字幕を選び、一覧のその行が見えるようにする（Filmora の字幕の編集と同じ）。

        字幕の無い所では前に選んだ字幕のまま。文字を入力している間は、入力を邪魔しないように動かさない。
        """
        i = tl.caption_at(self.captions, self.src)
        if i < 0 or i == self.cap or self.editing_text():
            return
        if self.mode == "short" and tl.src_to_out(self.keeps, self.src) is None:
            return  # ショートの表示で外した所（字幕は出ていない）
        self.cap = i
        self.typing = False
        self.caret = None
        self._filling = True
        self.caps.setCurrentCell(i, 1)
        self.caps.selectRow(i)
        self._filling = False
        item = self.caps.item(i, 1)
        if item is not None:
            self.caps.scrollToItem(item, QAbstractItemView.ScrollHint.PositionAtCenter)

    def _peek(self) -> None:
        if self.player.source().isEmpty() or self.player.mediaStatus() in (
                QMediaPlayer.MediaStatus.NoMedia, QMediaPlayer.MediaStatus.LoadingMedia,
                QMediaPlayer.MediaStatus.InvalidMedia):
            return
        self.peeking = True
        if self.audio:
            self.audio.setMuted(True)
        self.player.play()
        self.peek_timer.start(PEEK_MS)

    def _on_shown(self, sec: float) -> None:
        if not self.peeking:
            return
        # 飛ぶ前のコマが届くことがあるので、飛んだ先の近くのコマを待つ（時刻が無ければそのまま止める）
        if sec >= 0 and abs(sec * self.fps - self.src) > 3:
            return
        self._end_peek()

    def _end_peek(self) -> None:
        self.peek_timer.stop()
        if not self.peeking:
            return
        self.peeking = False
        if not self.playing:
            self.player.pause()
            self.player.setPosition(int((self.src + 0.5) / self.fps * 1000))
        if self.audio:
            self.audio.setMuted(False)

    def seek_click(self, f: float) -> None:
        self.pause()
        self.seek(f, follow=True)

    def _on_status(self, status: QMediaPlayer.MediaStatus) -> None:
        if status == QMediaPlayer.MediaStatus.LoadedMedia:
            # 止めた・位置を変えたときにも LoadedMedia に戻る OS があるので、最初の1回だけ頭へ合わせる
            if not self.loaded:
                self.loaded = True
                self.view.set_message("")
                self.seek(self.src)
        elif status == QMediaPlayer.MediaStatus.LoadingMedia:
            self.view.set_message("動画を読み込んでいます…")
        elif status == QMediaPlayer.MediaStatus.InvalidMedia:
            self.view.set_message(f"動画を開けません：{self.player.errorString() or self.player.source().toString()}")

    def _on_error(self, _err: QMediaPlayer.Error, msg: str) -> None:
        self.view.set_message(f"動画を再生できません：{msg}\n{self.player.source().toString()}")
        self.pause()

    def _on_position(self, ms: int) -> None:
        if self.seek_target is not None and abs(ms / 1000 * self.fps - self.seek_target) < 2:
            self.seek_target = None

    def step(self, n: int) -> None:
        """ショートの位置で n フレーム動かす（元動画の表示なら元動画で）"""
        self.pause()
        if self.mode == "source":
            return self.seek(self.src + n, follow=True)
        out = tl.src_to_out(self.keeps, self.src)
        if out is None:
            out = self._nearest_out()
        self.seek(tl.out_to_src(self.keeps, max(0, min(tl.total_frames(self.keeps) - 1, out + n))), follow=True)

    def _nearest_out(self) -> int:
        """外した所にいるとき、次に残る所のショートの位置"""
        off = 0
        for k in self.keeps:
            if self.src < k["start"]:
                return off
            off += k["end"] - k["start"]
        return max(0, off - 1)

    def toggle(self) -> None:
        if self.playing:
            self.pause()
        else:
            self.play()

    def play(self) -> None:
        if self.player.source().isEmpty():
            return
        if self.mode == "short" and tl.keep_index_at(self.keeps, self.src) < 0:
            self.seek(tl.out_to_src(self.keeps, self._nearest_out()))
        self.playing = True
        self.peeking = False
        self.peek_timer.stop()
        if self.audio:
            self.audio.setMuted(False)
        self.play_keep = tl.keep_index_at(self.keeps, self.src)
        self.player.play()
        self.timer.start()
        self.update_pos()

    def _tick(self) -> None:
        if not self.playing:
            return
        if self.seek_target is not None:
            # 飛んだ先の位置が届くのを待つ（届かない OS もあるので、少し待ったら進める）
            if self.seek_clock.elapsed() < SEEK_WAIT_MS:
                return
            self.seek_target = None
        f = int(self.player.position() / 1000 * self.fps)
        cur = self.keeps[self.play_keep] if 0 <= self.play_keep < len(self.keeps) else None
        if self.mode == "short" and cur and f >= cur["end"]:
            # 区間の終わりを過ぎた：並びで次の区間へ（最後なら止める）
            self.play_keep += 1
            if self.play_keep >= len(self.keeps):
                self.pause()
                self.seek(cur["end"] - 1)
                return
            self.seek(self.keeps[self.play_keep]["start"])
        elif f != self.src:
            self.seek(f, from_playback=True)

    def pause(self) -> None:
        self.playing = False
        self.timer.stop()
        self.player.pause()
        self.update_pos()

    def set_mode(self, m: str) -> None:
        self.mode = m
        self.render()

    # ------------------------------------------------------------ 直す

    def change(self, keeps: list | None = None, captions: list | None = None) -> None:
        self.undo.append((self.keeps, self.captions))
        self.timeline.select_clip(None)  # 番号が変わるので、選んだクリップは外す
        if keeps is not None:
            self.doc["keeps"] = keeps
            self.keeps_changed = True
        if captions is not None:
            self.doc["captions"] = captions
        self.dirty = True
        self.typing = False
        self.render()

    def do_undo(self) -> None:
        if not self.undo:
            return
        self.doc["keeps"], self.doc["captions"] = self.undo.pop()
        self.dirty = bool(self.undo)
        if self.cap >= len(self.captions):
            self.cap = -1
        self.typing = False
        self.render()

    def set_edge(self, edge: tl.Edge) -> None:
        """[ ]：いまの位置を区間の頭・終わりにする（区間の中ならその区間、外した所なら隣の区間を広げる）"""
        k = self.keeps
        i = tl.keep_index_at(k, self.src)
        if i < 0:
            # 外した所：頭なら後ろの区間、終わりなら前の区間（元動画でいちばん近いもの）
            if edge == "start":
                cands = [(x["start"], j) for j, x in enumerate(k) if x["start"] > self.src]
                i = min(cands)[1] if cands else -1
            else:
                cands = [(x["end"], j) for j, x in enumerate(k) if x["end"] <= self.src]
                i = max(cands)[1] if cands else -1
        if i < 0:
            return
        self.change(keeps=tl.move_edge(k, i, edge, self.src if edge == "start" else self.src + 1))

    def blade(self) -> None:
        """B：いまの位置で、残す区間と字幕を2つに分ける（Filmora・Premiere の分割と同じ）"""
        keeps, caps = self.keeps, self.captions
        i = tl.keep_index_at(keeps, self.src)
        if i >= 0 and keeps[i]["start"] < self.src < keeps[i]["end"]:
            k = keeps[i]
            # 分けた2つは元動画でつながっているが、まとめない（片方を消す・端を動かすため）
            keeps = [*keeps[:i], {"start": k["start"], "end": self.src}, {"start": self.src, "end": k["end"]},
                     *keeps[i + 1:]]
        j = tl.caption_at(caps, self.src)
        sel = self.cap
        if j >= 0:
            pos = self.caret[1] if self.caret and self.caret[0] == j else None
            caps, sel = tl.split_caption(caps, j, self.src, pos)
            if sel < 0:
                caps, sel = self.captions, self.cap
        if keeps is self.keeps and caps is self.captions:
            return
        self.cap = sel
        self.caret = None
        self.change(keeps=None if keeps is self.keeps else keeps, captions=None if caps is self.captions else caps)

    def go_start(self) -> None:
        """Return：タイムラインの最初へ（ショートの頭、元動画の表示ならトピックの区間の頭）"""
        self.pause()
        if self.mode == "short" and self.keeps:
            f = self.keeps[0]["start"]
        else:
            f = int(self.data["range"][0] * self.fps)
        self.timeline.left = self.timeline.axis_start() - self.timeline.axis_len()
        self.timeline.follow = True
        self.seek(f)

    def edit_caption(self, i: int) -> None:
        """タイムラインの字幕をダブルクリック：右上の一覧のその字幕の文字を直し始める"""
        if not 0 <= i < len(self.captions):
            return
        self._click_cap(i, 1)
        self.caps.setCurrentCell(i, 1)
        self.caps.scrollToItem(self.caps.item(i, 1))
        self.caps.setFocus()
        self.caps.editItem(self.caps.item(i, 1))

    def delete_clip(self, kind: str, i: int) -> None:
        """タイムラインで選んだクリップを消す（映像・音声なら残す区間、字幕なら字幕）"""
        self.timeline.select_clip(None)
        if kind == "keep":
            if not 0 <= i < len(self.keeps) or len(self.keeps) <= 1:
                return  # 区間が無くなるとショートが無くなるので、最後の 1 つは消さない
            self.change(keeps=[k for j, k in enumerate(self.keeps) if j != i])
        elif 0 <= i < len(self.captions):
            self.cap = i
            self.cap_del()

    def trim(self, kind: str, i: int, edge: tl.Edge, delta: int, commit: bool) -> None:
        """タイムラインでクリップの端をドラッグした（delta はフレーム）。ドラッグ中は見せるだけで、離したら直す"""
        if kind == "keep":
            if not 0 <= i < len(self.keeps):
                return
            to = self.keeps[i][edge] + delta
            keeps, caps, sel = tl.move_edge(self.keeps, i, edge, to), self.captions, self.cap
        else:
            if not 0 <= i < len(self.captions):
                return
            to = self.captions[i][edge] + delta
            keeps = self.keeps
            caps, sel = tl.move_caption_edge(self.captions, i, edge, to)
        if commit:
            if delta == 0:
                self.render()
                return
            if kind == "keep":
                self.change(keeps=keeps)
            else:
                self._change_caps(caps, sel)
            return
        # ドラッグ中：その端のコマを見せ、タイムラインには直した後の形を描く（まだ直さない）
        self.pause()
        self.seek(max(0, to if edge == "start" else to - 1))
        lo, hi = self.data["range"]
        self.timeline.set_data(self.mode, self.fps, keeps, caps, sel, self.peaks,
                               (int(lo * self.fps), int(hi * self.fps) + 1), self.src, spf=self.peak_spf)

    def _target(self) -> int:
        """字幕の操作の対象：選んだ字幕、無ければいま出ている字幕"""
        return self.cap if self.cap >= 0 else tl.caption_at(self.captions, self.src)

    def _change_caps(self, caps: list, select: int) -> None:
        self.cap = select
        self.caret = None
        self.change(captions=caps)

    def cap_edge(self, edge: tl.Edge) -> None:
        i = self._target()
        if i >= 0:
            self._change_caps(*tl.move_caption_edge(self.captions, i, edge,
                                                     self.src if edge == "start" else self.src + 1))

    def cap_split(self) -> None:
        i = self._target()
        if i < 0:
            return
        pos = self.caret[1] if self.caret and self.caret[0] == i else None
        caps, j = tl.split_caption(self.captions, i, self.src, pos)
        if j >= 0:
            self._change_caps(caps, j)

    def cap_merge(self) -> None:
        i = self._target()
        if i < 0:
            return
        caps, j = tl.merge_caption_next(self.captions, i)
        if j >= 0:
            self._change_caps(caps, j)

    def cap_add(self) -> None:
        if tl.caption_at(self.captions, self.src) >= 0:
            return  # 字幕が出ている所には足さない（分ける）
        caps, j = tl.add_caption(self.captions, self.src, round(NEW_CAPTION_SEC * self.fps))
        self._change_caps(caps, j)
        self.caps.setCurrentCell(j, 1)
        self.caps.editItem(self.caps.item(j, 1))

    def cap_del(self) -> None:
        i = self._target()
        if i >= 0:
            self._change_caps([c for j, c in enumerate(self.captions) if j != i], -1)

    def _cap_text(self, item: QTableWidgetItem) -> None:
        """字幕の文字を直した（一覧は描き直さない。行の番号が変わらないので）"""
        if self._filling or item.column() != 1:
            return
        i = item.row()
        text = item.text()
        if text == self.captions[i]["text"]:
            return
        if not self.typing:
            self.undo.append((self.keeps, self.captions))
            self.typing = True
        self.doc["captions"] = [{**c, "text": text} if j == i else c for j, c in enumerate(self.captions)]
        self.dirty = True
        self._filling = True
        n = self.caps.item(i, 2)
        n.setText(str(len(text)))
        f = n.font()
        f.setBold(len(text) > MAX_CHARS)
        n.setFont(f)
        n.setForeground(QBrush(QColor("#b26b00" if len(text) > MAX_CHARS else "gray")))
        self._filling = False
        self.rev.setText(f"版 {self.base}（未保存の変更あり）")
        self.update_pos()

    def _click_cap(self, row: int, _col: int) -> None:
        self.cap = row
        self.typing = False
        self.pause()
        c = self.captions[row]
        f = c["start"]
        # ショートの表示では、頭が外した所なら字幕の中で最初に残る所へ
        if self.mode == "short" and tl.src_to_out(self.keeps, f) is None:
            f = next((x for x in range(c["start"], c["end"]) if tl.src_to_out(self.keeps, x) is not None), f)
        self.seek(f)

    # ------------------------------------------------------------ キー

    def eventFilter(self, obj: QObject, e: QEvent) -> bool:  # noqa: N802
        t = e.type()
        if t not in (QEvent.Type.KeyPress, QEvent.Type.InputMethod) or not self.isVisible() \
                or not self.isActiveWindow():
            return False
        if isinstance(QApplication.focusWidget(), QLineEdit):
            return False  # 字幕の文字の入力中（Enter・Esc で入力を終える）
        if t == QEvent.Type.InputMethod:
            # 日本語入力から空白だけが確定して届いた（Space）：再生・停止にする
            if e.commitString() in (" ", "\u3000") and not e.preeditString():
                self.toggle()
                return True
            return False
        return self.key(e)

    def key(self, e: QKeyEvent) -> bool:
        k = e.key()
        mods = e.modifiers()
        if mods & (Qt.KeyboardModifier.ControlModifier | Qt.KeyboardModifier.MetaModifier):
            return False  # 保存・取り消しは QShortcut
        sel = self.timeline.sel_clip
        if sel and k in (Qt.Key.Key_Delete, Qt.Key.Key_Backspace):
            self.delete_clip(*sel)
        elif sel and k == Qt.Key.Key_Escape:
            self.timeline.select_clip(None)
        elif k == Qt.Key.Key_Space:
            self.toggle()
        elif k in (Qt.Key.Key_T, Qt.Key.Key_R) and not mods & Qt.KeyboardModifier.ShiftModifier:
            self.timeline.zoom_by(1.25 if k == Qt.Key.Key_T else 0.8)
        elif k in (Qt.Key.Key_Right, Qt.Key.Key_Left):
            n = 10 if mods & Qt.KeyboardModifier.ShiftModifier else 1
            self.step(n if k == Qt.Key.Key_Right else -n)
        elif k in (Qt.Key.Key_Tab, Qt.Key.Key_Backtab):
            self.set_mode("source" if self.mode == "short" else "short")
        elif k == Qt.Key.Key_Z and mods & Qt.KeyboardModifier.ShiftModifier:
            self.timeline.fit_all()
        elif k in (Qt.Key.Key_Return, Qt.Key.Key_Enter):
            self.go_start()
        elif k == Qt.Key.Key_B:
            self.blade()
        elif k in (Qt.Key.Key_BracketLeft, Qt.Key.Key_BracketRight):
            self.set_edge("start" if k == Qt.Key.Key_BracketLeft else "end")
        elif k == Qt.Key.Key_I:
            self.cap_edge("start")
        elif k == Qt.Key.Key_O:
            self.cap_edge("end")
        elif k == Qt.Key.Key_Slash:
            self.cap_split()
        elif k == Qt.Key.Key_N:
            self.cap_add()
        elif k in (Qt.Key.Key_Delete, Qt.Key.Key_Backspace) and self.cap >= 0:
            self.cap_del()  # 選んだ字幕だけ（何も選んでいなければ消さない）
        else:
            return False
        return True

    # ------------------------------------------------------------ 保存

    def build_doc(self, note: str) -> dict[str, Any]:
        """保存する版。字幕だけを直した版は captions、カットも直した版は cut"""
        caps = [{**c, "text": c["text"].strip()} for c in self.captions if c["text"].strip()]
        doc = {**self.doc, "captions": caps, "by": "human", "step": "cut" if self.keeps_changed else "captions"}
        doc.pop("note", None)
        if note:
            doc["note"] = note
        return doc

    def save(self, note: str | None = None) -> bool:
        if not self.dirty:
            return True
        if self.caps.state() == QAbstractItemView.State.EditingState:
            self.caps.setFocus()  # 入力中の文字を確定する
        doc = self.build_doc((note or "").strip())  # メモは聞かない（指定があったときだけ付ける）
        errs = validate(doc)
        if errs:
            QMessageBox.warning(self, "保存できません", "\n".join(errs))
            return False
        try:
            saved = self.api.save(self.name, self.topic, self.base, doc)
        except ApiError as e:
            msg = str(e)
            if e.status == 409:
                msg += "。ほかで保存された版があります。一覧に戻って開き直してから直してください"
            QMessageBox.warning(self, "保存できませんでした", msg)
            return False
        self.doc = {**saved, "captions": tl.sort_captions(saved["captions"])}
        self.base = saved["revision"]
        self.undo.clear()
        self.dirty = False
        self.keeps_changed = False
        self.cap = -1
        self.render()
        return True

    def export(self) -> bool:
        """保存した版から XML と字幕を書き出し直す（serve が topic_XX/ に書く）"""
        if self.dirty and not self.save():
            return False
        QApplication.setOverrideCursor(Qt.CursorShape.WaitCursor)
        try:
            out = self.api.export(self.name, self.topic)
        except ApiError as e:
            QApplication.restoreOverrideCursor()
            msg = str(e)
            if e.status == 501 or e.status == 404 and msg == "見つかりません":  # 書き出しの API が無い前の serve
                msg += "（movie-editer を新しくして serve を起動し直してください）"
            QMessageBox.warning(self, "書き出せませんでした", msg)
            return False
        QApplication.restoreOverrideCursor()
        files = "\n".join(f"・{f}" for f in out.get("files", []))
        QMessageBox.information(self, "書き出しました",
                                f"版 {out.get('revision')} から書き出しました。\n{files}\n\n場所：{out.get('dir', '')}")
        return True
