# movie-editer-studio

movie-editer の AI が作ったカットと字幕を、Filmora を使わずに人がフレーム単位で直す Mac・Windows のアプリです。

## 主な機能

- movie-editer の `shorts serve` につなぎ、動画ごとのトピックの一覧から開く（この PC の serve が動いていなければアプリが起動する）
- 元動画を見ながら、ショート（外した所を飛ばす）と元動画（そのまま）の 2 通りで再生する。ショートは編集ソフトと同じく区間の切れ目で止まらずにつなぐ（音はトピックの区間の音声を先に読んで切れ目ぴったりに並べて鳴らし、映像は 2 つの動画を入れ替える。音声は serve の `/audio` から。前の serve には無いので、そのときは動画の音で再生する）
- 動画編集ソフトのようなタイムライン（目盛り・字幕・映像・音声の波形）で、区間と字幕の長さをドラッグで変える
- 区間と字幕の分割・削除、字幕の文字の直し・分ける・つなぐ・足す
- 再生中・フレーム送りで、字幕の一覧の選択がいまの位置の字幕に付いていく
- 直したカットと字幕を `topic_XX/edit.json` の新しい版として保存する（movie-editer-schema の形を確かめてから）
- 「ショートを作る」で、縦型レイアウト・字幕・BGM・効果音・画像・画面の文字を付けたショートを Premiere のプロジェクト（.prproj）として作る

## 入れ方

