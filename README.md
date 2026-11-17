# movie-editer-studio

movie-editer（`shorts`）の AI が作ったカットと字幕を、Filmora を使わずに人がフレーム単位で直す Mac・Windows のアプリです（Qt / PySide6）。ファイルの読み書きは movie-editer の `shorts serve` の API に頼み、このアプリは表示と操作だけを持ちます。

## 入れ方

GitHub の Actions の「Build」の成果物（Artifacts）から、Mac は `movie-editer-studio-mac.zip`、Windows は `movie-editer-studio-windows.zip` をダウンロードし、1回展開するとアプリが出てきます（Mac の Safari では自動で展開されます）。署名していないので、初回は Mac なら右クリック ▸ 開く、Windows なら「詳細情報 ▸ 実行」で開きます。

ソースから動かすとき（Python 3.12）：

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install -e ".[dev]"
.venv/bin/python -m studio
```

## 使い方

1. movie-editer でトピックのカットを作る（`/cut`。波形も作られる）。アプリは元動画（`topic_XX/cut.json` の場所）をそのまま再生する
   - 元動画の再生・コマ送りが重いときだけ、確認用の動画（30fps・高さ 960）を作る。あればアプリはそちらを使う

     ```bash
     .venv/bin/python -m shorts proxy <動画パス>
     ```

2. アプリを開き、つなぐ serve を設定する
   - Mac（movie-editer と同じ PC）：「movie-editer のフォルダ」を選ぶ。serve が動いていなければアプリが起動し、アプリを閉じると止める（ターミナルで起動した serve はそのまま使う）
   - Windows など別の PC：Mac で `.venv/bin/python -m shorts serve --lan` を起動し、そのとき出る URL（例 `http://<名前>.local:8765`）を「serve の URL」に入れる
3. トピックをダブルクリックで開いて直し、保存する（`topic_XX/edit.json` の新しい版になる。前の版は `topic_XX/edits/` に残る。ほかで保存されていたら保存せずに知らせる）
4. 直し終わったら movie-editer で Filmora・Premiere 用の XML と字幕を書き出す

   ```bash
   .venv/bin/python -m shorts export <動画パス> <トピックID>
   ```

## 操作

再生は「ショート」（外した所を飛ばす）と「元動画」（そのまま）の 2 通りです。

