/**
 * 動画の再生（WebView の <video> と Web Audio）。編集画面はこの形（Player）だけを使うので、テストでは差し替える。
 *
 * 編集ソフトと同じく、区間の切れ目で止まらずにつなぐ：
 * - 音：トピックの区間の音声（serve の /audio、WAV）を先に読んでおき、再生の並び（区間の順）どおりに
 *   Web Audio で鳴らす時刻を前もって決める。切れ目でも音は 1 サンプルも途切れない。再生中の時刻はこの音の時計で決める
 * - 映像：<video> を 2 つ持ち、表は音の時計に合わせて再生する（ずれたら速さを少し変えて合わせる）。
 *   次の区間の頭の少し前を裏の <video> でシークしておき、区間の終わりの少し前から再生しておいて、切れ目では表と裏を入れ替える
 *   （元動画の HEVC はシークに時間がかかるため）
 * - 音声を読めないとき（前の serve・区間の外）は、<video> の音と時計で再生する（切れ目は同じく入れ替え）
 *
 * そのほか：止めている間に位置を変えると <video> はその位置のコマを出す。serve の動画は HTTP の Range で読む（CORS は要らない）
 */
import { locate, startOf, type Seg } from '../lib/plan';

export interface Player {
  /** 画面に置く要素 */
  readonly el: HTMLElement;
  setSource(url: string | null): void;
  /** 区間の切れ目で途切れずに鳴らす音声（WAV など）。start は元動画の何秒からの音か。null でやめる */
  setAudio(data: ArrayBuffer | null, start: number): Promise<void>;
  /** いまの時刻（秒） */
  readonly time: number;
  /** 動画の大きさ（読み込む前は 0） */
  readonly size: [number, number];
  seek(sec: number): void;
  /** 並び（元動画の秒の区間を再生する順に）を頭から再生する。最後まで再生したら onEnded */
  play(plan: Seg[]): void;
  pause(): void;
  destroy(): void;
  /** 再生中にいまの時刻（元動画の秒）を知らせる */
  onTick: ((sec: number) => void) | null;
  /** 読み込みの様子・再生できないとき（空文字は知らせを消す） */
  onMessage: ((text: string) => void) | null;
  /** 最初に読み込めたとき */
  onLoaded: (() => void) | null;
  /** 並びの最後まで再生した */
  onEnded: (() => void) | null;
  /** 大きさが分かった・変わった（字幕を重ねる所を合わせ直す） */
  onResize: (() => void) | null;
}

const ERRORS: Record<number, string> = {
  1: '読み込みを止めました',
  2: 'ネットワークのエラー（serve につながっているか確かめてください）',
  3: '動画をデコードできません（この PC で再生できない形式かもしれません。shorts proxy で確認用の動画を作ってください）',
  4: 'この形式の動画は再生できません（Windows で HEVC の元動画なら、shorts proxy で確認用の動画を作ってください）',
};

/** 裏の動画は、次の区間の頭のこれだけ前から再生しておく（秒） */
const PREROLL = 0.3;
/** 音を鳴らし始めるまでの余裕（秒。この間に鳴らす時刻を決めておく） */
const AUDIO_LEAD = 0.06;
/** 映像が音とこれ以上ずれたらシークで合わせる（秒）。これより小さければ速さを少し変えて合わせる */
const HARD_SYNC = 0.3;
const SOFT_SYNC = 0.02;
/** 切れ目の音のつなぎ目のプチッという音を消すフェード（秒） */
const FADE = 0.002;
/** 切れ目で裏が区間の頭に着くのを待つ長さの上限（ミリ秒） */
const HOLD_MS = 250;

type Video = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
};

export class VideoPlayer implements Player {
  readonly el: HTMLDivElement;
  onTick: ((sec: number) => void) | null = null;
  onMessage: ((text: string) => void) | null = null;
  onLoaded: (() => void) | null = null;
  onEnded: (() => void) | null = null;
  onResize: (() => void) | null = null;
  /** 表（映っている）と裏（次の区間の頭を用意しておく） */
  private front: Video;
  private back: Video;
  private loaded = false;

  private ctx: AudioContext | null = null;
  private buf: AudioBuffer | null = null;
  private bufStart = 0;
  private nodes: AudioScheduledSourceNode[] = [];

  private playing = false;
  /** 音の時計で再生しているか（false なら <video> の音と時計） */
  private audioClock = false;
  private plan: Seg[] = [];
  private total = 0;
  /** いま表で再生している区間 */
  private k = 0;
  /** 音の時計で、並びの頭（0 秒）にあたる AudioContext の時刻。音を鳴らし始めるまでは null */
  private t0: number | null = null;
  private raf = 0;
  private seq = 0;
  private flipTimer: ReturnType<typeof setTimeout> | 0 = 0;
  /** 切れ目で、裏が区間の頭に着くのを待っている間（表は止めておく） */
  private hold: { t: number; until: number } | null = null;
  /** 先に再生している裏が出したコマの時刻（分からなければ -1） */
  private backShown = -1;

