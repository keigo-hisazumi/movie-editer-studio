"""カットの区間（keeps）と字幕を扱う純粋な処理。movie-editer の shorts/edit.py と同じ数え方。

フレーム番号は元動画のもの（fps は EditDoc の fps、30）。start は含み end は含まない。keeps の並び順がショートの順。
区間・字幕は edit.json と同じ dict（{"start": ..., "end": ...}、字幕は "text" も）で持ち、元の dict は書き換えない。
"""
from __future__ import annotations

import math
from typing import Literal, TypedDict


class Keep(TypedDict):
    start: int
    end: int


class Caption(TypedDict):
    start: int
    end: int
    text: str


Edge = Literal["start", "end"]


def total_frames(keeps: list[Keep]) -> int:
    """ショートの長さ（フレーム）"""
    return sum(k["end"] - k["start"] for k in keeps)


def out_to_src(keeps: list[Keep], f: int) -> int:
    """ショートのフレーム f が元動画のどのフレームか（最後より後は最後の区間の終わり）"""
    off = 0
    for k in keeps:
        n = k["end"] - k["start"]
        if f < off + n:
            return k["start"] + f - off
        off += n
    return keeps[-1]["end"] if keeps else 0


def src_to_out(keeps: list[Keep], f: int) -> int | None:
    """元動画のフレーム f がショートの何フレーム目か（残す区間に入っていなければ None）"""
    off = 0
    for k in keeps:
        if k["start"] <= f < k["end"]:
            return off + f - k["start"]
        off += k["end"] - k["start"]
    return None


def keep_index_at(keeps: list[Keep], f: int) -> int:
    """元動画のフレーム f を含む区間の番号（無ければ -1）"""
    return next((i for i, k in enumerate(keeps) if k["start"] <= f < k["end"]), -1)


def sec_to_frames(start: float, end: float, fps: float) -> Keep:
    """秒の区間をフレームの区間に（頭は切り捨て、終わりは切り上げ。発話を削らないように）"""
    return {"start": math.floor(start * fps + 1e-6), "end": math.ceil(end * fps - 1e-6)}


def kept_frames(keeps: list[Keep], r: Keep | Caption) -> int:
    """区間 r の中で残しているフレームの数"""
    return sum(max(0, min(k["end"], r["end"]) - max(k["start"], r["start"])) for k in keeps)


def remove_range(keeps: list[Keep], r: Keep) -> list[Keep]:
    """区間 r を外す（区間の途中なら2つに分かれる）"""
    out: list[Keep] = []
    for k in keeps:
        if r["end"] <= k["start"] or k["end"] <= r["start"]:
            out.append({"start": k["start"], "end": k["end"]})
            continue
        if k["start"] < r["start"]:
            out.append({"start": k["start"], "end": r["start"]})
        if r["end"] < k["end"]:
            out.append({"start": r["end"], "end": k["end"]})
    return out


def merge_adjacent(keeps: list[Keep]) -> list[Keep]:
    """並びで隣り合い、元動画でもつながっている区間を1つにする。空の区間は消す"""
    out: list[Keep] = []
    for k in keeps:
        if k["end"] <= k["start"]:
            continue
        if out and out[-1]["end"] == k["start"]:
            out[-1] = {"start": out[-1]["start"], "end": k["end"]}
        else:
            out.append({"start": k["start"], "end": k["end"]})
    return out


def add_range(keeps: list[Keep], r: Keep) -> list[Keep]:
    """区間 r を残す（戻す）。重なる・隣り合う区間があればつなげ、無ければ元動画の順で入る所に足す"""
    out = [{"start": k["start"], "end": k["end"]} for k in keeps]
    if r["end"] <= r["start"]:
        return out
    rest = [{"start": r["start"], "end": r["end"]}]
    for k in keeps:  # すでに残している所は除く
        rest = [y for x in rest for y in remove_range([x], k)]
    for x in rest:
        before = next((i for i, k in enumerate(out) if k["end"] == x["start"]), -1)
        after = next((i for i, k in enumerate(out) if k["start"] == x["end"]), -1)
        if before >= 0:
            out[before]["end"] = x["end"]
        elif after >= 0:
            out[after]["start"] = x["start"]
        else:
            # 元動画の順で、x より前で終わる最後の区間の後ろ
            at = 0
            for i, k in enumerate(out):
                if k["end"] <= x["start"]:
                    at = i + 1
            out.insert(at, dict(x))
        out = merge_adjacent(out)
    return out


