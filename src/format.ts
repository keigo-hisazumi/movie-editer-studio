// 表示用の小さな関数

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** 秒を "MM:SS.mmm"（1 時間以上なら "H:MM:SS.mmm"） */
export function clock(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  const mm = String(m).padStart(2, '0');
  const ss = `${String(s).padStart(2, '0')}.${String(r).padStart(3, '0')}`;
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** フレーム数を "秒+フレーム"（例 12s+07f） */
export function frames(f: number, fps: number): string {
  const s = Math.floor(f / fps);
  return `${s}s+${String(Math.round(f - s * fps)).padStart(2, '0')}f`;
}
