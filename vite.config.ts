/// <reference types="vitest/config" />
import Ajv from 'ajv';
import standaloneCode from 'ajv/dist/standalone/index.js';
import schema from 'movie-editer-schema/schema.json';
import { defineConfig, type Plugin } from 'vite';

/**
 * movie-editer-schema の EditDoc を検査する関数を、ビルドのときに JavaScript にしておく（virtual:editdoc-validator）。
 * Ajv はふだん実行時に new Function で検査の関数を作るが、アプリの CSP は eval を許さないので、先に作る
 */
function editDocValidator(): Plugin {
  const id = 'virtual:editdoc-validator';
  return {
    name: 'editdoc-validator',
    resolveId: (s) => (s === id ? '\0' + id : null),
    load(s) {
      if (s !== '\0' + id) return null;
      // schema.json は draft-07。format（date-time など）は movie-editer の検査に任せ、ここでは形だけを見る
      const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false, code: { source: true, esm: true } });
      const validate = ajv.compile({ $ref: '#/definitions/EditDoc', definitions: schema.definitions });
      return standaloneCode(ajv, validate);
    },
  };
}

// Tauri の画面（src-tauri/tauri.conf.json の devUrl・frontendDist と合わせる）
export default defineConfig({
  plugins: [editDocValidator()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    // Mac は Safari（WKWebView）、Windows は Edge（WebView2）で動く
    target: ['safari15', 'chrome105'],
    outDir: 'dist',
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
});
