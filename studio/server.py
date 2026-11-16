"""serve を自分で起動する（movie-editer のフォルダが設定されていて、serve が動いていないとき）。

起動した serve はアプリを閉じるときに止める。自分で起動していない serve（ターミナルで起動したもの）は止めない。
"""
from __future__ import annotations

import sys
from pathlib import Path
from urllib.parse import urlsplit

from PySide6.QtCore import QObject, QProcess


def venv_python(repo: Path) -> Path:
    """movie-editer の仮想環境の python（Windows は .venv\\Scripts\\python.exe）"""
    if sys.platform == "win32":
        return repo / ".venv" / "Scripts" / "python.exe"
    return repo / ".venv" / "bin" / "python"


def local_port(base: str) -> int | None:
    """URL がこの PC（localhost・127.0.0.1）の serve ならポート番号、ほかの PC なら None（起動しない）"""
    u = urlsplit(base)
    if u.hostname not in ("localhost", "127.0.0.1", "::1"):
        return None
    return u.port or 80


class ServeProcess(QObject):
    def __init__(self, parent: QObject | None = None):
        super().__init__(parent)
        self.proc: QProcess | None = None
        self.log = ""

    def running(self) -> bool:
        return self.proc is not None and self.proc.state() != QProcess.ProcessState.NotRunning

    def start(self, repo: Path, port: int) -> str | None:
        """起動する。起動できなければその理由"""
        py = venv_python(repo)
        if not py.exists():
            return f"{py} がありません（movie-editer のフォルダを確かめてください）"
        self.stop()
        p = QProcess(self)
        p.setWorkingDirectory(str(repo))
        p.setProcessChannelMode(QProcess.ProcessChannelMode.MergedChannels)
        p.readyReadStandardOutput.connect(lambda: self._read(p))
        p.start(str(py), ["-m", "shorts", "serve", "--port", str(port)])
        if not p.waitForStarted(5000):
            return f"serve を起動できません：{p.errorString()}"
        self.proc = p
        return None

    def _read(self, p: QProcess) -> None:
        self.log = (self.log + bytes(p.readAllStandardOutput().data()).decode("utf-8", "replace"))[-4000:]

    def stop(self) -> None:
        if self.running():
            self.proc.terminate()
            if not self.proc.waitForFinished(3000):
                self.proc.kill()
        self.proc = None
