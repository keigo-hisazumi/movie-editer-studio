/**
 * 動画の再生（WebView の <video>）。編集画面はこの形（Player）だけを使うので、テストでは差し替える。
 *
 * - 止めている間に位置を変えても、<video> はその位置のコマを出す（Qt の版のように少しだけ再生して確かめる必要は無い）
 * - 再生中は動画の新しいコマごと（requestVideoFrameCallback）にいまの時刻を知らせる
 * - serve の動画（元動画・確認用の動画）は HTTP の Range で読む。CORS は要らない（<video> は crossOrigin を付けない）
 * - 区間の切れ目で止まらないように、<video> を 2 つ持つ。次の区間の頭の少し前を裏の <video> で先に用意し（cue）、
 *   区間の終わりの少し前から裏を音を消して再生しておき、切れ目では表と裏を入れ替えるだけにする
 *   （元動画の HEVC はシークに時間がかかり、止めた動画の再生を始めるのにも少し時間がかかるため）
 */
export interface Player {
  /** 画面に置く要素 */
  readonly el: HTMLElement;
  setSource(url: string | null): void;
  /** いまの時刻（秒） */
  readonly time: number;
  /** 動画の大きさ（読み込む前は 0） */
  readonly size: [number, number];
  seek(sec: number): void;
  /**
   * 再生中、いまの動画の時刻 from（秒）まで来たら sec（秒）へ飛ぶことを先に知らせる（sec が null でやめる）。
   * その時刻への seek は止まらずにつながる
   */
  cue(sec: number | null, from?: number): void;
  play(): void;
  pause(): void;
  destroy(): void;
  /** 再生中にいまの時刻（秒）を知らせる */
  onTick: ((sec: number) => void) | null;
  /** 読み込みの様子・再生できないとき（空文字は知らせを消す） */
  onMessage: ((text: string) => void) | null;
  /** 最初に読み込めたとき */
  onLoaded: (() => void) | null;
  /** 最後まで再生した */
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

type Video = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
  cancelVideoFrameCallback?: (h: number) => void;
};

/** 用意した時刻と飛ぶ先がこれより近ければ同じとみなす（秒） */
const CUE_EPS = 0.002;
/** 裏の動画は、飛ぶ先のこれだけ前から再生しておく（秒） */
const PREROLL = 0.3;
/** 裏の動画が飛ぶ先に着くのを待つ長さの上限（ミリ秒。着かなければそのまま入れ替える） */
const FLIP_WAIT_MS = 500;

