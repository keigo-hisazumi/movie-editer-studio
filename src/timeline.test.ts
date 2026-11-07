import { describe, expect, it } from 'vitest';
import {
  addRange,
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
