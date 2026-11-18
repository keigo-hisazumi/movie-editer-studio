/**
 * アプリ（Tauri の Rust 側、src-tauri/src/lib.rs）に頼むこと：serve への HTTP・serve の起動と停止・記録の書き込み・self-check。
 *
 * serve は CORS のヘッダーを返さないので、API は画面（WebView）の fetch でなく Rust 側から呼ぶ。
 * 動画（<video>）は CORS が要らないので、画面から serve の URL をそのまま読む。
 */
import { invoke } from '@tauri-apps/api/core';

export interface HttpResponse {
  status: number;
  body: string;
}

/** Tauri の中で動いているか（ブラウザで vite の画面だけを開いたときは false） */
export const inTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** HTTP で呼ぶ。つながらなければ例外（Error） */
export async function httpRequest(url: string, method: string, body: string | null, timeoutMs: number): Promise<HttpResponse> {
  if (inTauri()) return invoke<HttpResponse>('http_request', { url, method, body, timeoutMs });
  // ブラウザで開いたとき（開発用）：fetch で呼ぶ（serve が同じオリジンでないと CORS で止まる）
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method,
      body,
      headers: body === null ? {} : { 'Content-Type': 'application/json' },
      signal: ctl.signal,
    });
    return { status: r.status, body: await r.text() };
  } finally {
    clearTimeout(timer);
  }
}

/** movie-editer のフォルダの serve を起動する（起動できなければ例外。理由は文字列） */
export const startServe = (repo: string, port: number): Promise<void> => invoke('start_serve', { repo, port });
/** アプリが起動した serve が動いているか */
export const serveRunning = async (): Promise<boolean> => (inTauri() ? invoke<boolean>('serve_running') : false);
/** アプリが起動した serve の出力（最後の 4000 文字ほど） */
export const serveLog = (): Promise<string> => invoke<string>('serve_log');
/** アプリが起動した serve を止める（ターミナルで起動した serve は止めない） */
export const stopServe = async (): Promise<void> => {
  if (inTauri()) await invoke('stop_serve');
};

/** 思わぬエラーを記録に書く。記録の場所を返す */
export async function writeLog(title: string, text: string): Promise<string> {
  if (!inTauri()) {
    console.error(title, text);
    return '（ブラウザのコンソール）';
  }
  return invoke<string>('write_log', { title, text });
}

export interface SelfCheckTarget {
  /** 確かめる動画の URL（アプリの中の小さな HTTP サーバーが Range にも答えて渡す）。動画を渡されなければ null */
  url: string | null;
  name: string | null;
}

/** --self-check で起動されたら、確かめる動画。普通に起動されたら null */
export async function selfCheckTarget(): Promise<SelfCheckTarget | null> {
  if (!inTauri()) return null;
  return invoke<SelfCheckTarget | null>('self_check_target');
}

/** self-check の結果を self-check.log と標準出力に書き、アプリを閉じる（ok でなければ終了コード 1） */
export const selfCheckDone = (text: string, ok: boolean): Promise<void> => invoke('self_check_done', { text, ok });
