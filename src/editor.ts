// トピックの編集画面：確認用の動画を見ながら、カット（残す区間）と字幕をフレーム単位で直して、edit.json の新しい版として保存する
//
// 右側は2枚の切り替え：
// - カット：文ごとに残す・外すを切り替え、区間の頭と終わりを詰める
// - 字幕：字幕の文字と、出す・消すフレームを直す（分ける・つなぐ・足す・消す）
// 再生は2通り：
// - ショート：残す区間だけを、並びの順につないで再生する（外した所は飛ばす）
// - 元動画：外した所も含めてそのまま再生する（外した文を戻すか決めるとき）
// キー（共通）：Space 再生・停止／← → 1 フレーム（Shift で 10 フレーム）／Tab ショートと元動画の切り替え／
//              Ctrl(⌘)+Z 取り消し／Ctrl(⌘)+S 保存
// キー（カット）：X 選んだ文を外す・戻す／[ ] いまの位置を区間の頭・終わりにする
// キー（字幕）：I O いまの位置を字幕の頭・終わりにする／/ いまの位置で分ける／N いまの位置に足す／Delete 消す
import type { EditDoc } from 'movie-editer-schema';
import { api, ApiError, type Peaks, type Segment, type TopicData } from './api';
import { clock, esc, frames } from './format';
import {
  addCaption,
  addRange,
  captionAt,
  keepIndexAt,
  keptFrames,
  mergeCaptionNext,
  moveCaptionEdge,
  moveEdge,
  outToSrc,
  removeRange,
  secToFrames,
  sortCaptions,
  splitCaption,
  srcToOut,
  totalFrames,
  type Caption,
  type Keep,
} from './timeline';

type Mode = 'short' | 'source';
type Panel = 'cut' | 'captions';
type Snapshot = { keeps: Keep[]; captions: Caption[] };

const ZOOM_SEC = 12; // 拡大した帯に出す長さ（秒）
const MAX_CHARS = 9; // 字幕 1 行の文字数の目安（movie-editer の subtitle.max_chars_per_line）
const NEW_CAPTION_SEC = 1; // 足す字幕の長さ（秒）

export class Editor {
  dirty = false;
  private doc: EditDoc;
  private base: number; // 直し始めた版
  private undo: Snapshot[] = [];
  private keepsChanged = false; // 前の保存からカットを直したか（保存の step を決める）
  private mode: Mode = 'short';
  private panel: Panel = 'cut';
  private src = 0; // いまの位置（元動画のフレーム）
  private selected = -1; // カット：選んだ文（segments の番号）
  private cap = -1; // 字幕：選んだ字幕（doc.captions の番号）
  private caret: { i: number; pos: number } | null = null; // 字幕の文字のカーソル（分ける位置）
  private typing = false; // 字幕の文字を直し始めた（取り消し用の控えを取った）
  private nowCap = -1; // いま出ている字幕
  private playing = false;
  private playKeep = -1; // ショートを再生中の区間
  private seeking = false; // 区間の頭へ飛んでいる間（古い位置で次の区間へ進まないように）
  private raf = 0;
  private readonly fps: number;
  private readonly video: HTMLVideoElement;
  private readonly el: HTMLElement;
  private readonly onKey = (e: KeyboardEvent) => this.key(e);
  private readonly onResize = () => this.draw();

  constructor(
    root: HTMLElement,
    private readonly name: string,
    private readonly topic: number,
    private readonly data: TopicData,
    private readonly peaks: Peaks | null,
  ) {
    this.doc = { ...structuredClone(data.edit), captions: sortCaptions(data.edit.captions) };
    this.base = data.edit.revision;
    this.fps = data.edit.fps;
    this.src = this.doc.keeps[0]?.start ?? 0;
    root.innerHTML = this.layout();
    this.el = root;
    this.video = root.querySelector('video')!;
    this.video?.addEventListener('loadedmetadata', () => this.seek(this.src));
    this.video?.addEventListener('seeked', () => (this.seeking = false));
    const on = (sel: string, f: () => void) => root.querySelector(sel)!.addEventListener('click', f);
    on('[data-act=play]', () => this.toggle());
    on('[data-act=mode]', () => this.setMode(this.mode === 'short' ? 'source' : 'short'));
    on('[data-act=save]', () => void this.save());
    on('[data-act=undo]', () => this.doUndo());
    for (const b of root.querySelectorAll<HTMLElement>('[data-panel]')) {
      b.addEventListener('click', () => this.setPanel(b.dataset.panel as Panel));
    }
    root.querySelector('.segs')!.addEventListener('click', (e) => this.clickSeg(e as MouseEvent));
    const caps = root.querySelector<HTMLElement>('.caps')!;
    caps.addEventListener('click', (e) => this.clickCap(e as MouseEvent));
    caps.addEventListener('input', (e) => this.inputCap(e));
    caps.addEventListener('focusin', () => (this.typing = false));
    for (const t of ['keyup', 'mouseup', 'select']) caps.addEventListener(t, (e) => this.keepCaret(e));
    root.querySelector('.cap-tools')!.addEventListener('click', (e) => this.capTool(e as MouseEvent));
    for (const c of root.querySelectorAll<HTMLCanvasElement>('canvas')) {
      c.addEventListener('click', (e) => this.clickBar(e, c));
    }
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('resize', this.onResize);
    this.render();
  }

