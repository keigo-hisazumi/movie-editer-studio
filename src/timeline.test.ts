import { describe, expect, it } from 'vitest';
import {
  addCaption,
  addRange,
  captionAt,
  mergeCaptionNext,
  moveCaptionEdge,
  splitCaption,
  keptFrames,
  mergeAdjacent,
  moveEdge,
  outToSrc,
  removeRange,
  secToFrames,
  srcToOut,
  totalFrames,
} from './timeline';

const K = [
  { start: 300, end: 360 },
  { start: 600, end: 630 },
];

describe('時刻の付け替え（movie-editer の edit.py と同じ）', () => {
  it('ショートと元動画', () => {
    expect(totalFrames(K)).toBe(90);
    expect(outToSrc(K, 0)).toBe(300);
    expect(outToSrc(K, 60)).toBe(600);
    expect(outToSrc(K, 999)).toBe(630);
    expect(srcToOut(K, 605)).toBe(65);
    expect(srcToOut(K, 400)).toBeNull();
  });
  it('秒の区間は発話を削らないように広げる', () => {
    expect(secToFrames(10.01, 10.99, 30)).toEqual({ start: 300, end: 330 });
    expect(secToFrames(10, 11, 30)).toEqual({ start: 300, end: 330 });
  });
});

describe('外す・戻す', () => {
  it('区間の途中を外すと2つに分かれる', () => {
    expect(removeRange(K, { start: 320, end: 330 })).toEqual([
      { start: 300, end: 320 },
      { start: 330, end: 360 },
      { start: 600, end: 630 },
    ]);
  });
  it('戻すと隣とつながる', () => {
    const r = removeRange(K, { start: 320, end: 330 });
    expect(addRange(r, { start: 320, end: 330 })).toEqual(K);
  });
  it('離れた所を戻すと元動画の順の位置に入る', () => {
    expect(addRange(K, { start: 450, end: 480 })).toEqual([
      { start: 300, end: 360 },
      { start: 450, end: 480 },
      { start: 600, end: 630 },
    ]);
  });
  it('一部を残している文を戻すと、足りない所だけ足す', () => {
    expect(addRange(K, { start: 350, end: 380 })).toEqual([
      { start: 300, end: 380 },
      { start: 600, end: 630 },
    ]);
    expect(keptFrames(K, { start: 350, end: 380 })).toBe(10);
  });
  it('並べ替えた区間（先出し）はそのまま', () => {
    const moved = [K[1], K[0]];
    expect(addRange(moved, { start: 360, end: 370 })).toEqual([
      { start: 600, end: 630 },
      { start: 300, end: 370 },
    ]);
  });
  it('つながった区間をまとめる', () => {
    expect(mergeAdjacent([{ start: 0, end: 5 }, { start: 5, end: 9 }, { start: 9, end: 9 }])).toEqual([{ start: 0, end: 9 }]);
  });
});

describe('区間の頭と終わりを動かす', () => {
  it('頭を後ろへ', () => {
    expect(moveEdge(K, 0, 'start', 310)).toEqual([{ start: 310, end: 360 }, K[1]]);
  });
  it('終わりを伸ばして次の区間とつながる', () => {
    expect(moveEdge(K, 0, 'end', 600)).toEqual([{ start: 300, end: 630 }]);
  });
  it('頭を終わりより後ろにはできない', () => {
    expect(moveEdge(K, 0, 'start', 999)).toEqual([{ start: 359, end: 360 }, K[1]]);
  });
});

describe('字幕', () => {
  const caps = () => [
    { start: 10, end: 20, text: 'あいうえ' },
    { start: 20, end: 30, text: 'かき' },
    { start: 50, end: 60, text: 'さ' },
  ];

  it('いまの位置の字幕', () => {
    expect(captionAt(caps(), 19)).toBe(0);
    expect(captionAt(caps(), 20)).toBe(1);
    expect(captionAt(caps(), 40)).toBe(-1);
  });

  it('頭・終わりを動かす（1 フレームは残す・並び直す）', () => {
    expect(moveCaptionEdge(caps(), 0, 'end', 5)[0]).toEqual({ start: 10, end: 11, text: 'あいうえ' });
    const moved = moveCaptionEdge(caps(), 2, 'start', 0);
    expect(moved.map((c) => c.text)).toEqual(['さ', 'あいうえ', 'かき']);
    expect(moved[0]).toEqual({ start: 0, end: 60, text: 'さ' });
  });

  it('分ける（文字は指定の位置、無ければ長さの比）', () => {
    expect(splitCaption(caps(), 0, 15, 1).slice(0, 2)).toEqual([
      { start: 10, end: 15, text: 'あ' },
      { start: 15, end: 20, text: 'いうえ' },
    ]);
    expect(splitCaption(caps(), 0, 15).slice(0, 2).map((c) => c.text)).toEqual(['あい', 'うえ']);
    expect(splitCaption(caps(), 0, 10)).toEqual(caps()); // 頭では分けない
  });

  it('次とつなぐ', () => {
    const m = mergeCaptionNext(caps(), 0);
    expect(m).toHaveLength(2);
    expect(m[0]).toEqual({ start: 10, end: 30, text: 'あいうえかき' });
    expect(mergeCaptionNext(caps(), 2)).toEqual(caps());
  });

  it('足す（次の字幕の頭までに収める）', () => {
    const r = addCaption(caps(), 40, 30, 'た');
    expect(r.index).toBe(2);
    expect(r.caps[2]).toEqual({ start: 40, end: 50, text: 'た' });
    expect(addCaption(caps(), 70, 30).caps[3]).toEqual({ start: 70, end: 100, text: '' });
  });
});
