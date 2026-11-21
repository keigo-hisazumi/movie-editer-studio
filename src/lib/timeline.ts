/**
 * カットの区間（keeps）と字幕を扱う純粋な処理。movie-editer の shorts/edit.py と同じ数え方。
 *
 * フレーム番号は元動画のもの（fps は EditDoc の fps、30）。start は含み end は含まない。keeps の並び順がショートの順。
 * 区間・字幕は edit.json と同じ形（{start, end}、字幕は text も）で持ち、元の配列・オブジェクトは書き換えない。
 */

export interface Keep {
  start: number;
  end: number;
}

export interface Caption {
  start: number;
  end: number;
  text: string;
}

export type Edge = 'start' | 'end';

/** ショートの長さ（フレーム） */
export function totalFrames(keeps: Keep[]): number {
  return keeps.reduce((n, k) => n + k.end - k.start, 0);
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
  return keeps.reduce((n, k) => n + Math.max(0, Math.min(k.end, r.end) - Math.max(k.start, r.start)), 0);
}

/** 区間 r を外す（区間の途中なら2つに分かれる） */
export function removeRange(keeps: Keep[], r: Keep): Keep[] {
  const out: Keep[] = [];
  for (const k of keeps) {
    if (r.end <= k.start || k.end <= r.start) {
      out.push({ start: k.start, end: k.end });
      continue;
    }
    if (k.start < r.start) out.push({ start: k.start, end: r.start });
    if (r.end < k.end) out.push({ start: r.end, end: k.end });
  }
  return out;
}

/** 並びで隣り合い、元動画でもつながっている区間を1つにする。空の区間は消す */
export function mergeAdjacent(keeps: Keep[]): Keep[] {
  const out: Keep[] = [];
  for (const k of keeps) {
    if (k.end <= k.start) continue;
    const last = out[out.length - 1];
    if (last && last.end === k.start) out[out.length - 1] = { start: last.start, end: k.end };
    else out.push({ start: k.start, end: k.end });
  }
  return out;
}