  destroy(): void {
    this.pause();
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('resize', this.onResize);
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
        <span class="tabs"><button data-panel="cut">カット</button><button data-panel="captions">字幕</button></span>
        <span class="rev"></span>
        <button data-act="undo" title="Ctrl(⌘)+Z">取り消し</button>
        <button data-act="save" class="primary" title="Ctrl(⌘)+S">保存</button>
      </header>
      <main class="cut">
        <section class="player">
          <div class="screen">
            ${proxy ? `<video src="${esc(proxy)}" preload="auto" playsinline></video>` : '<p class="err">確認用の動画がありません（Mac で shorts proxy を実行）</p>'}
            <div class="sub"></div>
          </div>
          <div class="controls">
            <button data-act="play" title="Space">再生</button>
            <button data-act="mode" title="Tab"></button>
            <span class="pos"></span>
          </div>
          <p class="muted small help"></p>
        </section>
        <section class="edit">
          <canvas class="overview" height="36"></canvas>
          <canvas class="zoom" height="84"></canvas>
          <div class="summary"></div>
          <ol class="segs"></ol>
          <div class="cap-tools">
            <button data-tool="in" title="I">頭をいまの位置に</button>
            <button data-tool="out" title="O">終わりをいまの位置に</button>
            <button data-tool="split" title="/">いまの位置で分ける</button>
            <button data-tool="merge">次とつなぐ</button>
            <button data-tool="add" title="N">いまの位置に足す</button>
            <button data-tool="del" title="Delete">消す</button>
          </div>
          <ol class="caps"></ol>
        </section>
      </main>`;
  }

  private render(): void {
    const k = this.doc.keeps;
    const total = totalFrames(k);
    const isCut = this.panel === 'cut';
    this.el.querySelector('.rev')!.textContent = `版 ${this.base}${this.dirty ? '（未保存の変更あり）' : ''}`;
    for (const b of this.el.querySelectorAll<HTMLElement>('[data-panel]')) {
      b.classList.toggle('on', b.dataset.panel === this.panel);
    }
    this.el.querySelector<HTMLButtonElement>('[data-act=mode]')!.textContent =
      this.mode === 'short' ? '表示：ショート' : '表示：元動画';
    this.el.querySelector('.help')!.textContent = isCut
      ? 'Space 再生／← → 1 フレーム（Shift で 10）／Tab ショート・元動画／X 文を外す・戻す／[ ] いまの位置を区間の頭・終わりに'
      : 'Space 再生／← → 1 フレーム（Shift で 10）／Tab ショート・元動画／I O いまの位置を字幕の頭・終わりに／/ 分ける／N 足す／Delete 消す';
    this.el.querySelector<HTMLElement>('.segs')!.hidden = !isCut;
    this.el.querySelector<HTMLElement>('.caps')!.hidden = isCut;
    this.el.querySelector<HTMLElement>('.cap-tools')!.hidden = isCut;
    const shown = this.doc.captions.filter((c) => keptFrames(k, c) > 0).length;
    this.el.querySelector('.summary')!.innerHTML =
      `ショートの長さ <b>${(total / this.fps).toFixed(1)} 秒</b>（区間 ${k.length} 個）` +
      `　字幕 ${this.doc.captions.length} 個（ショートに出るもの ${shown} 個）`;
    if (isCut) this.renderSegs();
    else this.renderCaps();
    this.updatePos();
    this.draw();
  }

  private renderSegs(): void {
    const k = this.doc.keeps;
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
  }

  private renderCaps(): void {
    const k = this.doc.keeps;
    this.el.querySelector('.caps')!.innerHTML = this.doc.captions
      .map((c, i) => {
        const kept = keptFrames(k, c);
        const state = kept === 0 ? 'out' : kept >= c.end - c.start ? 'in' : 'part';
        const first = srcToOut(k, c.start);
        const at = first != null ? frames(first, this.fps) : state === 'out' ? '外した所' : '頭が外した所';
        const len = [...c.text].length;
        return `<li data-c="${i}" class="${state}${i === this.cap ? ' sel' : ''}${i === this.nowCap ? ' now' : ''}">
          <span class="t" title="ショートの時刻">${at}</span>
          <input value="${esc(c.text)}" data-c="${i}" spellcheck="false">
          <span class="n${len > MAX_CHARS ? ' warn' : ''}" title="文字数">${len}</span>
          <span class="f" title="元動画のフレーム（長さ）">${c.start}–${c.end}（${((c.end - c.start) / this.fps).toFixed(2)}s）</span></li>`;
      })
      .join('');
  }

  private updatePos(): void {
    const out = srcToOut(this.doc.keeps, this.src);
    const pos = this.el.querySelector('.pos')!;
    pos.innerHTML =
      `元動画 ${clock(this.src / this.fps)}（${this.src}f）` +
      (out == null ? '　<span class="warn">外した所</span>' : `　ショート ${frames(out, this.fps)}`);
    this.el.querySelector<HTMLButtonElement>('[data-act=play]')!.textContent = this.playing ? '停止' : '再生';
    // 動画の上の字幕（ショートの表示では外した所には出さない）
    const i = captionAt(this.doc.captions, this.src);
    const visible = i >= 0 && (this.mode === 'source' || out != null);
    this.el.querySelector('.sub')!.textContent = visible ? this.doc.captions[i].text : '';
    if (i !== this.nowCap) {
      this.nowCap = i;
      for (const li of this.el.querySelectorAll<HTMLElement>('.caps li')) {
        li.classList.toggle('now', Number(li.dataset.c) === i);
      }
    }
  }

  /** 全体の帯（トピックの区間）と、いまの位置のまわりを拡大した帯 */
  private draw(): void {
    const [lo, hi] = this.data.range;
    this.drawBar(this.el.querySelector('.overview')!, Math.floor(lo * this.fps), Math.ceil(hi * this.fps), false);
    const half = (ZOOM_SEC * this.fps) / 2;
    this.drawBar(this.el.querySelector('.zoom')!, this.src - half, this.src + half, true);
  }

  private drawBar(c: HTMLCanvasElement, a: number, b: number, captions: boolean): void {
    const w = (c.width = c.clientWidth * devicePixelRatio);
    const h = (c.height = Number(c.getAttribute('height')) * devicePixelRatio);
    c.dataset.a = String(a);
    c.dataset.b = String(b);
    const g = c.getContext('2d')!;
    const css = getComputedStyle(document.documentElement);
    const x = (f: number) => ((f - a) / (b - a)) * w;
    const capH = captions ? Math.round(h * 0.28) : 0; // 下に字幕の帯
    const wh = h - capH;
    g.clearRect(0, 0, w, h);
    g.fillStyle = css.getPropertyValue('--removed');
    g.fillRect(0, 0, w, wh);
    g.fillStyle = css.getPropertyValue('--kept');
    this.doc.keeps.forEach((k) => g.fillRect(x(k.start), 0, Math.max(1, x(k.end) - x(k.start)), wh));
    if (this.peaks) {
      g.fillStyle = css.getPropertyValue('--wave');
      const per = Math.max(1, (b - a) / w);
      for (let px = 0; px < w; px++) {
        const f0 = Math.floor(a + px * per);
        let m = 0;
        for (let f = f0; f < f0 + per; f++) m = Math.max(m, this.peaks.peaks[f] ?? 0);
        const v = (m / 255) * wh * 0.9;
        g.fillRect(px, (wh - v) / 2, 1, Math.max(1, v));
      }
    }
    // 区間の切れ目
    g.fillStyle = css.getPropertyValue('--edge');
    this.doc.keeps.forEach((k) => {
      g.fillRect(x(k.start), 0, devicePixelRatio, wh);
      g.fillRect(x(k.end) - devicePixelRatio, 0, devicePixelRatio, wh);
    });
    if (captions) {
      const gap = devicePixelRatio;
      this.doc.captions.forEach((cp, i) => {
        if (cp.end < a || cp.start > b) return;
        g.fillStyle = css.getPropertyValue(i === this.cap ? '--cap-sel' : '--cap');
        g.fillRect(x(cp.start) + gap, wh + gap, Math.max(1, x(cp.end) - x(cp.start) - gap), capH - gap);
      });
    }
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

  private setPanel(p: Panel): void {
    this.panel = p;
    this.render();
  }

  // ------------------------------------------------------------ 直す

  private snapshot(): Snapshot {
    return { keeps: this.doc.keeps, captions: this.doc.captions };
  }

  private change(patch: Partial<Snapshot>): void {
    this.undo.push(this.snapshot());
    if (patch.keeps) this.keepsChanged = true;
    this.doc = { ...this.doc, ...patch };
    this.dirty = true;
    this.render();
  }

  private doUndo(): void {
    const prev = this.undo.pop();
    if (!prev) return;
    this.doc = { ...this.doc, ...prev };
    this.dirty = this.undo.length > 0;
    if (this.cap >= this.doc.captions.length) this.cap = -1;
    this.typing = false;
    this.render();
  }

  private toggleSeg(i: number): void {
    const s = this.segments[i];
    if (!s) return;
    const r = secToFrames(s.start, s.end, this.fps);
    const kept = keptFrames(this.doc.keeps, r);
    this.change({ keeps: kept > 0 ? removeRange(this.doc.keeps, r) : addRange(this.doc.keeps, r) });
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
    this.change({ keeps: moveEdge(k, i, edge, edge === 'start' ? this.src : this.src + 1) });
  }

  /** 字幕の操作の対象：選んだ字幕、無ければいま出ている字幕 */
  private target(): number {
    return this.cap >= 0 ? this.cap : captionAt(this.doc.captions, this.src);
  }

  /** 並び直した後も同じ字幕を選んだままにする */
  private changeCaps(caps: Caption[], keep?: Caption): void {
    this.cap = keep ? caps.indexOf(keep) : -1;
    this.caret = null;
    this.change({ captions: caps });
  }

  private capEdge(edge: 'start' | 'end'): void {
    const i = this.target();
    if (i < 0) return;
    const caps = moveCaptionEdge(this.doc.captions, i, edge, edge === 'start' ? this.src : this.src + 1);
    const c = this.doc.captions[i];
    this.changeCaps(caps, caps.find((x) => x.text === c.text && (edge === 'start' ? x.end === c.end : x.start === c.start)));
  }

  private capSplit(): void {
    const i = this.target();
    if (i < 0) return;
    const pos = this.caret?.i === i ? this.caret.pos : undefined;
    const caps = splitCaption(this.doc.captions, i, this.src, pos);
    if (caps === this.doc.captions) return;
    this.changeCaps(caps, caps.find((x) => x.start === this.src));
  }

  private capMerge(): void {
    const i = this.target();
    if (i < 0) return;
    const caps = mergeCaptionNext(this.doc.captions, i);
    if (caps === this.doc.captions) return;
    this.changeCaps(caps, caps.find((x) => x.start === this.doc.captions[i].start));
  }

  private capAdd(): void {
    if (captionAt(this.doc.captions, this.src) >= 0) return; // 字幕が出ている所には足さない（分ける）
    const r = addCaption(this.doc.captions, this.src, Math.round(NEW_CAPTION_SEC * this.fps));
    this.changeCaps(r.caps, r.caps[r.index]);
    this.el.querySelector<HTMLInputElement>(`.caps input[data-c="${this.cap}"]`)?.focus();
  }

  private capDel(): void {
    const i = this.target();
    if (i < 0) return;
    this.changeCaps(this.doc.captions.filter((_, j) => j !== i));
  }

  private capTool(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-tool]')?.dataset.tool;
    if (t === 'in') this.capEdge('start');
    else if (t === 'out') this.capEdge('end');
    else if (t === 'split') this.capSplit();
    else if (t === 'merge') this.capMerge();
    else if (t === 'add') this.capAdd();
    else if (t === 'del') this.capDel();
  }

  /** 字幕の文字を直す（一覧は描き直さない。入力中のカーソルを失わないように） */
  private inputCap(e: Event): void {
    const input = e.target as HTMLInputElement;
    const i = Number(input.dataset.c);
    if (!this.typing) {
      this.undo.push(this.snapshot());
      this.typing = true;
    }
    this.doc = {
      ...this.doc,
      captions: this.doc.captions.map((c, j) => (j === i ? { ...c, text: input.value } : c)),
    };
    this.dirty = true;
    this.keepCaret(e);
    const n = input.parentElement!.querySelector('.n')!;
    const len = [...input.value].length;
    n.textContent = String(len);
    n.classList.toggle('warn', len > MAX_CHARS);
    this.el.querySelector('.rev')!.textContent = `版 ${this.base}（未保存の変更あり）`;
    this.updatePos();
  }

  private keepCaret(e: Event): void {
    const input = e.target as HTMLInputElement;
    if (input.tagName !== 'INPUT') return;
    // selectionStart は UTF-16 の位置なので、文字（コードポイント）の数に直す
    this.caret = { i: Number(input.dataset.c), pos: [...input.value.slice(0, input.selectionStart ?? 0)].length };
  }

  private clickCap(e: MouseEvent): void {
    const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-c]');
    if (!li) return;
    const i = Number(li.dataset.c);
    const fromInput = (e.target as HTMLElement).tagName === 'INPUT';
    if (i === this.cap && fromInput) return; // 文字を直しているときは動かさない
    this.cap = i;
    this.pause();
    for (const x of this.el.querySelectorAll<HTMLElement>('.caps li')) {
      x.classList.toggle('sel', Number(x.dataset.c) === i);
    }
    const c = this.doc.captions[i];
    // ショートの表示では、頭が外した所なら字幕の中で最初に残る所へ
    let f = c.start;
    if (this.mode === 'short' && srcToOut(this.doc.keeps, f) == null) {
      for (let x = c.start; x < c.end; x++) {
        if (srcToOut(this.doc.keeps, x) != null) {
          f = x;
          break;
        }
      }
    }
    this.seek(f);
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
    const mod = e.ctrlKey || e.metaKey;
    const inInput = !!(e.target as HTMLElement).closest('input, textarea');
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void this.save();
      return;
    }
    if (inInput) {
      // 字幕の文字の入力中：Enter・Esc で入力を終える（ほかのキーは文字の入力）
      if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLElement).blur();
      return;
    }
    const k = e.key.toLowerCase();
    if (mod && k === 'z') {
      e.preventDefault();
      this.doUndo();
    } else if (mod) {
      return;
    } else if (e.key === ' ') {
      e.preventDefault();
      this.toggle();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      this.step((e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 10 : 1));
    } else if (e.key === 'Tab') {
      e.preventDefault();
      this.setMode(this.mode === 'short' ? 'source' : 'short');
    } else if (this.panel === 'cut') {
      if (k === 'x' && this.selected >= 0) this.toggleSeg(this.selected);
      else if (e.key === '[' || e.key === ']') this.setEdge(e.key === '[' ? 'start' : 'end');
    } else {
      if (k === 'i') this.capEdge('start');
      else if (k === 'o') this.capEdge('end');
      else if (e.key === '/') this.capSplit();
      else if (k === 'n') this.capAdd();
      else if (e.key === 'Delete' || e.key === 'Backspace') this.capDel();
      else return;
      e.preventDefault();
    }
  }

  private async save(): Promise<void> {
    if (!this.dirty) return;
    (document.activeElement as HTMLElement | null)?.blur();
    const note = prompt('直したことのメモ（空でもよい）', '') ?? '';
    // 字幕だけを直した版は captions、カットも直した版は cut
    const step = this.keepsChanged ? 'cut' : 'captions';
    const captions = this.doc.captions.map((c) => ({ ...c, text: c.text.trim() })).filter((c) => c.text);
    const doc: EditDoc = { ...this.doc, captions, by: 'human', step, ...(note ? { note } : {}) };
    if (!note) delete (doc as Partial<EditDoc>).note;
    try {
      const saved = await api.save(this.name, this.topic, this.base, doc);
      this.doc = { ...saved, captions: sortCaptions(saved.captions) };
      this.base = saved.revision;
      this.undo = [];
      this.dirty = false;
      this.keepsChanged = false;
      this.cap = -1;
      this.render();
    } catch (e) {
      const msg =
        e instanceof ApiError && e.status === 409
          ? `${e.message}。ほかで保存された版があります。再読み込みしてから直してください`
          : (e as Error).message;
      alert(`保存できませんでした：${msg}`);
    }
  }
}
