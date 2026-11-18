/** 表示用の小さな関数 */

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** 秒を "MM:SS.mmm"（1 時間以上なら "H:MM:SS.mmm"） */
export function clock(sec: number): string {
  let ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  ms %= 3_600_000;
  const m = Math.floor(ms / 60_000);
  ms %= 60_000;
  const s = Math.floor(ms / 1000);
  ms %= 1000;
  return h ? `${h}:${pad(m)}:${pad(s)}.${pad(ms, 3)}` : `${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

/** フレーム数を "秒+フレーム"（例 12s+07f） */
export function frames(f: number, fps: number): string {
  const s = Math.floor(f / fps);
  return `${s}s+${pad(Math.round(f - s * fps))}f`;
}

/** フレーム数を "HH:MM:SS:FF"（Filmora・Premiere と同じ書き方） */
export function timecode(f: number, fps: number): string {
  f = Math.max(0, Math.trunc(f));
  const per = Math.max(1, Math.round(fps));
  const ff = f % per;
  let s = Math.floor(f / per);
  const h = Math.floor(s / 3600);
  s %= 3600;
  const m = Math.floor(s / 60);
  s %= 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(ff)}`;
}

/** HTML に入れる文字を逃がす */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
