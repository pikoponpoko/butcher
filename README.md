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
- `src/app/editor.js` — 画像ツールの画面（レイヤー、スライス、プレビュー、書き出し）
- `src/app/giftool.js` — GIF・動画ツールの画面とエンコード
- `samples/` — テスト用 PSD（画面のサンプル選択と自動テストで共用）
- `tests/` — 合成結果のスナップショット、PSD 内の統合画像との比較、描画モードの単体テスト
