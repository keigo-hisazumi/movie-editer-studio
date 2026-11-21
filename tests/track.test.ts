import { expect, test } from 'vitest';
import { edgeCursor, HEAD_W, TrackView } from '../src/editor/track';

const KEEPS = [
  { start: 100, end: 160 },
  { start: 300, end: 330 },
];

function make(mode: 'short' | 'source' = 'short') {
  const seeks: number[] = [];
  const caps: number[] = [];
  const v = new TrackView(
    (f) => seeks.push(f),
    (i) => caps.push(i),
  );
  v.resize(900, 220);
  const peaks = new Array(400).fill(0);
  for (let f = 300; f < 310; f++) peaks[f] = 255;
  v.setData(mode, 30, KEEPS, [{ start: 100, end: 130, text: 'えっ' }], -1, peaks, [90, 340], 100);
  return { v, seeks, caps };
}

test('横軸と位置', () => {
  const { v, seeks } = make();
  expect(v.axisLen()).toBe(90);
  expect(v.head).toBe(0);
  expect(v.toSrc(60)).toBe(300);
  expect(v.toAxis(305)).toBe(65);
  v.seekX(v.x(65.5));
  expect(seeks.at(-1)).toBe(305);
  v.setData('source', 30, KEEPS, [], -1, [], [90, 340], 305);
  expect(v.axisLen()).toBe(250);
  expect(v.head).toBe(305);
});

test('字幕をクリック', () => {
  const { v, caps } = make();
  expect(v.captionHit(v.x(10))).toBe(0);
  expect(v.captionHit(v.x(50))).toBeNull();
  v.press(v.x(10), v.rows().cap.y + 10);
  expect(caps).toEqual([0]);
});

test('拡大して全体に戻す', () => {
  const { v } = make();
  const fit = v.ppf;
  v.zoomBy(4);
  expect(v.ppf).toBeGreaterThan(fit);
  expect(v.fit).toBe(false);
  v.fitAll();
  expect(v.fit).toBe(true);
  expect(Math.abs(v.ppf - fit)).toBeLessThan(1e-6);
});

test('ショートの波形（元動画の 300〜310 がショートの 60〜70）', () => {
  const { v } = make();
  expect(v.level(65, 66)).toEqual([255, true]);
  expect(v.level(20, 21)).toEqual([0, true]);
  expect(v.x(65)).toBeGreaterThan(HEAD_W);
});

test('ホイールの向きは一般のソフトと逆：奥へ回すと右へ・⌘（Ctrl）＋奥で縮小', () => {
  const { v } = make();
  v.setPpf(12);
  v.left = 5;
  v.syncBar();
  const left = v.left;
  v.wheelBy(0, -120, false, 400); // 奥へ回す（deltaY が負）
  expect(v.left).toBeGreaterThan(left);
  const p = v.ppf;
  v.wheelBy(0, -120, true, 400);
  expect(v.ppf).toBeLessThan(p);
});

test('1 フレームを 8 つに分けた波形（peaks.json の rate 240）を、その細かさで読む', () => {
  const { v } = make();
  const peaks = new Array(400 * 8).fill(0);
  peaks[300 * 8 + 3] = 200; // 元動画の 300 フレームの中ほどだけ大きい
  v.setData('source', 30, KEEPS, [], -1, peaks, [90, 340], 100, false, 8);
  expect(v.level(300, 300.3)).toEqual([0, true]);
  expect(v.level(300.375, 300.5)[0]).toBe(200);
  v.setData('short', 30, KEEPS, [], -1, peaks, [90, 340], 100, false, 8);
  expect(v.level(60.375, 60.5)[0]).toBe(200); // ショートの 60 フレーム = 元動画の 300
});

test('クリップの端のカーソル', () => {
  expect(edgeCursor('start')).toContain('12 12');
  expect(edgeCursor('end')).not.toBe(edgeCursor('start'));
});
