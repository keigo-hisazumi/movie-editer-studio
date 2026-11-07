// カットの画面：確認用の動画を見ながら、文ごとに残す・外すを切り替え、区間の頭と終わりをフレーム単位で詰める
//
// 再生は2通り：
// - ショート：残す区間だけを、並びの順につないで再生する（外した所は飛ばす）
// - 元動画：外した所も含めてそのまま再生する（外した文を戻すか決めるとき）
// キー：Space 再生・停止／← → 1 フレーム（Shift で 10 フレーム）／Tab ショートと元動画の切り替え／
//       X 選んだ文を外す・戻す／[ ] いまの位置を区間の頭・終わりにする／Ctrl(⌘)+Z 取り消し／Ctrl(⌘)+S 保存
import type { EditDoc } from 'movie-editer-schema';
import { api, ApiError, type Peaks, type Segment, type TopicData } from './api';
import { clock, esc, frames } from './format';
import {
  addRange,
  keepIndexAt,
  keptFrames,
  moveEdge,
  outToSrc,
  removeRange,
  secToFrames,
  srcToOut,
  totalFrames,
  type Keep,
} from './timeline';

type Mode = 'short' | 'source';

const ZOOM_SEC = 12; // 拡大した帯に出す長さ（秒）

export class CutEditor {
  dirty = false;
  private doc: EditDoc;
  private base: number; // 直し始めた版
  private undo: Keep[][] = [];
  private mode: Mode = 'short';
  private src = 0; // いまの位置（元動画のフレーム）
  private selected = -1; // 選んだ文（segments の番号）
  private playing = false;
  private playKeep = -1; // ショートを再生中の区間
  private seeking = false; // 区間の頭へ飛んでいる間（古い位置で次の区間へ進まないように）
  private raf = 0;
  private readonly fps: number;
  private readonly video: HTMLVideoElement;
  private readonly el: HTMLElement;
  private readonly onKey = (e: KeyboardEvent) => this.key(e);

  constructor(
    root: HTMLElement,
    private readonly name: string,
    private readonly topic: number,
    private readonly data: TopicData,
    private readonly peaks: Peaks | null,
  ) {
    this.doc = structuredClone(data.edit);
    this.base = data.edit.revision;
    this.fps = data.edit.fps;
    this.src = this.doc.keeps[0]?.start ?? 0;
    root.innerHTML = this.layout();
    this.el = root;
    this.video = root.querySelector('video')!;
    this.video?.addEventListener('loadedmetadata', () => this.seek(this.src));
    this.video?.addEventListener('seeked', () => (this.seeking = false));
    root.querySelector('[data-act=play]')!.addEventListener('click', () => this.toggle());
    root.querySelector('[data-act=mode]')!.addEventListener('click', () => this.setMode(this.mode === 'short' ? 'source' : 'short'));
    root.querySelector('[data-act=save]')!.addEventListener('click', () => void this.save());
    root.querySelector('[data-act=undo]')!.addEventListener('click', () => this.doUndo());
    root.querySelector('.segs')!.addEventListener('click', (e) => this.clickSeg(e as MouseEvent));
    for (const c of root.querySelectorAll<HTMLCanvasElement>('canvas')) {
      c.addEventListener('click', (e) => this.clickBar(e, c));
    }
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('resize', () => this.draw());
    this.render();
  }

  destroy(): void {
    this.pause();
    window.removeEventListener('keydown', this.onKey);
  }

  private get segments(): Segment[] {
    return this.data.segments;
  }

  // ------------------------------------------------------------ 画面

  private layout(): string {
    const cut = this.data.cut;
    const proxy = this.data.media['proxy.mp4'];
    return `
      <header>
        <a href="#/">← 一覧</a>
        <h1>${esc(this.name)} topic_${String(this.topic).padStart(2, '0')} ${esc(cut.title ?? '')}</h1>
        <span class="rev"></span>
        <button data-act="undo" title="Ctrl(⌘)+Z">取り消し</button>
        <button data-act="save" class="primary" title="Ctrl(⌘)+S">保存</button>
      </header>
      <main class="cut">
        <section class="player">
          ${proxy ? `<video src="${esc(proxy)}" preload="auto" playsinline></video>` : '<p class="err">確認用の動画がありません（Mac で shorts proxy を実行）</p>'}
          <div class="controls">
            <button data-act="play" title="Space">再生</button>
            <button data-act="mode" title="Tab"></button>
            <span class="pos"></span>
          </div>
          <p class="muted small">Space 再生／← → 1 フレーム（Shift で 10）／Tab ショート・元動画／X 文を外す・戻す／[ ] いまの位置を区間の頭・終わりに</p>
        </section>
        <section class="edit">
          <canvas class="overview" height="36"></canvas>
          <canvas class="zoom" height="72"></canvas>
          <div class="summary"></div>
          <ol class="segs"></ol>
        </section>
      </main>`;
  }

