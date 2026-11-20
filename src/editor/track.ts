/**
 * 下のタイムライン：目盛り・字幕・映像（残す区間）・音声（波形）のトラックと、いまの位置。
 *
 * 動画編集ソフト（Filmora・Premiere）と同じく、左から右へ時間が流れ、拡大・スクロールできる。
 * - ショートの表示：横軸はショートの時間（残す区間をつなげたもの）。区間の切れ目に縦の線
 * - 元動画の表示：横軸は元動画の時間（トピックの区間）。外した所は暗く
 * クリック・ドラッグでその位置へ動き、字幕をクリックするとその字幕を選ぶ。字幕・映像・音声のクリップの端をドラッグすると長さを変える。
 * クリップをダブルクリックで選び、Delete で消す。
 * ホイールで横にスクロール、⌘（Ctrl）＋ホイール・下のつまみ・T（拡大）R（縮小）で拡大・縮小（ホイールの向きは一般のソフトと逆）。
 */
import { timecode } from '../lib/fmt';
import * as tl from '../lib/timeline';
import type { Caption, Edge, Keep } from '../lib/timeline';

export const HEAD_W = 34; // 左のトラック名の幅
export const RULER_H = 26;
const CAP_H = 34;
const VIDEO_H = 30;
const AUDIO_H = 64;
const GAP = 4;
const EDGE_PX = 5; // クリップの端をつかめる幅（ピクセル）
const MAX_PX_PER_FRAME = 12.0; // いちばん拡大したとき（1 フレームの幅）

const C = {
  bg: '#1b1c1f',
  track: '#232428',
  head: '#26272b',
  line: '#3a3b40',
  text: '#c9cbd1',
  muted: '#7d8088',
  cap: '#177a8f',
  capSel: '#1d93ab',
  capOut: 'rgb(70,72,78)',
  video: '#3d5a9e',
  audio: '#1f5e45',
  wave: '#5fd39a',
  waveOut: '#5b5e66',
};

export type Mode = 'short' | 'source';
export type ClipKind = 'keep' | 'cap';
export type Clip = [ClipKind, number];
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
type Block = [number, number, string, boolean, number]; // 軸の start・end、文字、ショートに残るか、字幕の番号

const contains = (r: Rect, x: number, y: number): boolean => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

/** クリップの端のカーソル：頭は [、終わりは ]（どちらのクリップを動かすかが分かるように） */
export function edgeCursor(edge: Edge): string {
  const side = edge === 'start' ? 1 : -1; // 横の棒が出る向き（頭なら右、終わりなら左）
  const h = 12;
  const bracket = `M${h + side * 6} 3 L${h} 3 L${h} 21 L${h + side * 6} 21`;
  const arrow = [-1, 1].map((d) => `M${h + d * 3} 12 L${h + d * 9} 12 M${h + d * 9} 12 L${h + d * 6} 9 M${h + d * 9} 12 L${h + d * 6} 15`).join(' ');
  const path = `${bracket} ${arrow}`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" stroke-linecap="round">` +
    `<path d="${path}" stroke="black" stroke-width="4"/><path d="${path}" stroke="white" stroke-width="2"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, ew-resize`;
}

export type TrimFn = (kind: ClipKind, i: number, edge: Edge, delta: number, commit: boolean) => void;

export class TrackView {
  readonly el: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  /** いまの位置の線（canvas に描かず、CSS の transform で動かす。再生中に canvas を描き直さないように） */
  private readonly playhead: HTMLElement;
  private readonly bar: HTMLInputElement;
  private readonly slider: HTMLInputElement;

