from studio.fmt import clock, frames
from studio.timeline import (
    add_caption,
    add_range,
    caption_at,
    kept_frames,
    merge_adjacent,
    merge_caption_next,
    move_caption_edge,
    move_edge,
    out_to_src,
    remove_range,
    sec_to_frames,
    split_caption,
    src_to_out,
    total_frames,
)

K = [{"start": 300, "end": 360}, {"start": 600, "end": 630}]


def r(a, b):
    return {"start": a, "end": b}


def test_out_src():  # movie-editer の edit.py と同じ数え方
    assert total_frames(K) == 90
    assert out_to_src(K, 0) == 300
    assert out_to_src(K, 60) == 600
    assert out_to_src(K, 999) == 630
    assert src_to_out(K, 605) == 65
    assert src_to_out(K, 400) is None


def test_sec_to_frames():  # 発話を削らないように広げる
    assert sec_to_frames(10.01, 10.99, 30) == r(300, 330)
    assert sec_to_frames(10, 11, 30) == r(300, 330)


def test_remove_and_add():
    cut = remove_range(K, r(320, 330))
    assert cut == [r(300, 320), r(330, 360), r(600, 630)]
    assert add_range(cut, r(320, 330)) == K  # 戻すと隣とつながる
    assert add_range(K, r(450, 480)) == [r(300, 360), r(450, 480), r(600, 630)]  # 元動画の順の位置に入る
    assert add_range(K, r(350, 380)) == [r(300, 380), r(600, 630)]  # 足りない所だけ足す
    assert kept_frames(K, r(350, 380)) == 10
    assert add_range([K[1], K[0]], r(360, 370)) == [r(600, 630), r(300, 370)]  # 先出しはそのまま
    assert merge_adjacent([r(0, 5), r(5, 9), r(9, 9)]) == [r(0, 9)]
    assert K == [r(300, 360), r(600, 630)]  # 元は書き換えない


def test_move_edge():
    assert move_edge(K, 0, "start", 310) == [r(310, 360), K[1]]
    assert move_edge(K, 0, "end", 600) == [r(300, 630)]  # 次の区間とつながる
    assert move_edge(K, 0, "start", 999) == [r(359, 360), K[1]]  # 終わりより後ろにはできない


def caps():
    return [{"start": 10, "end": 20, "text": "あいうえ"}, {"start": 20, "end": 30, "text": "かき"},
            {"start": 50, "end": 60, "text": "さ"}]


def test_caption_at():
    assert caption_at(caps(), 19) == 0
    assert caption_at(caps(), 20) == 1
    assert caption_at(caps(), 40) == -1


def test_move_caption_edge():
    out, i = move_caption_edge(caps(), 0, "end", 5)
    assert out[0] == {"start": 10, "end": 11, "text": "あいうえ"} and i == 0  # 1 フレームは残す
    out, i = move_caption_edge(caps(), 2, "start", 0)
    assert [c["text"] for c in out] == ["さ", "あいうえ", "かき"] and i == 0  # 並び直す


def test_split_caption():
    out, i = split_caption(caps(), 0, 15, 1)
    assert out[:2] == [{"start": 10, "end": 15, "text": "あ"}, {"start": 15, "end": 20, "text": "いうえ"}] and i == 1
    out, _ = split_caption(caps(), 0, 15)  # 文字の位置が無ければ長さの比
    assert [c["text"] for c in out[:2]] == ["あい", "うえ"]
    assert split_caption(caps(), 0, 10) == (caps(), -1)  # 頭では分けない


def test_merge_caption_next():
    out, i = merge_caption_next(caps(), 0)
    assert len(out) == 2 and out[0] == {"start": 10, "end": 30, "text": "あいうえかき"} and i == 0
    assert merge_caption_next(caps(), 2) == (caps(), -1)


def test_add_caption():
    out, i = add_caption(caps(), 40, 30, "た")
    assert i == 2 and out[2] == {"start": 40, "end": 50, "text": "た"}  # 次の字幕の頭までに収める
    out, i = add_caption(caps(), 70, 30)
    assert i == 3 and out[3] == {"start": 70, "end": 100, "text": ""}


def test_fmt():
    assert clock(65.5) == "01:05.500"
    assert clock(3725.25) == "1:02:05.250"
    assert frames(367, 30) == "12s+07f"