- 共通：`Space` 再生・停止（字幕の文字の入力中以外。日本語入力がオンでも効く）、`←` `→` 1 フレーム（`Shift` で 10 フレーム）、`Return` タイムラインの頭へ、`B` いまの位置で区間と字幕を分割、`Shift` + `Z` タイムラインの全体を表示、`Tab` ショートと元動画の切り替え、`Ctrl`（`⌘`）+ `Z` 取り消し、`Ctrl`（`⌘`）+ `S` 保存（メモは聞かない）。下のタイムライン（目盛り・字幕・映像・音声の波形）をクリック・ドラッグするとその位置へ動き、字幕をクリックするとその字幕を選ぶ。字幕・映像・音声のクリップの端をドラッグすると長さを変えられる（カーソルが頭は [、終わりは ] になる。隣り合う境目では、マウスがある側のクリップを動かす。映像・音声は残す区間。ショートの表示では後ろが詰まる。字幕をほかの字幕に重ねると、重なった方の字幕の重なる所が削られ、すっぽり重なった字幕は消える）。映像・音声のクリップをダブルクリックすると選ばれ（白い枠）、`Delete` でその区間を消せる（最後の 1 つは消さない。`Esc` で選ぶのをやめる）。字幕のクリップをダブルクリックすると、右上の一覧でその字幕の文字を直し始める。ホイールで横にスクロール、`T`（拡大）・`R`（縮小）・`Ctrl`（`⌘`）+ ホイール・右下のつまみで拡大・縮小（ホイールの向きは一般のソフトと逆）、「全体」で全体を表示
- 区間：`[` `]` でいまの区間の頭・終わりをいまの位置に
- 右上の字幕の一覧：クリックで選び、ダブルクリックでその場で文字を直す（9 文字を超えると文字数が色付きになる）。`I` `O` 選んだ字幕（無ければいま出ている字幕）の頭・終わりをいまの位置に、`/` いまの位置で分ける（文字は直していた欄のカーソルの位置、無ければ長さの比で分ける）、`N` いまの位置に 1 秒の字幕を足す、`Delete` 選んだ字幕を消す、「次とつなぐ」。再生中・フレーム送り・タイムラインのクリックで位置が動くと、選んだ字幕（一覧の選択とタイムラインの字幕の枠）がいまの位置の字幕に付いていき、一覧はその行が真ん中に来るようにスクロールする（字幕の無い所では前の字幕のまま。字幕の文字を入力している間は動かさない）
- 動画の上に、いま出ている字幕を重ねて出す（ショートの表示では外した所の字幕は出さない）
- 字幕は元動画のフレームで持つので、あとでカットを直しても元の発話に付いたまま。字幕だけを直して保存した版は `step: captions`、カットも直した版は `step: cut`
- 保存する前に movie-editer-schema の `EditDoc` の形を確かめる
- 「XML に書き出す」：いまのカットと字幕を、Filmora・Premiere 用の XML（`<動画名>_topic_XX_studio.xml`）と `studio.srt` に書き出し直す（serve が `topic_XX/` に書く。保存していない変更は先に保存する。movie-editer の serve が書き出しの API（`POST /api/v/<動画名>/t/<ID>/export`）を持っている必要がある）
- 動画を開けない・再生できないときは、動画の所に理由を出す。アプリだけで再生できるかは、ターミナルで `"/Applications/movie-editer studio.app/Contents/MacOS/movie-editer studio" --self-check <確認用の動画>` を実行すると確かめられる（結果はいまのフォルダの `self-check.log` にも書く）
- 一覧からトピックを開けないなど思わぬエラーは、理由を画面に出し、記録にも書く（Mac は `~/Library/Logs/movie-editer studio.log`、Windows は `%LOCALAPPDATA%\movie-editer\movie-editer studio\movie-editer studio.log` あたり。画面に場所が出る）

## 開発

- `studio/timeline.py`：区間と字幕のフレームの計算（movie-editer の `shorts/edit.py` と同じ数え方）
- `studio/editor.py`：編集の画面、`studio/app.py`：一覧と設定、`studio/api.py`：serve の API、`studio/server.py`：serve の起動、`studio/track.py`：下のタイムライン
- テスト：`QT_QPA_PLATFORM=offscreen STUDIO_NO_AUDIO=1 .venv/bin/python -m pytest`、Lint：`.venv/bin/python -m ruff check .`
- `.github/workflows/build.yml` が Mac・Windows のアプリを書き出す（PyInstaller）

---

## テンプレートについて

このリポジトリは新しいプロジェクト用のテンプレートです。AI アシスタント向けの指示書、Issue / PR テンプレート、CI/CD の雛形、エディタ設定、各種ドット・ガバナンスファイルを含みます。

## AI アシスタント運用方針

このテンプレートは **Claude をメインの AI アシスタント** として利用し、**GitHub Copilot をサブツール** として併用するワークフローを想定しています。開発ルールの **正本は [`AGENTS.md`](./AGENTS.md)** で、各ツール向けの指示書はそれを参照する構成です。

| ツール | ファイル | 役割 |
| --- | --- | --- |
| 汎用 AI エージェント | [`AGENTS.md`](./AGENTS.md) | **正本**。すべてのルールはここに集約 |
| Claude Code | [`CLAUDE.md`](./CLAUDE.md) | `AGENTS.md` を参照 |

## 含まれるもの

### AI 向け指示書

- `AGENTS.md` — **正本**（汎用 AI エージェント向け）
- `CLAUDE.md` — Claude Code 向け（`AGENTS.md` を参照）

### Issue / PR

- `.github/ISSUE_TEMPLATE/` — バグ報告 / 機能要望 / 質問テンプレート
- `.github/PULL_REQUEST_TEMPLATE.md` — PR テンプレート（日本語）
- `.github/CODEOWNERS` — レビュー自動アサイン
- `CONTRIBUTING.md` / `SECURITY.md` — 貢献ガイドとセキュリティポリシー

