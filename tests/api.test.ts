import { expect, test } from 'vitest';
import { Api, ApiError, localPort } from '../src/lib/api';
import { validate } from '../src/lib/validate';
import { EDIT, FakeServe } from './fake';

test('serve の API', async () => {
  const fake = new FakeServe();
  const api = fake.api('http://127.0.0.1:8765/');
  expect(await api.alive()).toBe(true);
  expect((await api.videos())[0].name).toBe('20261017');
  expect((await api.topic('20261017', 2)).edit.revision).toBe(1);
  expect(api.url('/media/x/proxy.mp4')).toBe('http://127.0.0.1:8765/media/x/proxy.mp4');
  const saved = await api.save('20261017', 2, 1, { ...EDIT, keeps: [] });
  expect(saved.revision).toBe(2);
  expect(fake.saved[0].base_revision).toBe(1);
  await expect(api.save('20261017', 2, 1, EDIT)).rejects.toMatchObject({ status: 409, message: 'いまは版 2 です' });
  await expect(api.topic('nope', 1)).rejects.toMatchObject({ status: 404 });
});

test('つながらないとき', async () => {
  const api = new FakeServe().api('http://127.0.0.1:9');
  expect(await api.alive()).toBe(false);
  const e = await api.videos().catch((x: unknown) => x);
  expect(e).toBeInstanceOf(ApiError);
  expect((e as ApiError).status).toBe(0);
  expect((e as ApiError).message).toContain('つながりません');
});

test('この PC の serve だけ起動する', () => {
  expect(localPort('http://127.0.0.1:8765')).toBe(8765);
  expect(localPort('http://localhost:9000/')).toBe(9000);
  expect(localPort('http://mac.local:8765')).toBeNull(); // ほかの PC の serve は起動しない
});

test('日本語の動画名の URL も送れる形にする（serve は /media/<動画名>/... をそのまま返す）', async () => {
  const api = new Api('http://127.0.0.1:8765');
  expect(api.url('/media/朝配信/peaks.json')).toBe('http://127.0.0.1:8765/media/%E6%9C%9D%E9%85%8D%E4%BF%A1/peaks.json');
  expect(api.url('/api/v/%E6%9C%9D/t/1')).toBe('http://127.0.0.1:8765/api/v/%E6%9C%9D/t/1');
  const fake = new FakeServe();
  await fake.api().topic('朝 配信', 1).catch(() => undefined);
  expect(fake.calls.at(-1)!.url).toBe('http://127.0.0.1:8765/api/v/%E6%9C%9D%20%E9%85%8D%E4%BF%A1/t/1');
});

test('edit.json の形を確かめる（movie-editer-schema の EditDoc）', () => {
  expect(validate(EDIT)).toEqual([]);
  expect(validate({ format: 1 }).length).toBeGreaterThan(0);
  expect(validate({ ...EDIT, fps: '30' }).join()).toContain('fps');
});
