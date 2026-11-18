/** 設定（serve の URL・movie-editer のフォルダ）。アプリの WebView の localStorage に置く（この PC だけのもの） */

export const DEFAULT_URL = 'http://127.0.0.1:8765';
const KEY = 'movie-editer-studio:settings';

export interface Settings {
  serveUrl: string;
  repo: string;
}

export function loadSettings(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    return { serveUrl: s.serveUrl || DEFAULT_URL, repo: s.repo ?? '' };
  } catch {
    return { serveUrl: DEFAULT_URL, repo: '' };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // 書けなくても次に開くときに聞き直すだけ
  }
}
