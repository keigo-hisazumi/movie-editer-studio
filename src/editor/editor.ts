/**
 * トピックの編集画面：元動画を見ながら、カット（残す区間）と字幕をフレーム単位で直して、edit.json の新しい版として保存する。
 *
 * 再生は2通り：
 * - ショート：残す区間だけを、並びの順につないで再生する（外した所は飛ばす）
 * - 元動画：外した所も含めてそのまま再生する（外した文を戻すか決めるとき）
 * キー：Space 再生・停止／← → 1 フレーム（Shift で 10 フレーム）／Return 頭へ／B いまの位置で分割／T R 拡大・縮小／
 *       Shift+Z 全体／Tab ショートと元動画の切り替え／[ ] いまの位置を区間の頭・終わりに／I O いまの位置を字幕の頭・終わりに／
 *       / いまの位置で字幕を分ける／N 字幕を足す／Delete 選んだクリップ・字幕を消す／Ctrl(⌘)+Z 取り消し／Ctrl(⌘)+S 保存
 * 再生中・フレーム送り・タイムラインのクリックで位置が動くと、字幕の一覧の選択がその位置の字幕に付いていく
 * （字幕の文字を入力している間は動かさない）
 */
import type { EditDoc } from 'movie-editer-schema';
import { Api, ApiError, type Peaks, type TopicData } from '../lib/api';
import { clock, frames, timecode } from '../lib/fmt';
import * as tl from '../lib/timeline';
import type { Caption, Edge, Keep } from '../lib/timeline';
import { validate } from '../lib/validate';
import { domDialogs, isOpen, type Dialogs } from '../ui/dialogs';
import { VideoPlayer, type Player } from './player';
import { TrackView, type ClipKind, type Mode } from './track';

export const MAX_CHARS = 9; // 字幕 1 行の文字数の目安（movie-editer の subtitle.max_chars_per_line）
const NEW_CAPTION_SEC = 1; // 足す字幕の長さ（秒）
const SEEK_WAIT_MS = 300; // 区間の頭へ飛んだ後、位置が届くのを待つ長さ

/** キーの押し方（KeyboardEvent の一部。テストからも渡す） */
export interface KeyPress {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

export interface EditorOptions {
  player?: Player;
  dialogs?: Dialogs;
  /** 「← 一覧」を押した */
  onBack?: () => void;
  /** 未保存の変更の有無・版が変わった（ウィンドウの題などに） */
  onDirty?: (dirty: boolean) => void;
}

const HELP =
  'Space 再生・停止／← → 1 フレーム（Shift で 10）／Return 頭へ／B いまの位置で分割／T R 拡大・縮小／Shift+Z 全体／' +
  'クリップをダブルクリック → Delete で消す／[ ] いまの位置を区間の頭・終わりに／I O いまの位置を字幕の頭・終わりに／' +
  'N 字幕を足す／Tab ショート・元動画';

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...kids);
  return el;
}

function button(label: string, title: string, fn: () => void, cls = ''): HTMLButtonElement {
  const b = h('button', { textContent: label, title, className: cls });
  b.addEventListener('click', () => fn());
  b.addEventListener('mousedown', (e) => e.preventDefault()); // 押してもフォーカスを取らない（キーを編集画面に残す）
  return b;
}

export class Editor {
  readonly el: HTMLElement;
  readonly timeline: TrackView;
  readonly player: Player;
  readonly fps: number;
  doc: EditDoc;
  base: number;
  peaks: number[];
  peakSpf: number;
  undo: [Keep[], Caption[]][] = [];
  keepsChanged = false;
  dirty = false;
  mode: Mode = 'short';
  src: number;
  cap = -1; // 選んだ字幕
  caret: [number, number] | null = null; // 字幕の文字を入力中のカーソルの位置（行、文字目）
  typing = false;
  playing = false;
  playKeep = -1;
  seekTarget: number | null = null; // 区間の頭へ飛んでいる間（古い位置で次の区間へ進まないように）
  private seekAt = 0;
  /** 字幕の文字を直している行（入力欄が出ている間） */
  editingRow: number | null = null;
  private editStart: { caps: Caption[]; undo: number; dirty: boolean } | null = null;
  subText = ''; // 動画の上に出している字幕
  message = ''; // 動画が無い・再生できないときの知らせ

