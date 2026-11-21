import { expect, test } from 'vitest';
import { buildPlan, locate, startOf } from '../src/lib/plan';

const keeps = [
  { start: 30, end: 60 },
  { start: 60, end: 90 },
  { start: 150, end: 180 },
];

test('並び：いまの区間の残りと後の区間。元動画で隣り合う区間は 1 つに', () => {
  expect(buildPlan(keeps, 30, 45, 'short')).toEqual([
    { s: 1.5, e: 3 },
    { s: 5, e: 6 },
  ]);
  expect(buildPlan(keeps, 30, 100, 'short')).toEqual([]); // 外した所
  expect(buildPlan(keeps, 30, 100, 'source')).toEqual([{ s: 100 / 30, e: Infinity }]);
});

test('並びの頭から何秒め → 区間と元動画の秒', () => {
  const plan = buildPlan(keeps, 30, 30, 'short'); // 1〜3 秒、5〜6 秒
  expect(locate(plan, 0)).toEqual({ k: 0, t: 1 });
  expect(locate(plan, 1.999)?.k).toBe(0);
  expect(locate(plan, 2)).toEqual({ k: 1, t: 5 });
  expect(locate(plan, 2.5)).toEqual({ k: 1, t: 5.5 });
  expect(locate(plan, 3)).toBeNull();
  expect(startOf(plan, 1)).toBe(2);
  expect(startOf(plan, 2)).toBe(3);
});
