# Notion Chat Memo

チャット感覚で送ったメッセージを、Notionデータベースの新規ページとして保存するWebアプリです。
GitHub Pages（静的ホスティング）で動作します。

- 本文の1行目 → ページタイトル、メッセージ全体 → 本文の段落ブロック
- 画像・PDF・動画・音声・その他ファイルを添付（📎／貼り付け／ドラッグ&ドロップ）→ Notionへアップロードして埋め込み
- ルームごとに「書き込み先DB」「プロパティ書き込み（固定値／今日の日付／現在の日時）」を設定
- トークン・DB ID・ルーム・履歴はブラウザ（localStorage）にのみ保存

## ファイル構成
| ファイル | 内容 |
|---|---|
| index.html / style.css / app.js | アプリ本体（GitHub Pagesに置く） |
| manifest.webmanifest / sw.js | PWA設定・オフライン用アプリシェル |
| icons/ | ファビコン・PWA・ホーム画面用アイコン |
| worker.js | Notion API中継（Cloudflare Workers用 CORSプロキシ） |

## なぜ中継が必要？
Notion APIはブラウザからの直接呼び出し（CORS）を許可していないため、GitHub Pagesだけでは通信できません。
`worker.js` はリクエストをNotionへ転送するだけで、トークン等は保存・記録しません。

## セットアップ
### 1. Notionインテグレーション
1. https://www.notion.so/profile/integrations で「内部インテグレーション」を作成し、トークンを控える
2. 機能で「コンテンツの読み取り／挿入」を有効にする
3. 書き込みたいデータベースを開き「…」→「接続」からインテグレーションを追加

### 2. 中継（Cloudflare Workers・無料枠で可）
1. Cloudflare ダッシュボード → Workers & Pages → Create → 「Hello World」Worker を作成
2. コードを `worker.js` の内容に置き換えてデプロイ
3. Settings → Variables に `ALLOWED_ORIGINS` = `https://<ユーザー名>.github.io` を追加（推奨）
4. 発行されたURL（例 `https://notion-proxy.xxx.workers.dev`）を控える

### 3. GitHub Pages
1. リポジトリに `index.html` `style.css` `app.js` `manifest.webmanifest` `sw.js` と `icons/` フォルダをアップロード
2. Settings → Pages → Branch: `main` / `(root)` で公開
3. HTTPSで公開後、ブラウザーで開くとPWAのアプリシェルが登録されます。Notionへの送信にはインターネット接続が必要です。

### 4. アプリの初期設定
1. 「⚙️ 共通設定」でトークン、API中継URL、データベース（表示名＋IDまたはURL）を登録。◉でデフォルト指定、「確認」で接続テスト
2. 「＋ 新しいルーム」→ ルーム設定で使用DB（未指定ならデフォルト）とプロパティを設定

## プロパティ値
- 値の種類：**固定値** / **今日の日付** / **現在の日時**
- 固定値の中で `{{today}}` `{{now}}` が使えます
- マルチセレクト・リレーションはカンマ区切り、チェックボックスは `true`/`false`、日付の期間は `2026-10-01 → 2026-10-05`
- 「プロパティ一覧を取得」でプロパティ名の入力候補が出ます

## 操作
- 送信：送信ボタン または Ctrl/⌘ + Enter（Enterは改行）
- 失敗時は「再送」可能（添付付きはページを再読み込みすると再送不可）

## 注意
- トークンはlocalStorageに平文保存されます。共有PCでは使わないでください。
- 添付の上限はNotionのプランに依存（無料プランは1ファイル5MB）。20MB超は自動で分割アップロードします。


## PWAとしてインストール
- **iPhone / iPad**：Safariでアプリを開き、「共有」→「ホーム画面に追加」。
- **Android**：Chromeでアプリを開き、メニューの「アプリをインストール」または「ホーム画面に追加」。
- **PC**：Chrome / Edgeでアプリを開き、アドレスバー付近のインストールアイコン、またはブラウザーのメニューからインストール。
- 初回アクセス後はアプリ画面（HTML / CSS / JavaScript / アイコン）をオフラインでも開けます。Notionへの保存や添付アップロードはオンライン時のみ利用できます。Notionのページ内容やトークンはService Workerのキャッシュ対象にしていません。
