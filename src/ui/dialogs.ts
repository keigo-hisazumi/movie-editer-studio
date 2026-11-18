/**
 * 画面の中に出す知らせ・確かめ（ネイティブのダイアログは OS ごとに出方が違うので、自分で描く）。
 * 出ている間は、編集画面のキー（Space など）を効かせない（isOpen）。
 */
import { esc } from '../lib/fmt';

export type SaveAnswer = 'save' | 'discard' | 'cancel';

export interface Dialogs {
  info(title: string, msg: string): Promise<void>;
  warn(title: string, msg: string): Promise<void>;
  error(title: string, msg: string, detail?: string): Promise<void>;
  /** 保存していない変更があるとき：保存する・保存しない・やめる */
  askSave(): Promise<SaveAnswer>;
}

export const isOpen = (): boolean => document.querySelector('.modal-back') !== null;

interface Button<T> {
  label: string;
  value: T;
  primary?: boolean;
}

function open<T>(kind: 'info' | 'warn' | 'error', title: string, msg: string, buttons: Button<T>[], cancel: T, detail?: string): Promise<T> {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    const box = document.createElement('div');
    box.className = `modal modal-${kind}`;
    box.setAttribute('role', 'dialog');
    box.innerHTML =
      `<h2>${esc(title)}</h2><p class="modal-msg">${esc(msg)}</p>` +
      (detail ? `<details><summary>詳しく</summary><pre>${esc(detail)}</pre></details>` : '');
    const row = document.createElement('div');
    row.className = 'modal-buttons';
    const close = (v: T): void => {
      document.removeEventListener('keydown', onKey, true);
      back.remove();
      resolve(v);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(cancel);
      } else if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        close((buttons.find((b) => b.primary) ?? buttons[0]).value);
      }
    };
    for (const b of buttons) {
      const el = Object.assign(document.createElement('button'), { textContent: b.label });
      if (b.primary) el.className = 'primary';
      el.addEventListener('click', () => close(b.value));
      row.append(el);
    }
    box.append(row);
    back.append(box);
    document.body.append(back);
    document.addEventListener('keydown', onKey, true);
    (row.querySelector<HTMLButtonElement>('.primary') ?? row.querySelector('button'))?.focus();
  });
}

export const domDialogs: Dialogs = {
  info: (title, msg) => open('info', title, msg, [{ label: 'OK', value: undefined, primary: true }], undefined),
  warn: (title, msg) => open('warn', title, msg, [{ label: 'OK', value: undefined, primary: true }], undefined),
  error: (title, msg, detail) => open('error', title, msg, [{ label: 'OK', value: undefined, primary: true }], undefined, detail),
  askSave: () =>
    open<SaveAnswer>(
      'warn',
      '保存していない変更',
      '保存していない変更があります。保存しますか？',
      [
        { label: 'キャンセル', value: 'cancel' },
        { label: '保存しない', value: 'discard' },
        { label: '保存', value: 'save', primary: true },
      ],
      'cancel',
    ),
};