  onCaptionEdit: ((i: number) => void) | null = null; // 字幕をダブルクリックした
  trimming = false;
  selClip: Clip | null = null; // ダブルクリックで選んだクリップ
  mode: Mode = 'short';
  fps = 30;
  keeps: Keep[] = [];
  captions: Caption[] = [];
  selected = -1;
  peaks: number[] = [];
  range: [number, number] = [0, 1]; // 元動画の表示の横軸（トピックの区間）
  src = 0;
  head = 0; // 軸のフレーム
  ppf = 1; // 1 フレームの幅（ピクセル）
  left = 0; // 左端の軸のフレーム
  fit = true; // 全体が収まる拡大率のまま（大きさが変わったら合わせ直す）
  follow = true;
  spf = 1;
  blocks: Block[] = [];
  private waveKey = '';
  private outPeaks: number[] = [];
  private w = 0;
  private h = 0;
  private trim: [ClipKind, number, Edge, number] | null = null; // 端をドラッグ中（種類・番号・端・押した x）
  private drag = false;
  private paintedKey = '';
  /** 描く中身（区間・字幕・波形・選択）が変わるたびに増やす（描き直すかどうかの判定に使う） */
  private version = 0;
  private frame = 0;
  private syncing = false;

  constructor(
    private readonly onSeek: (f: number) => void,
    private readonly onCaption: (i: number) => void,
    private readonly onTrim: TrimFn | null = null,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'track';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'track-canvas';
    this.playhead = document.createElement('div');
    this.playhead.className = 'playhead';
    const heads = document.createElement('div');
    heads.className = 'track-heads';
    heads.style.left = `${HEAD_W}px`;
    heads.append(this.playhead);
    const area = document.createElement('div');
    area.className = 'track-area';
    area.append(this.canvas, heads);
    const row = document.createElement('div');
    row.className = 'track-ctl';
    this.bar = Object.assign(document.createElement('input'), { type: 'range', className: 'track-bar', min: '0', max: '0', step: 'any' });
    this.slider = Object.assign(document.createElement('input'), { type: 'range', className: 'track-zoom', min: '0', max: '1000', step: '1' });
    const btn = (label: string, title: string, fn: () => void): HTMLButtonElement => {
      const b = Object.assign(document.createElement('button'), { textContent: label, title, tabIndex: -1 });
      b.addEventListener('click', fn);
      return b;
    };
    row.append(
      this.bar,
      btn('全体', '全体を表示（Shift+Z）', () => this.fitAll()),
      btn('−', '縮小（R）', () => this.zoomBy(0.8)),
      this.slider,
      btn('＋', '拡大（T）', () => this.zoomBy(1.25)),
    );
    for (const w of [this.bar, this.slider]) w.tabIndex = -1;
    this.bar.addEventListener('input', () => this.scrolled(Number(this.bar.value)));
    this.slider.addEventListener('input', () => this.slid(Number(this.slider.value)));
    this.el.append(area, row);

    this.canvas.addEventListener('mousedown', (e) => this.mouseDown(e));
    this.canvas.addEventListener('dblclick', (e) => this.doubleClick(this.pos(e)));
    this.canvas.addEventListener('mousemove', (e) => this.hover(e));
    window.addEventListener('mousemove', this.onWindowMove);
    window.addEventListener('mouseup', this.onWindowUp);
    this.canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this.resize(this.canvas.clientWidth, this.canvas.clientHeight)).observe(this.canvas);
    }
  }

  destroy(): void {
    window.removeEventListener('mousemove', this.onWindowMove);
    window.removeEventListener('mouseup', this.onWindowUp);
    cancelAnimationFrame(this.frame);
  }

  /** 描く大きさ（CSS のピクセル）。画面の大きさが変わったときと、テストで呼ぶ */
  resize(w: number, h: number): void {
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.relayout();
  }

  get width(): number {
    return this.w;
  }

  // ---------------------------------------------------------------- データ

  /** spf：波形の 1 フレームあたりの数（peaks.json の rate / fps。前の 1 フレームごとの波形なら 1） */
  setData(
    mode: Mode,
    fps: number,
    keeps: Keep[],
    captions: Caption[],
    selected: number,
    peaks: number[],
    rng: [number, number],
    src: number,
    playing = false,
    spf = 1,
  ): void {
    if (
      mode === this.mode &&
      fps === this.fps &&
      keeps === this.keeps &&
      captions === this.captions &&
      selected === this.selected &&
      peaks === this.peaks &&
      Math.max(1e-6, spf) === this.spf &&
      rng[0] === this.range[0] &&
      Math.max(rng[1], rng[0] + 1) === this.range[1]
    ) {
      // 位置だけが変わった（再生中はここを毎コマ通る）：線を動かすだけで、区間・字幕・波形は作り直さない
      this.src = src;
      this.head = this.toAxis(src);
      if (!this.trimming && (playing || this.follow)) this.keepHeadVisible(playing);
      this.update();
      return;
    }
    this.version += 1;
    const changedAxis =
      mode !== this.mode || rng[0] !== this.range[0] || rng[1] !== this.range[1] || tl.totalFrames(keeps) !== tl.totalFrames(this.keeps);
    this.mode = mode;
    this.fps = fps;
    this.keeps = keeps;
    this.captions = captions;
    this.selected = selected;
    if (peaks !== this.peaks) this.waveKey = '';
    this.peaks = peaks;
    this.range = [rng[0], Math.max(rng[1], rng[0] + 1)];
    this.src = src;
    this.spf = Math.max(1e-6, spf);
    const key = `${mode}|${keeps.map((k) => `${k.start}-${k.end}`).join(',')}|${peaks.length}|${this.spf}`;
    if (key !== this.waveKey) {
      // ショートの時間ごとの音量（再生中に毎回計算しないように）
      this.waveKey = key;
      this.outPeaks = mode === 'short' ? this.makeOutPeaks() : [];
    }
    this.blocks = this.makeBlocks();
    this.head = this.toAxis(src);
    if (this.trimming) {
      // 端をドラッグ中は、見ている範囲を動かさない
      this.update();
      return;
    }
    if (changedAxis && this.fit) this.fitAll(false);
    this.syncBar();
    if (playing || this.follow) this.keepHeadVisible(playing);
    this.update();
  }

  axisLen(): number {
    return this.mode === 'short' ? Math.max(1, tl.totalFrames(this.keeps)) : this.range[1] - this.range[0];
  }

  axisStart(): number {
    return this.mode === 'short' ? 0 : this.range[0];
  }

  toAxis(src: number): number {
    if (this.mode === 'source') return src;
    const out = tl.srcToOut(this.keeps, src);
    if (out !== null) return out;
    let off = 0; // 外した所なら、次に残る所
    for (const k of this.keeps) {
      if (src < k.start) return off;
      off += k.end - k.start;
    }
    return off;
  }

  toSrc(f: number): number {
    f = Math.floor(f);
    if (this.mode === 'source') return Math.max(0, f);
    const total = tl.totalFrames(this.keeps);
    if (total <= 0) return 0;
    return tl.outToSrc(this.keeps, Math.max(0, Math.min(total - 1, f)));
  }

  /** 映像・音声のクリップ（軸のフレーム） */
  clipRanges(): [number, number][] {
    if (this.mode === 'source') return this.keeps.map((k) => [k.start, k.end]);
    const out: [number, number][] = [];
    let off = 0;
    for (const k of this.keeps) {
      const n = k.end - k.start;
      out.push([off, off + n]);
      off += n;
    }
    return out;
  }

  cutPoints(): number[] {
    return this.clipRanges()
      .slice(0, -1)
      .map(([, b]) => b);
  }

  private makeBlocks(): Block[] {
    const out: Block[] = [];
    this.captions.forEach((c, i) => {
      if (this.mode === 'source') out.push([c.start, c.end, c.text, tl.keptFrames(this.keeps, c) > 0, i]);
      else for (const [a, b] of tl.captionPieces(this.keeps, c)) out.push([a, b, c.text, true, i]);
    });
    return out;
  }

  selectClip(clip: Clip | null): void {
    if (clip?.[0] !== this.selClip?.[0] || clip?.[1] !== this.selClip?.[1]) {
      this.selClip = clip;
      this.version += 1;
      this.update();
    }
  }

  captionHit(x: number): number | null {
    const f = this.left + (x - HEAD_W) / this.ppf;
    const b = this.blocks.find(([a, bb]) => a <= f && f < bb);
    return b ? b[4] : null;
  }

  /**
   * 軸の f0〜f1（フレーム）の音量の最大（0〜255）と、ショートに残る所か。
   * 波形は 1 フレームを spf 個に分けた細かさ（movie-editer の peaks.json の rate / fps）で持つ
   */
  level(f0: number, f1: number): [number, boolean] {
    const a = Math.floor(f0 * this.spf);
    const b = Math.max(a + 1, Math.floor(f1 * this.spf));
    const src = this.mode === 'source' ? this.peaks : this.outPeaks;
    let v = 0;
    for (let i = Math.max(0, a); i < Math.min(src.length, b); i++) if (src[i] > v) v = src[i];
    const kept = this.mode !== 'source' || tl.keepIndexAt(this.keeps, Math.floor(f0)) >= 0;
    return [v, kept];
  }

  /** ショートの順につなげた波形（残す区間ごとに、元動画の波形を切り出す） */
  private makeOutPeaks(): number[] {
    const n = this.peaks.length;
    const out: number[] = [];
    for (const k of this.keeps) {
      const a = Math.round(k.start * this.spf);
      const b = Math.round(k.end * this.spf);
      const lo = Math.max(0, a);
      const hi = Math.max(lo, Math.min(n, b));
      for (let i = lo; i < hi; i++) out.push(this.peaks[i]);
      for (let i = hi - lo; i < b - a; i++) out.push(0);
    }
    return out;
  }

  // ---------------------------------------------------------------- 位置と拡大

  x(f: number): number {
    return HEAD_W + (f - this.left) * this.ppf;
  }

  viewW(): number {
    return Math.max(1, this.w - HEAD_W);
  }

  minPpf(): number {
    return this.viewW() / (this.axisLen() * 1.02);
  }

  private maxPpf(): number {
    return Math.max(MAX_PX_PER_FRAME, this.minPpf());
  }

  private ppfFromSlider(v: number): number {
    const lo = Math.log(this.minPpf());
    const hi = Math.log(this.maxPpf());
    return Math.exp(lo + ((hi - lo) * v) / 1000);
  }

  private sliderFromPpf(p: number): number {
    const lo = Math.log(this.minPpf());
    const hi = Math.log(this.maxPpf());
    return hi <= lo ? 0 : Math.round(((Math.log(p) - lo) / (hi - lo)) * 1000);
  }

  fitAll(update = true): void {
    this.fit = true;
    this.ppf = this.minPpf();
    this.left = this.axisStart() - this.axisLen() * 0.01;
    this.syncBar();
    if (update) this.update();
  }

  zoomBy(k: number, atX: number | null = null): void {
    this.setPpf(this.ppf * k, atX);
  }

  setPpf(p: number, atX: number | null = null): void {
    p = Math.max(this.minPpf(), Math.min(this.maxPpf(), p));
    // 拡大の中心：指定が無ければいまの位置（見えていれば）、見えていなければ真ん中
    if (atX === null) {
      const hx = this.x(this.head);
      atX = hx >= HEAD_W && hx <= this.w ? hx : HEAD_W + this.viewW() / 2;
    }
    const f = this.left + (atX - HEAD_W) / this.ppf;
    this.ppf = p;
    this.left = f - (atX - HEAD_W) / p;
    this.fit = p <= this.minPpf() * 1.0001;
    this.syncBar();
    this.update();
  }

  scrollBy(frames: number): void {
    this.left += frames;
    this.follow = false;
    this.syncBar();
    this.update();
  }

  seekX(x: number): void {
    let f = this.left + (x - HEAD_W) / this.ppf;
    const lo = this.axisStart();
    f = Math.max(lo, Math.min(lo + this.axisLen() - 1, f));
    this.follow = true;
    this.onSeek(this.toSrc(f));
  }

  /** 見ている範囲をタイムラインの左端に（頭へ戻るとき。いまの位置の線も左端に出る） */
  scrollToStart(): void {
    this.left = this.axisStart() - this.axisLen();
    this.follow = true;
    this.syncBar(); // 左端（少しの余白）にそろえる
    this.update();
  }

  private keepHeadVisible(playing: boolean): void {
    const vis = this.viewW() / this.ppf;
    if (this.head < this.left || this.head > this.left + vis) {
      // 再生中はページ送り（いまの位置を左寄りに）、止めているときは真ん中に
      this.left = this.head - vis * (playing ? 0.1 : 0.5);
      this.syncBar();
    }
  }

  syncBar(): void {
    const vis = this.viewW() / this.ppf;
    const lo = this.axisStart() - this.axisLen() * 0.01;
    const hi = this.axisStart() + this.axisLen() * 1.01 - vis;
    this.left = Math.max(lo, Math.min(Math.max(lo, hi), this.left));
    this.syncing = true;
    this.bar.max = String(Math.max(0, hi - lo));
    this.bar.value = String(this.left - lo);
    this.bar.disabled = hi <= lo;
    this.slider.value = String(this.sliderFromPpf(this.ppf));
    this.syncing = false;
  }

  private scrolled(v: number): void {
    if (this.syncing) return;
    this.left = this.axisStart() - this.axisLen() * 0.01 + v;
    this.follow = false;
    this.update();
  }

  private slid(v: number): void {
    if (this.syncing) return;
    this.setPpf(this.ppfFromSlider(v));
  }

  relayout(): void {
    if (this.fit) this.fitAll(false);
    else {
      this.ppf = Math.max(this.ppf, this.minPpf());
      this.syncBar();
    }
    this.update();
  }

  // ---------------------------------------------------------------- 行の位置と描画

  rows(): Record<'cap' | 'video' | 'audio', Rect> {
    const w = this.w - HEAD_W;
    let y = RULER_H + GAP;
    const out = {} as Record<'cap' | 'video' | 'audio', Rect>;
    for (const [name, h0] of [
      ['cap', CAP_H],
      ['video', VIDEO_H],
      ['audio', AUDIO_H],
    ] as const) {
      const h = name === 'audio' ? Math.max(AUDIO_H, this.h - y - GAP) : h0; // 音声は残りの高さいっぱい（波形を大きく見せる）
      out[name] = { x: HEAD_W, y, w, h };
      y += h + GAP;
    }
    return out;
  }

  /** 次のコマで描き直す（何度呼んでも 1 回）。いまの位置の線はすぐ動かす */
  update(): void {
    this.placeHead();
    if (this.frame || typeof requestAnimationFrame === 'undefined') return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  /** いまの位置の線を動かす（DOM の transform だけ。描き直さない） */
  private placeHead(): void {
    const x = this.x(this.head) - HEAD_W;
    const visible = x >= -8 && x <= this.w - HEAD_W + 8;
    if (this.playhead.hidden === visible) this.playhead.hidden = !visible;
    if (visible) this.playhead.style.transform = `translateX(${x.toFixed(2)}px)`;
  }

  /** トラックを描く。見ている範囲・中身が変わったときだけ（再生中に毎回描くと重い） */
  paint(): void {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(this.w * dpr);
    const H = Math.round(this.h * dpr);
    const key = `${this.left}|${this.ppf}|${W}|${H}|${this.mode}|${this.version}`;
    if (key === this.paintedKey) return;
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    const g = this.canvas.getContext('2d');
    if (!g || W === 0 || H === 0) return;
    this.paintedKey = key;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.paintTracks(g);
  }

  private font(px: number): string {
    return `${px}px -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic UI", "Segoe UI", sans-serif`;
  }

  private paintTracks(g: CanvasRenderingContext2D): void {
    const rows = this.rows();
    g.fillStyle = C.bg;
    g.fillRect(0, 0, this.w, this.h);
    g.save();
    g.beginPath();
    g.rect(HEAD_W, 0, this.w - HEAD_W, this.h);
    g.clip();
    g.fillStyle = C.track;
    for (const r of Object.values(rows)) g.fillRect(r.x, r.y, r.w, r.h);
    this.ruler(g);
    this.clips(g, rows.video, C.video, '映像');
    this.clips(g, rows.audio, C.audio, null);
    this.wave(g, rows.audio);
    if (this.selClip?.[0] === 'keep') {
      // ダブルクリックで選んだ区間（映像・音声）を白い枠で
      const ranges = this.clipRanges();
      const sel = ranges[this.selClip[1]];
      if (sel) {
        const [a, b] = sel;
        g.strokeStyle = 'white';
        g.lineWidth = 2;
        for (const r of [rows.video, rows.audio]) {
          roundRect(g, this.x(a) + 1, r.y + 1, Math.max(1, this.x(b) - this.x(a)) - 2, r.h - 2, 3);
          g.stroke();
        }
      }
    }
    this.captionsRow(g, rows.cap);
    if (this.mode === 'short') {
      g.strokeStyle = 'rgba(0,0,0,0.63)';
      g.lineWidth = 2;
      for (const f of this.cutPoints()) {
        const px = this.x(f);
        g.beginPath();
        g.moveTo(px, rows.video.y);
        g.lineTo(px, rows.audio.y + rows.audio.h);
        g.stroke();
      }
    }
    g.restore();
    // トラック名
    g.fillStyle = C.head;
    g.fillRect(0, 0, HEAD_W, this.h);
    g.fillStyle = C.muted;
    g.font = this.font(12);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const [name, label] of [
      ['cap', '字'],
      ['video', '映'],
      ['audio', '音'],
    ] as const) {
      g.fillText(label, HEAD_W / 2, rows[name].y + rows[name].h / 2);
    }
    g.textAlign = 'left';
  }

  private ruler(g: CanvasRenderingContext2D): void {
    g.strokeStyle = C.line;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(HEAD_W, RULER_H - 0.5);
    g.lineTo(this.w, RULER_H - 0.5);
    g.stroke();
    // 目盛りの間隔：文字が 100 ピクセルほど離れるように、1 フレーム・秒の切りのよい数から選ぶ
    const fps = Math.max(1, Math.round(this.fps));
    const steps = [1, 2, 5, 10, 15, ...[1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600].map((s) => fps * s)];
    const major = steps.find((s) => s * this.ppf >= 100) ?? steps[steps.length - 1];
    const minor = [...steps].reverse().find((s) => s < major && s * this.ppf >= 8 && major % s === 0) ?? major;
    const b = this.left + (this.w - HEAD_W) / this.ppf;
    g.font = this.font(10);
    g.textBaseline = 'alphabetic';
    for (let f = Math.floor(this.left / minor) * minor; f <= b; f += minor) {
      const x = this.x(f);
      g.beginPath();
      if (f % major === 0) {
        g.strokeStyle = C.muted;
        g.moveTo(x, RULER_H - 9);
        g.lineTo(x, RULER_H - 1);
        g.stroke();
        g.fillStyle = C.muted;
        g.fillText(timecode(f, this.fps), x + 3, RULER_H - 11);
      } else {
        g.strokeStyle = C.line;
        g.moveTo(x, RULER_H - 5);
        g.lineTo(x, RULER_H - 1);
        g.stroke();
      }
    }
  }

  private clips(g: CanvasRenderingContext2D, r: Rect, color: string, label: string | null): void {
    for (const [a, b] of this.clipRanges()) {
      const x0 = this.x(a);
      const x1 = this.x(b);
      if (x1 < HEAD_W || x0 > this.w) continue;
      const w = Math.max(1, x1 - x0);
      g.fillStyle = color;
      roundRect(g, x0 + 0.5, r.y + 0.5, w - 1, r.h - 1, 3);
      g.fill();
      if (label && w > 40) {
        g.fillStyle = C.text;
        g.font = this.font(10);
        g.textBaseline = 'middle';
        g.fillText(label, x0 + 6, r.y + r.h / 2);
      }
    }
  }

  /** 動画編集ソフトのような、下から伸びる塗りつぶしの波形 */
  private wave(g: CanvasRenderingContext2D, r: Rect): void {
    if (!this.peaks.length) return;
    const base = r.y + r.h - 2;
    const span = r.h - 6;
    for (const kept of [true, false]) {
      g.fillStyle = kept ? C.wave : C.waveOut;
      g.beginPath();
      g.moveTo(HEAD_W, base);
      for (let px = HEAD_W; px <= this.w; px++) {
        const f0 = this.left + (px - HEAD_W) / this.ppf;
        const f1 = this.left + (px + 1 - HEAD_W) / this.ppf;
        const [v, isIn] = this.level(f0, f1);
        // 小さい音も見えるように、少しだけ持ち上げる（平方根）
        const h = v > 0 && isIn === kept ? Math.sqrt(v / 255) * span : 0;
        g.lineTo(px, base - h);
      }
      g.lineTo(this.w, base);
      g.closePath();
      g.fill();
    }
  }

  private captionsRow(g: CanvasRenderingContext2D, r: Rect): void {
    g.font = this.font(10);
    g.textBaseline = 'middle';
    for (const [a, b, text, kept, i] of this.blocks) {
      const x0 = this.x(a);
      const x1 = this.x(b);
      if (x1 < HEAD_W || x0 > this.w) continue;
      const w = Math.max(2, x1 - x0) - 1;
      const sel = i === this.selected;
      g.fillStyle = kept ? (sel ? C.capSel : C.cap) : C.capOut;
      roundRect(g, x0 + 0.5, r.y + 0.5, w, r.h - 1, 3);
      g.fill();
      if (sel) {
        g.strokeStyle = 'white';
        g.lineWidth = 1.5;
        g.stroke();
      }
      if (w > 18) {
        g.save();
        g.beginPath();
        g.rect(x0 + 5, r.y, w - 8, r.h);
        g.clip();
        g.fillStyle = kept ? C.text : C.muted;
        g.fillText(elide(g, text, w - 8), x0 + 5, r.y + r.h / 2);
        g.restore();
      }
    }
  }

  // ---------------------------------------------------------------- 操作

  private pos(e: MouseEvent): [number, number] {
    const b = this.canvas.getBoundingClientRect();
    return [e.clientX - b.left, e.clientY - b.top];
  }

  /** (x, y) がクリップの端の上なら [種類（"cap" か "keep"）、字幕・区間の番号、端（"start" か "end"）] */
  edgeAt(x: number, y: number): [ClipKind, number, Edge] | null {
    const rows = this.rows();
    let ranges: [ClipKind, number, number, number][] = [];
    if (contains(rows.cap, x, y)) {
      const spans = new Map<number, [number, number]>();
      for (const [a, b, , kept, i] of this.blocks) {
        if (!kept) continue;
        const s = spans.get(i);
        spans.set(i, s ? [Math.min(s[0], a), Math.max(s[1], b)] : [a, b]);
      }
      ranges = [...spans].map(([i, [a, b]]) => ['cap', i, a, b]);
    } else if (contains(rows.video, x, y) || contains(rows.audio, x, y)) {
      ranges = this.clipRanges().map(([a, b], i) => ['keep', i, a, b]);
    }
    const hits: [number, ClipKind, number, Edge][] = [];
    for (const [kind, i, a, b] of ranges) {
      // 隣り合うクリップの境目では、マウスがある側のクリップを操作する
      // （境目の右なら右のクリップの頭、左なら左のクリップの終わり）。クリップの外側は少しだけ
      let d = x - this.x(a);
      if (d >= -1 && d <= EDGE_PX) hits.push([d >= 0 ? d : EDGE_PX + 1 - d, kind, i, 'start']);
      d = this.x(b) - x;
      if (d >= -1 && d <= EDGE_PX) hits.push([d > 0 ? d : EDGE_PX + 1 - d, kind, i, 'end']);
    }
    if (!hits.length) return null;
    hits.sort((p, q) => p[0] - q[0] || (p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : 0) || p[2] - q[2] || (p[3] < q[3] ? -1 : 1));
    const [, kind, i, edge] = hits[0];
    return [kind, i, edge];
  }

  /** 左ボタンを押した（テストからも呼ぶ） */
  press(x: number, y: number): void {
    if (x < HEAD_W) return;
    this.selectClip(null);
    const hit = this.edgeAt(x, y);
    if (hit && this.onTrim) {
      this.trim = [...hit, x];
      this.trimming = true;
      this.onTrim(hit[0], hit[1], hit[2], 0, false);
      return;
    }
    if (contains(this.rows().cap, x, y)) {
      const i = this.captionHit(x);
      if (i !== null) {
        this.onCaption(i);
        return;
      }
    }
    this.drag = true;
    this.seekX(x);
  }

  move(x: number): void {
    if (this.trim) {
      const [kind, i, edge] = this.trim;
      this.onTrim?.(kind, i, edge, this.trimDelta(x), false);
    } else if (this.drag) this.seekX(x);
  }

  release(x: number): void {
    if (this.trim) {
      const [kind, i, edge] = this.trim;
      const delta = this.trimDelta(x);
      this.trim = null;
      this.trimming = false;
      this.onTrim?.(kind, i, edge, delta, true);
    }
    this.drag = false;
  }

  private trimDelta(x: number): number {
    return Math.round((x - this.trim![3]) / this.ppf);
  }

  private mouseDown(e: MouseEvent): void {
    if (e.button !== 0 || e.detail > 1) return; // ダブルクリックの 2 回目は dblclick で
    e.preventDefault();
    const [x, y] = this.pos(e);
    this.press(x, y);
  }

  private readonly onWindowMove = (e: MouseEvent): void => {
    if (this.trim || this.drag) this.move(this.pos(e)[0]);
  };

  private readonly onWindowUp = (e: MouseEvent): void => {
    if (this.trim || this.drag) this.release(this.pos(e)[0]);
  };

  private hover(e: MouseEvent): void {
    if (this.trim || this.drag) return;
    const [x, y] = this.pos(e);
    const hit = x >= HEAD_W ? this.edgeAt(x, y) : null;
    this.canvas.style.cursor = hit ? edgeCursor(hit[2]) : 'default';
  }

  /** クリップをダブルクリックで選ぶ（Delete で消せる） */
  doubleClick([x, y]: [number, number]): void {
    if (x < HEAD_W) return;
    const rows = this.rows();
    if (contains(rows.cap, x, y)) {
      const i = this.captionHit(x);
      if (i !== null) {
        this.selectClip(['cap', i]);
        (this.onCaptionEdit ?? this.onCaption)(i); // 右上の一覧で文字を直し始める
      }
      return;
    }
    if (contains(rows.video, x, y) || contains(rows.audio, x, y)) {
      const f = this.left + (x - HEAD_W) / this.ppf;
      const i = this.clipRanges().findIndex(([a, b]) => a <= f && f < b);
      if (i >= 0) this.selectClip(['keep', i]);
    }
  }

  /**
   * ホイール。向きは指定により一般のソフトと逆（奥へ回すと右へ・⌘（Ctrl）＋奥で縮小）。
   * dx・dy はブラウザの deltaX・deltaY（ピクセル。奥へ回すと dy が負）
   */
  wheelBy(dx: number, dy: number, zoom: boolean, atX: number): void {
    if (zoom) this.zoomBy(dy < 0 ? 0.8 : 1.25, atX);
    else {
      const step = Math.abs(dx) > Math.abs(dy) ? dx : -dy;
      this.scrollBy(step / Math.max(1e-6, this.ppf));
    }
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    this.wheelBy(e.deltaX * k, e.deltaY * k, e.ctrlKey || e.metaKey, this.pos(e)[0]);
  }
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** 幅に収まらない文字は … で切る */
function elide(g: CanvasRenderingContext2D, text: string, w: number): string {
  if (g.measureText(text).width <= w) return text;
  const cs = Array.from(text);
  while (cs.length && g.measureText(cs.join('') + '…').width > w) cs.pop();
  return cs.join('') + '…';
}
