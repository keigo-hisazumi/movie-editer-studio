import { afterEach, expect, test, vi } from 'vitest';
import { Editor, type KeyPress } from '../src/editor/editor';
import { FakeDialogs, FakePlayer, FakeServe, TOPIC } from './fake';

let open: Editor[] = [];
afterEach(() => {
  open.forEach((e) => e.destroy());
  open = [];
});

function make(fake = new FakeServe(), opts: { premiereWaitMs?: number } = {}) {
  const dialogs = new FakeDialogs();
  const player = new FakePlayer();
  const e = new Editor(fake.api(), '20261017', 2, structuredClone(TOPIC), { fps: 30, peaks: new Array(900).fill(100) }, { player, dialogs, premierePollMs: 1, premiereWaitMs: opts.premiereWaitMs ?? 50 });
  document.body.append(e.el);
  e.timeline.resize(1100, 240);
  open.push(e);
  return { e, fake, dialogs, player };
}

const press = (e: Editor, key: string, mods: Omit<KeyPress, 'key'> = {}) => e.key({ key, ...mods });

test('B：いまの位置で区間と字幕を分ける。⌘Z で戻す', () => {
  const { e } = make();
  e.seek(315);
  expect(press(e, 'b')).toBe(true);
  expect(e.keeps).toEqual([
    { start: 300, end: 315 },
    { start: 315, end: 360 },
    { start: 600, end: 630 },
  ]);
  expect(e.captions.slice(0, 2).map((c) => [c.start, c.end])).toEqual([
    [300, 315],
    [315, 330],
  ]);
  expect(e.dirty).toBe(true);
  expect(e.el.querySelector('.rev')!.textContent).toContain('未保存');
  press(e, 'z', { metaKey: true });
  expect(e.keeps).toEqual(TOPIC.edit.keeps);
  expect(e.captions.length).toBe(2);
  expect(e.dirty).toBe(false);
  e.seek(300);
  press(e, 'b'); // 区間の頭では分けない（字幕も頭）
  expect(e.keeps).toEqual(TOPIC.edit.keeps);
});

test('Return で頭へ、Shift+Z で全体', () => {
  const { e } = make();
  e.seek(610);
  press(e, 'Enter');
  expect(e.src).toBe(300);
  e.setMode('source');
  e.timeline.setPpf(6);
  press(e, 'Z', { shiftKey: true });
  expect(e.timeline.fit).toBe(true);
  press(e, 'Enter');
  expect(e.src).toBe(150); // 元動画の表示ではトピックの区間の頭（5 秒）
});

test('フレーム送りと区間の端', () => {
  const { e, player } = make();
  expect(e.src).toBe(300);
  press(e, 'ArrowLeft');
  expect(e.src).toBe(300); // ショートの頭より前には行かない
  press(e, 'ArrowRight', { shiftKey: true });
  expect(e.src).toBe(310);
  expect(player.time).toBeCloseTo(310.5 / 30); // フレームの真ん中に合わせる
  press(e, '['); // いまの位置を区間の頭に
  expect(e.keeps[0]).toEqual({ start: 310, end: 360 });
  e.seek(355);
  press(e, 'ArrowRight', { shiftKey: true }); // ショートでは次の区間へ飛ぶ
  expect(e.src).toBe(605);
  press(e, 'Tab');
  expect(e.mode).toBe('source');
});