  private render(): void {
    const k = this.doc.keeps;
    const total = totalFrames(k);
    this.el.querySelector('.rev')!.textContent =
      `版 ${this.base}${this.dirty ? '（未保存の変更あり）' : ''}`;
    this.el.querySelector<HTMLButtonElement>('[data-act=mode]')!.textContent =
      this.mode === 'short' ? '表示：ショート' : '表示：元動画';
    this.el.querySelector('.summary')!.innerHTML =
      `ショートの長さ <b>${(total / this.fps).toFixed(1)} 秒</b>（区間 ${k.length} 個）`;
    this.el.querySelector('.segs')!.innerHTML = this.segments
      .map((s, i) => {
        const r = secToFrames(s.start, s.end, this.fps);
        const n = r.end - r.start;
        const kept = keptFrames(k, r);
        const state = kept === 0 ? 'out' : kept >= n ? 'in' : 'part';
        const label = { in: '残す', part: '一部', out: '外す' }[state];
        return `<li data-i="${i}" class="${state}${i === this.selected ? ' sel' : ''}">
          <span class="t">${clock(s.start)}</span><span class="st">${label}</span>
          <span class="tx">${esc(s.text)}</span>
          <button data-toggle="${i}">${state === 'out' ? '戻す' : '外す'}</button></li>`;
      })
      .join('');
    this.updatePos();
    this.draw();
  }

  private updatePos(): void {
    const out = srcToOut(this.doc.keeps, this.src);
    const pos = this.el.querySelector('.pos')!;
    pos.innerHTML =
      `元動画 ${clock(this.src / this.fps)}（${this.src}f）` +
      (out == null ? '　<span class="warn">外した所</span>' : `　ショート ${frames(out, this.fps)}`);
    this.el.querySelector<HTMLButtonElement>('[data-act=play]')!.textContent = this.playing ? '停止' : '再生';
  }

  /** 全体の帯（トピックの区間）と、いまの位置のまわりを拡大した帯 */
  private draw(): void {
    const [lo, hi] = this.data.range;
    this.drawBar(this.el.querySelector('.overview')!, Math.floor(lo * this.fps), Math.ceil(hi * this.fps));
    const half = (ZOOM_SEC * this.fps) / 2;
    this.drawBar(this.el.querySelector('.zoom')!, this.src - half, this.src + half);
  }

  private drawBar(c: HTMLCanvasElement, a: number, b: number): void {
    const w = (c.width = c.clientWidth * devicePixelRatio);
    const h = (c.height = Number(c.getAttribute('height')) * devicePixelRatio);
    c.dataset.a = String(a);
    c.dataset.b = String(b);
    const g = c.getContext('2d')!;
    const css = getComputedStyle(document.documentElement);
    const x = (f: number) => ((f - a) / (b - a)) * w;
    g.clearRect(0, 0, w, h);
    g.fillStyle = css.getPropertyValue('--removed');
    g.fillRect(0, 0, w, h);
    g.fillStyle = css.getPropertyValue('--kept');
    this.doc.keeps.forEach((k) => g.fillRect(x(k.start), 0, Math.max(1, x(k.end) - x(k.start)), h));
    if (this.peaks) {
      g.fillStyle = css.getPropertyValue('--wave');
      const per = Math.max(1, (b - a) / w);
      for (let px = 0; px < w; px++) {
        const f0 = Math.floor(a + px * per);
        let m = 0;
        for (let f = f0; f < f0 + per; f++) m = Math.max(m, this.peaks.peaks[f] ?? 0);
        const v = (m / 255) * h * 0.9;
        g.fillRect(px, (h - v) / 2, 1, Math.max(1, v));
      }
    }
    // 区間の切れ目
    g.fillStyle = css.getPropertyValue('--edge');
    this.doc.keeps.forEach((k) => {
      g.fillRect(x(k.start), 0, devicePixelRatio, h);
      g.fillRect(x(k.end) - devicePixelRatio, 0, devicePixelRatio, h);
    });
    g.fillStyle = css.getPropertyValue('--head');
    g.fillRect(x(this.src) - devicePixelRatio, 0, 2 * devicePixelRatio, h);
  }

  // ------------------------------------------------------------ 位置と再生

  private seek(src: number, fromPlayback = false): void {
    this.src = Math.max(0, Math.round(src));
    if (!fromPlayback && this.video) this.video.currentTime = (this.src + 0.5) / this.fps; // フレームの真ん中に合わせる
    this.updatePos();
    this.draw();
  }

  /** ショートの位置で n フレーム動かす（元動画の表示なら元動画で） */
  private step(n: number): void {
    this.pause();
    if (this.mode === 'source') return this.seek(this.src + n);
    const k = this.doc.keeps;
    const out = srcToOut(k, this.src) ?? this.nearestOut();
    this.seek(outToSrc(k, Math.max(0, Math.min(totalFrames(k) - 1, out + n))));
  }

  /** 外した所にいるとき、次に残る所のショートの位置 */
  private nearestOut(): number {
    const k = this.doc.keeps;
    let off = 0;
    for (const x of k) {
      if (this.src < x.start) return off;
      off += x.end - x.start;
    }
    return Math.max(0, off - 1);
  }

  private toggle(): void {
    if (this.playing) this.pause();
    else void this.play();
  }

