// カットの区間（keeps）と字幕を扱う純粋な処理。movie-editer の shorts/edit.py と同じ数え方
// フレーム番号は元動画のもの（fps は EditDoc.fps、30）。start は含み end は含まない。keeps の並び順がショートの順
import type { EditCaption, FrameRange } from 'movie-editer-schema';

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

// ------------------------------------------------------------ 字幕（元動画のフレームで持つ。並びは元動画の順）

export type Caption = EditCaption;

/** 元動画の順に並べる */
export function sortCaptions(caps: Caption[]): Caption[] {
  return [...caps].sort((a, b) => a.start - b.start || a.end - b.end);
}

/** 元動画のフレーム f に出ている字幕の番号（無ければ -1。重なっていれば後に始まったもの） */
export function captionAt(caps: Caption[], f: number): number {
  let hit = -1;
  caps.forEach((c, i) => {
    if (c.start <= f && f < c.end && (hit < 0 || c.start >= caps[hit].start)) hit = i;
  });
  return hit;
}

/** 字幕 i の頭・終わりを to にする（1 フレーム以上は残す） */
export function moveCaptionEdge(caps: Caption[], i: number, edge: 'start' | 'end', to: number): Caption[] {
  const c = caps[i];
  const next =
    edge === 'start' ? { ...c, start: Math.min(Math.max(0, to), c.end - 1) } : { ...c, end: Math.max(to, c.start + 1) };
  return sortCaptions(caps.map((x, j) => (j === i ? next : x)));
}

/** 字幕 i をフレーム at（含む方が後ろ）で2つに分ける。文字は pos 文字目で分ける（省けば長さの比で） */
export function splitCaption(caps: Caption[], i: number, at: number, pos?: number): Caption[] {
  const c = caps[i];
  if (at <= c.start || at >= c.end) return caps;
  const chars = [...c.text];
  const p = Math.max(0, Math.min(chars.length, pos ?? Math.round((chars.length * (at - c.start)) / (c.end - c.start))));
  const a = { ...c, end: at, text: chars.slice(0, p).join('').trim() };
  const b = { ...c, start: at, text: chars.slice(p).join('').trim() };
  return sortCaptions([...caps.slice(0, i), a, b, ...caps.slice(i + 1)]);
}

/** 字幕 i を、元動画の順で次の字幕とつなぐ */
export function mergeCaptionNext(caps: Caption[], i: number): Caption[] {
  const s = sortCaptions(caps);
  const j = s.indexOf(caps[i]);
  const a = s[j];
  const b = s[j + 1];
  if (!a || !b) return caps;
  const m = { ...a, end: Math.max(a.end, b.end), text: a.text + b.text };
  return [...s.slice(0, j), m, ...s.slice(j + 2)];
}

/** フレーム at から len フレームの字幕を足す（次の字幕の頭より後ろには伸ばさない）。足した字幕の番号も返す */
export function addCaption(caps: Caption[], at: number, len: number, text = ''): { caps: Caption[]; index: number } {
  const nextStart = Math.min(...caps.filter((c) => c.start > at).map((c) => c.start), Infinity);
  const c = { start: at, end: Math.max(at + 1, Math.min(at + len, nextStart)), text };
  const out = sortCaptions([...caps, c]);
  return { caps: out, index: out.indexOf(c) };
}
