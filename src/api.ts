// movie-editer の serve（shorts/studio.py）の API。vite の開発サーバーが /api・/media を serve に転送する
import type { CutMemo, EditDoc } from 'movie-editer-schema';

export interface TopicBrief {
  topic: number;
  title: string;
  revision: number | null;
  by: string | null;
  step: string | null;
}

export interface VideoBrief {
  name: string;
  topics: TopicBrief[];
  proxy: boolean;
  peaks: boolean;
}

export interface Word {
  start: number;
  end: number;
  word: string;
}

/** 文字起こしの文（元動画の秒） */
export interface Segment {
  id: number | null;
  start: number;
  end: number;
  text: string;
  words: Word[];
}

export interface TopicData {
  edit: EditDoc;
  cut: Partial<CutMemo>;
  range: [number, number];
  segments: Segment[];
  media: { 'proxy.mp4': string | null; 'peaks.json': string | null };
}

export interface Peaks {
  fps: number;
  peaks: number[];
}

export interface RevisionBrief {
  revision: number;
  by: string;
  step: string;
  made: string;
  note: string | null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError(0, 'movie-editer の serve につながりません（Mac で .venv/bin/python -m shorts serve を起動してください）');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, (body && body.error) || `${res.status} ${res.statusText}`);
  return body as T;
}

const enc = encodeURIComponent;

export const api = {
  videos: () => call<VideoBrief[]>('/api/videos'),
  topic: (name: string, topic: number) => call<TopicData>(`/api/v/${enc(name)}/t/${topic}`),
  edits: (name: string, topic: number) => call<RevisionBrief[]>(`/api/v/${enc(name)}/t/${topic}/edits`),
  save: (name: string, topic: number, baseRevision: number, doc: EditDoc) =>
    call<EditDoc>(`/api/v/${enc(name)}/t/${topic}/edit`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_revision: baseRevision, doc }),
    }),
  peaks: (url: string) => call<Peaks>(url),
};
