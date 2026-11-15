import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

# 画面の無い環境（CI）で Qt を動かす。音の装置が無いと音声の出力で落ちることがあるので作らない
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("STUDIO_NO_AUDIO", "1")

EDIT = {
    "format": 1, "video": "20261017", "topic": 2, "fps": 30, "revision": 1, "by": "ai", "step": "draft",
    "made": "2026-11-07T00:00:00+00:00",
    "keeps": [{"start": 300, "end": 360}, {"start": 600, "end": 630}],
    "captions": [{"start": 300, "end": 330, "text": "えっ待って"}, {"start": 600, "end": 630, "text": "うそでしょ"}],
}
TOPIC = {
    "edit": EDIT, "cut": {"title": "ホラーで叫ぶ"}, "range": [5.0, 25.0],
    "segments": [{"id": 0, "start": 10.0, "end": 12.0, "text": "えっ待って", "words": []},
                 {"id": 1, "start": 15.0, "end": 16.0, "text": "関係ない話", "words": []},
                 {"id": 2, "start": 20.0, "end": 21.0, "text": "うそでしょ", "words": []}],
    "media": {"proxy.mp4": None, "peaks.json": None},
}


class Fake(BaseHTTPRequestHandler):
    """serve の代わり（版の確かめ方だけ同じ）"""

    saved: list = []
    exported: list = []
    revision = 1

    def _json(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # noqa: N802
        if self.path == "/api/videos":
            return self._json(200, [{"name": "20261017", "proxy": False, "peaks": False,
                                     "topics": [{"topic": 2, "title": "ホラーで叫ぶ", "revision": 1, "by": "ai",
                                                 "step": "draft"}]}])
        if self.path == "/api/v/20261017/t/2":
            return self._json(200, TOPIC)
        self._json(404, {"error": "見つかりません"})

    def do_PUT(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if body["base_revision"] != Fake.revision:
            return self._json(409, {"error": f"いまは版 {Fake.revision} です"})
        Fake.revision += 1
        Fake.saved.append(body)
        self._json(200, {**body["doc"], "revision": Fake.revision})

    def do_POST(self):  # noqa: N802
        self.rfile.read(int(self.headers["Content-Length"]))
        if self.path == "/api/v/20261017/t/2/export":
            Fake.exported.append(Fake.revision)
            return self._json(200, {"revision": Fake.revision, "files": ["20261017_topic_02_studio.xml", "studio.srt"],
                                    "dir": "/out/20261017/topic_02"})
        self._json(404, {"error": "見つかりません"})

    def log_message(self, *a):
        pass


@pytest.fixture
def serve():
    Fake.saved, Fake.revision, Fake.exported = [], 1, []
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_port}", Fake
    srv.shutdown()
    srv.server_close()


@pytest.fixture(scope="session")
def qapp():
    from PySide6.QtWidgets import QApplication

    return QApplication.instance() or QApplication([])