test('字幕：分ける・足す・消す・文字を直す', () => {
  const { e } = make();
  expect(e.el.querySelectorAll('tbody tr').length).toBe(2);
  e.clickCap(0);
  e.seek(310);
  e.caret = [0, 2];
  press(e, '/'); // カーソルの位置で分ける
  expect(e.captions.slice(0, 2).map((c) => c.text)).toEqual(['えっ', '待って']);
  expect(e.captions[1].start).toBe(310);
  e.cap = -1;
  e.seek(340);
  press(e, 'n'); // 字幕の無い所に足す（そのまま文字を直し始める）
  expect([e.captions[2].start, e.captions[2].end]).toEqual([340, 370]);
  expect(e.editingText()).toBe(true);
  e.finishEdit(true);
  press(e, 'Delete'); // 選んだ字幕（足した字幕）を消す
  expect(e.captions.length).toBe(3);
  e.startEdit(1);
  const input = e.el.querySelectorAll('tbody tr')[1].querySelector<HTMLInputElement>('.cap-input')!;
  input.value = '待ってよ';
  input.dispatchEvent(new Event('input'));
  expect(e.captions[1].text).toBe('待ってよ');
  expect(e.el.querySelectorAll('tbody tr')[1].querySelector('.count')!.textContent).toBe('4');
  expect(e.subText).toBe(''); // 340 には字幕が無い
  e.finishEdit(true);
  e.seek(315);
  expect(e.subText).toBe('待ってよ');
});

test('文字を直している間に Esc：直す前に戻す', () => {
  const { e } = make();
  e.startEdit(0);
  const input = e.el.querySelector<HTMLInputElement>('.cap-input')!;
  input.value = 'ちがう';
  input.dispatchEvent(new Event('input'));
  expect(e.dirty).toBe(true);
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(e.captions[0].text).toBe('えっ待って');
  expect(e.dirty).toBe(false);
  expect(e.undo.length).toBe(0);
});

test('保存：字幕だけなら captions、カットも直したら cut', async () => {
  const { e, fake } = make();
  e.setCapText(0, 'えっ待ってよ');
  expect(await e.save('字幕だけ')).toBe(true);
  const body = fake.saved[0];
  expect(body.base_revision).toBe(1);
  expect(body.doc).toMatchObject({ by: 'human', step: 'captions', note: '字幕だけ' });
  expect(body.doc.captions[0].text).toBe('えっ待ってよ');
  expect(e.base).toBe(2);
  expect(e.dirty).toBe(false);
  e.deleteClip('keep', 1);
  expect(await e.save()).toBe(true);
  expect(fake.saved[1].doc.step).toBe('cut');
  expect('note' in fake.saved[1].doc).toBe(false);
});

test('形が違えば保存しない（schema で止める）', async () => {
  const { e, fake, dialogs } = make();
  (e.doc as unknown as Record<string, unknown>).fps = '30';
  e.dirty = true;
  expect(await e.save('')).toBe(false);
  expect(fake.saved.length).toBe(0);
  expect(dialogs.shown[0][2]).toContain('fps');
});

test('保存ボタンで、メモを聞かずに保存する', async () => {
  const { e, fake } = make();
  e.deleteClip('keep', 1);
  e.el.querySelector<HTMLButtonElement>('button.primary')!.click();
  await new Promise((r) => setTimeout(r, 0));
  expect(fake.saved.length).toBe(1);
  expect('note' in fake.saved[0].doc).toBe(false);
});

test('ほかで保存されていたら知らせる（409）', async () => {
  const { e, fake, dialogs } = make();
  fake.revision = 5;
  e.deleteClip('keep', 1);
  expect(await e.save()).toBe(false);
  expect(dialogs.shown[0][2]).toContain('ほかで保存された版があります');
});

test('Space は再生・停止、T で拡大・R で縮小', () => {
  const { e } = make();
  let toggled = 0;
  e.toggle = () => {
    toggled += 1;
  };
  press(e, ' ');
  press(e, '　'); // 日本語入力の全角の空白
  expect(toggled).toBe(2);
  e.setMode('source'); // 拡大・縮小できる長さにする
  e.timeline.setPpf(4);
  const p = e.timeline.ppf;
  press(e, 't');
  expect(e.timeline.ppf).toBeGreaterThan(p);
  press(e, 'r');
  press(e, 'r');
  expect(e.timeline.ppf).toBeLessThan(p);
});

