"""movie-editer の serve（shorts/studio.py）の API を呼ぶ。

serve は Mac で動かす（`.venv/bin/python -m shorts serve`）。Windows など別の PC からは、Mac で `serve --lan` にして
その URL（例 http://<名前>.local:8765）を設定する。
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import quote

TIMEOUT = 15


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class Api:
    def __init__(self, base: str):
        self.base = base.rstrip("/")

    def url(self, path: str) -> str:
        """API が返す /media/... などの URL を、serve の URL 付きにする"""
        return path if path.startswith(("http://", "https://")) else self.base + path

    def _call(self, path: str, method: str = "GET", body: Any = None, timeout: float = TIMEOUT) -> Any:
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(self.url(path), data=data, method=method,
                                     headers={"Content-Type": "application/json"} if data else {})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read()).get("error") or e.reason
            except (ValueError, AttributeError):
                msg = e.reason
            raise ApiError(e.code, str(msg)) from e
        except (urllib.error.URLError, OSError) as e:
            raise ApiError(0, f"movie-editer の serve（{self.base}）につながりません") from e

    def alive(self) -> bool:
        try:
            self._call("/api/videos", timeout=2)
            return True
        except ApiError:
            return False

    def videos(self) -> list[dict[str, Any]]:
        return self._call("/api/videos")

    def topic(self, name: str, topic: int) -> dict[str, Any]:
        return self._call(f"/api/v/{quote(name, safe='')}/t/{topic}")

    def edits(self, name: str, topic: int) -> list[dict[str, Any]]:
        return self._call(f"/api/v/{quote(name, safe='')}/t/{topic}/edits")

    def save(self, name: str, topic: int, base_revision: int, doc: dict[str, Any]) -> dict[str, Any]:
        return self._call(f"/api/v/{quote(name, safe='')}/t/{topic}/edit", "PUT",
                          {"base_revision": base_revision, "doc": doc})

    def peaks(self, path: str) -> dict[str, Any]:
        return self._call(path)
