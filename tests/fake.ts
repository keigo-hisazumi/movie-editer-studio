/** テスト用：serve の代わり（版の確かめ方だけ同じ）と、再生の代わり */
import type { EditDoc } from 'movie-editer-schema';
import { Api, type BytesTransport, type TopicData, type Transport } from '../src/lib/api';
import type { Player } from '../src/editor/player';
import type { Seg } from '../src/lib/plan';
import type { Dialogs, SaveAnswer } from '../src/ui/dialogs';

export const EDIT: EditDoc = {
  format: 1,
  video: '20261017',
  topic: 2,
  fps: 30,
  revision: 1,
  by: 'ai',
  step: 'draft',
  made: '2026-11-07T00:00:00+00:00',
  keeps: [
    { start: 300, end: 360 },
    { start: 600, end: 630 },
  ],
  captions: [
    { start: 300, end: 330, text: 'えっ待って' },
    { start: 600, end: 630, text: 'うそでしょ' },
  ],
};

export const TOPIC: TopicData = {
  edit: EDIT,
  cut: { title: 'ホラーで叫ぶ' },
  range: [5.0, 25.0],
  segments: [
    { id: 0, start: 10.0, end: 12.0, text: 'えっ待って' },
    { id: 1, start: 15.0, end: 16.0, text: '関係ない話' },
    { id: 2, start: 20.0, end: 21.0, text: 'うそでしょ' },
  ],
  media: { video: null, 'proxy.mp4': null, 'peaks.json': null },
};

export class FakeServe {
  saved: { base_revision: number; doc: EditDoc }[] = [];
  exported: number[] = [];
  shorts: number[] = [];
  revision = 1;
  calls: { url: string; method: string }[] = [];
  /** 書き出しの後に GET topic で返す Premiere の依頼の状態（順に。null なら依頼を出さない前の serve） */
  premiere: ('queued' | 'running' | 'done' | 'error')[] | null = null;
  premiereMessage = '';

  bytesUrls: string[] = [];
  bytes: BytesTransport = async (url) => {
    this.bytesUrls.push(url);
    return new ArrayBuffer(8);
  };
  transport: Transport = async (url, method, body) => {
    this.calls.push({ url, method });
    const path = new URL(url).pathname;
    const json = (status: number, obj: unknown) => ({ status, body: JSON.stringify(obj) });
    if (url.startsWith('http://127.0.0.1:9/')) throw new Error('connection refused');
    if (method === 'GET' && path === '/api/videos')
      return json(200, [
        { name: '20261017', video: false, proxy: false, peaks: false, topics: [{ topic: 2, title: 'ホラーで叫ぶ', revision: 1, by: 'ai', step: 'draft' }] },
      ]);
    if (method === 'GET' && path === '/api/v/20261017/t/2') {
      const status = this.premiere && this.premiere.length > 1 ? this.premiere.shift()! : this.premiere?.[0];
      return json(200, { ...TOPIC, premiere: status ? this.job(status) : null });
    }
    if (method === 'PUT') {
      const b = JSON.parse(body!);
      if (b.base_revision !== this.revision) return json(409, { error: `いまは版 ${this.revision} です` });
      this.revision += 1;
      this.saved.push(b);
      return json(200, { ...b.doc, revision: this.revision });
    }
    if (method === 'POST' && path === '/api/v/20261017/t/2/short') {
      this.shorts.push(this.revision);
      return json(200, {
        revision: this.revision,
        duration: 41.27,
        files: ['20261017_topic_02_short_Edit.xml', 'edit.srt', 'texts.png', 'memo.json'],
        dir: '/out/20261017/topic_02',
        ...(this.premiere ? { premiere: this.job('queued') } : {}),
      });
    }
    if (method === 'POST' && path === '/api/v/20261017/t/2/export') {
      this.exported.push(this.revision);
      return json(200, {
        revision: this.revision,
        files: ['20261017_topic_02_studio.xml', 'studio.srt'],
        dir: '/out/20261017/topic_02',
        ...(this.premiere ? { premiere: this.job('queued') } : {}),
      });
    }
    return json(404, { error: '見つかりません' });
  };

  job(status: 'queued' | 'running' | 'done' | 'error') {
    const project = `/out/20261017/topic_02/20261017_topic_02_short_r${String(this.revision).padStart(4, '0')}.prproj`;
    return { status, revision: this.revision, project, message: status === 'queued' ? '' : this.premiereMessage };
  }

  api(base = 'http://127.0.0.1:8765'): Api {
    return new Api(base, this.transport, this.bytes);
  }
}

export class FakePlayer implements Player {
  el = document.createElement('div');
  time = 0;
  size: [number, number] = [1080, 1920];
  playing = false;
  seeks: number[] = [];
  plans: Seg[][] = [];
  audio: [ArrayBuffer | null, number] | null = null;
  source: string | null = null;
  onTick: ((sec: number) => void) | null = null;
  onMessage: ((text: string) => void) | null = null;
  onLoaded: (() => void) | null = null;
  onEnded: (() => void) | null = null;
  onResize: (() => void) | null = null;
  setSource(url: string | null) {
    this.source = url;
  }
  seek(sec: number) {
    this.time = sec;
    this.seeks.push(sec);
  }
  setAudio(data: ArrayBuffer | null, start: number) {
    this.audio = [data, start];
    return Promise.resolve();
  }
  play(plan: Seg[]) {
    this.playing = true;
    this.plans.push(plan);
  }
  pause() {
    this.playing = false;
  }
  destroy() {}
}

export class FakeDialogs implements Dialogs {
  shown: [string, string, string][] = [];
  answer: SaveAnswer = 'cancel';
  async info(title: string, msg: string) {
    this.shown.push(['info', title, msg]);
  }
  async warn(title: string, msg: string) {
    this.shown.push(['warn', title, msg]);
  }
  async error(title: string, msg: string) {
    this.shown.push(['error', title, msg]);
  }
  async askSave() {
    return this.answer;
  }
}
