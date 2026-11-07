"""波形の帯：残す区間（色）・外した所（灰色）・波形・区間の切れ目・字幕・いまの位置を描く。クリックでその位置へ動く"""
from __future__ import annotations

from collections.abc import Callable

from PySide6.QtCore import QRectF, Qt
from PySide6.QtGui import QColor, QMouseEvent, QPainter, QPaintEvent, QPalette
from PySide6.QtWidgets import QWidget

from .timeline import Caption, Keep


def _dark(w: QWidget) -> bool:
    return w.palette().color(QPalette.ColorRole.Window).lightness() < 128


class Bar(QWidget):
    """a〜b（元動画のフレーム）を横いっぱいに描く"""

    def __init__(self, height: int, captions: bool, on_seek: Callable[[float], None]):
        super().__init__()
        self.setFixedHeight(height)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.show_captions = captions
        self.on_seek = on_seek
        self.a, self.b = 0.0, 1.0
        self.keeps: list[Keep] = []
        self.captions: list[Caption] = []
        self.selected_caption = -1
        self.peaks: list[int] = []
        self.head = 0

    def set_view(self, a: float, b: float, keeps: list[Keep], captions: list[Caption], selected_caption: int,
                 peaks: list[int], head: int) -> None:
        self.a, self.b = a, max(b, a + 1)
        self.keeps, self.captions, self.selected_caption = keeps, captions, selected_caption
        self.peaks, self.head = peaks, head
        self.update()

    def _x(self, f: float) -> float:
        return (f - self.a) / (self.b - self.a) * self.width()

    def paintEvent(self, e: QPaintEvent) -> None:  # noqa: N802
        dark = _dark(self)
        g = QPainter(self)
        w, h = self.width(), self.height()
        cap_h = round(h * 0.28) if self.show_captions else 0
        wh = h - cap_h
        g.fillRect(0, 0, w, wh, QColor("#2a2a27" if dark else "#e7e7e2"))
        kept = QColor("#23406b" if dark else "#cfe3ff")
        for k in self.keeps:
            g.fillRect(QRectF(self._x(k["start"]), 0, max(1.0, self._x(k["end"]) - self._x(k["start"])), wh), kept)
        if self.peaks:
            wave = QColor(240, 240, 240, 140) if dark else QColor(30, 30, 30, 140)
            per = max(1.0, (self.b - self.a) / max(1, w))
            for px in range(w):
                f0 = int(self.a + px * per)
                m = max((self.peaks[f] for f in range(max(0, f0), min(len(self.peaks), f0 + int(per) + 1))), default=0)
                v = m / 255 * wh * 0.9
                g.fillRect(QRectF(px, (wh - v) / 2, 1, max(1.0, v)), wave)
        edge = QColor("#6ea0ff" if dark else "#2f6fdb")
        for k in self.keeps:
            g.fillRect(QRectF(self._x(k["start"]), 0, 1, wh), edge)
            g.fillRect(QRectF(self._x(k["end"]) - 1, 0, 1, wh), edge)
        if self.show_captions:
            for i, c in enumerate(self.captions):
                if c["end"] < self.a or c["start"] > self.b:
                    continue
                color = QColor("#e5484d" if i == self.selected_caption else "#f2b84b")
                x0, x1 = self._x(c["start"]), self._x(c["end"])
                g.fillRect(QRectF(x0 + 1, wh + 1, max(1.0, x1 - x0 - 1), cap_h - 1), color)
        g.fillRect(QRectF(self._x(self.head) - 1, 0, 2, h), QColor("#e5484d"))
        g.end()

    def mousePressEvent(self, e: QMouseEvent) -> None:  # noqa: N802
        self.on_seek(self.a + e.position().x() / max(1, self.width()) * (self.b - self.a))
