## インストール

Windows: `LineMelt.aex` を `C:\Program Files\Adobe\Common\Plug-ins\7.0\MediaCore\` に置く。

Mac: `LineMelt-Mac.zip` を展開し、`LineMelt.plugin` を `/Library/Application Support/Adobe/Common/Plug-ins/7.0/MediaCore/` に置く。初回に開けない場合は、ターミナルで `xattr -dr com.apple.quarantine "/Library/Application Support/Adobe/Common/Plug-ins/7.0/MediaCore/LineMelt.plugin"` を実行する。

After Effects を再起動すると、エフェクト › スタイライズ › Line Melt に出る。

## 項目

| 項目 | 内容 |
| --- | --- |
| Smoothness | 輪郭をならす強さ（px）。大きいほど溶ける |
| Limit Shift / Max Shift | 元の輪郭から動ける距離の上限（px）。オフで上限なし |
| Lines | 線として扱う部分。Alpha＝不透明部分、Dark Pixels＝白地の黒線 |
| Threshold | 線とみなす境目（%） |

線画アプリの補正「強」に近いのは、線幅の約1.1倍の Smoothness と約0.3倍の Max Shift。
