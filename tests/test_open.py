"""一覧から開くときのエラーの出し方と、止めている間のプレビュー"""
import copy
import time
from pathlib import Path

from PySide6.QtCore import QUrl
from PySide6.QtWidgets import QApplication

from studio import app as studio_app
from studio.api import Api
from studio.editor import Editor

from .conftest import TOPIC

SAMPLE = Path(__file__).parent / "data" / "sample.mp4"


def test_open_reports_unexpected_error(qapp, serve, monkeypatch, tmp_path):
    """ApiError でない例外も、黙って消えずに画面と記録に出す"""
    base, _ = serve
    monkeypatch.setattr(studio_app, "log_path", lambda: tmp_path / "studio.log")
    shown = []
    monkeypatch.setattr(studio_app.QMessageBox, "exec", lambda self: shown.append(self.text()))

    def broken(*a, **k):
        raise KeyError("keeps")

    monkeypatch.setattr(studio_app, "Editor", broken)
    win = studio_app.MainWindow()
    win.api = Api(base)
    win.open_topic("20261017", 2)
    assert win.editor is None
    assert shown and "KeyError" in shown[0]
    assert "KeyError" in (tmp_path / "studio.log").read_text(encoding="utf-8")
    win.close()


class FileApi(Api):
    def url(self, path):
        return QUrl.fromLocalFile(str(SAMPLE)).toString() if path == "sample" else super().url(path)


def wait_for(cond, sec=15.0):
    end = time.monotonic() + sec
    while time.monotonic() < end:
        QApplication.processEvents()
        if cond():
            return True
        time.sleep(0.01)
    return False


def test_paused_preview_shows_frame(qapp):
    """止めたまま開く・飛ぶでも、その位置のコマを出して止まる"""
    data = copy.deepcopy(TOPIC)
    data["edit"]["keeps"] = [{"start": 6, "end": 30}, {"start": 40, "end": 55}]
    data["edit"]["captions"] = [{"start": 6, "end": 20, "text": "えっ待って"}]
    data["media"] = {"proxy.mp4": "sample", "peaks.json": None}
    e = Editor(FileApi("http://127.0.0.1:9"), "20261017", 2, data, None)
    e.resize(1000, 700)
    e.show()
    assert wait_for(lambda: e.view.image is not None and not e.peeking), "開いた後にコマが出ない"
    e.view.image = None
    e.seek_click(45)
    assert wait_for(lambda: e.view.image is not None and not e.peeking), "止めて飛んだ後にコマが出ない"
    assert not e.playing
    assert wait_for(lambda: e.player.playbackState() != e.player.PlaybackState.PlayingState, 3)
    e.destroy_editor()
