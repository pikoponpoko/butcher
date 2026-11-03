# Line Melt (After Effects)

線画の輪郭を弧長方向にならす After Effects エフェクト。Butcher 線画ツールの手ブレ補正（smooth_contours2）を移植したもの。

- `src/melt.rs` 処理本体（Ae に依存しない）。`cargo test --release`
- `src/plugin.rs` Ae エフェクト（[after-effects](https://crates.io/crates/after-effects) クレート、Adobe SDK 不要）
- `examples/try.rs` PNG で試す: `cargo run --release --example try -- in.png out.png <Smoothness> <Max Shift|none>`
- ビルド: `.github/workflows/ae-line-melt.yml`（Windows `.aex` / Mac `.plugin`）

インストールと項目は [INSTALL.md](INSTALL.md)。