### CI/CD

- `.github/workflows/ci.yml` — PR 時の lint / typecheck / test / build（`package.json` がある場合のみ実行）
- `.github/workflows/actionlint.yml` — workflow 自体の Lint（公式バイナリをバージョン固定で実行。`.github/actionlint-matcher.json` でエラー行に注釈を付ける）
- `.github/workflows/markdownlint.yml` — Markdown の書き方チェック（ルールは `.markdownlint-cli2.jsonc`、内容は `AGENTS.md` の「Markdown の書き方」）
- `.github/workflows/codeql.yml` — セキュリティスキャン（workflow 定義は常に、JS/TS は ソースがある場合のみ解析）
- `.github/workflows/deploy.yml` — main への PR マージ時に GitHub Pages へデプロイ
- `.github/workflows/pr-preview.yml` — PR ごとのプレビュー環境（`pr-<番号>/`）を gh-pages にデプロイし、URL と QR コードをコメント
- `.github/workflows/release-drafter.yml` + `.github/release-drafter.yml` — main へのマージごとにリリースノート草案を更新（PR タイトルの Conventional Commits プレフィックスで分類）
- `.github/workflows/pr-title.yml` — PR タイトルが Conventional Commits 形式（例: `feat: 〜`）かを検証
- `.github/workflows/screenshot.yml` — PR スクリーンショット用 Playwright 雛形
- `.github/dependabot.yml` — 依存関係の自動更新

### 環境差異の吸収

- `.editorconfig` — エディタ間のインデント／改行統一
- `.markdownlint-cli2.jsonc` — Markdown の書き方ルール
- `.gitattributes` — テキスト/バイナリ・改行コードの正規化
- `.gitignore` — OS / 言語 / ビルド成果物
- `.vscode/extensions.json`, `.vscode/settings.json` — VSCode 推奨拡張・設定

### その他

- `LICENSE` — MIT

## テンプレートの使い方

1. このテンプレートから新しいリポジトリを作成（GitHub の **Use this template** ボタン、または clone）。
2. `README.md` を `AGENTS.md` の「README の構成」に沿って書き換え、`CODEOWNERS`、`LICENSE` のプロジェクト名や著作権者を書き換える。
3. 言語/フレームワークが決まったら以下を有効化:
   - `.github/workflows/ci.yml` は `lint` / `type-check` / `build` の npm script を実行する（`lint` / `type-check` はスクリプトがなければスキップ、`build` は必須）。テストを追加したら Test ジョブのプレースホルダーを差し替える
   - `.github/workflows/codeql.yml` で JS/TS 以外の言語を解析する場合は detect ジョブの判定を追加
   - `.github/workflows/deploy.yml` / `pr-preview.yml` のベースパス変数名（既定は Vite の `VITE_BASE_PATH`）と `publish_dir` を確認
   - Vite の場合は `vite.config.ts` に `base: process.env.VITE_BASE_PATH ?? '/'` を追加する（未設定だと GitHub Pages 上でアセットが 404 になり画面が真っ白になる）
   - `.github/workflows/screenshot.yml` は Playwright 導入後、リポジトリ変数 `ENABLE_SCREENSHOT` を `true` に設定して有効化
   - `.github/dependabot.yml` の対応する `package-ecosystem` のコメントアウトを外す（typescript-eslint を使わない場合は typescript の `ignore` を削除）
4. **リポジトリ作成後の手動設定**（テンプレートに含められないため `README` で案内）:
   - `main` ブランチ保護ルールを設定（PR 必須、CI パス必須、force push 禁止）
   - GitHub Actions の権限を `Read and write` 許可（Release Drafter / GitHub Pages デプロイ / PR プレビュー用）
   - GitHub Pages のソースを `gh-pages` ブランチに設定（`deploy.yml` / `pr-preview.yml` を使う場合）
   - Secret スキャン / Dependabot Alerts を有効化

## VSCode 環境

VSCode をエディタとして使うワークフローを想定しています。`.vscode/extensions.json` に記載の拡張をインストールすると、Lint / Format / Spell check が即座に動きます。

## ライセンス

MIT
