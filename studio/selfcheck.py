"""書き出したアプリの確かめ（CI と、動画が出ないときの切り分け）。

    movie-editer-studio --self-check [動画のファイル]

Qt の動画の部品が使えるか・edit.json の検査が動くかを見る。動画のファイルを渡すと、ファイルと HTTP（serve と同じ
つなぎ方。Range にも答える）の両方で実際に再生し、コマが届いて再生位置が進むかを見る。結果は self-check.log（いまのフォルダ）と、標準出力が
あればそこにも書き、だめなら終了コード 1。
"""
from __future__ import annotations

import sys
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PySide6.QtCore import QUrl
from PySide6.QtMultimedia import QMediaPlayer, QVideoFrame, QVideoSink
from PySide6.QtWidgets import QApplication


def play(url: QUrl, wait: float = 15.0) -> str | None:
    """url を再生して、コマが届き位置が進めば None、だめならその様子"""
    player = QMediaPlayer()
    sink = QVideoSink()
    got = {"frames": 0, "size": None}
    errors: list[str] = []

    def frame(f: QVideoFrame) -> None:
        if f.isValid():
            img = f.toImage()
            if not img.isNull():
                got["frames"] += 1
                got["size"] = (img.width(), img.height())

    sink.videoFrameChanged.connect(frame)
    player.errorOccurred.connect(lambda _e, msg: errors.append(msg))
    player.setVideoOutput(sink)
    player.setSource(url)
    player.play()
    end = time.monotonic() + wait
    while time.monotonic() < end:
        QApplication.processEvents()
        if errors:
            break
        if got["frames"] >= 5 and player.position() >= 300:
            player.stop()
            return None
        time.sleep(0.01)
    state = (f"コマ {got['frames']} 枚（{got['size']}）・位置 {player.position()}ms・"
             f"{player.mediaStatus().name}・{'、'.join(errors) or 'エラーなし'}")
    player.stop()
    return state


def run(argv: list[str]) -> int:
    from .editor import validate

    app = QApplication.instance() or QApplication(argv)
    lines = []
    ok = True
    errs = validate({"format": 1})
    lines.append(f"edit.json の検査：{'ok' if errs else '動いていません'}")
    ok &= bool(errs)
    files = [a for a in argv[argv.index("--self-check") + 1:] if not a.startswith("-")]
    for f in files:
        p = Path(f).resolve()
        r = play(QUrl.fromLocalFile(str(p)))
        lines.append(f"再生（ファイル {p.name}）：{r or 'ok'}")
        ok &= r is None
        srv = ThreadingHTTPServer(("127.0.0.1", 0), partial(_Quiet, directory=str(p.parent)))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            r = play(QUrl(f"http://127.0.0.1:{srv.server_port}/{p.name}"))
        finally:
            srv.shutdown()
            srv.server_close()
        lines.append(f"再生（HTTP {p.name}）：{r or 'ok'}")
        ok &= r is None
    lines.append(f"self-check: {'ok' if ok else 'NG'}")
    text = "\n".join(lines)
    Path("self-check.log").write_text(text + "\n", encoding="utf-8")
    if sys.stdout:  # Windows の画面のあるアプリには標準出力が無いことがあり、あっても UTF-8 とは限らない
        try:
            sys.stdout.buffer.write((text + "\n").encode("utf-8"))
            sys.stdout.flush()
        except (AttributeError, OSError):
            pass
    app.quit()
    return 0 if ok else 1


class _Quiet(SimpleHTTPRequestHandler):
    """Range（bytes=a-b）にも答える（serve と同じ。iPhone の録画は moov が最後にあり、Range が無いと読めない）"""

    left: int | None = None

    def log_message(self, *a) -> None:
        pass

    def send_head(self):  # noqa: ANN201
        rng = self.headers.get("Range") or ""
        path = Path(self.translate_path(self.path))
        if not rng.startswith("bytes=") or "," in rng or not path.is_file():
            return super().send_head()
        size = path.stat().st_size
        a, _, b = rng[6:].strip().partition("-")
        try:
            start, end = (size - int(b), size - 1) if a == "" else (int(a), int(b) if b else size - 1)
        except ValueError:
            return super().send_head()
        start, end = max(0, start), min(end, size - 1)
        if start > end:
            self.send_error(416)
            return None
        f = path.open("rb")
        f.seek(start)
        self.left = end - start + 1
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(str(path)))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(self.left))
        self.end_headers()
        return f

    def copyfile(self, source, outputfile) -> None:  # noqa: ANN001
        if self.left is None:
            return super().copyfile(source, outputfile)
        while self.left > 0:
            chunk = source.read(min(1 << 20, self.left))
            if not chunk:
                break
            outputfile.write(chunk)
            self.left -= len(chunk)