  /** 裏で用意している区間・裏をどこから再生するか・シークし終えたか・再生し始めたか */
  private cuedK = -1;
  private cueStart = 0;
  private cueReady = false;
  private prerolling = false;
  /** 裏の再生が始まるまでの遅れの見込み（秒。入れ替えるたびに合わせ直す） */
  private lag = 0.08;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'player';
    this.front = this.makeVideo();
    this.back = this.makeVideo();
    this.front.classList.add('front');
    this.back.muted = true;
    this.el.append(this.back, this.front);
  }

  private makeVideo(): Video {
    const v = document.createElement('video') as Video;
    v.preload = 'auto';
    v.playsInline = true;
    v.disablePictureInPicture = true;
    v.className = 'video';
    v.addEventListener('loadstart', () => {
      if (v === this.front && !this.loaded && v.getAttribute('src')) this.onMessage?.('動画を読み込んでいます…');
    });
    v.addEventListener('loadeddata', () => {
      if (v !== this.front || this.loaded) return;
      this.loaded = true;
      this.onMessage?.('');
      this.onLoaded?.();
    });
    v.addEventListener('loadedmetadata', () => v === this.front && this.onResize?.());
    v.addEventListener('resize', () => v === this.front && this.onResize?.());
    v.addEventListener('seeked', () => {
      if (v === this.back && this.cuedK >= 0 && !this.prerolling && Math.abs(v.currentTime - this.cueStart) < 0.002) this.cueReady = true;
    });
    v.addEventListener('error', () => {
      const e = v.error;
      if (!e) return;
      if (v !== this.front) {
        this.dropCue(); // 裏で読めなければ、切れ目ではふつうにシークする
        return;
      }
      this.onMessage?.(`動画を再生できません：${ERRORS[e.code] ?? e.message}\n${v.currentSrc || v.src}`);
      this.stop();
    });
    v.addEventListener('ended', () => {
      if (v === this.front && this.playing && !this.audioClock) this.finish();
    });
    return v;
  }

  get time(): number {
    return this.front.currentTime;
  }

  get size(): [number, number] {
    return [this.front.videoWidth, this.front.videoHeight];
  }

  setSource(url: string | null): void {
    this.loaded = false;
    this.dropCue();
    for (const v of [this.front, this.back]) {
      if (url) v.src = url;
      else {
        v.removeAttribute('src');
        v.load();
      }
    }
  }

  async setAudio(data: ArrayBuffer | null, start: number): Promise<void> {
    if (!data) {
      this.buf = null;
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    this.ctx ??= new Ctx({ latencyHint: 'interactive' });
    this.buf = await this.ctx.decodeAudioData(data);
    this.bufStart = start;
  }

  seek(sec: number): void {
    sec = Math.max(0, sec);
    if (this.front.readyState >= 1 || this.front.getAttribute('src')) this.front.currentTime = sec;
  }

  play(plan: Seg[]): void {
    this.stop();
    const dur = Number.isFinite(this.front.duration) ? this.front.duration : Infinity;
    this.plan = plan.map((g) => ({ s: g.s, e: Math.min(g.e, dur) })).filter((g) => g.e > g.s);
    if (!this.plan.length) {
      this.onEnded?.();
      return;
    }
    this.total = startOf(this.plan, this.plan.length);
    this.k = 0;
    this.playing = true;
    const seq = ++this.seq;
    // 並びがすべて読んだ音声の中にあれば、音の時計で再生する
    const b = this.buf;
    this.audioClock =
      !!b && !!this.ctx && Number.isFinite(this.total) && this.plan.every((g) => g.s >= this.bufStart - 0.01 && g.e <= this.bufStart + b.duration + 0.01);
    const first = this.plan[0];
    if (Math.abs(this.front.currentTime - first.s) > 0.04) this.front.currentTime = first.s;
    this.front.muted = this.audioClock;
    this.front.playbackRate = 1;
    this.t0 = null;
    const started = this.front.play();
    started.catch((e: unknown) => {
      // 位置を変えた直後の pause で play が止められたとき（AbortError）は知らせない
      if (!(e instanceof DOMException && e.name === 'AbortError')) this.onMessage?.(`動画を再生できません：${String(e)}`);
    });
    if (this.audioClock) {
      const ctx = this.ctx!;
      void ctx.resume();
      // 映像が動き出してから、映像のいまの位置に合わせて音を鳴らし始める（映像の立ち上がりの遅れで音とずれないように）
      void started
        .catch(() => undefined)
        .then(() => {
          if (seq !== this.seq || !this.playing) return;
          const at = Math.min(Math.max(this.front.currentTime, first.s), first.e - 0.001);
          this.startAudio(at - first.s);
        });
    }
    this.raf = requestAnimationFrame(this.loop);
  }

  /** 並びの頭から elapsed 秒の所の音を、少し後（AUDIO_LEAD）から鳴らす。その間に映像が進む分も足す */
  private startAudio(elapsed: number): void {
    const ctx = this.ctx!;
    const buf = this.buf!;
    const when = ctx.currentTime + AUDIO_LEAD;
    const from = elapsed + AUDIO_LEAD;
    this.t0 = when - from;
    let off = 0;
    for (const g of this.plan) {
      const len = g.e - g.s;
      const a = Math.max(from, off);
      const b = off + len;
      off = b;
      if (b <= a) continue;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const gain = ctx.createGain();
      const start = this.t0 + a;
      const end = this.t0 + b;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(1, start + FADE);
      gain.gain.setValueAtTime(1, Math.max(start + FADE, end - FADE));
      gain.gain.linearRampToValueAtTime(0, end);
      src.connect(gain).connect(ctx.destination);
      src.start(start, g.s + (a - (b - len)) - this.bufStart, b - a);
      this.nodes.push(src);
    }
  }

  /** 並びの頭から何秒めか（音の時計か、表の <video> の時刻から） */
  private elapsed(): number | null {
    if (this.audioClock) {
      if (this.t0 === null) return null;
      const ctx = this.ctx!;
      const latency = (ctx as AudioContext & { outputLatency?: number }).outputLatency ?? ctx.baseLatency ?? 0;
      return ctx.currentTime - latency - this.t0;
    }
    const g = this.plan[this.k];
    return startOf(this.plan, this.k) + Math.max(0, Math.min(this.front.currentTime, g.e) - g.s) + (this.front.currentTime >= g.e ? 1e-6 : 0);
  }

  private loop = (): void => {
    if (!this.playing) return;
    this.raf = requestAnimationFrame(this.loop);
    const el = this.elapsed();
    if (el === null) return; // 音を鳴らし始める前
    const at = locate(this.plan, el);
    if (!at) {
      this.finish();
      return;
    }
    if (this.hold) {
      // 裏が区間の頭に着いたら入れ替える（着かなくても少し待ったら入れ替える）
      if (this.backPos() >= this.hold.t - 0.008 || performance.now() > this.hold.until) this.swap();
      this.onTick?.(Math.max(at.t, this.plan[this.k].s));
      return;
    }
    if (at.k > this.k) this.enter(at.k, at.t);
    else if (at.k === this.k && this.audioClock) this.sync(at.t);
    this.prepareNext(el);
    this.flipOnTime();
    this.onTick?.(at.k < this.k ? this.plan[this.k].s : at.t);
  };

  /**
   * 表の映像が区間の終わりに来るちょうどの時刻に入れ替える（画面の描き直しを待つと、外した所が 1〜2 コマ映るため）。
   * 音は出ていく所の遅れがあるので、映像は音の時計より少し先を出している。入れ替えも映像の時刻で決める
   */
  private flipOnTime(): void {
    const g = this.plan[this.k];
    if (this.flipTimer || !this.plan[this.k + 1] || this.front.paused) return;
    const left = (g.e - this.front.currentTime) / (this.front.playbackRate || 1);
    if (left > 0.1) return;
    const k = this.k;
    const go = (): void => {
      if (this.playing && this.k === k && !this.hold) this.enter(k + 1, this.plan[k + 1].s);
    };
    this.flipTimer = setTimeout(
      () => {
        this.flipTimer = 0;
        go();
      },
      Math.max(0, left * 1000 - 12), // タイマーの遅れと、描き直しの前に次のコマが出てしまう分を見込んで少し早めに
    );
    // コマが出るたびに確かめ、区間の最後のコマを出したらすぐ入れ替える（次のコマは外した所なので）
    const v = this.front;
    if (typeof v.requestVideoFrameCallback !== 'function') return;
    let prev = -1;
    const onFrame = (_now: number, meta: { mediaTime: number }): void => {
      if (!this.playing || this.k !== k || this.front !== v) return;
      const step = prev >= 0 ? Math.min(1 / 24, Math.max(1 / 120, meta.mediaTime - prev)) : 1 / 60;
      prev = meta.mediaTime;
      if (meta.mediaTime + step * 1.1 >= g.e) go();
      else v.requestVideoFrameCallback!(onFrame);
    };
    v.requestVideoFrameCallback(onFrame);
  }

  /** 映像を音の時計に合わせる（少しのずれは速さで、大きなずれはシークで） */
  private sync(t: number): void {
    const v = this.front;
    if (v.seeking) return;
    const diff = v.currentTime - t;
    if (Math.abs(diff) > HARD_SYNC) {
      v.currentTime = t + 0.03;
      v.playbackRate = 1;
    } else if (Math.abs(diff) > SOFT_SYNC) v.playbackRate = Math.min(1.1, Math.max(0.9, 1 - diff * 2));
    else if (v.playbackRate !== 1) v.playbackRate = 1;
  }

  /** 次の区間の頭を裏で用意し、切れ目の少し前から裏を再生しておく */
  private prepareNext(elapsed: number): void {
    const n = this.k + 1;
    const next = this.plan[n];
    if (!next) return;
    if (this.cuedK !== n) {
      this.dropCue();
      if (!this.back.getAttribute('src')) return;
      this.cuedK = n;
      this.cueStart = Math.max(0, next.s - PREROLL);
      this.back.muted = true;
      if (Math.abs(this.back.currentTime - this.cueStart) < 0.002 && this.back.readyState >= 2 && !this.back.seeking) this.cueReady = true;
      else this.back.currentTime = this.cueStart;
      return;
    }
    if (!this.cueReady || this.prerolling) return;
    const left = startOf(this.plan, n) - elapsed; // 切れ目まで（秒）
    if (left > next.s - this.cueStart + this.lag) return;
    this.prerolling = true;
    const b = this.back;
    b.playbackRate = 1;
    b.play().catch(() => this.dropCue());
    // 裏が実際に出したコマの時刻（currentTime はデコードの位置で、出したコマより先のことがある）
    this.backShown = -1;
    if (typeof b.requestVideoFrameCallback === 'function') {
      const onFrame = (_now: number, meta: { mediaTime: number }): void => {
        if (this.back !== b || !this.prerolling) return;
        this.backShown = meta.mediaTime;
        b.requestVideoFrameCallback!(onFrame);
      };
      b.requestVideoFrameCallback(onFrame);
    }
  }

  /** 区間 k に入った：用意した裏と入れ替える（用意できていなければシーク） */
  private enter(k: number, t: number): void {
    const ready = k === this.cuedK && (this.prerolling || this.cueReady) && this.back.readyState >= 2;
    this.k = k;
    if (this.flipTimer) clearTimeout(this.flipTimer);
    this.flipTimer = 0;
    if (!ready) {
      this.dropCue();
      this.front.currentTime = t;
      return;
    }
    const next = this.back;
    if (this.prerolling) {
      const behind = t - this.backPos();
      // 次からの遅れの見込みを合わせる（遅れていれば早めに、先に行っていれば遅めに再生し始める）
      this.lag = Math.min(0.5, Math.max(0, this.lag + behind * 0.7));
      if (behind > 0.5 / 30) {
        // 裏がまだ区間の頭に着いていない：外した所を映さないよう、表を区間の終わりのコマで止めて待つ（音は続ける）
        this.front.pause();
        this.hold = { t, until: performance.now() + HOLD_MS };
        return;
      }
    } else next.currentTime = t;
    this.swap();
  }

  /** 先に再生している裏がいま出しているコマの時刻 */
  private backPos(): number {
    return this.backShown >= 0 ? Math.min(this.backShown, this.back.currentTime) : this.back.currentTime;
  }

  /** 裏を表に出して再生を続ける（表と裏を入れ替える） */
  private swap(): void {
    const old = this.front;
    const next = this.back;
    const wasPlaying = this.prerolling;
    this.hold = null;
    this.cuedK = -1;
    this.cueReady = false;
    this.prerolling = false;
    this.front = next;
    this.back = old;
    next.muted = this.audioClock;
    next.volume = old.volume;
    next.playbackRate = 1;
    if (!wasPlaying || next.paused) next.play().catch(() => undefined);
    next.classList.add('front');
    old.classList.remove('front');
    old.pause();
    old.muted = true;
    old.playbackRate = 1;
  }

  private dropCue(): void {
    if (this.prerolling) this.back.pause();
    this.hold = null;
    this.cuedK = -1;
    this.cueReady = false;
    this.prerolling = false;
  }

  private finish(): void {
    const last = this.plan[this.plan.length - 1];
    this.stop();
    if (last && Number.isFinite(last.e)) this.front.currentTime = Math.max(last.s, last.e - 0.001);
    this.onEnded?.();
  }

  /** 再生を止める（音・映像・裏の用意） */
  private stop(): void {
    this.playing = false;
    this.seq++;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.flipTimer) clearTimeout(this.flipTimer);
    this.flipTimer = 0;
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {
        // まだ鳴らしていない・もう止まった
      }
      n.disconnect();
    }
    this.nodes = [];
    this.t0 = null;
    this.dropCue();
    this.front.pause();
    this.front.playbackRate = 1;
  }

  pause(): void {
    this.stop();
  }

  destroy(): void {
    this.stop();
    this.setSource(null);
    void this.ctx?.close();
    this.ctx = null;
  }
}
