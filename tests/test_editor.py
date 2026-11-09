import copy

from PySide6.QtCore import QEvent, Qt
from PySide6.QtGui import QKeyEvent

from studio.api import Api
from studio.editor import Editor

from .conftest import TOPIC


def make(qapp, base="http://127.0.0.1:9"):
    e = Editor(Api(base), "20261017", 2, copy.deepcopy(TOPIC), {"fps": 30, "peaks": [100] * 900})
    e.resize(1200, 800)
    e.show()
    return e


def press(e, key, mods=Qt.KeyboardModifier.NoModifier):
    return e.key(QKeyEvent(QEvent.Type.KeyPress, key, mods))


def test_cut_toggle_and_undo(qapp):
    e = make(qapp)
    assert e.segs.rowCount() == 3 and e.segs.item(0, 1).text() == "残す" and e.segs.item(1, 1).text() == "外す"
    e._click_seg(1, 0)
    assert press(e, Qt.Key.Key_X)  # 外した文を戻す
    assert e.keeps == [{"start": 300, "end": 360}, {"start": 450, "end": 480}, {"start": 600, "end": 630}]
    assert e.dirty and "未保存" in e.rev.text()
    e.do_undo()
    assert e.keeps == TOPIC["edit"]["keeps"] and not e.dirty
    e.destroy_editor()


def test_step_and_edges(qapp):
    e = make(qapp)
    assert e.src == 300
    press(e, Qt.Key.Key_Left)
    assert e.src == 300  # ショートの頭より前には行かない
    press(e, Qt.Key.Key_Right, Qt.KeyboardModifier.ShiftModifier)
    assert e.src == 310
    press(e, Qt.Key.Key_BracketLeft)  # いまの位置を区間の頭に
    assert e.keeps[0] == {"start": 310, "end": 360}
    e.seek(355)
    press(e, Qt.Key.Key_Right, Qt.KeyboardModifier.ShiftModifier)  # ショートでは次の区間へ飛ぶ
    assert e.src == 605
    press(e, Qt.Key.Key_Tab)
    assert e.mode == "source"
    e.destroy_editor()


def test_captions(qapp):
    e = make(qapp)
    e.tabs.setCurrentIndex(1)
    assert e.caps.rowCount() == 2
    e._click_cap(0, 1)
    e.seek(310)
    e.caret = (0, 2)
    press(e, Qt.Key.Key_Slash)  # カーソルの位置で分ける
    assert [c["text"] for c in e.captions[:2]] == ["えっ", "待って"] and e.captions[1]["start"] == 310
    e.cap = -1
    e.seek(340)
    press(e, Qt.Key.Key_N)  # 字幕の無い所に足す
    assert e.captions[2]["start"] == 340 and e.captions[2]["end"] == 370
    press(e, Qt.Key.Key_Delete)
    assert len(e.captions) == 3
    e.caps.item(1, 1).setText("待ってよ")  # 文字を直す
    assert e.captions[1]["text"] == "待ってよ" and e.caps.item(1, 2).text() == "4"
    assert e.view.text == ""  # 340 には字幕が無い
    e.seek(315)
    assert e.view.text == "待ってよ"
    e.destroy_editor()


def test_save(qapp, serve):
    base, fake = serve
    e = make(qapp, base)
    e.tabs.setCurrentIndex(1)
    e.caps.item(0, 1).setText("えっ待ってよ")
    assert e.save(note="字幕だけ")
    body = fake.saved[0]
    assert body["base_revision"] == 1
    doc = body["doc"]
    assert doc["by"] == "human" and doc["step"] == "captions" and doc["note"] == "字幕だけ"
    assert doc["captions"][0]["text"] == "えっ待ってよ"
    assert e.base == 2 and not e.dirty
    e.tabs.setCurrentIndex(0)
    e._click_seg(1, 0)
    press(e, Qt.Key.Key_X)
    assert e.save(note="")
    assert fake.saved[1]["doc"]["step"] == "cut" and "note" not in fake.saved[1]["doc"]
    e.destroy_editor()


def test_save_rejects_bad_doc(qapp, serve, monkeypatch):
    base, fake = serve
    e = make(qapp, base)
    shown = []
    monkeypatch.setattr("studio.editor.QMessageBox.warning", lambda *a: shown.append(a[2]))
    e.doc["fps"] = "30"  # 形が違う（schema で止める）
    e.dirty = True
    assert not e.save(note="")
    assert not fake.saved and "fps" in shown[0]
    e.destroy_editor()


def test_save_button(qapp, serve, monkeypatch):
    """保存ボタンを押すと、メモを聞いてから保存する（clicked の bool をメモにしない）"""
    from studio import editor as ed

    base, fake = serve
    e = make(qapp, base)
    monkeypatch.setattr(ed.QInputDialog, "getText", lambda *a, **k: ("ボタンで保存", True))
    e._click_seg(1, 0)
    press(e, Qt.Key.Key_X)
    e.save_btn.click()
    assert fake.saved and fake.saved[0]["doc"]["note"] == "ボタンで保存"
    e.destroy_editor()
