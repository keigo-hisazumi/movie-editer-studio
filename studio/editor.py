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
    QInputDialog,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QSizePolicy,
    QSplitter,
    QStyledItemDelegate,
    QTableWidget,
    QTableWidgetItem,
    QTabWidget,
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
        self.image: QImage | None = None
        self.text = ""  # 字幕
        self.message = ""  # 動画が無い・再生できないときの知らせ
        self.setMinimumWidth(240)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)

    def _frame(self, frame: QVideoFrame) -> None:
        if frame.isValid():
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
        self.doc: dict[str, Any] = copy.deepcopy(data["edit"])
        self.doc["captions"] = tl.sort_captions(self.doc["captions"])
        self.base: int = self.doc["revision"]
        self.fps = float(self.doc["fps"])
        self.undo: list[tuple[list, list]] = []
        self.keeps_changed = False
        self.dirty = False
        self.mode = "short"
        self.src = self.doc["keeps"][0]["start"] if self.doc["keeps"] else 0
        self.selected = -1  # カット：選んだ文
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
        for w in (self.rev, self.undo_btn, self.save_btn):
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

        # 右：字幕・カットの一覧
        self.summary = QLabel()
        self.tabs = QTabWidget()
        self.segs = QTableWidget(0, 4)
        self.segs.setHorizontalHeaderLabels(["時刻", "", "文", ""])
        self._table(self.segs, stretch=2)
        self.segs.cellClicked.connect(self._click_seg)
        self.caps = QTableWidget(0, 4)
        self.caps.setHorizontalHeaderLabels(["タイムコード", "字幕", "文字数", "操作"])
        self._table(self.caps, stretch=1)
        self.caps.setWordWrap(True)
        self.caps.verticalHeader().setDefaultSectionSize(52)
        self.caps.setEditTriggers(QAbstractItemView.EditTrigger.DoubleClicked
                                  | QAbstractItemView.EditTrigger.EditKeyPressed
                                  | QAbstractItemView.EditTrigger.AnyKeyPressed)
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
        cut_page = QWidget()
        sv = QVBoxLayout(cut_page)
        sv.setContentsMargins(0, 4, 0, 0)
        sv.addWidget(self.segs)
        self.tabs.addTab(cut_page, "カット")
        self.tabs.addTab(cap_page, "字幕")
        self.tabs.currentChanged.connect(lambda _: self.render())
        self.tabs.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        right = QWidget()
        rv = QVBoxLayout(right)
        rv.setContentsMargins(0, 0, 0, 0)
        rv.addWidget(self.summary)
        rv.addWidget(self.tabs, 1)

        upper = QSplitter(Qt.Orientation.Horizontal)
        upper.addWidget(left)
        upper.addWidget(right)
        upper.setStretchFactor(0, 1)
        upper.setStretchFactor(1, 1)
        upper.setSizes([620, 700])

        # 下：タイムライン
        self.timeline = TrackView(self.seek_click, lambda i: self._click_cap(i, 0))
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
        url = (self.data.get("media") or {}).get("proxy.mp4")
        if url:
            self.player.setSource(QUrl(self.api.url(url)))
        else:
            self.view.set_message("確認用の動画がありません（Mac で shorts proxy を実行）")

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

    @property
    def panel(self) -> str:
        return "cut" if self.tabs.currentIndex() == 0 else "captions"

    def render(self) -> None:
        k = self.keeps
        self.rev.setText(f"版 {self.base}{'（未保存の変更あり）' if self.dirty else ''}")
        self.mode_btn.setText("表示：ショート" if self.mode == "short" else "表示：元動画")
        common = "Space 再生／← → 1 フレーム（Shift で 10）／Tab ショート・元動画／"
        self.help.setText(common + ("X 文を外す・戻す／[ ] いまの位置を区間の頭・終わりに" if self.panel == "cut"
                                    else "I O いまの位置を字幕の頭・終わりに／/ 分ける／N 足す／Delete 消す"))
        shown = sum(1 for c in self.captions if tl.kept_frames(k, c) > 0)
        self.summary.setText(f"ショートの長さ <b>{tl.total_frames(k) / self.fps:.1f} 秒</b>（区間 {len(k)} 個）"
                             f"　字幕 {len(self.captions)} 個（ショートに出るもの {shown} 個）")
        self._fill_segs()
        self._fill_caps()
        self.update_pos()

    def _fill_segs(self) -> None:
        gray, ok, warn = QBrush(QColor("gray")), QBrush(QColor("#1f8a4c")), QBrush(QColor("#b26b00"))
        segs = self.data["segments"]
        self.segs.setRowCount(len(segs))
        for i, s in enumerate(segs):
            r = tl.sec_to_frames(s["start"], s["end"], self.fps)
            kept = tl.kept_frames(self.keeps, r)
            state = "out" if kept == 0 else "in" if kept >= r["end"] - r["start"] else "part"
            cells = [clock(s["start"]), {"in": "残す", "part": "一部", "out": "外す"}[state], s["text"]]
            for c, text in enumerate(cells):
                it = QTableWidgetItem(text)
                if c == 1:
                    it.setForeground({"in": ok, "part": warn, "out": gray}[state])
                if c == 2 and state == "out":
                    f = it.font()
                    f.setStrikeOut(True)
                    it.setFont(f)
                    it.setForeground(gray)
                self.segs.setItem(i, c, it)
            b = QPushButton("戻す" if state == "out" else "外す")
            b.setFocusPolicy(Qt.FocusPolicy.NoFocus)
            b.clicked.connect(lambda _=False, i=i: self.toggle_seg(i))
            self.segs.setCellWidget(i, 3, b)
        if 0 <= self.selected < len(segs):
            self.segs.selectRow(self.selected)

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
                               (int(lo * self.fps), int(hi * self.fps) + 1), self.src, self.playing)

    # ------------------------------------------------------------ 位置と再生

    def seek(self, f: float, from_playback: bool = False) -> None:
        self.src = max(0, round(f))
        if not from_playback:
            self.seek_target = self.src
            self.seek_clock.restart()
            self.player.setPosition(int((self.src + 0.5) / self.fps * 1000))  # フレームの真ん中に合わせる
            if not self.playing:
                self._peek()
        self.update_pos()

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
        self.seek(f)

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
            return self.seek(self.src + n)
        out = tl.src_to_out(self.keeps, self.src)
        if out is None:
            out = self._nearest_out()
        self.seek(tl.out_to_src(self.keeps, max(0, min(tl.total_frames(self.keeps) - 1, out + n))))

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

    def toggle_seg(self, i: int) -> None:
        s = self.data["segments"][i]
        r = tl.sec_to_frames(s["start"], s["end"], self.fps)
        kept = tl.kept_frames(self.keeps, r)
        self.change(keeps=tl.remove_range(self.keeps, r) if kept > 0 else tl.add_range(self.keeps, r))

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

    def _click_seg(self, row: int, _col: int) -> None:
        self.selected = row
        self.pause()
        s = self.data["segments"][row]
        self.seek(tl.sec_to_frames(s["start"], s["end"], self.fps)["start"])

    # ------------------------------------------------------------ キー

    def eventFilter(self, obj: QObject, e: QEvent) -> bool:  # noqa: N802
        if e.type() != QEvent.Type.KeyPress or not self.isVisible() or not self.isActiveWindow():
            return False
        if isinstance(QApplication.focusWidget(), QLineEdit):
            return False  # 字幕の文字の入力中（Enter・Esc で入力を終える）
        return self.key(e)

    def key(self, e: QKeyEvent) -> bool:
        k = e.key()
        mods = e.modifiers()
        if mods & (Qt.KeyboardModifier.ControlModifier | Qt.KeyboardModifier.MetaModifier):
            return False  # 保存・取り消しは QShortcut
        if k == Qt.Key.Key_Space:
            self.toggle()
        elif k in (Qt.Key.Key_Right, Qt.Key.Key_Left):
            n = 10 if mods & Qt.KeyboardModifier.ShiftModifier else 1
            self.step(n if k == Qt.Key.Key_Right else -n)
        elif k in (Qt.Key.Key_Tab, Qt.Key.Key_Backtab):
            self.set_mode("source" if self.mode == "short" else "short")
        elif self.panel == "cut":
            if k == Qt.Key.Key_X and self.selected >= 0:
                self.toggle_seg(self.selected)
            elif k in (Qt.Key.Key_BracketLeft, Qt.Key.Key_BracketRight):
                self.set_edge("start" if k == Qt.Key.Key_BracketLeft else "end")
            else:
                return False
        else:
            if k == Qt.Key.Key_I:
                self.cap_edge("start")
            elif k == Qt.Key.Key_O:
                self.cap_edge("end")
            elif k == Qt.Key.Key_Slash:
                self.cap_split()
            elif k == Qt.Key.Key_N:
                self.cap_add()
            elif k in (Qt.Key.Key_Delete, Qt.Key.Key_Backspace):
                self.cap_del()
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
        if note is None:
            note, ok = QInputDialog.getText(self, "保存", "直したことのメモ（空でもよい）")
            if not ok:
                return False
        doc = self.build_doc(note.strip())
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