  private async play(): Promise<void> {
    if (!this.video) return;
    if (this.mode === 'short' && keepIndexAt(this.doc.keeps, this.src) < 0) {
      this.seek(outToSrc(this.doc.keeps, this.nearestOut()));
    }
    this.playing = true;
    this.playKeep = keepIndexAt(this.doc.keeps, this.src);
    this.updatePos();
    await this.video.play().catch(() => (this.playing = false));
    const tick = () => {
      if (!this.playing) return;
      if (!this.seeking) {
        const f = Math.floor(this.video.currentTime * this.fps);
        const cur = this.doc.keeps[this.playKeep];
        if (this.mode === 'short' && cur && f >= cur.end) {
          // 区間の終わりを過ぎた：並びで次の区間へ（最後なら止める）
          const next = this.doc.keeps[++this.playKeep];
          if (!next) {
            this.seek(cur.end - 1);
            this.pause();
            return;
          }
          this.seeking = true;
          this.seek(next.start);
        } else {
          this.seek(f, true);
        }
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private pause(): void {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.video?.pause();
    if (this.el) this.updatePos();
  }

  private setMode(m: Mode): void {
    this.mode = m;
    this.render();
  }

  // ------------------------------------------------------------ 直す

  private change(keeps: Keep[]): void {
    this.undo.push(this.doc.keeps);
    this.doc = { ...this.doc, keeps };
    this.dirty = true;
    this.render();
  }

  private doUndo(): void {
    const prev = this.undo.pop();
    if (!prev) return;
    this.doc = { ...this.doc, keeps: prev };
    this.dirty = this.undo.length > 0;
    this.render();
  }

  private toggleSeg(i: number): void {
    const s = this.segments[i];
    if (!s) return;
    const r = secToFrames(s.start, s.end, this.fps);
    const kept = keptFrames(this.doc.keeps, r);
    this.change(kept > 0 ? removeRange(this.doc.keeps, r) : addRange(this.doc.keeps, r));
  }

  /** [ ]：いまの位置を区間の頭・終わりにする（区間の中ならその区間、外した所なら隣の区間を広げる） */
  private setEdge(edge: 'start' | 'end'): void {
    const k = this.doc.keeps;
    let i = keepIndexAt(k, this.src);
    if (i < 0) {
      // 外した所：頭なら後ろの区間、終わりなら前の区間（元動画でいちばん近いもの）
      let best = -1;
      k.forEach((x, j) => {
        if (edge === 'start' && x.start > this.src && (best < 0 || x.start < k[best].start)) best = j;
        if (edge === 'end' && x.end <= this.src && (best < 0 || x.end > k[best].end)) best = j;
      });
      i = best;
    }
    if (i < 0) return;
    this.change(moveEdge(k, i, edge, edge === 'start' ? this.src : this.src + 1));
  }

  private clickSeg(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    const btn = t.closest<HTMLElement>('[data-toggle]');
    if (btn) return this.toggleSeg(Number(btn.dataset.toggle));
    const li = t.closest<HTMLElement>('li[data-i]');
    if (!li) return;
    this.selected = Number(li.dataset.i);
    this.pause();
    const s = this.segments[this.selected];
    const f = secToFrames(s.start, s.end, this.fps).start;
    this.render();
    this.seek(f);
  }

  private clickBar(e: MouseEvent, c: HTMLCanvasElement): void {
    const a = Number(c.dataset.a);
    const b = Number(c.dataset.b);
    const r = c.getBoundingClientRect();
    this.pause();
    this.seek(a + ((e.clientX - r.left) / r.width) * (b - a));
  }

  private key(e: KeyboardEvent): void {
    if ((e.target as HTMLElement).closest('input, textarea')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void this.save();
    } else if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      this.doUndo();
    } else if (e.key === ' ') {
      e.preventDefault();
      this.toggle();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      this.step((e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 10 : 1));
    } else if (e.key === 'Tab') {
      e.preventDefault();
      this.setMode(this.mode === 'short' ? 'source' : 'short');
    } else if (e.key.toLowerCase() === 'x' && this.selected >= 0) {
      this.toggleSeg(this.selected);
    } else if (e.key === '[' || e.key === ']') {
      this.setEdge(e.key === '[' ? 'start' : 'end');
    }
  }

  private async save(): Promise<void> {
    if (!this.dirty) return;
    const note = prompt('直したことのメモ（空でもよい）', '') ?? '';
    const doc: EditDoc = { ...this.doc, by: 'human', step: 'cut', ...(note ? { note } : {}) };
    if (!note) delete (doc as Partial<EditDoc>).note;
    try {
      const saved = await api.save(this.name, this.topic, this.base, doc);
      this.doc = saved;
      this.base = saved.revision;
      this.undo = [];
      this.dirty = false;
      this.render();
    } catch (e) {
      const msg = e instanceof ApiError && e.status === 409
        ? `${e.message}。ほかで保存された版があります。再読み込みしてから直してください`
        : (e as Error).message;
      alert(`保存できませんでした：${msg}`);
    }
  }
}
