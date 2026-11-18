/**
 * 動画の再生（WebView の <video>）。編集画面はこの形（Player）だけを使うので、テストでは差し替える。
 *
 * - 止めている間に位置を変えても、<video> はその位置のコマを出す（Qt の版のように少しだけ再生して確かめる必要は無い）
 * - 再生中は画面のコマごと（requestAnimationFrame）にいまの時刻を知らせる
 * - serve の動画（元動画・確認用の動画）は HTTP の Range で読む。CORS は要らない（<video> は crossOrigin を付けない）
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

export class VideoPlayer implements Player {
  readonly el: HTMLVideoElement;
  onTick: ((sec: number) => void) | null = null;
  onMessage: ((text: string) => void) | null = null;
  onLoaded: (() => void) | null = null;
  onEnded: (() => void) | null = null;
  onResize: (() => void) | null = null;
  private raf = 0;
  private loaded = false;

  constructor() {
    const v = document.createElement('video');
    v.preload = 'auto';
    v.playsInline = true;
    v.disablePictureInPicture = true;
    v.className = 'video';
    v.addEventListener('loadstart', () => {
      if (!this.loaded && v.getAttribute('src')) this.onMessage?.('動画を読み込んでいます…');
    });
    v.addEventListener('loadeddata', () => {
      if (this.loaded) return;
      this.loaded = true;
      this.onMessage?.('');
      this.onLoaded?.();
    });
    v.addEventListener('loadedmetadata', () => this.onResize?.());
    v.addEventListener('resize', () => this.onResize?.());
    v.addEventListener('error', () => {
      const e = v.error;
      if (!e) return;
      this.onMessage?.(`動画を再生できません：${ERRORS[e.code] ?? e.message}\n${v.currentSrc || v.src}`);
      this.stopLoop();
    });
    v.addEventListener('ended', () => {
      this.stopLoop();
      this.onEnded?.();
    });
    this.el = v;
  }

  get time(): number {
    return this.el.currentTime;
  }

  get size(): [number, number] {
    return [this.el.videoWidth, this.el.videoHeight];
  }

  setSource(url: string | null): void {
    this.loaded = false;
    if (url) this.el.src = url;
    else {
      this.el.removeAttribute('src');
      this.el.load();
    }
  }

  seek(sec: number): void {
    if (this.el.readyState >= 1 || this.el.getAttribute('src')) this.el.currentTime = Math.max(0, sec);
  }

  play(): void {
    this.el.play().catch((e: unknown) => {
      // 位置を変えた直後の pause で play が止められたとき（AbortError）は知らせない
      if (!(e instanceof DOMException && e.name === 'AbortError')) this.onMessage?.(`動画を再生できません：${String(e)}`);
    });
    this.startLoop();
  }

  pause(): void {
    this.el.pause();
    this.stopLoop();
  }

  destroy(): void {
    this.pause();
    this.setSource(null);
  }

  private startLoop(): void {
    if (this.raf) return;
    const loop = (): void => {
      this.raf = requestAnimationFrame(loop);
      if (!this.el.paused) this.onTick?.(this.el.currentTime);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private stopLoop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}
