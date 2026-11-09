"""下のタイムライン：目盛り・字幕・映像（残す区間）・音声（波形）のトラックと、いまの位置。

動画編集ソフト（Filmora・Premiere）と同じく、左から右へ時間が流れ、拡大・スクロールできる。
- ショートの表示：横軸はショートの時間（残す区間をつなげたもの）。区間の切れ目に縦の線
- 元動画の表示：横軸は元動画の時間（トピックの区間）。外した所は暗く
クリック・ドラッグでその位置へ動き、字幕をクリックするとその字幕を選ぶ。
ホイールで横にスクロール、⌘（Ctrl）＋ホイール・下のつまみで拡大・縮小。
"""
from __future__ import annotations

import math
from collections.abc import Callable

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QColor, QFont, QMouseEvent, QPainter, QPainterPath, QPaintEvent, QPen, QPixmap, QWheelEvent
from PySide6.QtWidgets import QHBoxLayout, QPushButton, QScrollBar, QSlider, QVBoxLayout, QWidget

from . import timeline as tl
from .timeline import Caption, Keep

HEAD_W = 34  # 左のトラック名の幅
RULER_H = 26
CAP_H = 34
VIDEO_H = 30
AUDIO_H = 64
GAP = 4
MAX_PX_PER_FRAME = 12.0  # いちばん拡大したとき（1 フレームの幅）

BG = QColor("#1b1c1f")
TRACK_BG = QColor("#232428")
HEAD_BG = QColor("#26272b")
LINE = QColor("#3a3b40")
TEXT = QColor("#c9cbd1")
MUTED = QColor("#7d8088")
CAP = QColor("#177a8f")
CAP_SEL = QColor("#1d93ab")
VIDEO = QColor("#3d5a9e")
AUDIO = QColor("#1f5e45")
WAVE = QColor("#5fd39a")
WAVE_OUT = QColor("#5b5e66")
HEAD = QColor("#ff5a5f")


def timecode(f: int, fps: float) -> str:
    """フレーム数を "HH:MM:SS:FF"（Filmora・Premiere と同じ書き方）"""
    f = max(0, int(f))
    per = max(1, round(fps))
    s, ff = divmod(f, per)
    h, s = divmod(s, 3600)
    m, s = divmod(s, 60)
    return f"{h:02d}:{m:02d}:{s:02d}:{ff:02d}"


def caption_pieces(keeps: list[Keep], c: Caption) -> list[tuple[int, int]]:
    """字幕がショートに出る所（ショートのフレーム、start 含む・end 含まない）。つながる所は1つにまとめる"""
    out: list[tuple[int, int]] = []
    off = 0
    for k in keeps:
        a, b = max(c["start"], k["start"]), min(c["end"], k["end"])
        if a < b:
            s, e = off + a - k["start"], off + b - k["start"]
            if out and out[-1][1] == s:
                out[-1] = (out[-1][0], e)
            else:
                out.append((s, e))
        off += k["end"] - k["start"]
    return out