test('文字の入力中はキーを編集画面に回さない', () => {
  const { e } = make();
  e.startEdit(0);
  const input = e.el.querySelector<HTMLInputElement>('.cap-input')!;
  const ev = new KeyboardEvent('keydown', { key: 'b', bubbles: true, cancelable: true });
  input.dispatchEvent(ev);
  expect(e.keeps.length).toBe(2);
  expect(ev.defaultPrevented).toBe(false);
});

test('タイムラインのクリップの端をドラッグして、区間・字幕の長さを変える（離すまで直さない）', () => {
  const { e } = make();
  const tv = e.timeline;
  tv.setPpf(8);
  tv.left = 40;
  tv.syncBar();
  const rows = tv.rows();
  const drag = (y: number, x0: number, x1: number) => {
    tv.press(x0, y);
    tv.move(x1);
    tv.release(x1);
  };
  // 映像の 1 つめのクリップ（元動画 300〜360、ショート 0〜60）の終わりを 10 フレーム右へ
  let y = rows.video.y + rows.video.h / 2;
  // 隣り合う境目：左側なら左のクリップの終わり、右側なら右のクリップの頭
  expect(tv.edgeAt(tv.x(60) - 2, y)).toEqual(['keep', 0, 'end']);
  expect(tv.edgeAt(tv.x(60) + 2, y)).toEqual(['keep', 1, 'start']);
  tv.press(tv.x(60) - 2, y);
  tv.move(tv.x(60) - 2 + 10 * tv.ppf);
  expect(e.keeps[0]).toEqual({ start: 300, end: 360 }); // ドラッグ中はまだ直さない
  tv.release(tv.x(60) - 2 + 10 * tv.ppf);
  expect(e.keeps[0]).toEqual({ start: 300, end: 370 });
  expect(e.dirty).toBe(true);
  // 字幕の 1 つめ（300〜330）の終わりを 5 フレーム左へ
  y = rows.cap.y + rows.cap.h / 2;
  expect(tv.edgeAt(tv.x(30) - 2, y)).toEqual(['cap', 0, 'end']);
  drag(y, tv.x(30) - 2, tv.x(30) - 2 - 5 * tv.ppf);
  expect(e.captions[0].end).toBe(325);
  e.doUndo();
  expect(e.captions[0].end).toBe(330);
  expect(e.keeps[0].end).toBe(370);
});

test('クリップをダブルクリックで選び、Delete で消す（映像・音声は残す区間、字幕は字幕）', () => {
  const { e } = make();
  const tv = e.timeline;
  const rows = tv.rows();
  // 2 つめの区間（元動画 600〜630、ショート 60〜90）をダブルクリック
  tv.doubleClick([tv.x(75), rows.audio.y + rows.audio.h / 2]);
  expect(tv.selClip).toEqual(['keep', 1]);
  press(e, 'Delete');
  expect(e.keeps).toEqual([{ start: 300, end: 360 }]);
  expect(tv.selClip).toBeNull();
  e.cap = -1;
  press(e, 'Delete'); // 何も選んでいなければ何も消さない
  expect([e.keeps.length, e.captions.length]).toEqual([1, 2]);
  tv.selectClip(['keep', 0]);
  press(e, 'Delete'); // 最後の 1 つの区間は消さない
  expect(e.keeps.length).toBe(1);
  // 字幕をダブルクリック → 右上の一覧でその字幕の文字を直し始める
  tv.doubleClick([tv.x(10), rows.cap.y + rows.cap.h / 2]);
  expect(e.cap).toBe(0);
  expect(e.editingRow).toBe(0);
});

