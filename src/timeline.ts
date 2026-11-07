// カットの区間（keeps）と字幕を扱う純粋な処理。movie-editer の shorts/edit.py と同じ数え方
// フレーム番号は元動画のもの（fps は EditDoc.fps、30）。start は含み end は含まない。keeps の並び順がショートの順
import type { FrameRange } from 'movie-editer-schema';

export type Keep = FrameRange;

/** ショートの長さ（フレーム） */
export function totalFrames(keeps: Keep[]): number {
  return keeps.reduce((n, k) => n + (k.end - k.start), 0);
}

/** ショートのフレーム f が元動画のどのフレームか（最後より後は最後の区間の終わり） */
export function outToSrc(keeps: Keep[], f: number): number {
  let off = 0;
  for (const k of keeps) {
    const n = k.end - k.start;
    if (f < off + n) return k.start + f - off;
    off += n;
  }
  return keeps.length ? keeps[keeps.length - 1].end : 0;
}

/** 元動画のフレーム f がショートの何フレーム目か（残す区間に入っていなければ null） */
export function srcToOut(keeps: Keep[], f: number): number | null {
  let off = 0;
  for (const k of keeps) {
    if (k.start <= f && f < k.end) return off + f - k.start;
    off += k.end - k.start;
  }
  return null;
}

/** 元動画のフレーム f を含む区間の番号（無ければ -1） */
export function keepIndexAt(keeps: Keep[], f: number): number {
  return keeps.findIndex((k) => k.start <= f && f < k.end);
}

/** 秒の区間をフレームの区間に（頭は切り捨て、終わりは切り上げ。発話を削らないように） */
export function secToFrames(start: number, end: number, fps: number): Keep {
  return { start: Math.floor(start * fps + 1e-6), end: Math.ceil(end * fps - 1e-6) };
}

/** 区間 r の中で残しているフレームの数 */
export function keptFrames(keeps: Keep[], r: Keep): number {
  let n = 0;
  for (const k of keeps) n += Math.max(0, Math.min(k.end, r.end) - Math.max(k.start, r.start));
  return n;
}

/** 区間 r を外す（区間の途中なら2つに分かれる） */
export function removeRange(keeps: Keep[], r: Keep): Keep[] {
  const out: Keep[] = [];
  for (const k of keeps) {
    if (r.end <= k.start || k.end <= r.start) {
      out.push({ ...k });
      continue;
    }
    if (k.start < r.start) out.push({ start: k.start, end: r.start });
    if (r.end < k.end) out.push({ start: r.end, end: k.end });
  }
  return out;
}

/** 区間 r を残す（戻す）。重なる・隣り合う区間があればつなげ、無ければ元動画の順で入る所に足す */
export function addRange(keeps: Keep[], r: Keep): Keep[] {
  if (r.end <= r.start) return keeps.map((k) => ({ ...k }));
  let rest = [{ ...r }];
  // すでに残している所は除く
  for (const k of keeps) rest = rest.flatMap((x) => removeRange([x], k));
  let out = keeps.map((k) => ({ ...k }));
  for (const x of rest) {
    // 前（x の頭にくっつく区間）・後（x の終わりにくっつく区間）
    const before = out.findIndex((k) => k.end === x.start);
    const after = out.findIndex((k) => k.start === x.end);
    if (before >= 0) {
      out[before].end = x.end;
    } else if (after >= 0) {
      out[after].start = x.start;
    } else {
      // 元動画の順で、x より前で終わる最後の区間の後ろ
      let at = 0;
      out.forEach((k, i) => {
        if (k.end <= x.start) at = i + 1;
      });
      out.splice(at, 0, { ...x });
    }
    out = mergeAdjacent(out);
  }
  return out;
}

/** 並びで隣り合い、元動画でもつながっている区間を1つにする。空の区間は消す */
export function mergeAdjacent(keeps: Keep[]): Keep[] {
  const out: Keep[] = [];
  for (const k of keeps) {
    if (k.end <= k.start) continue;
    const last = out[out.length - 1];
    if (last && last.end === k.start) last.end = k.end;
    else out.push({ ...k });
  }
  return out;
}

/** i 番目の区間の頭（edge が start）か終わり（end）を to にする。前後の区間と重ならないようにする */
export function moveEdge(keeps: Keep[], i: number, edge: 'start' | 'end', to: number): Keep[] {
  const out = keeps.map((k) => ({ ...k }));
  const k = out[i];
  if (!k) return out;
  if (edge === 'start') k.start = Math.max(0, Math.min(to, k.end - 1));
  else k.end = Math.max(k.start + 1, to);
  // 元動画で重なった区間は、動かした方を優先して削る
  return mergeAdjacent(
    out.flatMap((x, j) => (j === i ? [x] : removeRange([x], k))),
  );
}
