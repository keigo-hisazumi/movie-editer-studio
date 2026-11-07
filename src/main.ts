// movie-editer-studio：カットと字幕を人が直す画面。ページは #/（一覧）と #/v/<動画名>/t/<トピックID>（編集）
import './style.css';
import { api, ApiError, type VideoBrief } from './api';
import { Editor } from './editor';
import { esc } from './format';

const app = document.querySelector<HTMLDivElement>('#app')!;
let current: Editor | null = null;
let shown = location.hash; // いま表示しているページ（移動を取り消したときに戻す）
let ignoreNext = false;

async function listPage(): Promise<void> {
  app.innerHTML = '<header><h1>movie-editer studio</h1></header><main><p class="muted">読み込み中…</p></main>';
  let videos: VideoBrief[];
  try {
    videos = await api.videos();
  } catch (e) {
    app.querySelector('main')!.innerHTML = `<p class="err">${esc((e as Error).message)}</p>`;
    return;
  }
  const rows = videos
    .filter((v) => v.topics.length)
    .map((v) => {
      const topics = v.topics
        .map((t) => {
          const state =
            t.revision == null
              ? '<span class="chip">edit.json なし</span>'
              : `<span class="chip ${t.by === 'human' ? 'ok' : ''}">版 ${t.revision}（${t.by === 'human' ? '人' : 'AI'}・${esc(t.step ?? '')}）</span>`;
          const link =
            t.revision == null
              ? `topic_${String(t.topic).padStart(2, '0')}`
              : `<a href="#/v/${encodeURIComponent(v.name)}/t/${t.topic}">topic_${String(t.topic).padStart(2, '0')}</a>`;
          return `<li>${link} ${esc(t.title)} ${state}</li>`;
        })
        .join('');
      const media = v.proxy ? '' : '<span class="chip warn">確認用の動画なし（shorts proxy で作る）</span>';
      return `<section class="card"><h2>${esc(v.name)} ${media}</h2><ul>${topics}</ul></section>`;
    });
  app.querySelector('main')!.innerHTML = rows.join('') || '<p class="muted">カットを作ったトピックがありません</p>';
}

async function route(): Promise<void> {
  if (ignoreNext) {
    ignoreNext = false;
    return;
  }
  if (current?.dirty && !confirm('保存していない変更があります。移動しますか？')) {
    ignoreNext = true;
    location.hash = shown;
    return;
  }
  shown = location.hash;
  current?.destroy();
  current = null;
  const m = location.hash.match(/^#\/v\/([^/]+)\/t\/(\d+)$/);
  if (!m) return listPage();
  const name = decodeURIComponent(m[1]);
  const topic = Number(m[2]);
  app.innerHTML = '<p class="muted">読み込み中…</p>';
  try {
    const data = await api.topic(name, topic);
    const peaks = data.media['peaks.json'] ? await api.peaks(data.media['peaks.json']).catch(() => null) : null;
    current = new Editor(app, name, topic, data, peaks);
  } catch (e) {
    const msg = e instanceof ApiError ? e.message : String(e);
    app.innerHTML = `<header><a href="#/">← 一覧</a></header><main><p class="err">${esc(msg)}</p></main>`;
  }
}

window.addEventListener('hashchange', () => void route());
window.addEventListener('beforeunload', (e) => {
  if (current?.dirty) e.preventDefault();
});
void route();
