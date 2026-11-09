"""下のタイムライン（track.py）"""
from PySide6.QtGui import QImage

from studio.track import HEAD_W, TrackView, caption_pieces, timecode

KEEPS = [{"start": 100, "end": 160}, {"start": 300, "end": 330}]


def test_timecode():
    assert timecode(0, 30) == "00:00:00:00"
    assert timecode(30 * 61 + 7, 30) == "00:01:01:07"


def test_caption_pieces():
    assert caption_pieces(KEEPS, {"start": 90, "end": 120}) == [(0, 20)]
    assert caption_pieces(KEEPS, {"start": 150, "end": 310}) == [(50, 70)]  # 区間をまたいでもつながる
    assert caption_pieces(KEEPS, {"start": 200, "end": 250}) == []


def make(qapp, mode="short"):
    v = TrackView(lambda f: seeks.append(f), lambda i: caps.append(i))
    v.resize(900, 220)
    v.show()
    peaks = [0] * 400
    for f in range(300, 310):
        peaks[f] = 255
    v.set_data(mode, 30, KEEPS, [{"start": 100, "end": 130, "text": "えっ"}], -1, peaks, (90, 340), 100)
    qapp.processEvents()
    return v


seeks: list = []
caps: list = []


def test_axis_and_seek(qapp):
    seeks.clear()
    v = make(qapp)
    assert v.axis_len() == 90 and v.head == 0
    assert v.to_src(60) == 300 and v.to_axis(305) == 65
    v.seek_x(v.x(65.5))
    assert seeks[-1] == 305
    v.set_data("source", 30, KEEPS, [], -1, [], (90, 340), 305)
    assert v.axis_len() == 250 and v.head == 305


def test_caption_click(qapp):
    caps.clear()
    v = make(qapp)
    assert v.caption_hit(v.x(10)) == 0 and v.caption_hit(v.x(50)) is None


def test_zoom_keeps_scale(qapp):
    v = make(qapp)
    fit = v.ppf
    v.zoom_by(4)
    assert v.ppf > fit and not v.fit
    v.fit_all()
    assert v.fit and abs(v.ppf - fit) < 1e-6


def test_wave_from_bottom(qapp):
    """波形は下から伸びる（上下対称にしない）。ショートの 60〜70 フレーム（元動画の 300〜310）が大きい"""
    v = make(qapp)
    img = QImage(v.canvas.size(), QImage.Format.Format_RGB32)
    v.canvas.render(img)
    r = v.canvas.rows()["audio"]
    x = int(v.x(65))
    near_bottom = img.pixelColor(x, int(r.bottom()) - 4)
    near_top = img.pixelColor(x, int(r.top()) + 6)
    quiet_top = img.pixelColor(int(v.x(20)), int(r.top()) + 6)
    assert near_bottom.green() > 150 and near_top.green() > 150  # 大きい所は上まで届く
    assert quiet_top.green() < 150  # 静かな所の上は塗らない
    assert x > HEAD_W


def test_wheel_reversed(qapp):
    """ホイールの向きは一般のソフトと逆：奥へ回すと右へ・⌘（Ctrl）＋奥で縮小"""
    from PySide6.QtCore import QPoint, QPointF, Qt
    from PySide6.QtGui import QWheelEvent

    v = make(qapp)
    v.set_ppf(12.0)
    v.left = 5
    v._sync_bar()

    def wheel(dy, mods=Qt.KeyboardModifier.NoModifier):
        ev = QWheelEvent(QPointF(400, 100), QPointF(400, 100), QPoint(0, 0), QPoint(0, dy),
                         Qt.MouseButton.NoButton, mods, Qt.ScrollPhase.NoScrollPhase, False)
        v.canvas.wheelEvent(ev)

    left = v.left
    wheel(120)
    assert v.left > left
    p = v.ppf
    wheel(120, Qt.KeyboardModifier.ControlModifier)
    assert v.ppf < p
