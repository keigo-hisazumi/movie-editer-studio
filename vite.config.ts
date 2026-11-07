import { defineConfig } from 'vite';

declare const process: { env: Record<string, string | undefined> }; // @types/node を入れずに環境変数を読む

// Mac で `npm run dev` で開く。ファイルの読み書きと動画は movie-editer の serve（既定 http://localhost:8765）に任せ、
// /api と /media をそこへ転送する（同じオリジンになるので CORS の設定は要らない）
const SERVE = process.env.STUDIO_SERVE ?? 'http://localhost:8765';

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? '/',
  server: {
    port: 5173,
    proxy: { '/api': SERVE, '/media': SERVE },
  },
});