test('一覧の字幕はいつも入力欄。クリック 1 回で選んで直し始め、ほかの行へ移れる', () => {
  const { e } = make();
  const rows = () => e.el.querySelectorAll('tbody tr');
  expect(rows()[0].querySelector<HTMLInputElement>('.cap-input')!.value).toBe('えっ待って');
  // 入力欄の外（文字数）をクリック：選ぶだけ
  rows()[1].querySelector('.count')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  expect(e.cap).toBe(1);
  expect(e.editingText()).toBe(false);
  // 入力欄をクリック：選んで直し始める
  const input = rows()[1].querySelector<HTMLInputElement>('.cap-input')!;
  input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  input.focus();
  expect(e.cap).toBe(1);
  expect(e.editingRow).toBe(1);
  input.value = '待ってよ';
  input.dispatchEvent(new Event('input'));
  // 別の行の入力欄をクリック：前の行を確定し、その行を直し始める（一覧は作り直さない）
  const other = rows()[0].querySelector<HTMLInputElement>('.cap-input')!;
  other.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  other.focus();
  expect(e.captions[1].text).toBe('待ってよ');
  expect(e.editingRow).toBe(0);
  expect(other.isConnected).toBe(true);
  expect(document.activeElement).toBe(other);
});

test('「ショートを作る」：前の serve（ショートの API が無い）では、movie-editer を新しくするよう知らせる', async () => {
  const fake = new FakeServe();
  const orig = fake.transport;
  fake.transport = async (url, method, body, t) =>
    url.endsWith('/short') ? { status: 404, body: JSON.stringify({ error: '見つかりません' }) } : orig(url, method, body, t);
  const { e, dialogs } = make(fake);
  expect(await e.makeShort()).toBe(false);
  expect(dialogs.shown.at(-1)!.slice(0, 2)).toEqual(['warn', 'ショートを作れませんでした']);
  expect(dialogs.shown.at(-1)![2]).toContain('movie-editer を新しく');
});

test('「ショートを作る」：保存してからショートを作り、パネルがプロジェクトを作り終えるまで待って知らせる', async () => {
  const fake = new FakeServe();
  fake.premiere = ['queued', 'running', 'done'];
  fake.premiereMessage = 'プロジェクトを作りました: 20261017_topic_02_short_r0002.prproj';
  const { e, dialogs } = make(fake);
  e.deleteClip('keep', 1);
  expect(await e.makeShort()).toBe(true);
  expect(fake.saved.length).toBe(1);
  expect(fake.shorts).toEqual([2]);
  const [kind, title, msg] = dialogs.shown.at(-1)!;
  expect([kind, title]).toEqual(['info', 'Premiere のプロジェクトを作りました']);
  expect(msg).toContain('41.3 秒');
  expect(msg).toContain('short_r0002.prproj');
  const btn = [...e.el.querySelectorAll('button')].find((b) => b.title.includes('.prproj'))!;
  expect(btn.disabled).toBe(false);
  expect(btn.textContent).toBe('ショートを作る');
});

test('「ショートを作る」：作れなかった・Premiere が開いていないときも知らせる', async () => {
  const fake = new FakeServe();
  fake.premiere = ['running', 'error'];
  fake.premiereMessage = 'XML を読み込めませんでした';
  let { e, dialogs } = make(fake);
  await e.makeShort();
  expect(dialogs.shown.at(-1)!.slice(0, 2)).toEqual(['warn', 'Premiere のプロジェクトを作れませんでした']);
  expect(dialogs.shown.at(-1)![2]).toContain('XML を読み込めませんでした');

  const idle = new FakeServe();
  idle.premiere = ['queued'];
  ({ e, dialogs } = make(idle, { premiereWaitMs: 5 }));
  await e.makeShort();
  expect(dialogs.shown.at(-1)!.slice(0, 2)).toEqual(['info', 'ショートの XML と字幕を作りました']);
  expect(dialogs.shown.at(-1)![2]).toContain('20261017_topic_02_short_r0001.prproj');
});