def move_edge(keeps: list[Keep], i: int, edge: Edge, to: int) -> list[Keep]:
    """i 番目の区間の頭（start）か終わり（end）を to にする。元動画で重なった区間は、動かした方を優先して削る"""
    out = [{"start": k["start"], "end": k["end"]} for k in keeps]
    if not 0 <= i < len(out):
        return out
    k = out[i]
    if edge == "start":
        k["start"] = max(0, min(to, k["end"] - 1))
    else:
        k["end"] = max(k["start"] + 1, to)
    return merge_adjacent([y for j, x in enumerate(out) for y in ([x] if j == i else remove_range([x], k))])


# ---------------------------------------------------------------- 字幕（元動画のフレームで持つ。並びは元動画の順）

def sort_captions(caps: list[Caption]) -> list[Caption]:
    """元動画の順に並べる"""
    return sorted(caps, key=lambda c: (c["start"], c["end"]))


def caption_at(caps: list[Caption], f: int) -> int:
    """元動画のフレーム f に出ている字幕の番号（無ければ -1。重なっていれば後に始まったもの）"""
    hit = -1
    for i, c in enumerate(caps):
        if c["start"] <= f < c["end"] and (hit < 0 or c["start"] >= caps[hit]["start"]):
            hit = i
    return hit


def move_caption_edge(caps: list[Caption], i: int, edge: Edge, to: int) -> tuple[list[Caption], int]:
    """字幕 i の頭・終わりを to にする（1 フレーム以上は残す）。並び直した後の、その字幕の番号も返す"""
    c = caps[i]
    if edge == "start":
        new: Caption = {**c, "start": min(max(0, to), c["end"] - 1)}
    else:
        new = {**c, "end": max(to, c["start"] + 1)}
    rest = [x for j, x in enumerate(caps) if j != i]
    out = sort_captions([new, *_cut_overlap(rest, new["start"], new["end"], edge)])
    return out, next(j for j, x in enumerate(out) if x is new)


def _cut_overlap(caps: list[Caption], a: int, b: int, edge: Edge) -> list[Caption]:
    """ほかの字幕から a〜b に重なる所を削る（動かした字幕を優先する）。すっぽり重なった字幕は消す"""
    out: list[Caption] = []
    for x in caps:
        if x["end"] <= a or x["start"] >= b:
            out.append(x)
        elif x["start"] >= a and x["end"] <= b:
            continue  # すっぽり重なった
        elif x["start"] < a and x["end"] > b:
            # 動かした字幕を包んでいる：動かした端の側を削る
            out.append({**x, "end": a} if edge == "start" else {**x, "start": b})
        elif x["start"] < a:
            out.append({**x, "end": a})
        else:
            out.append({**x, "start": b})
    return out


def split_caption(caps: list[Caption], i: int, at: int, pos: int | None = None) -> tuple[list[Caption], int]:
    """字幕 i をフレーム at（含む方が後ろ）で2つに分ける。文字は pos 文字目で分ける（省けば長さの比で）。

    分けられなければ (caps, -1)、分けたら後ろの字幕の番号も返す。
    """
    c = caps[i]
    if at <= c["start"] or at >= c["end"]:
        return caps, -1
    text = c["text"]
    if pos is None:
        pos = round(len(text) * (at - c["start"]) / (c["end"] - c["start"]))
    pos = max(0, min(len(text), pos))
    a: Caption = {**c, "end": at, "text": text[:pos].strip()}
    b: Caption = {**c, "start": at, "text": text[pos:].strip()}
    out = sort_captions([*caps[:i], a, b, *caps[i + 1:]])
    return out, next(j for j, x in enumerate(out) if x is b)


def merge_caption_next(caps: list[Caption], i: int) -> tuple[list[Caption], int]:
    """字幕 i を、元動画の順で次の字幕とつなぐ。つなげなければ (caps, -1)"""
    s = sort_captions(caps)
    j = next(n for n, x in enumerate(s) if x is caps[i])
    if j + 1 >= len(s):
        return caps, -1
    a, b = s[j], s[j + 1]
    m: Caption = {**a, "end": max(a["end"], b["end"]), "text": a["text"] + b["text"]}
    return [*s[:j], m, *s[j + 2:]], j


def add_caption(caps: list[Caption], at: int, length: int, text: str = "") -> tuple[list[Caption], int]:
    """フレーム at から length フレームの字幕を足す（次の字幕の頭より後ろには伸ばさない）。足した字幕の番号も返す"""
    next_start = min((c["start"] for c in caps if c["start"] > at), default=math.inf)
    new: Caption = {"start": at, "end": int(max(at + 1, min(at + length, next_start))), "text": text}
    out = sort_captions([*caps, new])
    return out, next(j for j, x in enumerate(out) if x is new)