/** 区間 r を残す（戻す）。重なる・隣り合う区間があればつなげ、無ければ元動画の順で入る所に足す */
export function addRange(keeps: Keep[], r: Keep): Keep[] {
  let out = keeps.map((k) => ({ start: k.start, end: k.end }));
  if (r.end <= r.start) return out;
  let rest: Keep[] = [{ start: r.start, end: r.end }];
  for (const k of keeps) rest = rest.flatMap((x) => removeRange([x], k)); // すでに残している所は除く
  for (const x of rest) {
    const before = out.findIndex((k) => k.end === x.start);
    const after = out.findIndex((k) => k.start === x.end);
    if (before >= 0) out[before].end = x.end;
    else if (after >= 0) out[after].start = x.start;
    else {
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

/** i 番目の区間の頭（start）か終わり（end）を to にする。元動画で重なった区間は、動かした方を優先して削る */
export function moveEdge(keeps: Keep[], i: number, edge: Edge, to: number): Keep[] {
  const out = keeps.map((k) => ({ start: k.start, end: k.end }));
  if (i < 0 || i >= out.length) return out;
  const k = out[i];
  if (edge === 'start') k.start = Math.max(0, Math.min(to, k.end - 1));
  else k.end = Math.max(k.start + 1, to);
  return mergeAdjacent(out.flatMap((x, j) => (j === i ? [x] : removeRange([x], k))));
}

// ---------------------------------------------------------------- 字幕（元動画のフレームで持つ。並びは元動画の順）

/** 元動画の順に並べる（元の配列は書き換えない） */
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

/** 字幕 i の頭・終わりを to にする（1 フレーム以上は残す）。並び直した後の、その字幕の番号も返す */
export function moveCaptionEdge(caps: Caption[], i: number, edge: Edge, to: number): [Caption[], number] {
  const c = caps[i];
  const moved: Caption =
    edge === 'start' ? { ...c, start: Math.min(Math.max(0, to), c.end - 1) } : { ...c, end: Math.max(to, c.start + 1) };
  const rest = caps.filter((_, j) => j !== i);
  const out = sortCaptions([moved, ...cutOverlap(rest, moved.start, moved.end, edge)]);
  return [out, out.indexOf(moved)];
}

/** ほかの字幕から a〜b に重なる所を削る（動かした字幕を優先する）。すっぽり重なった字幕は消す */
function cutOverlap(caps: Caption[], a: number, b: number, edge: Edge): Caption[] {
  const out: Caption[] = [];
  for (const x of caps) {
    if (x.end <= a || x.start >= b) out.push(x);
    else if (x.start >= a && x.end <= b) continue; // すっぽり重なった
    else if (x.start < a && x.end > b) {
      // 動かした字幕を包んでいる：動かした端の側を削る
      out.push(edge === 'start' ? { ...x, end: a } : { ...x, start: b });
    } else if (x.start < a) out.push({ ...x, end: a });
    else out.push({ ...x, start: b });
  }
  return out;
}

/** 文字列を文字（コードポイント）の配列に（絵文字などのサロゲートペアを分けない） */
const chars = (s: string): string[] => Array.from(s);

/**
 * 字幕 i をフレーム at（含む方が後ろ）で2つに分ける。文字は pos 文字目で分ける（省けば長さの比で）。
 * 分けられなければ [caps, -1]、分けたら後ろの字幕の番号も返す。
 */
export function splitCaption(caps: Caption[], i: number, at: number, pos: number | null = null): [Caption[], number] {
  const c = caps[i];
  if (at <= c.start || at >= c.end) return [caps, -1];
  const text = chars(c.text);
  let p = pos ?? pyRound((text.length * (at - c.start)) / (c.end - c.start));
  p = Math.max(0, Math.min(text.length, p));
  const a: Caption = { ...c, end: at, text: text.slice(0, p).join('').trim() };
  const b: Caption = { ...c, start: at, text: text.slice(p).join('').trim() };
  const out = sortCaptions([...caps.slice(0, i), a, b, ...caps.slice(i + 1)]);
  return [out, out.indexOf(b)];
}

/** 字幕 i を、元動画の順で次の字幕とつなぐ。つなげなければ [caps, -1] */
export function mergeCaptionNext(caps: Caption[], i: number): [Caption[], number] {
  const s = sortCaptions(caps);
  const j = s.indexOf(caps[i]);
  if (j + 1 >= s.length) return [caps, -1];
  const [a, b] = [s[j], s[j + 1]];
  const m: Caption = { ...a, end: Math.max(a.end, b.end), text: a.text + b.text };
  return [[...s.slice(0, j), m, ...s.slice(j + 2)], j];
}

/** フレーム at から length フレームの字幕を足す（次の字幕の頭より後ろには伸ばさない）。足した字幕の番号も返す */
export function addCaption(caps: Caption[], at: number, length: number, text = ''): [Caption[], number] {
  const nextStart = Math.min(Infinity, ...caps.filter((c) => c.start > at).map((c) => c.start));
  const added: Caption = { start: at, end: Math.max(at + 1, Math.min(at + length, nextStart)), text };
  const out = sortCaptions([...caps, added]);
  return [out, out.indexOf(added)];
}

/** 字幕がショートに出る所（ショートのフレーム、start 含む・end 含まない）。つながる所は1つにまとめる */
export function captionPieces(keeps: Keep[], c: Keep): [number, number][] {
  const out: [number, number][] = [];
  let off = 0;
  for (const k of keeps) {
    const a = Math.max(c.start, k.start);
    const b = Math.min(c.end, k.end);
    if (a < b) {
      const s = off + a - k.start;
      const e = off + b - k.start;
      const last = out[out.length - 1];
      if (last && last[1] === s) last[1] = e;
      else out.push([s, e]);
    }
    off += k.end - k.start;
  }
  return out;
}

/** Python の round と同じ（.5 は偶数へ）。Python 版と同じ所で字幕の文字を分けるため */
export function pyRound(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}
