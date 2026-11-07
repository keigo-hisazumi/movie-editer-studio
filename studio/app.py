"""movie-editer-studio：movie-editer の AI が作ったカットと字幕を、人がフレーム単位で直す Mac・Windows のアプリ（Qt）。

ファイルの読み書きは movie-editer の serve（`shorts serve`）の API に頼む。設定：
- serve の URL（既定 http://127.0.0.1:8765。Windows など別の PC からは、Mac で `serve --lan` にしてその URL）
- movie-editer のフォルダ（この PC の serve につながらないとき、アプリが serve を起動する。閉じるときに止める）
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

from PySide6.QtCore import QSettings, Qt
from PySide6.QtGui import QCloseEvent
from PySide6.QtWidgets import (
    QApplication,
    QFileDialog,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QStackedWidget,
    QTreeWidget,
    QTreeWidgetItem,
    QVBoxLayout,
    QWidget,
)

from .api import Api, ApiError
from .editor import Editor
from .server import ServeProcess, local_port

DEFAULT_URL = "http://127.0.0.1:8765"


class Home(QWidget):
    """設定と、動画ごとのトピックの一覧"""

    def __init__(self, win: MainWindow):
        super().__init__()
        self.win = win
        self.url = QLineEdit(win.settings.value("serve_url", DEFAULT_URL))
        self.repo = QLineEdit(win.settings.value("repo", ""))
        self.repo.setPlaceholderText("この PC で serve を起動するときだけ（例 ~/movie-editer）")
        pick = QPushButton("選ぶ…")
        pick.clicked.connect(self.pick_repo)
        connect = QPushButton("つなぐ")
        connect.setDefault(True)
        connect.clicked.connect(self.reload)
        repo_row = QHBoxLayout()
        repo_row.addWidget(self.repo, 1)
        repo_row.addWidget(pick)
        url_row = QHBoxLayout()
        url_row.addWidget(self.url, 1)
        url_row.addWidget(connect)
        form = QFormLayout()
        form.addRow("serve の URL", url_row)
        form.addRow("movie-editer のフォルダ", repo_row)
        self.status = QLabel()
        self.status.setWordWrap(True)
        self.status.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        self.tree = QTreeWidget()
        self.tree.setHeaderLabels(["トピック", "タイトル", "edit.json"])
        self.tree.itemActivated.connect(self.open_item)
        hint = QLabel("トピックをダブルクリックで開く。edit.json が無いトピックは、先に /cut でカットを作る")
        hint.setStyleSheet("color: gray;")
        lay = QVBoxLayout(self)
        lay.addLayout(form)
        lay.addWidget(self.status)
        lay.addWidget(self.tree, 1)
        lay.addWidget(hint)

    def pick_repo(self) -> None:
        d = QFileDialog.getExistingDirectory(self, "movie-editer のフォルダ", self.repo.text() or str(Path.home()))
        if d:
            self.repo.setText(d)

    def reload(self) -> None:
        url = self.url.text().strip() or DEFAULT_URL
        repo = self.repo.text().strip()
        self.win.settings.setValue("serve_url", url)
        self.win.settings.setValue("repo", repo)
        self.win.api = Api(url)
        self.status.setText("つないでいます…")
        QApplication.processEvents()
        err = self.win.ensure_serve(repo)
        if err:
            self.status.setText(f"<span style='color:#c0392b'>{err}</span>")
            self.tree.clear()
            return
        try:
            videos = self.win.api.videos()
        except ApiError as e:
            self.status.setText(f"<span style='color:#c0392b'>{e}</span>")
            return
        started = "（アプリが起動した serve）" if self.win.serve.running() else ""
        self.status.setText(f"{url} につながりました{started}")
        self.fill(videos)

    def fill(self, videos: list[dict]) -> None:
        self.tree.clear()
        for v in videos:
            if not v["topics"]:
                continue
            top = QTreeWidgetItem([v["name"], "" if v["proxy"] else "確認用の動画なし（shorts proxy で作る）", ""])
            for t in v["topics"]:
                state = ("edit.json なし" if t["revision"] is None
                         else f"版 {t['revision']}（{'人' if t['by'] == 'human' else 'AI'}・{t['step'] or ''}）")
                it = QTreeWidgetItem([f"topic_{t['topic']:02d}", t["title"], state])
                it.setData(0, Qt.ItemDataRole.UserRole, (v["name"], t["topic"]) if t["revision"] is not None else None)
                if t["revision"] is None:
                    for c in range(3):
                        it.setForeground(c, self.palette().placeholderText())
                top.addChild(it)
            self.tree.addTopLevelItem(top)
            top.setExpanded(True)
        for c in range(3):
            self.tree.resizeColumnToContents(c)

    def open_item(self, item: QTreeWidgetItem) -> None:
        target = item.data(0, Qt.ItemDataRole.UserRole)
        if target:
            self.win.open_topic(*target)


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("movie-editer studio")
        self.resize(1360, 900)
        self.settings = QSettings("movie-editer", "studio")
        self.api = Api(self.settings.value("serve_url", DEFAULT_URL))
        self.serve = ServeProcess(self)
        self.stack = QStackedWidget()
        self.home = Home(self)
        self.stack.addWidget(self.home)
        self.setCentralWidget(self.stack)
        self.editor: Editor | None = None

    def ensure_serve(self, repo: str) -> str | None:
        """serve につながるか確かめ、この PC の serve でつながらなければ起動する。つながらなければその理由"""
        if self.api.alive():
            return None
        port = local_port(self.api.base)
        if not repo or port is None:
            hint = "Mac で .venv/bin/python -m shorts serve を起動するか、movie-editer のフォルダを設定してください"
            return f"{self.api.base} につながりません。{hint}"
        err = self.serve.start(Path(repo).expanduser(), port)
        if err:
            return err
        for _ in range(60):  # 最大 15 秒待つ
            QApplication.processEvents()
            if self.api.alive():
                return None
            if not self.serve.running():
                break
            time.sleep(0.25)
        return f"serve が起動しませんでした：{self.serve.log[-600:] or '（出力なし）'}"

    def open_topic(self, name: str, topic: int) -> None:
        QApplication.setOverrideCursor(Qt.CursorShape.WaitCursor)
        try:
            data = self.api.topic(name, topic)
            peaks = None
            if (data.get("media") or {}).get("peaks.json"):
                try:
                    peaks = self.api.peaks(data["media"]["peaks.json"])
                except ApiError:
                    peaks = None
        except ApiError as e:
            QMessageBox.warning(self, "開けません", str(e))
            return
        finally:
            QApplication.restoreOverrideCursor()
        self.close_editor()
        self.editor = Editor(self.api, name, topic, data, peaks)
        self.editor.back.connect(self.go_home)
        self.stack.addWidget(self.editor)
        self.stack.setCurrentWidget(self.editor)
        self.setWindowTitle(f"{name} topic_{topic:02d} — movie-editer studio")

    def confirm_leave(self) -> bool:
        if not self.editor or not self.editor.dirty:
            return True
        r = QMessageBox.question(self, "保存していない変更", "保存していない変更があります。保存しますか？",
                                 QMessageBox.StandardButton.Save | QMessageBox.StandardButton.Discard
                                 | QMessageBox.StandardButton.Cancel)
        if r == QMessageBox.StandardButton.Save:
            return self.editor.save()
        return r == QMessageBox.StandardButton.Discard

    def go_home(self) -> None:
        if not self.confirm_leave():
            return
        self.close_editor()
        self.setWindowTitle("movie-editer studio")
        self.stack.setCurrentWidget(self.home)
        self.home.reload()

    def close_editor(self) -> None:
        if self.editor:
            self.editor.destroy_editor()
            self.stack.removeWidget(self.editor)
            self.editor.deleteLater()
            self.editor = None

    def closeEvent(self, e: QCloseEvent) -> None:  # noqa: N802
        if not self.confirm_leave():
            e.ignore()
            return
        self.close_editor()
        self.serve.stop()
        e.accept()


def self_check() -> int:
    """書き出したアプリの確かめ（CI）：Qt の動画と、edit.json の検査が使えるか"""
    from PySide6.QtMultimedia import QMediaPlayer

    from .editor import validate

    app = QApplication(sys.argv)
    QMediaPlayer()
    errs = validate({"format": 1})
    if sys.stdout:  # Windows の画面のあるアプリには標準出力が無い
        print("self-check:", "ok" if errs else "edit.json の検査が動いていません", flush=True)
    app.quit()
    return 0 if errs else 1


def main() -> int:
    if "--self-check" in sys.argv:
        return self_check()
    app = QApplication(sys.argv)
    app.setApplicationName("movie-editer studio")
    win = MainWindow()
    win.show()
    win.home.reload()
    return app.exec()