GitHub の Releases の「[最新版](https://github.com/keigo-hisazumi/movie-editer-studio/releases/tag/latest)」からダウンロードします。main にマージするたびに自動で置き直すので、いつも同じリンクで最新のアプリが取れます（GitHub にログインした状態で開きます）。

- Mac：[movie-editer-studio-mac.zip](https://github.com/keigo-hisazumi/movie-editer-studio/releases/download/latest/movie-editer-studio-mac.zip)
- Windows：[movie-editer-studio-windows.zip](https://github.com/keigo-hisazumi/movie-editer-studio/releases/download/latest/movie-editer-studio-windows.zip)

1 回展開するとアプリが出てきます（Mac の Safari では自動で展開されます）。署名していないので、初回は Mac なら右クリック ▸ 開く、Windows なら「詳細情報 ▸ 実行」で開きます。Windows は WebView2（Windows 10・11 に入っている）を使います。

## 使い方

1. movie-editer でトピックのカットを作る（`/cut`。波形も作られる）。アプリは元動画（`topic_XX/cut.json` の場所）をそのまま再生する
2. アプリを開き、つなぐ serve を設定する
   - Mac（movie-editer と同じ PC）：「movie-editer のフォルダ」を選ぶ。serve が動いていなければアプリが起動し、アプリを閉じると止める（ターミナルで起動した serve はそのまま使う）
   - Windows など別の PC：Mac で `.venv/bin/python -m shorts serve --lan` を起動し、そのとき出る URL（例 `http://<名前>.local:8765`）を「serve の URL」に入れる
3. トピックをダブルクリックで開いて直し、保存する（`topic_XX/edit.json` の新しい版になる。前の版は `topic_XX/edits/` に残る。ほかで保存されていたら保存せずに知らせる）
4. 直し終わったら「ショートを作る」を押す（movie-editer の `shorts short <動画パス> <トピックID>` と同じ。Premiere を開き、movie-editer-premiere のパネルを入れておく）

## 動画が再生できないとき

アプリは OS の WebView（Mac は Safari と同じ WebKit、Windows は Edge と同じ WebView2）の `<video>` で再生します。

- Windows で元動画（iPhone の画面録画の HEVC）が再生できないときは、「HEVC ビデオ拡張機能」を Microsoft Store から入れるか、movie-editer で確認用の動画（H.264・30fps・高さ 960）を作る。あればアプリはそちらを使う

  ```bash
  .venv/bin/python -m shorts proxy <動画パス>
  ```

- 元動画の再生・コマ送りが重いときも、同じく確認用の動画を作る
- アプリだけで再生できるかは、ターミナルで次を実行すると確かめられる（結果はいまのフォルダの `self-check.log` にも書く）

  ```bash
  # Mac
  "/Applications/movie-editer studio.app/Contents/MacOS/"* --self-check <動画>
  # Windows（PowerShell）
  & ".\movie-editer studio.exe" --self-check <動画>
  ```

- 一覧からトピックを開けないなど思わぬエラーは、理由を画面に出し、記録にも書く（Mac は `~/Library/Logs/movie-editer studio.log`、Windows は `%LOCALAPPDATA%\io.github.keigo-hisazumi.movie-editer-studio\movie-editer studio.log`。画面に場所が出る）

## 操作

再生は「ショート」（外した所を飛ばす）と「元動画」（そのまま）の 2 通りです。

- 共通：`Space` 再生・停止（字幕の文字の入力中以外。日本語入力がオンでも効く）、`←` `→` 1 フレーム（`Shift` で 10 フレーム）、`Return` タイムラインの頭へ、`B` いまの位置で区間と字幕を分割、`Shift` + `Z` タイムラインの全体を表示、`Tab` ショートと元動画の切り替え、`Ctrl`（`⌘`）+ `Z` 取り消し、`Ctrl`（`⌘`）+ `S` 保存（メモは聞かない）
- タイムライン（目盛り・字幕・映像・音声の波形）：クリック・ドラッグでその位置へ動き、字幕をクリックするとその字幕を選ぶ。字幕・映像・音声のクリップの端をドラッグすると長さを変えられる（カーソルが頭は [、終わりは ] になる。隣り合う境目では、マウスがある側のクリップを動かす。映像・音声は残す区間。ショートの表示では後ろが詰まる。字幕をほかの字幕に重ねると、重なった方の字幕の重なる所が削られ、すっぽり重なった字幕は消える）。映像・音声のクリップをダブルクリックすると選ばれ（白い枠）、`Delete` でその区間を消せる（最後の 1 つは消さない。`Esc` で選ぶのをやめる）。字幕のクリップをダブルクリックすると、右上の一覧でその字幕の文字を直し始める。ホイールで横にスクロール、`T`（拡大）・`R`（縮小）・`Ctrl`（`⌘`）+ ホイール・右下のつまみで拡大・縮小（ホイールの向きは一般のソフトと逆）、「全体」で全体を表示
- 区間：`[` `]` でいまの区間の頭・終わりをいまの位置に
- 右上の字幕の一覧：クリックで選び、ダブルクリックでその場で文字を直す（`Return` で確定、`Esc` で直す前に戻す。9 文字を超えると文字数が色付きになる）。`I` `O` 選んだ字幕（無ければいま出ている字幕）の頭・終わりをいまの位置に、`/` いまの位置で分ける（文字は直していた欄のカーソルの位置、無ければ長さの比で分ける）、`N` いまの位置に 1 秒の字幕を足す、`Delete` 選んだ字幕を消す、「次とつなぐ」。再生中・フレーム送り・タイムラインのクリックで位置が動くと、選んだ字幕（一覧の選択とタイムラインの字幕の枠）がいまの位置の字幕に付いていき、一覧はその行が真ん中に来るようにスクロールする（字幕の無い所では前の字幕のまま。字幕の文字を入力している間は動かさない）
- 動画の上に、いま出ている字幕を重ねて出す（ショートの表示では外した所の字幕は出さない）
- 字幕は元動画のフレームで持つので、あとでカットを直しても元の発話に付いたまま。字幕だけを直して保存した版は `step: captions`、カットも直した版は `step: cut`
- 「ショートを作る」：いまのカットと字幕から、serve が movie-editer の `short` と同じショート（`<動画名>_topic_XX_short_Edit.xml`（縦型レイアウト・BGM・効果音・画像・画面の文字）・`edit.srt`）を `topic_XX/` に作り直し（字幕・画面の文字は、movie-editer-premiere のテンプレート（.mogrt）から Premiere で編集できるテキストとして入れる。保存していない変更は先に保存する。BGM・効果音・画像は `cuts.yaml` のそのトピックの項目で、効果音・画像がまだ無ければ serve が Claude Code に決めてもらう。そのときは数分かかる）、Premiere の拡張パネル（[movie-editer-premiere](https://github.com/keigo-hisazumi/movie-editer-premiere)）がそこから Premiere のプロジェクト `<動画名>_topic_XX_short_rNNNN.prproj` を作るのを最長 60 秒待って結果を知らせる。版ごとに別のファイルなので、Premiere で仕上げたプロジェクトは上書きしない。Premiere が開いていなければ、次に開いたときに作られる（movie-editer の serve がショートの API（`POST /api/v/<動画名>/t/<ID>/short`）を持っている必要がある）

## 技術スタック

- Tauri（Mac は WKWebView、Windows は WebView2）
- Rust（serve への HTTP・serve の起動と停止・記録・self-check）
- TypeScript・Vite（画面。フレームワークは使わない）
- Ajv（movie-editer-schema の EditDoc の検査。ビルドのときに検査の関数を作る）
- Vitest・jsdom（テスト）
- GitHub Actions・GitHub Releases（Mac・Windows のアプリの書き出しと配布）

## 開発

### 必要な環境

- Node.js 22
- Rust（stable）
- Tauri の前提（Mac は Xcode の Command Line Tools、Windows は WebView2 と Visual Studio の C++ ビルドツール、Linux は `libwebkit2gtk-4.1-dev` など）

### コマンド

```bash
npm ci
npm run tauri dev       # アプリを開発用に起動する（画面は書き換えるとすぐ反映）
npm run tauri build     # アプリを書き出す
npm test                # 画面のテスト（Vitest）
npm run type-check      # 型チェック
npm run build           # 画面だけをビルドする
cd src-tauri && cargo test && cargo clippy --all-targets   # アプリ側のテストと Lint
```

## ディレクトリ構成

```text
src/
  main.ts            一覧と編集画面の切り替え・閉じる前の確かめ・思わぬエラーの記録
  selfcheck.ts       --self-check（書き出したアプリで動画を再生できるか）
  editor/editor.ts   編集画面（再生・字幕の一覧・キー・保存・書き出し）
  editor/track.ts    下のタイムライン（canvas）
  editor/player.ts   動画の再生（<video> を 2 つ入れ替える・音は Web Audio で区間の順に鳴らす）
  lib/plan.ts        再生の並び（区間を再生する順に）
  lib/timeline.ts    区間と字幕のフレームの計算（movie-editer の shorts/edit.py と同じ数え方）
  lib/api.ts         serve の API
  lib/native.ts      Rust 側に頼むこと
  ui/home.ts         設定とトピックの一覧
src-tauri/
  src/lib.rs         serve への HTTP・記録・self-check の入口
  src/serve.rs       serve の起動と停止
  src/selfcheck.rs   self-check の HTTP サーバー（Range 対応）
  tauri.conf.json    アプリの設定（ウィンドウ・CSP・書き出し）
tests/               画面のテスト（serve と再生は偽物に差し替える）
tests/data/          self-check で再生する動画
```

## デプロイ

- `.github/workflows/build.yml` が PR と main への push のたびに Mac の .app と Windows の .exe を書き出し、`--self-check` で動画を再生できるか確かめる
- main への push（マージ）のときは、Releases の「最新版」（タグ `latest`）の `movie-editer-studio-mac.zip`・`movie-editer-studio-windows.zip` を置き直す

## 開発ルール

[`AGENTS.md`](./AGENTS.md)（正本）を参照してください。

## ライセンス

MIT