test('再生中・フレーム送り・タイムラインのクリックで、字幕の一覧の選択がいまの位置の字幕に付いていく', () => {
  const { e } = make();
  e.cap = -1;
  e.render();
  e.seekClick(605); // タイムラインのクリック
  expect(e.cap).toBe(1);
  expect(e.el.querySelectorAll('tbody tr')[1].classList.contains('sel')).toBe(true);
  press(e, 'Enter'); // 頭へ（字幕 0 の所）
  press(e, 'ArrowRight');
  expect(e.cap).toBe(0);
  // 再生中は位置が届くたびに付いていく
  e.playing = true;
  e.seek(610, true);
  expect(e.cap).toBe(1);
  // 字幕の無い所では前に選んだ字幕のまま
  e.setMode('source');
  e.seek(450, true);
  expect(e.cap).toBe(1);
  e.playing = false;
  // 位置を動かすだけ（seek）では付いていかない（一覧の行をクリックして選んだ字幕を保つ）
  e.clickCap(0);
  e.seek(610);
  expect(e.cap).toBe(0);
});

test('字幕の文字を入力している間は、選択を動かさない', () => {
  const { e } = make();
  e.editCaption(0);
  expect(e.editingText()).toBe(true);
  e.playing = true;
  e.seek(610, true);
  expect(e.cap).toBe(0);
  e.playing = false;
});

test('ショートの再生：いまの位置からの並び（区間の順。隣り合う区間はまとめる）を Player に渡し、最後で止まる', () => {
  const { e, player } = make();
  e.data.media.video = '/media/20261017/video';
  e.doc.keeps = [
    { start: 300, end: 360 },
    { start: 360, end: 400 },
    { start: 600, end: 630 },
  ];
  e.seek(330);
  e.play();
  expect(player.playing).toBe(true);
  const plan = player.plans.at(-1)!;
  expect(plan.map((g) => [g.s * 30, g.e * 30].map(Math.round))).toEqual([
    [330, 400],
    [600, 630],
  ]);
  e.tick(370.2 / 30);
  expect(e.src).toBe(370);
  expect(e.playKeep).toBe(1);
  e.tick(605 / 30);
  expect([e.src, e.playKeep]).toEqual([605, 2]);
  // 再生中に区間を直したら、いまの位置から並びを作り直す
  e.change([{ start: 600, end: 700 }]);
  expect(player.plans.at(-1)!.map((g) => [g.s * 30, g.e * 30].map(Math.round))).toEqual([[605, 700]]);
  player.onEnded?.();
  expect(e.playing).toBe(false);
  expect(e.src).toBe(699);
});

test('元動画の表示の再生は、いまの位置から最後まで', () => {
  const { e, player } = make();
  e.data.media.video = '/media/20261017/video';
  e.setMode('source');
  e.seek(450);
  e.play();
  expect(player.plans.at(-1)).toEqual([{ s: 15, e: Infinity }]);
});

test('区間の音声（serve の /audio）を読んで Player に渡す', async () => {
  const fake = new FakeServe();
  const player = new FakePlayer();
  const data = structuredClone(TOPIC);
  data.media.video = '/media/20261017/video';
  data.media.audio = '/api/v/20261017/t/2/audio';
  open.push(new Editor(fake.api(), '20261017', 2, data, null, { player, dialogs: new FakeDialogs() }));
  await vi.waitFor(() => expect(player.audio).not.toBeNull());
  expect(player.audio![1]).toBe(5);
  expect(fake.bytesUrls).toEqual(['http://127.0.0.1:8765/api/v/20261017/t/2/audio?start=5.000&end=25.000']);
});

test('動画の場所：確認用の動画があればそちら、無ければ元動画。どちらも無ければ知らせる', () => {
  const fake = new FakeServe();
  const player = new FakePlayer();
  const data = structuredClone(TOPIC);
  data.media = { video: '/media/朝/video', 'proxy.mp4': null, 'peaks.json': null };
  open.push(new Editor(fake.api(), '朝', 2, data, null, { player, dialogs: new FakeDialogs() }));
  expect(player.source).toBe('http://127.0.0.1:8765/media/%E6%9C%9D/video');
  const { e } = make();
  expect(e.message).toContain('元動画が見つかりません');
});