  private readonly dialogs: Dialogs;
  private readonly range: [number, number];
  private readonly ui: {
    rev: HTMLElement;
    summary: HTMLElement;
    tc: HTMLElement;
    pos: HTMLElement;
    posSrc: HTMLElement;
    posOut: HTMLElement;
    play: HTMLButtonElement;
    mode: HTMLButtonElement;
    sub: HTMLElement;
    msg: HTMLElement;
    stage: HTMLElement;
    capsBox: HTMLElement;
    caps: HTMLTableSectionElement;
    save: HTMLButtonElement;
    export: HTMLButtonElement;
  };

  constructor(
    readonly api: Api,
    readonly name: string,
    readonly topic: number,
    readonly data: TopicData,
    peaks: Peaks | null,
    private readonly opts: EditorOptions = {},
  ) {
    this.dialogs = opts.dialogs ?? domDialogs;
    this.peaks = peaks?.peaks ?? [];
    // 波形の 1 フレームあたりの数（movie-editer の peaks.json の rate。前の 1 フレームごとのものには rate が無い）
    this.peakSpf = (peaks?.rate || peaks?.fps || 30) / (peaks?.fps || 30);
    this.doc = structuredClone(data.edit);
    this.doc.captions = tl.sortCaptions(this.doc.captions);
    this.base = this.doc.revision;
    this.fps = Number(this.doc.fps);
    this.range = [Math.trunc(data.range[0] * this.fps), Math.trunc(data.range[1] * this.fps) + 1];
    this.src = this.doc.keeps.length ? this.doc.keeps[0].start : 0;
    this.player = opts.player ?? new VideoPlayer();
    this.timeline = new TrackView(
      (f) => this.seekClick(f),
      (i) => this.clickCap(i),
      (kind, i, edge, delta, commit) => this.trim(kind, i, edge, delta, commit),
    );
    this.timeline.onCaptionEdit = (i) => this.editCaption(i);

    // 上：戻る・題・版・取り消し・保存・書き出し
    const ui = {
      rev: h('span', { className: 'rev' }),
      summary: h('div', { className: 'summary' }),
      tc: h('span', { className: 'tc mono' }),
      pos: h('div', { className: 'pos' }),
      posSrc: h('span'),
      posOut: h('span'),
      play: button('▶︎ 再生', 'Space', () => this.toggle()),
      mode: button('', 'Tab', () => this.setMode(this.mode === 'short' ? 'source' : 'short')),
      sub: h('div', { className: 'sub' }),
      msg: h('div', { className: 'msg' }),
      stage: h('div', { className: 'stage' }),
      capsBox: h('div', { className: 'caps-box' }),
      caps: h('tbody'),
      save: button('保存', 'Ctrl(⌘)+S', () => void this.save(), 'primary'),
      export: button(
        'XML に書き出す',
        'いまのカットと字幕を、Filmora・Premiere 用の XML（_studio.xml）と studio.srt に書き出し直す（保存していない変更は先に保存する）',
        () => void this.export(),
      ),
    };
    this.ui = ui;
    ui.pos.append(ui.posSrc, '　', ui.posOut);
    const title = h('span', { className: 'title' }, h('b', { textContent: `${name} topic_${String(topic).padStart(2, '0')}` }), ` ${data.cut?.title ?? ''}`);
    const top = h(
      'header',
      { className: 'bar' },
      button('← 一覧', '一覧へ戻る', () => opts.onBack?.()),
      title,
      h('span', { className: 'grow' }),
      ui.rev,
      button('取り消し', 'Ctrl(⌘)+Z', () => this.doUndo()),
      ui.save,
      ui.export,
    );

    // 左：動画と再生
    ui.stage.append(this.player.el, ui.sub, ui.msg);
    const ctl = h(
      'div',
      { className: 'ctl' },
      button('◀︎|', '1 フレーム戻る（←）', () => this.step(-1)),
      button('|▶︎', '1 フレーム進む（→）', () => this.step(1)),
      ui.play,
      ui.tc,
      h('span', { className: 'grow' }),
      ui.mode,
    );
    const left = h('section', { className: 'left' }, ui.stage, ctl, ui.pos);

    // 右：字幕の一覧
    const tools = h(
      'div',
      { className: 'tools' },
      button('頭をいまの位置に', 'I', () => this.capEdge('start')),
      button('終わりをいまの位置に', 'O', () => this.capEdge('end')),
      button('次とつなぐ', '', () => this.capMerge()),
      button('いまの位置に足す', 'N', () => this.capAdd()),
    );
    const table = h(
      'table',
      { className: 'caps' },
      h('thead', {}, h('tr', {}, ...['タイムコード', '字幕', '文字数', '操作'].map((t) => h('th', { textContent: t })))),
      ui.caps,
    );
    ui.capsBox.append(table);
    const right = h('section', { className: 'right' }, ui.summary, tools, ui.capsBox);

    // 下：タイムライン
    const lower = h('section', { className: 'lower' }, this.timeline.el, h('div', { className: 'help', textContent: HELP }));
    this.el = h('div', { className: 'editor' }, top, h('div', { className: 'upper' }, left, right), lower);

    this.player.onTick = (sec) => this.tick(sec);
    this.player.onMessage = (text) => this.setMessage(text);
    this.player.onLoaded = () => this.seek(this.src);
    this.player.onEnded = () => this.pause();
    this.player.onResize = () => this.placeSub();
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.placeSub()).observe(ui.stage);
    window.addEventListener('keydown', this.onKey, true);
    this.loadMedia();
    this.render();
  }

  private loadMedia(): void {
    // 元動画をそのまま再生する。確認用の動画（shorts proxy で作る。元動画が重いとき用）があればそちらを使う
    const url = this.data.media?.['proxy.mp4'] || this.data.media?.video;
    if (url) this.player.setSource(this.api.url(url));
    else this.setMessage('元動画が見つかりません（topic_XX/cut.json の場所。動画を動かしたなら /cut で作り直す）');
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKey, true);
    this.pause();
    this.player.destroy();
    this.timeline.destroy();
    this.el.remove();
  }

  get keeps(): Keep[] {
    return this.doc.keeps;
  }

  get captions(): Caption[] {
    return this.doc.captions;
  }

  // ------------------------------------------------------------ 表示

  render(): void {
    const k = this.keeps;
    this.ui.rev.textContent = `版 ${this.base}${this.dirty ? '（未保存の変更あり）' : ''}`;
    this.ui.mode.textContent = this.mode === 'short' ? '表示：ショート' : '表示：元動画';
    const shown = this.captions.filter((c) => tl.keptFrames(k, c) > 0).length;
    this.ui.summary.innerHTML =
      `ショートの長さ <b>${(tl.totalFrames(k) / this.fps).toFixed(1)} 秒</b>（区間 ${k.length} 個）` +
      `　字幕 ${this.captions.length} 個（ショートに出るもの ${shown} 個）`;
    this.fillCaps();
    this.updatePos();
    this.opts.onDirty?.(this.dirty);
  }

  /** 字幕の一覧を作り直す */
  private fillCaps(): void {
    this.editingRow = null;
    this.ui.caps.replaceChildren(...this.captions.map((c, i) => this.capRow(c, i)));
    this.markSelected();
  }

  private capRow(c: Caption, i: number): HTMLTableRowElement {
    const kept = tl.keptFrames(this.keeps, c);
    const state = kept === 0 ? 'out' : kept >= c.end - c.start ? 'in' : 'part';
    const pieces = tl.captionPieces(this.keeps, c);
    const at = pieces.length ? `${timecode(pieces[0][0], this.fps)}\n${timecode(pieces[pieces.length - 1][1], this.fps)}` : '外した所';
    const n = Array.from(c.text).length;
    const tr = h('tr', { className: `cap-${state}` });
    const text = h('td', { className: 'text', textContent: c.text });
    const ops = h(
      'td',
      { className: 'ops' },
      button('分ける', 'いまの位置（文字を入力中ならカーソルの所）で分ける（/）', () => this.rowOp(i, () => this.capSplit())),
      button('消す', '消す（Delete）', () => this.rowOp(i, () => this.capDel())),
    );
    tr.append(h('td', { className: 'at mono', textContent: at }), text, h('td', { className: `count${n > MAX_CHARS ? ' over' : ''}`, textContent: String(n) }), ops);
    // クリックで選ぶだけ。文字を直し始めるのはダブルクリックのときだけ
    tr.addEventListener('mousedown', (e) => {
      if (this.editingRow === i || (e.target as HTMLElement).closest('.ops')) return;
      if (this.editingRow !== null) this.finishEdit(true);
      e.preventDefault();
      this.clickCap(i);
    });
    text.addEventListener('dblclick', () => this.startEdit(i));
    return tr;
  }

  private markSelected(): void {
    Array.from(this.ui.caps.rows).forEach((r, i) => r.classList.toggle('sel', i === this.cap));
  }

  private rowOp(i: number, fn: () => void): void {
    this.cap = i;
    fn();
  }

  private scrollToRow(i: number): void {
    const row = this.ui.caps.rows[i];
    const box = this.ui.capsBox;
    if (!row) return;
    box.scrollTop = row.offsetTop - box.clientHeight / 2 + row.offsetHeight / 2;
  }

  setMessage(text: string): void {
    this.message = text;
    this.ui.msg.textContent = text;
    this.ui.msg.hidden = !text;
  }

  /** 動画の上の字幕の位置と大きさを、映っている動画の大きさに合わせる */
  private placeSub(): void {
    const box = this.ui.stage;
    const w = box.clientWidth;
    const hgt = box.clientHeight;
    const [iw, ih] = this.player.size;
    let area = { x: 0, y: 0, w, h: hgt };
    if (iw && ih && w && hgt) {
      const s = Math.min(w / iw, hgt / ih);
      area = { x: (w - iw * s) / 2, y: (hgt - ih * s) / 2, w: iw * s, h: ih * s };
    }
    const px = Math.max(14, Math.round(area.h * 0.045));
    Object.assign(this.ui.sub.style, {
      left: `${area.x + area.w / 2}px`,
      top: `${area.y + area.h * 0.76}px`,
      fontSize: `${px}px`,
      webkitTextStrokeWidth: `${Math.max(3, px / 6)}px`, // 縁取り（paint-order で外側の半分だけが見える。Qt の版と同じ太さ）
    });
  }

  /** 文字を変えるのは中身が変わったときだけ（再生中は毎コマ呼ぶので、余計な並べ直しをさせない） */
  private setText(el: HTMLElement, text: string): void {
    if (el.textContent !== text) el.textContent = text;
  }

  updatePos(): void {
    const out = tl.srcToOut(this.keeps, this.src);
    this.setText(this.ui.posSrc, `元動画 ${clock(this.src / this.fps)}（${this.src}f）`);
    this.setText(this.ui.posOut, out === null ? '外した所' : `ショート ${frames(out, this.fps)}`);
    this.ui.posOut.classList.toggle('warn', out === null);
    this.setText(this.ui.play, this.playing ? '❚❚ 停止' : '▶︎ 再生');
    const i = tl.captionAt(this.captions, this.src);
    const visible = i >= 0 && (this.mode === 'source' || out !== null);
    this.subText = visible ? this.captions[i].text : '';
    this.setText(this.ui.sub, this.subText);
    if (this.ui.sub.hidden !== !this.subText) this.ui.sub.hidden = !this.subText;
    const total = tl.totalFrames(this.keeps);
    this.setText(this.ui.tc, `${timecode(out ?? this.nearestOut(), this.fps)} / ${timecode(total, this.fps)}`);
    this.timeline.setData(this.mode, this.fps, this.keeps, this.captions, this.cap, this.peaks, this.range, this.src, this.playing, this.peakSpf);
  }

  // ------------------------------------------------------------ 位置と再生

  /** 元動画のフレーム f へ。再生中と follow のときは、字幕の一覧の選択をその位置の字幕に付いていかせる */
  seek(f: number, fromPlayback = false, follow = false): void {
    this.src = Math.max(0, Math.round(f));
    if (!fromPlayback) {
      this.seekTarget = this.src;
      this.seekAt = now();
      this.player.seek((this.src + 0.5) / this.fps); // フレームの真ん中に合わせる
    }
    if (this.playing || follow) this.followCaption();
    this.updatePos();
  }

  /** 字幕の文字を入力している最中か */
  editingText(): boolean {
    return this.editingRow !== null;
  }

  /**
   * いまの位置に出ている字幕を選び、一覧のその行が見えるようにする（Filmora の字幕の編集と同じ）。
   * 字幕の無い所では前に選んだ字幕のまま。文字を入力している間は、入力を邪魔しないように動かさない。
   */
  followCaption(): void {
    const i = tl.captionAt(this.captions, this.src);
    if (i < 0 || i === this.cap || this.editingText()) return;
    if (this.mode === 'short' && tl.srcToOut(this.keeps, this.src) === null) return; // ショートの表示で外した所（字幕は出ていない）
    this.cap = i;
    this.typing = false;
    this.caret = null;
    this.markSelected();
    this.scrollToRow(i);
  }

  seekClick(f: number): void {
    this.pause();
    this.seek(f, false, true);
  }

  /** ショートの位置で n フレーム動かす（元動画の表示なら元動画で） */
  step(n: number): void {
    this.pause();
    if (this.mode === 'source') {
      this.seek(this.src + n, false, true);
      return;
    }
    const out = tl.srcToOut(this.keeps, this.src) ?? this.nearestOut();
    this.seek(tl.outToSrc(this.keeps, Math.max(0, Math.min(tl.totalFrames(this.keeps) - 1, out + n))), false, true);
  }

  /** 外した所にいるとき、次に残る所のショートの位置 */
  nearestOut(): number {
    let off = 0;
    for (const k of this.keeps) {
      if (this.src < k.start) return off;
      off += k.end - k.start;
    }
    return Math.max(0, off - 1);
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  play(): void {
    if (!this.data.media?.video && !this.data.media?.['proxy.mp4']) return;
    if (this.mode === 'short' && tl.keepIndexAt(this.keeps, this.src) < 0) this.seek(tl.outToSrc(this.keeps, this.nearestOut()));
    this.playing = true;
    this.playKeep = tl.keepIndexAt(this.keeps, this.src);
    this.player.play();
    this.updatePos();
  }

  /** 再生中に、いまの時刻が届いた */
  tick(sec: number): void {
    if (!this.playing) return;
    const f = Math.floor(sec * this.fps);
    if (this.seekTarget !== null) {
      // 飛んだ先の位置が届くのを待つ（届かないこともあるので、少し待ったら進める）
      if (Math.abs(sec * this.fps - this.seekTarget) >= 2 && now() - this.seekAt < SEEK_WAIT_MS) return;
      this.seekTarget = null;
    }
    const cur = this.keeps[this.playKeep];
    if (this.mode === 'short' && cur && f >= cur.end) {
      // 区間の終わりを過ぎた：並びで次の区間へ（最後なら止める）
      this.playKeep += 1;
      if (this.playKeep >= this.keeps.length) {
        this.pause();
        this.seek(cur.end - 1);
        return;
      }
      this.seek(this.keeps[this.playKeep].start);
    } else if (f !== this.src) this.seek(f, true);
  }

  pause(): void {
    this.playing = false;
    this.player.pause();
    this.updatePos();
  }

  setMode(m: Mode): void {
    this.mode = m;
    this.render();
  }

  // ------------------------------------------------------------ 直す

  change(keeps: Keep[] | null = null, captions: Caption[] | null = null): void {
    this.undo.push([this.keeps, this.captions]);
    this.timeline.selectClip(null); // 番号が変わるので、選んだクリップは外す
    if (keeps !== null) {
      this.doc.keeps = keeps;
      this.keepsChanged = true;
    }
    if (captions !== null) this.doc.captions = captions;
    this.dirty = true;
    this.typing = false;
    this.render();
  }

  doUndo(): void {
    const last = this.undo.pop();
    if (!last) return;
    [this.doc.keeps, this.doc.captions] = last;
    this.dirty = this.undo.length > 0;
    if (this.cap >= this.captions.length) this.cap = -1;
    this.typing = false;
    this.render();
  }

  /** [ ]：いまの位置を区間の頭・終わりにする（区間の中ならその区間、外した所なら隣の区間を広げる） */
  setEdge(edge: Edge): void {
    const k = this.keeps;
    let i = tl.keepIndexAt(k, this.src);
    if (i < 0) {
      // 外した所：頭なら後ろの区間、終わりなら前の区間（元動画でいちばん近いもの）
      let best: [number, number] | null = null;
      k.forEach((x, j) => {
        if (edge === 'start' && x.start > this.src && (!best || x.start < best[0])) best = [x.start, j];
        if (edge === 'end' && x.end <= this.src && (!best || x.end > best[0])) best = [x.end, j];
      });
      i = best ? (best as [number, number])[1] : -1;
    }
    if (i < 0) return;
    this.change(tl.moveEdge(k, i, edge, edge === 'start' ? this.src : this.src + 1));
  }

  /** B：いまの位置で、残す区間と字幕を2つに分ける（Filmora・Premiere の分割と同じ） */
  blade(): void {
    let keeps = this.keeps;
    let caps = this.captions;
    const i = tl.keepIndexAt(keeps, this.src);
    if (i >= 0 && keeps[i].start < this.src && this.src < keeps[i].end) {
      const k = keeps[i];
      // 分けた2つは元動画でつながっているが、まとめない（片方を消す・端を動かすため）
      keeps = [...keeps.slice(0, i), { start: k.start, end: this.src }, { start: this.src, end: k.end }, ...keeps.slice(i + 1)];
    }
    const j = tl.captionAt(caps, this.src);
    let sel = this.cap;
    if (j >= 0) {
      const pos = this.caret && this.caret[0] === j ? this.caret[1] : null;
      [caps, sel] = tl.splitCaption(caps, j, this.src, pos);
      if (sel < 0) [caps, sel] = [this.captions, this.cap];
    }
    if (keeps === this.keeps && caps === this.captions) return;
    this.cap = sel;
    this.caret = null;
    this.change(keeps === this.keeps ? null : keeps, caps === this.captions ? null : caps);
  }

  /** Return：タイムラインの最初へ（ショートの頭、元動画の表示ならトピックの区間の頭） */
  goStart(): void {
    this.pause();
    const f = this.mode === 'short' && this.keeps.length ? this.keeps[0].start : Math.trunc(this.data.range[0] * this.fps);
    this.timeline.left = this.timeline.axisStart() - this.timeline.axisLen();
    this.timeline.follow = true;
    this.seek(f);
  }

  /** タイムラインの字幕をダブルクリック：右上の一覧のその字幕の文字を直し始める */
  editCaption(i: number): void {
    if (i < 0 || i >= this.captions.length) return;
    this.clickCap(i);
    this.scrollToRow(i);
    this.startEdit(i);
  }

  /** タイムラインで選んだクリップを消す（映像・音声なら残す区間、字幕なら字幕） */
  deleteClip(kind: ClipKind, i: number): void {
    this.timeline.selectClip(null);
    if (kind === 'keep') {
      if (i < 0 || i >= this.keeps.length || this.keeps.length <= 1) return; // 区間が無くなるとショートが無くなるので、最後の 1 つは消さない
      this.change(this.keeps.filter((_, j) => j !== i));
    } else if (i >= 0 && i < this.captions.length) {
      this.cap = i;
      this.capDel();
    }
  }

  /** タイムラインでクリップの端をドラッグした（delta はフレーム）。ドラッグ中は見せるだけで、離したら直す */
  trim(kind: ClipKind, i: number, edge: Edge, delta: number, commit: boolean): void {
    let keeps = this.keeps;
    let caps = this.captions;
    let sel = this.cap;
    let to: number;
    if (kind === 'keep') {
      if (i < 0 || i >= this.keeps.length) return;
      to = this.keeps[i][edge] + delta;
      keeps = tl.moveEdge(this.keeps, i, edge, to);
    } else {
      if (i < 0 || i >= this.captions.length) return;
      to = this.captions[i][edge] + delta;
      [caps, sel] = tl.moveCaptionEdge(this.captions, i, edge, to);
    }
    if (commit) {
      if (delta === 0) this.render();
      else if (kind === 'keep') this.change(keeps);
      else this.changeCaps(caps, sel);
      return;
    }
    // ドラッグ中：その端のコマを見せ、タイムラインには直した後の形を描く（まだ直さない）
    this.pause();
    this.seek(Math.max(0, edge === 'start' ? to : to - 1));
    this.timeline.setData(this.mode, this.fps, keeps, caps, sel, this.peaks, this.range, this.src, false, this.peakSpf);
  }

  /** 字幕の操作の対象：選んだ字幕、無ければいま出ている字幕 */
  private target(): number {
    return this.cap >= 0 ? this.cap : tl.captionAt(this.captions, this.src);
  }

  private changeCaps(caps: Caption[], select: number): void {
    this.cap = select;
    this.caret = null;
    this.change(null, caps);
  }

  capEdge(edge: Edge): void {
    const i = this.target();
    if (i >= 0) this.changeCaps(...tl.moveCaptionEdge(this.captions, i, edge, edge === 'start' ? this.src : this.src + 1));
  }

  capSplit(): void {
    if (this.editingRow !== null) this.finishEdit(true);
    const i = this.target();
    if (i < 0) return;
    const pos = this.caret && this.caret[0] === i ? this.caret[1] : null;
    const [caps, j] = tl.splitCaption(this.captions, i, this.src, pos);
    if (j >= 0) this.changeCaps(caps, j);
  }

  capMerge(): void {
    const i = this.target();
    if (i < 0) return;
    const [caps, j] = tl.mergeCaptionNext(this.captions, i);
    if (j >= 0) this.changeCaps(caps, j);
  }

  capAdd(): void {
    if (tl.captionAt(this.captions, this.src) >= 0) return; // 字幕が出ている所には足さない（分ける）
    const [caps, j] = tl.addCaption(this.captions, this.src, Math.round(NEW_CAPTION_SEC * this.fps));
    this.changeCaps(caps, j);
    this.startEdit(j);
  }

  capDel(): void {
    if (this.editingRow !== null) this.finishEdit(true);
    const i = this.target();
    if (i >= 0) this.changeCaps(this.captions.filter((_, j) => j !== i), -1);
  }

  /** 字幕の文字を直した（一覧は作り直さない。行の番号が変わらないので） */
  setCapText(i: number, text: string): void {
    if (text === this.captions[i].text) return;
    if (!this.typing) {
      this.undo.push([this.keeps, this.captions]);
      this.typing = true;
    }
    this.doc.captions = this.captions.map((c, j) => (j === i ? { ...c, text } : c));
    this.dirty = true;
    const row = this.ui.caps.rows[i];
    if (row) {
      const n = Array.from(text).length;
      const count = row.cells[2];
      count.textContent = String(n);
      count.classList.toggle('over', n > MAX_CHARS);
    }
    this.ui.rev.textContent = `版 ${this.base}（未保存の変更あり）`;
    this.opts.onDirty?.(true);
    this.updatePos();
  }

  /** 一覧の i 行目の字幕の文字を直し始める（入力欄を出す） */
  startEdit(i: number): void {
    if (this.editingRow !== null) this.finishEdit(true);
    const row = this.ui.caps.rows[i];
    if (!row) return;
    this.cap = i;
    this.markSelected();
    this.editingRow = i;
    this.typing = false;
    this.editStart = { caps: this.captions, undo: this.undo.length, dirty: this.dirty };
    const cell = row.cells[1];
    const input = h('input', { type: 'text', value: this.captions[i].text, className: 'cap-input' });
    cell.replaceChildren(input);
    const caret = (): void => {
      this.caret = [i, Array.from(input.value.slice(0, input.selectionStart ?? input.value.length)).length];
    };
    input.addEventListener('input', () => {
      this.setCapText(i, input.value);
      caret();
    });
    for (const ev of ['keyup', 'click', 'select'] as const) input.addEventListener(ev, caret);
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        this.finishEdit(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.finishEdit(false);
      }
    });
    input.addEventListener('blur', () => {
      if (this.editingRow === i) this.finishEdit(true);
    });
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    caret();
  }

  /** 文字を直し終える（commit が false なら直す前に戻す） */
  finishEdit(commit: boolean): void {
    const i = this.editingRow;
    if (i === null) return;
    this.editingRow = null;
    if (!commit && this.editStart) {
      this.doc.captions = this.editStart.caps;
      this.undo.length = this.editStart.undo;
      this.dirty = this.editStart.dirty;
    }
    this.editStart = null;
    this.typing = false; // カーソルの位置（caret）は、この後の「分ける」で使うので残す
    const row = this.ui.caps.rows[i];
    if (row && this.captions[i]) row.replaceWith(this.capRow(this.captions[i], i));
    this.markSelected();
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.render();
  }

  clickCap(row: number): void {
    this.cap = row;
    this.typing = false;
    this.pause();
    const c = this.captions[row];
    let f = c.start;
    // ショートの表示では、頭が外した所なら字幕の中で最初に残る所へ
    if (this.mode === 'short' && tl.srcToOut(this.keeps, f) === null) {
      for (let x = c.start; x < c.end; x++) {
        if (tl.srcToOut(this.keeps, x) !== null) {
          f = x;
          break;
        }
      }
    }
    this.markSelected();
    this.seek(f);
  }

  // ------------------------------------------------------------ キー

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.isComposing || !this.el.isConnected || isOpen()) return;
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (this.editingRow !== null) this.finishEdit(true);
      void this.save();
      return;
    }
    if (typing) return; // 字幕の文字の入力中（Enter・Esc で入力を終える）。⌘Z は入力欄の取り消し
    if (this.key(e)) e.preventDefault();
  };

  /** キーを押した。使ったら true */
  key(e: KeyPress): boolean {
    const k = e.key;
    const lower = k.length === 1 ? k.toLowerCase() : k;
    if (e.ctrlKey || e.metaKey) {
      if (lower === 'z' && !e.shiftKey) {
        this.doUndo();
        return true;
      }
      return false;
    }
    const sel = this.timeline.selClip;
    if (sel && (k === 'Delete' || k === 'Backspace')) this.deleteClip(...sel);
    else if (sel && k === 'Escape') this.timeline.selectClip(null);
    else if (k === ' ' || k === 'Spacebar' || k === '　') this.toggle();
    else if ((lower === 't' || lower === 'r') && !e.shiftKey) this.timeline.zoomBy(lower === 't' ? 1.25 : 0.8);
    else if (k === 'ArrowRight' || k === 'ArrowLeft') {
      const n = e.shiftKey ? 10 : 1;
      this.step(k === 'ArrowRight' ? n : -n);
    } else if (k === 'Tab') this.setMode(this.mode === 'short' ? 'source' : 'short');
    else if (lower === 'z' && e.shiftKey) this.timeline.fitAll();
    else if (k === 'Enter') this.goStart();
    else if (lower === 'b') this.blade();
    else if (k === '[' || k === ']' || k === '「' || k === '」') this.setEdge(k === '[' || k === '「' ? 'start' : 'end');
    else if (lower === 'i') this.capEdge('start');
    else if (lower === 'o') this.capEdge('end');
    else if (k === '/' || k === '・') this.capSplit();
    else if (lower === 'n') this.capAdd();
    else if ((k === 'Delete' || k === 'Backspace') && this.cap >= 0) this.capDel(); // 選んだ字幕だけ（何も選んでいなければ消さない）
    else return false;
    return true;
  }

  // ------------------------------------------------------------ 保存

  /** 保存する版。字幕だけを直した版は captions、カットも直した版は cut */
  buildDoc(note: string): EditDoc {
    const captions = this.captions.filter((c) => c.text.trim()).map((c) => ({ ...c, text: c.text.trim() }));
    const doc: EditDoc = { ...this.doc, captions, by: 'human', step: this.keepsChanged ? 'cut' : 'captions' };
    delete doc.note;
    if (note) doc.note = note;
    return doc;
  }

  async save(note: string | null = null): Promise<boolean> {
    if (this.editingRow !== null) this.finishEdit(true); // 入力中の文字を確定する
    if (!this.dirty) return true;
    const doc = this.buildDoc((note ?? '').trim()); // メモは聞かない（指定があったときだけ付ける）
    const errs = validate(doc);
    if (errs.length) {
      await this.dialogs.warn('保存できません', errs.join('\n'));
      return false;
    }
    let saved: EditDoc;
    try {
      saved = await this.api.save(this.name, this.topic, this.base, doc);
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      let msg = e.message;
      if (e.status === 409) msg += '。ほかで保存された版があります。一覧に戻って開き直してから直してください';
      await this.dialogs.warn('保存できませんでした', msg);
      return false;
    }
    this.doc = { ...saved, captions: tl.sortCaptions(saved.captions) };
    this.base = saved.revision;
    this.undo = [];
    this.dirty = false;
    this.keepsChanged = false;
    this.cap = -1;
    this.render();
    return true;
  }

  /** 保存した版から XML と字幕を書き出し直す（serve が topic_XX/ に書く） */
  async export(): Promise<boolean> {
    if (this.dirty && !(await this.save())) return false;
    document.body.classList.add('busy');
    let out;
    try {
      out = await this.api.export(this.name, this.topic);
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      let msg = e.message;
      if (e.status === 501 || (e.status === 404 && msg === '見つかりません')) msg += '（movie-editer を新しくして serve を起動し直してください）'; // 書き出しの API が無い前の serve
      await this.dialogs.warn('書き出せませんでした', msg);
      return false;
    } finally {
      document.body.classList.remove('busy');
    }
    const files = (out.files ?? []).map((f) => `・${f}`).join('\n');
    await this.dialogs.info('書き出しました', `版 ${out.revision} から書き出しました。\n${files}\n\n場所：${out.dir ?? ''}`);
    return true;
  }
}

