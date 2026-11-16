"""表示用の小さな関数"""
from __future__ import annotations


def clock(sec: float) -> str:
    """秒を "MM:SS.mmm"（1 時間以上なら "H:MM:SS.mmm"）"""
    ms = max(0, round(sec * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h}:{m:02d}:{s:02d}.{ms:03d}" if h else f"{m:02d}:{s:02d}.{ms:03d}"


def frames(f: int, fps: float) -> str:
    """フレーム数を "秒+フレーム"（例 12s+07f）"""
    s = int(f // fps)
    return f"{s}s+{round(f - s * fps):02d}f"