class Canvas(QWidget):
    """トラックを描く所（横軸は「軸のフレーム」。ショートの表示ならショート、元動画の表示なら元動画のフレーム）"""

    def __init__(self, owner: TrackView):
        super().__init__()
        self.o = owner
        self.setMouseTracking(False)
        self.setMinimumHeight(RULER_H + CAP_H + VIDEO_H + AUDIO_H + GAP * 4)
        self._drag = False
        self._cache: QPixmap | None = None
        self._cache_key: tuple | None = None

    # 行の位置
    def rows(self) -> dict[str, QRectF]:
        w = self.width() - HEAD_W
        y = RULER_H + GAP
        out = {}
        for name, h in (("cap", CAP_H), ("video", VIDEO_H), ("audio", AUDIO_H)):
            if name == "audio":  # 音声は残りの高さいっぱい（波形を大きく見せる）
                h = max(AUDIO_H, self.height() - y - GAP)
            out[name] = QRectF(HEAD_W, y, w, h)
            y += h + GAP
        return out

    def paintEvent(self, e: QPaintEvent) -> None:  # noqa: N802
        o = self.o
        # いまの位置の線以外は、見ている範囲・中身が変わったときだけ描き直す（再生中に毎回描くと重い）
        dpr = self.devicePixelRatioF()
        key = (o.left, o.ppf, self.width(), self.height(), dpr, o.mode, o._wave_key,
               tuple(o._blocks), o.selected)
        if key != self._cache_key or self._cache is None:
            self._cache_key = key
            self._cache = QPixmap(round(self.width() * dpr), round(self.height() * dpr))
            self._cache.setDevicePixelRatio(dpr)
            cg = QPainter(self._cache)
            self._paint_tracks(cg)
            cg.end()
        g = QPainter(self)
        g.drawPixmap(0, 0, self._cache)
        g.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        g.setClipRect(QRectF(HEAD_W, 0, self.width() - HEAD_W, self.height()))
        hx = o.x(o.head)
        g.setPen(QPen(HEAD, 1.5))
        g.drawLine(QPointF(hx, 4), QPointF(hx, self.height()))
        tri = QPainterPath()
        tri.moveTo(hx - 6, 2)
        tri.lineTo(hx + 6, 2)
        tri.lineTo(hx + 6, 10)
        tri.lineTo(hx, 16)
        tri.lineTo(hx - 6, 10)
        tri.closeSubpath()
        g.fillPath(tri, HEAD)
        g.end()

    def _paint_tracks(self, g: QPainter) -> None:
        o = self.o
        g.fillRect(QRectF(0, 0, self.width(), self.height()), BG)
        rows = self.rows()
        g.setClipRect(QRectF(HEAD_W, 0, self.width() - HEAD_W, self.height()))
        for r in rows.values():
            g.fillRect(r, TRACK_BG)
        self._ruler(g)
        g.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        self._clips(g, rows["video"], VIDEO, "映像")
        self._clips(g, rows["audio"], AUDIO, None)
        g.setRenderHint(QPainter.RenderHint.Antialiasing, False)  # 波形は 1 ピクセルごとなので要らない（速い）
        self._wave(g, rows["audio"])
        g.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        self._captions(g, rows["cap"])
        if o.mode == "short":
            g.setPen(QPen(QColor(0, 0, 0, 160), 2))
            for x in o.cut_points():
                px = o.x(x)
                g.drawLine(QPointF(px, rows["video"].top()), QPointF(px, rows["audio"].bottom()))
        # トラック名
        g.setClipping(False)
        g.fillRect(QRectF(0, 0, HEAD_W, self.height()), HEAD_BG)
        g.setPen(MUTED)
        f = QFont(self.font())
        f.setPointSizeF(max(8.0, f.pointSizeF() - 1))
        g.setFont(f)
        for name, label in (("cap", "字"), ("video", "映"), ("audio", "音")):
            g.drawText(QRectF(0, rows[name].top(), HEAD_W, rows[name].height()), Qt.AlignmentFlag.AlignCenter, label)

    def _ruler(self, g: QPainter) -> None:
        o = self.o
        g.setPen(QPen(LINE, 1))
        g.drawLine(QPointF(HEAD_W, RULER_H - 0.5), QPointF(self.width(), RULER_H - 0.5))
        # 目盛りの間隔：文字が 100 ピクセルほど離れるように、1 フレーム・秒の切りのよい数から選ぶ
        fps = max(1, round(o.fps))
        steps = [1, 2, 5, 10, 15] + [fps * s for s in (1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600)]
        major = next((s for s in steps if s * o.ppf >= 100), steps[-1])
        minor = next((s for s in reversed(steps) if s < major and s * o.ppf >= 8 and major % s == 0), major)
        a = o.left
        b = a + (self.width() - HEAD_W) / o.ppf
        f = math.floor(a / minor) * minor
        g.setFont(self._small())
        while f <= b:
            x = o.x(f)
            if f % major == 0:
                g.setPen(QPen(MUTED, 1))
                g.drawLine(QPointF(x, RULER_H - 9), QPointF(x, RULER_H - 1))
                g.drawText(QPointF(x + 3, RULER_H - 11), timecode(f, o.fps))
            else:
                g.setPen(QPen(LINE, 1))
                g.drawLine(QPointF(x, RULER_H - 5), QPointF(x, RULER_H - 1))
            f += minor

    def _small(self) -> QFont:
        f = QFont(self.font())
        f.setPointSizeF(max(7.5, f.pointSizeF() - 2))
        return f

    def _clips(self, g: QPainter, r: QRectF, color: QColor, label: str | None) -> None:
        o = self.o
        for a, b in o.clip_ranges():
            x0, x1 = o.x(a), o.x(b)
            if x1 < HEAD_W or x0 > self.width():
                continue
            rect = QRectF(x0, r.top(), max(1.0, x1 - x0), r.height())
            path = QPainterPath()
            path.addRoundedRect(rect.adjusted(0.5, 0.5, -0.5, -0.5), 3, 3)
            g.fillPath(path, color)
            if label and rect.width() > 40:
                g.setPen(TEXT)
                g.setFont(self._small())
                g.drawText(rect.adjusted(6, 0, -4, 0), Qt.AlignmentFlag.AlignVCenter, label)

    def _wave(self, g: QPainter, r: QRectF) -> None:
        """動画編集ソフトのような、下から伸びる塗りつぶしの波形"""
        o = self.o
        if not o.peaks:
            return
        x_from = max(HEAD_W, 0)
        x_to = self.width()
        base = r.bottom() - 2
        span = r.height() - 6
        inside = QPainterPath()
        outside = QPainterPath()
        for path in (inside, outside):
            path.moveTo(x_from, base)
        pts_in: list[QPointF] = []
        pts_out: list[QPointF] = []
        for px in range(int(x_from), int(x_to) + 1):
            f0 = o.left + (px - HEAD_W) / o.ppf
            f1 = o.left + (px + 1 - HEAD_W) / o.ppf
            v, is_in = o.level(f0, f1)
            # 小さい音も見えるように、少しだけ持ち上げる（平方根）
            h = math.sqrt(v / 255) * span if v > 0 else 0
            (pts_in if is_in else pts_out).append(QPointF(px, base - h))
            (pts_out if is_in else pts_in).append(QPointF(px, base))
        for path, pts, color in ((inside, pts_in, WAVE), (outside, pts_out, WAVE_OUT)):
            for p in pts:
                path.lineTo(p)
            path.lineTo(x_to, base)
            path.closeSubpath()
            g.fillPath(path, color)

    def _captions(self, g: QPainter, r: QRectF) -> None:
        o = self.o
        g.setFont(self._small())
        for i, (a, b, text, kept) in enumerate(o.caption_blocks()):
            x0, x1 = o.x(a), o.x(b)
            if x1 < HEAD_W or x0 > self.width():
                continue
            rect = QRectF(x0, r.top(), max(2.0, x1 - x0), r.height()).adjusted(0.5, 0.5, -0.5, -0.5)
            path = QPainterPath()
            path.addRoundedRect(rect, 3, 3)
            sel = o.caption_index(i) == o.selected
            g.fillPath(path, (CAP_SEL if sel else CAP) if kept else QColor(70, 72, 78))
            if sel:
                g.setPen(QPen(QColor("white"), 1.5))
                g.drawPath(path)
            if rect.width() > 18:
                g.setPen(TEXT if kept else MUTED)
                fm = g.fontMetrics()
                g.drawText(rect.adjusted(5, 0, -3, 0), Qt.AlignmentFlag.AlignVCenter,
                           fm.elidedText(text, Qt.TextElideMode.ElideRight, int(rect.width() - 8)))

    # 操作
    def mousePressEvent(self, e: QMouseEvent) -> None:  # noqa: N802
        if e.button() != Qt.MouseButton.LeftButton or e.position().x() < HEAD_W:
            return
        pos = e.position()
        rows = self.rows()
        if rows["cap"].contains(pos):
            i = self.o.caption_hit(pos.x())
            if i is not None:
                self.o.on_caption(i)
                return
        self._drag = True
        self.o.seek_x(pos.x())

    def mouseMoveEvent(self, e: QMouseEvent) -> None:  # noqa: N802
        if self._drag:
            self.o.seek_x(e.position().x())

    def mouseReleaseEvent(self, e: QMouseEvent) -> None:  # noqa: N802
        self._drag = False

    def wheelEvent(self, e: QWheelEvent) -> None:  # noqa: N802
        d = e.angleDelta()
        if e.modifiers() & (Qt.KeyboardModifier.ControlModifier | Qt.KeyboardModifier.MetaModifier):
            self.o.zoom_by(1.25 if d.y() > 0 else 0.8, e.position().x())
        else:
            step = d.x() if abs(d.x()) > abs(d.y()) else -d.y()
            self.o.scroll_by(step / max(1e-6, self.o.ppf))
        e.accept()

    def resizeEvent(self, e) -> None:  # noqa: N802
        self.o.relayout()