export class VideoPlayer implements Player {
  readonly el: HTMLDivElement;
  onTick: ((sec: number) => void) | null = null;
  onMessage: ((text: string) => void) | null = null;
  onLoaded: (() => void) | null = null;
  onEnded: (() => void) | null = null;
  onResize: (() => void) | null = null;
  /** 表（映っている・音が出ている）と裏（次の区間の頭を用意しておく） */
  private front: Video;
  private back: Video;
  private raf = 0;
  private vfc = 0;
  private loopEl: Video | null = null;
  private loaded = false;
  private playing = false;
  /** 裏で用意している飛ぶ先（秒）・表のどの時刻で飛ぶか・裏をどこから再生するか */
  private cued: number | null = null;
  private cueFrom: number | null = null;
  private cueStart = 0;
  /** 裏をシークし終えたか・裏を再生し始めたか */
  private cueReady = false;
  private prerolling = false;
  /** 裏の再生が始まるまでの遅れの見込み（秒。入れ替えるたびに合わせ直す） */
  private lag = 0.08;
  private flipping = 0;

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
      // 裏の用意ができた（シークの途中で別の時刻を頼まれていたら、その時刻に着くまで待つ）
      if (v === this.back && this.cued !== null && !this.prerolling && Math.abs(v.currentTime - this.cueStart) < CUE_EPS) {
        this.cueReady = true;
      }
    });
    v.addEventListener('error', () => {
      const e = v.error;
      if (!e) return;
      if (v !== this.front) {
        this.dropCue(); // 裏で読めなければ、ふつうにシークする
        return;
      }
      this.onMessage?.(`動画を再生できません：${ERRORS[e.code] ?? e.message}\n${v.currentSrc || v.src}`);
      this.stopLoop();
    });
    v.addEventListener('ended', () => {
      if (v !== this.front) return;
      this.playing = false;
      this.stopLoop();
      this.onEnded?.();
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

  seek(sec: number): void {
    sec = Math.max(0, sec);
    if (this.flipping) return; // 入れ替えの途中（飛ぶ先は同じ）
    if (this.playing && this.cued !== null && Math.abs(sec - this.cued) < CUE_EPS && this.back.readyState >= 2) {
      if (this.prerolling) {
        this.flipWhenReached(sec);
        return;
      }
      if (this.cueReady && this.cueStart === this.cued) {
        this.flip();
        return;
      }
    }
    this.dropCue();
    if (this.front.readyState >= 1 || this.front.getAttribute('src')) this.front.currentTime = sec;
  }

  cue(sec: number | null, from?: number): void {
    if (sec === null) {
      this.dropCue();
      return;
    }
    sec = Math.max(0, sec);
    this.cueFrom = from ?? null;
    if (this.cued !== null && Math.abs(sec - this.cued) < CUE_EPS) return;
    this.dropCue();
    this.cueFrom = from ?? null;
    this.cued = sec;
    // 表のどこで飛ぶか分かっていれば、少し前から裏を再生しておく。分からなければ飛ぶ先そのものを用意する
    this.cueStart = from === undefined ? sec : Math.max(0, sec - PREROLL);
    if (!this.back.getAttribute('src')) return;
    if (Math.abs(this.back.currentTime - this.cueStart) < CUE_EPS && this.back.readyState >= 2 && !this.back.seeking) this.cueReady = true;
    else this.back.currentTime = this.cueStart;
  }

  /** 用意をやめる（裏の再生も止める） */
  private dropCue(): void {
    if (this.prerolling) this.back.pause();
    this.cued = null;
    this.cueFrom = null;
    this.cueReady = false;
    this.prerolling = false;
  }

  /** 表が飛ぶ所の少し前まで来たら、裏を音を消して再生し始める（飛ぶ先にちょうど着くように） */
  private maybePreroll(t: number): void {
    if (this.cued === null || this.cueFrom === null || !this.cueReady || this.prerolling) return;
    if (this.cueFrom - t > this.cued - this.cueStart + this.lag) return;
    this.prerolling = true;
    this.back.muted = true;
    this.back.playbackRate = this.front.playbackRate;
    this.back.play().catch(() => this.dropCue());
  }

  /** 表を止め、裏が飛ぶ先まで来たら入れ替える */
  private flipWhenReached(sec: number): void {
    this.front.pause();
    this.stopLoop();
    const behind = sec - this.back.currentTime;
    // 次からの遅れの見込みを合わせる（遅れていれば早めに、先に行っていれば遅めに再生し始める）
    this.lag = Math.min(0.4, Math.max(0, this.lag + behind * 0.7));
    if (behind <= 0.5 / 60) {
      this.flip();
      return;
    }
    const until = performance.now() + FLIP_WAIT_MS;
    const wait = (): void => {
      if (!this.flipping) return;
      if (this.back.currentTime >= sec - 0.5 / 60 || this.back.paused || performance.now() > until) {
        this.flipping = 0;
        this.flip();
        return;
      }
      this.flipping = requestAnimationFrame(wait);
    };
    this.flipping = requestAnimationFrame(wait);
  }

  /** 裏で用意した動画を表に出して再生を続ける（表と裏を入れ替える） */
  private flip(): void {
    const old = this.front;
    const next = this.back;
    const wasPlaying = this.prerolling;
    this.stopLoop();
    this.front = next;
    this.back = old;
    this.cued = null;
    this.cueFrom = null;
    this.cueReady = false;
    this.prerolling = false;
    next.muted = false;
    next.volume = old.volume;
    next.playbackRate = old.playbackRate;
    if (wasPlaying && !next.paused) this.startLoop();
    else this.startPlayback();
    // 先に表に出して再生を始めてから、前の動画を止めて裏に回す
    next.classList.add('front');
    old.classList.remove('front');
    old.pause();
    old.muted = true;
  }

  play(): void {
    this.playing = true;
    this.startPlayback();
  }

  private startPlayback(): void {
    this.front.play().catch((e: unknown) => {
      // 位置を変えた直後の pause で play が止められたとき（AbortError）は知らせない
      if (!(e instanceof DOMException && e.name === 'AbortError')) this.onMessage?.(`動画を再生できません：${String(e)}`);
    });
    this.startLoop();
  }

  pause(): void {
    this.playing = false;
    if (this.flipping) cancelAnimationFrame(this.flipping);
    this.flipping = 0;
    this.dropCue();
    this.front.pause();
    this.stopLoop();
  }

  destroy(): void {
    this.pause();
    this.setSource(null);
  }

  /**
   * 再生中、新しいコマが出るたびにその時刻を知らせる（requestVideoFrameCallback。Safari 15.4・Chromium にある）。
   * 無ければ画面の描き直しごと（requestAnimationFrame）。コマの出ない画面の描き直しでは何もしないので、無駄な処理をしない
   */
  private startLoop(): void {
    if (this.raf || this.vfc) return;
    const v = this.front;
    this.loopEl = v;
    const frame = (t: number): void => {
      if (v.paused) return;
      this.maybePreroll(t);
      this.onTick?.(t);
    };
    if (typeof v.requestVideoFrameCallback === 'function') {
      const onFrame = (_now: number, meta: { mediaTime: number }): void => {
        if (!this.vfc || this.loopEl !== v) return;
        this.vfc = v.requestVideoFrameCallback!(onFrame);
        frame(meta.mediaTime);
      };
      this.vfc = v.requestVideoFrameCallback(onFrame);
      return;
    }
    const loop = (): void => {
      this.raf = requestAnimationFrame(loop);
      frame(v.currentTime);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private stopLoop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.vfc) this.loopEl?.cancelVideoFrameCallback?.(this.vfc);
    this.vfc = 0;
    this.loopEl = null;
  }
}
