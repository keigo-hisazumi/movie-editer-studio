/**
 * 再生の並び（元動画の秒の区間を、再生する順に並べたもの）。編集ソフトのように、区間の切れ目を止まらずにつなぐために、
 * 再生を始めるときに並び全体を Player に渡す（音はこの並びどおりに Web Audio で前もって鳴らす時刻を決めておく）
 */
import { keepIndexAt, type Keep } from './timeline';

/** 元動画の s 秒から e 秒まで（e は含まない） */
export interface Seg {
  s: number;
  e: number;
}

/**
 * 元動画のフレーム src から再生する並び。
 * ショートの表示（short）は src の区間の残りと、その後の区間を並びの順に（元動画で隣り合う区間は 1 つにまとめる）。
 * 元動画の表示（source）は src から最後まで（e は Infinity）。src が外した所なら空
 */
export function buildPlan(keeps: Keep[], fps: number, src: number, mode: 'short' | 'source'): Seg[] {
  if (mode === 'source') return [{ s: src / fps, e: Infinity }];
  const i = keepIndexAt(keeps, src);
  if (i < 0) return [];
  const frames: [number, number][] = [[src, keeps[i].end]];
  for (const k of keeps.slice(i + 1)) {
    const last = frames[frames.length - 1];
    if (k.start === last[1]) last[1] = k.end;
    else frames.push([k.start, k.end]);
  }
  return frames.filter(([a, b]) => b > a).map(([a, b]) => ({ s: a / fps, e: b / fps }));
}

/** 並びの頭から何秒の所か → 何番めの区間の、元動画の何秒か。並びの終わりを過ぎたら null */
export function locate(plan: Seg[], elapsed: number): { k: number; t: number } | null {
  let off = 0;
  for (let k = 0; k < plan.length; k++) {
    const len = plan[k].e - plan[k].s;
    if (elapsed < off + len) return { k, t: plan[k].s + Math.max(0, elapsed - off) };
    off += len;
  }
  return null;
}

/** 区間 k が並びの頭から何秒めに始まるか */
export function startOf(plan: Seg[], k: number): number {
  let off = 0;
  for (let i = 0; i < k && i < plan.length; i++) off += plan[i].e - plan[i].s;
  return off;
}
