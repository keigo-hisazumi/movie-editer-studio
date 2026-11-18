import { describe, expect, test } from 'vitest';
import { clock, frames, timecode } from '../src/lib/fmt';
import {
  addCaption,
  addRange,
  captionAt,
  captionPieces,
  keptFrames,
  mergeAdjacent,
  mergeCaptionNext,
  moveCaptionEdge,
  moveEdge,
  outToSrc,
  removeRange,
  secToFrames,
  splitCaption,
  srcToOut,
  totalFrames,
  type Caption,
} from '../src/lib/timeline';

const r = (start: number, end: number) => ({ start, end });
const K = [r(300, 360), r(600, 630)];

describe('区間（movie-editer の edit.py と同じ数え方）', () => {
  test('ショートと元動画のフレーム', () => {
    expect(totalFrames(K)).toBe(90);
    expect(outToSrc(K, 0)).toBe(300);
    expect(outToSrc(K, 60)).toBe(600);
    expect(outToSrc(K, 999)).toBe(630);
    expect(srcToOut(K, 605)).toBe(65);
    expect(srcToOut(K, 400)).toBeNull();
  });

  test('秒からフレーム（発話を削らないように広げる）', () => {
    expect(secToFrames(10.01, 10.99, 30)).toEqual(r(300, 330));
    expect(secToFrames(10, 11, 30)).toEqual(r(300, 330));
  });

  test('外す・戻す', () => {
    const cut = removeRange(K, r(320, 330));
    expect(cut).toEqual([r(300, 320), r(330, 360), r(600, 630)]);
    expect(addRange(cut, r(320, 330))).toEqual(K); // 戻すと隣とつながる
    expect(addRange(K, r(450, 480))).toEqual([r(300, 360), r(450, 480), r(600, 630)]); // 元動画の順の位置に入る
    expect(addRange(K, r(350, 380))).toEqual([r(300, 380), r(600, 630)]); // 足りない所だけ足す
    expect(keptFrames(K, r(350, 380))).toBe(10);
    expect(addRange([K[1], K[0]], r(360, 370))).toEqual([r(600, 630), r(300, 370)]); // 先出しはそのまま
    expect(mergeAdjacent([r(0, 5), r(5, 9), r(9, 9)])).toEqual([r(0, 9)]);
    expect(K).toEqual([r(300, 360), r(600, 630)]); // 元は書き換えない
  });

  test('端を動かす', () => {
    expect(moveEdge(K, 0, 'start', 310)).toEqual([r(310, 360), K[1]]);
    expect(moveEdge(K, 0, 'end', 600)).toEqual([r(300, 630)]); // 次の区間とつながる
    expect(moveEdge(K, 0, 'start', 999)).toEqual([r(359, 360), K[1]]); // 終わりより後ろにはできない
  });
});

const caps = (): Caption[] => [
  { start: 10, end: 20, text: 'あいうえ' },
  { start: 20, end: 30, text: 'かき' },
  { start: 50, end: 60, text: 'さ' },
];

describe('字幕', () => {
  test('いまの位置の字幕', () => {
    expect(captionAt(caps(), 19)).toBe(0);
    expect(captionAt(caps(), 20)).toBe(1);
    expect(captionAt(caps(), 40)).toBe(-1);
  });

  test('端を動かす（重なった方を削る）', () => {
    let [out, i] = moveCaptionEdge(caps(), 0, 'end', 5);
    expect(out[0]).toEqual({ start: 10, end: 11, text: 'あいうえ' }); // 1 フレームは残す
    expect(i).toBe(0);
    [out, i] = moveCaptionEdge(caps(), 2, 'start', 0);
    expect(out).toEqual([{ start: 0, end: 60, text: 'さ' }]); // すっぽり重なった字幕は消す
    expect(i).toBe(0);
    [out, i] = moveCaptionEdge(caps(), 1, 'start', 15); // 前の字幕の後ろ側に重ねる
    expect(out[0]).toEqual({ start: 10, end: 15, text: 'あいうえ' });
    expect(out[1].start).toBe(15);
    expect(i).toBe(1);
    [out, i] = moveCaptionEdge(caps(), 0, 'end', 25); // 次の字幕の頭側に重ねる
    expect([out[0].end, out[1].start, out[1].text, i]).toEqual([25, 25, 'かき', 0]);
  });

  test('分ける', () => {
    let [out, i] = splitCaption(caps(), 0, 15, 1);
    expect(out.slice(0, 2)).toEqual([
      { start: 10, end: 15, text: 'あ' },
      { start: 15, end: 20, text: 'いうえ' },
    ]);
    expect(i).toBe(1);
    [out] = splitCaption(caps(), 0, 15); // 文字の位置が無ければ長さの比
    expect(out.slice(0, 2).map((c) => c.text)).toEqual(['あい', 'うえ']);
    expect(splitCaption(caps(), 0, 10)).toEqual([caps(), -1]); // 頭では分けない
  });

  test('次とつなぐ', () => {
    const [out, i] = mergeCaptionNext(caps(), 0);
    expect(out.length).toBe(2);
    expect(out[0]).toEqual({ start: 10, end: 30, text: 'あいうえかき' });
    expect(i).toBe(0);
    expect(mergeCaptionNext(caps(), 2)).toEqual([caps(), -1]);
  });

  test('足す', () => {
    let [out, i] = addCaption(caps(), 40, 30, 'た');
    expect(i).toBe(2);
    expect(out[2]).toEqual({ start: 40, end: 50, text: 'た' }); // 次の字幕の頭までに収める
    [out, i] = addCaption(caps(), 70, 30);
    expect(i).toBe(3);
    expect(out[3]).toEqual({ start: 70, end: 100, text: '' });
  });

  test('ショートに出る所', () => {
    const KEEPS = [r(100, 160), r(300, 330)];
    expect(captionPieces(KEEPS, r(90, 120))).toEqual([[0, 20]]);
    expect(captionPieces(KEEPS, r(150, 310))).toEqual([[50, 70]]); // 区間をまたいでもつながる
    expect(captionPieces(KEEPS, r(200, 250))).toEqual([]);
  });
});

test('表示の書き方', () => {
  expect(clock(65.5)).toBe('01:05.500');
  expect(clock(3725.25)).toBe('1:02:05.250');
  expect(frames(367, 30)).toBe('12s+07f');
  expect(timecode(0, 30)).toBe('00:00:00:00');
  expect(timecode(30 * 61 + 7, 30)).toBe('00:01:01:07');
});
