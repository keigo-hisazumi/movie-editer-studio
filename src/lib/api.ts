/**
 * movie-editer の serve（shorts/studio.py）の API を呼ぶ。
 *
 * serve は Mac で動かす（`.venv/bin/python -m shorts serve`）。Windows など別の PC からは、Mac で `serve --lan` にして
 * その URL（例 http://<名前>.local:8765）を設定する。
 */
import type { EditDoc } from 'movie-editer-schema';
import { httpBytes, httpRequest, type HttpResponse } from './native';

export const TIMEOUT_MS = 15_000;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** HTTP を呼ぶ手段（テストでは差し替える） */
export type Transport = (url: string, method: string, body: string | null, timeoutMs: number) => Promise<HttpResponse>;
export type BytesTransport = (url: string, timeoutMs: number) => Promise<ArrayBuffer>;

export interface TopicSummary {
  topic: number;
  title: string;
  revision: number | null;
  by: 'ai' | 'human' | null;
  step: string | null;
}

export interface VideoSummary {
  name: string;
  topics: TopicSummary[];
  video: boolean;
  proxy: boolean;
  peaks: boolean;
}

export interface Segment {
  id: number | null;
  start: number;
  end: number;
  text: string;
}

export interface TopicData {
  edit: EditDoc;
  cut: { title?: string; [k: string]: unknown };
  /** トピックの区間（秒）。元動画の表示の横軸 */
  range: [number, number];
  segments: Segment[];
  /** audio：区間の切れ目で途切れずに鳴らす音声（WAV。前の serve には無い） */
  media: { video: string | null; audio?: string | null; 'proxy.mp4': string | null; 'peaks.json': string | null };
  /** Premiere のプロジェクトの依頼（前の serve には無い） */
  premiere?: PremiereJob | null;
}

export interface Peaks {
  fps?: number;
  /** 1 秒あたりの数（無ければ 1 フレームごとの前の形） */
  rate?: number;
  peaks: number[];
}

/** Premiere のプロジェクトを作る依頼（serve の topic_XX/premiere.json。作るのは movie-editer-premiere のパネル） */
export interface PremiereJob {
  status: 'queued' | 'running' | 'done' | 'error';
  revision: number;
  /** 作る .prproj のパス */
  project: string;
  message: string;
}

export interface ExportResult {
  revision: number;
  files: string[];
  dir: string;
  /** 前の serve には無い */
  premiere?: PremiereJob | null;
}

export interface ShortResult extends ExportResult {
  /** ショートの長さ（秒） */
  duration: number;
  /** 効果音・画像を Claude Code に決めてもらったときの報告（決めていなければ null） */
  decided?: string | null;
}

// Python の urllib.parse.quote(url, safe=":/?#[]@!$&'()*+,;=%~") と同じ（ASCII 以外と空白などを %XX にする）
const SAFE = new Set(":/?#[]@!$&'()*+,;=%~-._".split(''));
export function quoteUrl(url: string): string {
  let out = '';
  for (const ch of url) {
    if (/^[A-Za-z0-9]$/.test(ch) || SAFE.has(ch)) out += ch;
    else for (const b of new TextEncoder().encode(ch)) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** パスの 1 つの部分（動画名）を %XX にする（quote(name, safe='')） */
const part = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export class Api {
  readonly base: string;

  constructor(
    base: string,
    private readonly transport: Transport = httpRequest,
    private readonly bytesTransport: BytesTransport = httpBytes,
  ) {
    this.base = base.replace(/\/+$/, '');
  }

  /**
   * API が返す /media/... などの URL を、serve の URL 付きにする。
   * serve は動画名（日本語のこともある）をそのまま URL に入れて返すので、ASCII 以外を %XX にする（すでに %XX のものはそのまま）
   */
  url(path: string): string {
    return quoteUrl(/^https?:\/\//.test(path) ? path : this.base + path);
  }

  private async call<T>(path: string, method = 'GET', body: unknown = undefined, timeoutMs = TIMEOUT_MS): Promise<T> {
    const data = body === undefined ? null : JSON.stringify(body);
    let r: HttpResponse;
    try {
      r = await this.transport(this.url(path), method, data, timeoutMs);
    } catch {
      throw new ApiError(0, `movie-editer の serve（${this.base}）につながりません`);
    }
    if (r.status >= 400) {
      let msg = `HTTP ${r.status}`;
      try {
        msg = (JSON.parse(r.body) as { error?: string }).error || msg;
      } catch {
        // JSON でない返事はそのまま HTTP の番号を出す
      }
      throw new ApiError(r.status, msg);
    }
    return (r.body ? JSON.parse(r.body) : null) as T;
  }

  async alive(): Promise<boolean> {
    try {
      await this.call('/api/videos', 'GET', undefined, 2000);
      return true;
    } catch {
      return false;
    }
  }

  videos(): Promise<VideoSummary[]> {
    return this.call('/api/videos');
  }

  topic(name: string, topic: number): Promise<TopicData> {
    return this.call(`/api/v/${part(name)}/t/${topic}`);
  }

  edits(name: string, topic: number): Promise<Partial<EditDoc>[]> {
    return this.call(`/api/v/${part(name)}/t/${topic}/edits`);
  }

  save(name: string, topic: number, baseRevision: number, doc: EditDoc): Promise<EditDoc> {
    return this.call(`/api/v/${part(name)}/t/${topic}/edit`, 'PUT', { base_revision: baseRevision, doc });
  }

  /** いまの edit.json から Filmora・Premiere 用の XML と字幕を topic_XX/ に書き出し直す（serve が書く） */
  export(name: string, topic: number): Promise<ExportResult> {
    return this.call(`/api/v/${part(name)}/t/${topic}/export`, 'POST', {}, 120_000);
  }

  /**
   * いまの edit.json から、BGM・効果音・画像・画面の文字を付けたショートを作り、Premiere のプロジェクトの依頼を出す。
   * 効果音・画像がまだ決まっていなければ serve が Claude Code に決めてもらうので、数分かかる
   */
  short(name: string, topic: number): Promise<ShortResult> {
    return this.call(`/api/v/${part(name)}/t/${topic}/short`, 'POST', {}, 30 * 60_000);
  }

  /** 音声などのバイナリを読む（読めなければ ApiError） */
  async bytes(path: string, timeoutMs = 120_000): Promise<ArrayBuffer> {
    try {
      return await this.bytesTransport(this.url(path), timeoutMs);
    } catch (e) {
      throw new ApiError(0, String(e instanceof Error ? e.message : e));
    }
  }

  peaks(path: string): Promise<Peaks> {
    return this.call(path, 'GET', undefined, 60_000);
  }
}

/** URL がこの PC（localhost・127.0.0.1）の serve ならポート番号、ほかの PC なら null（起動しない） */
export function localPort(base: string): number | null {
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return null;
  }
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname)) return null;
  return u.port ? Number(u.port) : 80;
}