class TrackView(QWidget):
    """タイムライン（Canvas）と、横のスクロールバー・拡大のつまみ"""

    def __init__(self, on_seek: Callable[[int], None], on_caption: Callable[[int], None]):
        super().__init__()
        self.on_seek, self.on_caption = on_seek, on_caption
        self.mode = "short"
        self.fps = 30.0
        self.keeps: list[Keep] = []
        self.captions: list[Caption] = []
        self.selected = -1
        self.peaks: list[int] = []
        self.range = (0, 1)  # 元動画の表示の横軸（トピックの区間）
        self.src = 0
        self.head = 0  # 軸のフレーム
        self.ppf = 1.0  # 1 フレームの幅（ピクセル）
        self.left = 0.0  # 左端の軸のフレーム
        self.fit = True  # 全体が収まる拡大率のまま（大きさが変わったら合わせ直す）
        self.follow = True
        self._blocks: list[tuple[int, int, str, bool, int]] = []
        self._wave_key: tuple | None = None
        self._out_peaks: list[int] = []

        self.canvas = Canvas(self)
        self.bar = QScrollBar(Qt.Orientation.Horizontal)
        self.bar.valueChanged.connect(self._scrolled)
        self.slider = QSlider(Qt.Orientation.Horizontal)
        self.slider.setRange(0, 1000)
        self.slider.setFixedWidth(160)
        self.slider.valueChanged.connect(self._slid)
        minus, plus, fit = QPushButton("−"), QPushButton("＋"), QPushButton("全体")
        for b in (minus, plus, fit):
            b.setFocusPolicy(Qt.FocusPolicy.NoFocus)
            b.setFixedWidth(44)
        minus.clicked.connect(lambda: self.zoom_by(0.8))
        plus.clicked.connect(lambda: self.zoom_by(1.25))
        fit.clicked.connect(lambda: self.fit_all())
        for w in (self.slider, self.bar):
            w.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        row = QHBoxLayout()
        row.setContentsMargins(HEAD_W, 0, 4, 0)
        row.addWidget(self.bar, 1)
        row.addWidget(fit)
        row.addWidget(minus)
        row.addWidget(self.slider)
        row.addWidget(plus)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(2)
        lay.addWidget(self.canvas, 1)
        lay.addLayout(row)
        self._syncing = False

    # ---------------------------------------------------------------- データ

    def set_data(self, mode: str, fps: float, keeps: list[Keep], captions: list[Caption], selected: int,
                 peaks: list[int], rng: tuple[int, int], src: int, playing: bool = False) -> None:
        changed_axis = mode != self.mode or rng != self.range or tl.total_frames(keeps) != tl.total_frames(self.keeps)
        self.mode, self.fps = mode, fps
        self.keeps, self.captions, self.selected, self.peaks = keeps, captions, selected, peaks
        self.range = (rng[0], max(rng[1], rng[0] + 1))
        self.src = src
        key = (mode, tuple((k["start"], k["end"]) for k in keeps), id(peaks), len(peaks))
        if key != self._wave_key:  # ショートの時間ごとの音量（再生中に毎回計算しないように）
            self._wave_key = key
            self._out_peaks = self._make_out_peaks() if mode == "short" else []
        self._blocks = self._make_blocks()
        self.head = self.to_axis(src)
        if changed_axis and self.fit:
            self.fit_all(update=False)
        self._sync_bar()
        if playing or self.follow:
            self._keep_head_visible(playing)
        self.canvas.update()

    def axis_len(self) -> int:
        return max(1, tl.total_frames(self.keeps)) if self.mode == "short" else self.range[1] - self.range[0]

    def axis_start(self) -> int:
        return 0 if self.mode == "short" else self.range[0]

    def to_axis(self, src: int) -> float:
        if self.mode == "source":
            return src
        out = tl.src_to_out(self.keeps, src)
        if out is not None:
            return out
        off = 0  # 外した所なら、次に残る所
        for k in self.keeps:
            if src < k["start"]:
                return off
            off += k["end"] - k["start"]
        return off

    def to_src(self, f: float) -> int:
        f = int(math.floor(f))
        if self.mode == "source":
            return max(0, f)
        total = tl.total_frames(self.keeps)
        if total <= 0:
            return 0
        return tl.out_to_src(self.keeps, max(0, min(total - 1, f)))

    def clip_ranges(self) -> list[tuple[int, int]]:
        """映像・音声のクリップ（軸のフレーム）"""
        if self.mode == "source":
            return [(k["start"], k["end"]) for k in self.keeps]
        out, off = [], 0
        for k in self.keeps:
            n = k["end"] - k["start"]
            out.append((off, off + n))
            off += n
        return out

    def cut_points(self) -> list[int]:
        return [b for _, b in self.clip_ranges()[:-1]]

    def _make_blocks(self) -> list[tuple[int, int, str, bool, int]]:
        """字幕の塊（軸の start・end、文字、ショートに残るか、字幕の番号）"""
        out = []
        for i, c in enumerate(self.captions):
            if self.mode == "source":
                out.append((c["start"], c["end"], c["text"], tl.kept_frames(self.keeps, c) > 0, i))
            else:
                for a, b in caption_pieces(self.keeps, c):
                    out.append((a, b, c["text"], True, i))
        return out

    def caption_blocks(self) -> list[tuple[int, int, str, bool]]:
        return [b[:4] for b in self._blocks]

    def caption_index(self, block: int) -> int:
        return self._blocks[block][4]

    def caption_hit(self, x: float) -> int | None:
        f = self.left + (x - HEAD_W) / self.ppf
        for a, b, _t, _k, i in self._blocks:
            if a <= f < b:
                return i
        return None

    def level(self, f0: float, f1: float) -> tuple[int, bool]:
        """軸の f0〜f1 の音量の最大（0〜255）と、ショートに残る所か"""
        a, b = int(math.floor(f0)), max(int(math.floor(f0)) + 1, int(math.floor(f1)))
        if self.mode == "source":
            seg = self.peaks[max(0, a):max(0, min(len(self.peaks), b))]
            kept = tl.keep_index_at(self.keeps, a) >= 0
            return (max(seg) if seg else 0), kept
        seg = self._out_peaks[max(0, a):max(0, min(len(self._out_peaks), b))]
        return (max(seg) if seg else 0), True

    def _make_out_peaks(self) -> list[int]:
        n = len(self.peaks)
        out: list[int] = []
        for k in self.keeps:
            seg = self.peaks[max(0, k["start"]):max(0, min(n, k["end"]))]
            out.extend(seg)
            out.extend([0] * (k["end"] - k["start"] - len(seg)))
        return out

    # ---------------------------------------------------------------- 位置と拡大

    def x(self, f: float) -> float:
        return HEAD_W + (f - self.left) * self.ppf

    def view_w(self) -> float:
        return max(1.0, self.canvas.width() - HEAD_W)

    def min_ppf(self) -> float:
        return self.view_w() / (self.axis_len() * 1.02)

    def _ppf_from_slider(self, v: int) -> float:
        lo, hi = math.log(self.min_ppf()), math.log(max(MAX_PX_PER_FRAME, self.min_ppf()))
        return math.exp(lo + (hi - lo) * v / 1000)

    def _slider_from_ppf(self, p: float) -> int:
        lo, hi = math.log(self.min_ppf()), math.log(max(MAX_PX_PER_FRAME, self.min_ppf()))
        return 0 if hi <= lo else round((math.log(p) - lo) / (hi - lo) * 1000)

    def fit_all(self, update: bool = True) -> None:
        self.fit = True
        self.ppf = self.min_ppf()
        self.left = self.axis_start() - self.axis_len() * 0.01
        self._sync_bar()
        if update:
            self.canvas.update()

    def zoom_by(self, k: float, at_x: float | None = None) -> None:
        self.set_ppf(self.ppf * k, at_x)

    def set_ppf(self, p: float, at_x: float | None = None) -> None:
        p = max(self.min_ppf(), min(max(MAX_PX_PER_FRAME, self.min_ppf()), p))
        # 拡大の中心：指定が無ければいまの位置（見えていれば）、見えていなければ真ん中
        if at_x is None:
            hx = self.x(self.head)
            at_x = hx if HEAD_W <= hx <= self.canvas.width() else HEAD_W + self.view_w() / 2
        f = self.left + (at_x - HEAD_W) / self.ppf
        self.ppf = p
        self.left = f - (at_x - HEAD_W) / p
        self.fit = p <= self.min_ppf() * 1.0001
        self._sync_bar()
        self.canvas.update()

    def scroll_by(self, frames: float) -> None:
        self.left += frames
        self.follow = False
        self._sync_bar()
        self.canvas.update()

    def seek_x(self, x: float) -> None:
        f = self.left + (x - HEAD_W) / self.ppf
        lo = self.axis_start()
        f = max(lo, min(lo + self.axis_len() - 1, f))
        self.follow = True
        self.on_seek(self.to_src(f))

    def _keep_head_visible(self, playing: bool) -> None:
        vis = self.view_w() / self.ppf
        if self.head < self.left or self.head > self.left + vis:
            # 再生中はページ送り（いまの位置を左寄りに）、止めているときは真ん中に
            self.left = self.head - vis * (0.1 if playing else 0.5)
            self._sync_bar()

    def _sync_bar(self) -> None:
        vis = self.view_w() / self.ppf
        lo = self.axis_start() - self.axis_len() * 0.01
        hi = self.axis_start() + self.axis_len() * 1.01 - vis
        self.left = max(lo, min(max(lo, hi), self.left))
        self._syncing = True
        self.bar.setRange(0, max(0, int(round(hi - lo))))
        self.bar.setPageStep(max(1, int(vis)))
        self.bar.setSingleStep(max(1, int(vis / 20)))
        self.bar.setValue(int(round(self.left - lo)))
        self.slider.setValue(self._slider_from_ppf(self.ppf))
        self._syncing = False

    def _scrolled(self, v: int) -> None:
        if self._syncing:
            return
        self.left = self.axis_start() - self.axis_len() * 0.01 + v
        self.follow = False
        self.canvas.update()

    def _slid(self, v: int) -> None:
        if self._syncing:
            return
        self.set_ppf(self._ppf_from_slider(v))

    def relayout(self) -> None:
        if self.fit:
            self.fit_all(update=False)
        else:
            self.ppf = max(self.ppf, self.min_ppf())
            self._sync_bar()
