/**
 * 書き出したアプリの確かめ（CI と、動画が出ないときの切り分け）。
 *
 *     "movie-editer studio" --self-check [動画のファイル]
 *
 * edit.json の検査が動くかを見る。動画のファイルを渡すと、アプリの中の小さな HTTP サーバー（serve と同じく Range にも答える）
 * から WebView の <video> で実際に再生し、コマが出て再生位置が進むか・止めたまま飛べるかを見る。
 * 結果は self-check.log（いまのフォルダ）と標準出力に書き、だめなら終了コード 1（Rust 側の self_check_done）。
 */
import { selfCheckDone, type SelfCheckTarget } from './lib/native';
import { validate } from './lib/validate';

const WAIT_MS = 20_000;

function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const end = Date.now() + ms;
    const loop = (): void => {
      if (cond()) resolve(true);
      else if (Date.now() > end) resolve(false);
      else setTimeout(loop, 20);
    };
    loop();
  });
}

/** url を再生して、コマが出て位置が進めば null、だめならその様子 */
export async function play(root: HTMLElement, url: string): Promise<string | null> {
  const v = document.createElement('video');
  v.muted = true; // 音を出さない（自動再生も許される）
  v.playsInline = true;
  v.preload = 'auto';
  root.append(v);
  const errors: string[] = [];
  v.addEventListener('error', () => errors.push(`${v.error?.code ?? ''} ${v.error?.message ?? ''}`.trim()));
  v.src = url;
  const state = (): string =>
    `大きさ ${v.videoWidth}x${v.videoHeight}・位置 ${Math.round(v.currentTime * 1000)}ms・readyState ${v.readyState}・${errors.join('、') || 'エラーなし'}`;
  try {
    if (!(await waitFor(() => v.readyState >= 2 || errors.length > 0, WAIT_MS)) || errors.length) return `読み込めません（${state()}）`;
    // 止めたまま飛ぶ（編集画面のフレーム送りと同じ）
    let seeked = false;
    v.addEventListener('seeked', () => (seeked = true), { once: true });
    v.currentTime = 0.5;
    if (!(await waitFor(() => seeked || errors.length > 0, WAIT_MS)) || errors.length) return `止めたまま飛べません（${state()}）`;
    v.currentTime = 0;
    await v.play().catch((e: unknown) => errors.push(String(e)));
    const ok = await waitFor(() => v.currentTime >= 0.3 || errors.length > 0, WAIT_MS);
    v.pause();
    if (!ok || errors.length || !v.videoWidth) return `再生できません（${state()}）`;
    return null;
  } finally {
    v.removeAttribute('src');
    v.load();
    v.remove();
  }
}

export async function runSelfCheck(root: HTMLElement, target: SelfCheckTarget): Promise<void> {
  const lines: string[] = [];
  let ok = true;
  try {
    const errs = validate({ format: 1 });
    lines.push(`edit.json の検査：${errs.length ? 'ok' : '動いていません'}`);
    ok &&= errs.length > 0;
    lines.push(`WebView：${navigator.userAgent}`);
    if (target.url) {
      const r = await play(root, target.url);
      lines.push(`再生（HTTP ${target.name ?? ''}）：${r ?? 'ok'}`);
      ok &&= r === null;
    }
  } catch (e) {
    lines.push(`エラー：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    ok = false;
  }
  lines.push(`self-check: ${ok ? 'ok' : 'NG'}`);
  root.textContent = lines.join('\n');
  await selfCheckDone(lines.join('\n'), ok);
}
