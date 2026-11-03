# butcher

PSD・CLIP STUDIO（.clip）・画像のレイヤー／フォルダ／スライス書き出しと、動画からの GIF・アニメWebP・MP4 書き出しを行うブラウザアプリ（試作段階）。

## 開発

```sh
npm install
npm run dev        # 開発サーバー
npm test           # テスト（samples/ の PSD を使用）
npm run typecheck  # 型チェック
npm run build      # dist/ に書き出し
```

## 構成

- `src/core/psdcore.ts` — レイヤー合成（描画モード・マスク・クリッピング）と書き出し対象の列挙
- `src/core/clipreader.ts` — .clip の読み込み（非公式の解析。通常レイヤー・表示・不透明度・フォルダのみ検証済み）
- `src/app/App.tsx` — 画面全体（React）。ツールバーと各ツールの切り替え、ファイルのドロップ
- `src/app/image/` — 画像ツール（レイヤー、スライス、プレビュー、書き出し）。`model.ts`・`exporter.ts` は React に依存しない処理
- `src/app/gif/` — GIF・動画ツールの画面（`GifTool.tsx`）とエンコーダー（`encoders.ts`）
- `samples/` — テスト用 PSD（画面のサンプル選択と自動テストで共用）
- `tests/` — 合成結果のスナップショット、PSD 内の統合画像との比較、描画モードの単体テスト

## Windows / Mac 版

`desktop/` は `dist/` をそのまま読み込む Electron アプリ。インストーラー（NSIS）は同じ appId の旧版を自動でアンインストールしてから入れ替える。Mac は universal（Apple シリコン / Intel）の dmg で、Applications にドラッグすると旧版を置き換える。ヘッダーの「アップデートを確認」はデスクトップ版にだけ出る。

公開手順:

1. `desktop/package.json` の `version` を上げて main にマージ
2. Actions の「Desktop」を main で Run workflow（「GitHub Releases に公開」にチェック）
3. `v<version>` のリリースに `Butcher-Setup-<version>.exe` と `Butcher-<version>.dmg` が載る

```sh
npm run build
cd desktop && npm install && npm start   # ローカルで起動
```

## ライセンス

[MIT License](LICENSE)
