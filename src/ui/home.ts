/**
 * 設定と、動画ごとのトピックの一覧。
 * - serve の URL（既定 http://127.0.0.1:8765。Windows など別の PC からは、Mac で `serve --lan` にしてその URL）
 * - movie-editer のフォルダ（この PC の serve につながらないとき、アプリが serve を起動する。閉じるときに止める）
 */
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { Api, ApiError, localPort, type VideoSummary } from '../lib/api';
import { esc } from '../lib/fmt';
import { inTauri, serveLog, serveRunning, startServe } from '../lib/native';
import { loadSettings, saveSettings } from '../lib/settings';

export interface HomeHost {
  api: Api;
  openTopic(name: string, topic: number): void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** serve につながるか確かめ、この PC の serve でつながらなければ起動する。つながらなければその理由 */
export async function ensureServe(api: Api, repo: string): Promise<string | null> {
  if (await api.alive()) return null;
  const port = localPort(api.base);
  if (!repo || port === null || !inTauri()) {
    const hint = 'Mac で .venv/bin/python -m shorts serve を起動するか、movie-editer のフォルダを設定してください';
    return `${api.base} につながりません。${hint}`;
  }
  try {
    await startServe(repo, port);
  } catch (e) {
    return String(e);
  }
  for (let n = 0; n < 60; n++) {
    // 最大 15 秒待つ
    if (await api.alive()) return null;
    if (!(await serveRunning())) break;
    await sleep(250);
  }
  const log = await serveLog().catch(() => '');
  return `serve が起動しませんでした：${log.slice(-600) || '（出力なし）'}`;
}

export class Home {
  readonly el: HTMLElement;
  private readonly url: HTMLInputElement;
  private readonly repo: HTMLInputElement;
  private readonly status: HTMLElement;
  private readonly list: HTMLElement;

  constructor(private readonly host: HomeHost) {
    const s = loadSettings();
    this.el = document.createElement('div');
    this.el.className = 'home';
    this.el.innerHTML = `
      <form class="settings">
        <label>serve の URL</label>
        <div class="row"><input name="url" spellcheck="false"><button type="submit" class="primary">つなぐ</button></div>
        <label>movie-editer のフォルダ</label>
        <div class="row"><input name="repo" spellcheck="false" placeholder="この PC で serve を起動するときだけ（例 ~/movie-editer）"><button type="button" class="pick">選ぶ…</button></div>
      </form>
      <div class="status"></div>
      <div class="topics" tabindex="0"></div>
      <div class="hint">トピックをダブルクリック（または選んで Return）で開く。edit.json が無いトピックは、先に /cut でカットを作る</div>`;
    const form = this.el.querySelector('form')!;
    this.url = form.querySelector('[name=url]')!;
    this.repo = form.querySelector('[name=repo]')!;
    this.status = this.el.querySelector('.status')!;
    this.list = this.el.querySelector('.topics')!;
    this.url.value = s.serveUrl;
    this.repo.value = s.repo;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.reload();
    });
    form.querySelector('.pick')!.addEventListener('click', () => void this.pickRepo());
    this.list.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const sel = this.list.querySelector<HTMLElement>('.topic.sel');
      if (sel) this.open(sel);
    });
  }

  private async pickRepo(): Promise<void> {
    if (!inTauri()) return;
    const d = await openDialog({ directory: true, title: 'movie-editer のフォルダ', defaultPath: this.repo.value || undefined });
    if (typeof d === 'string') this.repo.value = d;
  }

  private setStatus(html: string, error = false): void {
    this.status.innerHTML = html;
    this.status.classList.toggle('error', error);
  }

  async reload(): Promise<void> {
    const url = this.url.value.trim() || loadSettings().serveUrl;
    const repo = this.repo.value.trim();
    saveSettings({ serveUrl: url, repo });
    this.host.api = new Api(url);
    this.setStatus('つないでいます…');
    const err = await ensureServe(this.host.api, repo);
    if (err) {
      this.setStatus(esc(err), true);
      this.list.replaceChildren();
      return;
    }
    let videos: VideoSummary[];
    try {
      videos = await this.host.api.videos();
    } catch (e) {
      this.setStatus(esc(e instanceof ApiError ? e.message : String(e)), true);
      return;
    }
    const started = (await serveRunning()) ? '（アプリが起動した serve）' : '';
    this.setStatus(`${esc(url)} につながりました${started}`);
    this.fill(videos);
  }

  fill(videos: VideoSummary[]): void {
    const rows: string[] = [];
    for (const v of videos) {
      if (!v.topics.length) continue;
      rows.push(`<div class="video"><b>${esc(v.name)}</b>${v.video || v.proxy ? '' : '<span class="warn">元動画が見つからない</span>'}</div>`);
      for (const t of v.topics) {
        const id = `topic_${String(t.topic).padStart(2, '0')}`;
        const none = t.revision === null;
        const state = none ? 'edit.json なし' : `版 ${t.revision}（${t.by === 'human' ? '人' : 'AI'}・${t.step ?? ''}）`;
        rows.push(
          `<div class="topic${none ? ' none' : ''}" data-name="${esc(v.name)}" data-topic="${t.topic}">` +
            `<span class="id">${id}</span><span class="t">${esc(t.title)}</span><span class="state">${esc(state)}</span></div>`,
        );
      }
    }
    this.list.innerHTML = rows.join('') || '<div class="empty">トピックのある動画がありません</div>';
    for (const el of this.list.querySelectorAll<HTMLElement>('.topic')) {
      el.addEventListener('click', () => {
        this.list.querySelectorAll('.topic.sel').forEach((x) => x.classList.remove('sel'));
        el.classList.add('sel');
      });
      el.addEventListener('dblclick', () => this.open(el));
    }
  }

  private open(el: HTMLElement): void {
    if (el.classList.contains('none')) return;
    this.host.openTopic(el.dataset.name!, Number(el.dataset.topic));
  }
}
