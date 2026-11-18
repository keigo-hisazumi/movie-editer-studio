/**
 * movie-editer-studio：movie-editer の AI が作ったカットと字幕を、人がフレーム単位で直す Mac・Windows のアプリ（Tauri）。
 * ファイルの読み書きは movie-editer の serve（`shorts serve`）の API に頼む。
 */
import { getCurrentWindow } from '@tauri-apps/api/window';
import './style.css';
import { Editor } from './editor/editor';
import { Api, ApiError, type Peaks } from './lib/api';
import { inTauri, selfCheckTarget, stopServe, writeLog } from './lib/native';
import { loadSettings } from './lib/settings';
import { runSelfCheck } from './selfcheck';
import { domDialogs } from './ui/dialogs';
import { Home } from './ui/home';

const APP = 'movie-editer studio';

/** 思わぬエラーを記録に書き、画面に出す */
async function report(title: string, e: unknown): Promise<void> {
  const text = e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ''}` : String(e);
  let path = '';
  try {
    path = await writeLog(title, text);
  } catch {
    path = '（記録に書けませんでした）';
  }
  const head = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  await domDialogs.error(title, `${head}\n\n記録：${path}`, text);
}

class App {
  api = new Api(loadSettings().serveUrl);
  editor: Editor | null = null;
  readonly home: Home;
  private readonly root: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.home = new Home(this);
    root.append(this.home.el);
  }

  private setTitle(t: string): void {
    document.title = t;
    if (inTauri()) void getCurrentWindow().setTitle(t).catch(() => undefined);
  }

  async openTopic(name: string, topic: number): Promise<void> {
    const label = `${name} topic_${String(topic).padStart(2, '0')}`;
    document.body.classList.add('busy');
    let data;
    let peaks: Peaks | null = null;
    try {
      data = await this.api.topic(name, topic);
      const p = data.media?.['peaks.json'];
      if (p) peaks = await this.api.peaks(p).catch(() => null);
    } catch (e) {
      document.body.classList.remove('busy');
      if (e instanceof ApiError) await domDialogs.warn('開けません', e.message);
      else await report(`${label} を開けません`, e); // serve の返事が思っていた形でないなど
      return;
    }
    document.body.classList.remove('busy');
    this.closeEditor();
    try {
      this.editor = new Editor(this.api, name, topic, data, peaks, {
        onBack: () => void this.goHome(),
        onDirty: (dirty) => this.setTitle(`${dirty ? '● ' : ''}${label} — ${APP}`),
      });
    } catch (e) {
      this.editor = null;
      await report(`${label} を開けません`, e);
      return;
    }
    this.home.el.hidden = true;
    this.root.append(this.editor.el);
    this.setTitle(`${label} — ${APP}`);
  }

  /** 保存していない変更があれば聞く。離れてよければ true */
  async confirmLeave(): Promise<boolean> {
    if (!this.editor) return true;
    if (this.editor.editingRow !== null) this.editor.finishEdit(true);
    if (!this.editor.dirty) return true;
    const r = await domDialogs.askSave();
    if (r === 'save') return this.editor.save();
    return r === 'discard';
  }

  async goHome(): Promise<void> {
    if (!(await this.confirmLeave())) return;
    this.closeEditor();
    this.setTitle(APP);
    this.home.el.hidden = false;
    await this.home.reload();
  }

  closeEditor(): void {
    this.editor?.destroy();
    this.editor = null;
  }
}

async function main(): Promise<void> {
  const root = document.getElementById('app')!;
  const check = await selfCheckTarget();
  if (check) {
    await runSelfCheck(root, check);
    return;
  }
  window.addEventListener('error', (e) => void report('エラーが起きました', e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => void report('エラーが起きました', e.reason));
  const app = new App(root);
  if (inTauri()) {
    // 閉じる前に、保存していない変更を聞く。アプリが起動した serve は Rust 側が閉じるときに止める
    const win = getCurrentWindow();
    let closing = false;
    void win.onCloseRequested(async (e) => {
      if (closing) return;
      e.preventDefault();
      if (!(await app.confirmLeave())) return;
      closing = true;
      app.closeEditor();
      await stopServe().catch(() => undefined);
      await win.destroy();
    });
  }
  await app.home.reload();
}

void main();
