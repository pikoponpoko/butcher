// UI language. Japanese strings are the keys; English comes from EN, falling back to the Japanese text.
// The first visit follows the browser language; the toolbar switch is remembered in localStorage.
import { useSyncExternalStore } from 'react';

export type Lang = 'ja' | 'en';
const KEY = 'lang';

let cur: Lang = 'ja';
try { const v = localStorage.getItem(KEY); cur = v === 'ja' || v === 'en' ? v : /^ja\b/i.test(navigator.language || '') ? 'ja' : 'en'; document.documentElement.lang = cur; } catch {}
const subs = new Set<() => void>();

export const getLang = () => cur;
export function setLang(l: Lang) {
  cur = l; document.documentElement.lang = l;
  try { localStorage.setItem(KEY, l); } catch {}
  subs.forEach(f => f());
}
export const useLang = () => useSyncExternalStore(f => { subs.add(f); return () => subs.delete(f); }, getLang);

// tr('{n} ファイル', { n: 3 }) → '3 files' in English
// tr() in the language not shown, for reserving width
export function trAlt(ja: string, v?: Record<string, string | number>) {
  cur = cur === 'en' ? 'ja' : 'en';
  try { return tr(ja, v); } finally { cur = cur === 'en' ? 'ja' : 'en'; }
}
// A key may end in '|context' when one Japanese word needs two English ones.
export function tr(ja: string, v?: Record<string, string | number>) {
  const base = ja.split('|')[0], s = cur === 'en' ? EN[ja] ?? base : base;
  return v ? s.replace(/\{(\w+)\}/g, (m, k) => k in v ? String(v[k]) : m) : s;
}

// The same text in the language not shown (for reserving width); undefined when it has no translation.
// English words used for two Japanese ones (Custom, None) map back to the later key; pass Lbl `other` for the earlier one.
export const otherOf = (s: string): string | undefined => cur === 'en' ? JA_OF()[s] : EN[s];
let jaOf: Record<string, string> | null = null;
const JA_OF = () => jaOf ||= Object.fromEntries(Object.entries(EN).map(([k, v]) => [v, k.split('|')[0]]));

const EN: Record<string, string> = {
  // toolbar
  '画像': 'Image', 'GIF・動画': 'GIF/Video', '開く': 'Open', '閉じる': 'Close', 'クリックまたはドロップで追加': 'Click or drop to add', 'タップして追加': 'Tap to add',
  // layers / slices
  'レイヤー': 'Layers', 'スライス': 'Slices', 'すべて': 'All', '解除': 'None', '自動': 'Auto', '読込': 'Load', '保存': 'Save', '全削除': 'Delete all', '畳む': 'Collapse',
  '表示': 'Show', '非表示': 'Hide', '開閉': 'Expand', '元の名前：{n}': 'Original name: {n}', '(名前なし)': '(Untitled)', 'クリップ': 'Clip', '警告': 'Warning',
  '書き出し対象': 'Export', '名前': 'Name', '画像上をドラッグして作成': 'Drag on the image to create', 'スライス名': 'Slice name', '丸': 'Circle',
  '丸く切り抜いたときの見え方': 'Preview as a circle', '削除': 'Delete',
  // stage
  '：': ': ', '（{d}）': ' ({d})',
  'ここにドロップ': 'Drop here', '空': 'Empty', '警告 {n}': '{n} warnings', '警告なし': 'No warnings',
  // inspector
  '書き出し設定': 'Export settings', '方式': 'Mode', 'フォルダ': 'Folders', '両方': 'Both', '形式': 'Format', '画質': 'Quality', 'サイズ': 'Size', '原寸': 'Full',
  '指定': 'Custom', 'SNS': 'Social', '壁紙': 'Device', '基準の辺': 'Side', '幅': 'Width', '高さ': 'Height', 'ピクセル': 'Pixels', '基準': 'Basis', 'キャンバス': 'Canvas',
  '画像ごと': 'Per image', '合わせ方': 'Fit', '余白': 'Pad', '切り抜き': 'Crop', '余白カット': 'Trim', '接頭辞': 'Prefix', '接尾辞': 'Suffix',
  '署名': 'Signature', '署名を入れる': 'Add signature', '小': 'S', '中': 'M', '大': 'L', '白': 'White', '黒': 'Black',
  '非表示レイヤーを含む': 'Include hidden layers', 'フォルダ階層を保持': 'Keep folder structure', '透明部分を周囲の色で補完': 'Fill transparent areas with edge color',
  '開いているファイルをすべて処理': 'Process all open files', '{n} ファイル': '{n} files', '警告あり {n}': '{n} with warnings', '警告のある画像も書き出す': 'Export images with warnings',
  '個別': 'Separate', 'フォルダ|out': 'Folder', '書き出し': 'Export', '標準': 'Standard', '13インチ': '13-inch', '11インチ': '11-inch',
  // image status
  '{f}: 読み込めません（{e}）': '{f}: can’t open ({e})', '枠が見つかりません': 'No frames found', '{n} 件のスライスを追加': '{n} slices added', 'スライスがありません': 'No slices',
  'スライス設定を保存': 'Slices saved', 'キャンバスサイズが異なります（{w}×{h}）': 'Canvas size differs ({w}×{h})', '{n} 件のスライスを読込': '{n} slices loaded',
  'スライス設定を読み込めません': 'Can’t load slices', 'サイズを選んでください': 'Choose a size', '空の画像です': 'The image is empty', '{n} ファイルを書き出し': '{n} files exported',
  '保存を取り消しました': 'Save canceled', '保存できませんでした': 'Couldn’t save', 'この環境ではフォルダに保存できません': 'Can’t save to a folder here',
  '空の画像のため省略': 'Skipped: empty image', '{n} 件を省略': '{n} skipped', '書き出せる画像がありません': 'Nothing to export',
  '警告のため書き出さなかった画像: {n}': 'Images not exported because of warnings: {n}', 'エラー: {e}': 'Error: {e}',
  '読み込み用ライブラリを取得できません': 'Can’t load the file reader', 'CLIP STUDIOのファイルではありません': 'Not a CLIP STUDIO file', 'レイヤー情報が見つかりません': 'No layer data found',
  // layer warnings
  'レイヤー効果は描画されません': 'Layer effects are not drawn', '調整レイヤーは適用されません': 'Adjustment layers are not applied', 'ブレンド条件は適用されません': 'Blend If is not applied',
  'ノックアウトは適用されません': 'Knockout is not applied', 'ベクトルマスクは適用されません': 'Vector masks are not applied', 'スマートフィルターは保存済みの画像を使用': 'Smart filters use the saved image',
  'ピクセルデータがありません': 'No pixel data', 'シェイプ・塗りつぶしの画像がありません': 'Shape or fill has no image', '通過グループの不透明度は近似': 'Pass-through group opacity is approximate',
  'この描画モードの塗りは近似': 'Fill for this blend mode is approximate', 'この描画モードの不透明度は近似': 'Opacity for this blend mode is approximate', '未対応の描画モード': 'Unsupported blend mode',
  'マスクのぼかしは適用されません': 'Mask feather is not applied', 'アートボードの背景・切り抜きは適用されません': 'Artboard background and clipping are not applied',
  '合成モードは未検証（通常として処理）': 'Blend mode unverified (treated as Normal)', 'CLIP STUDIOのマスクは未検証': 'CLIP STUDIO masks unverified', 'レイヤーの位置情報は未検証': 'Layer position unverified',
  'この種類のレイヤーは未検証': 'Layer type unverified', 'タイル配置を読み取れません': 'Can’t read the tile layout', 'この色形式は未対応': 'Unsupported color format',
  // GIF / video
  'GIF書き出し設定': 'GIF export settings', '元': 'Orig', '自由': 'Free', '結果': 'Result', 'カスタム': 'Custom', '再生': 'Play', '停止': 'Pause', '透明': 'Clear', '背景': 'Background',
  '範囲': 'Range', '開始': 'Start', '終了': 'End', '秒': 's', '速度': 'Speed', 'ループ': 'Loop', '無限': 'Forever', '1回': 'Once', '2回': '2 times', '3回': '3 times',
  '目標サイズ': 'Target size', 'なし': 'None', 'ドット': 'Pixel', 'ドットの大きさ': 'Pixel size', '色数': 'Colors', '{n}色': '{n} colors', '設定': 'Preset',
  '設定を読込': 'Preset loaded', '設定を読み込めません': 'Can’t load preset', 'このまま保存': 'Save anyway',
  '{n} フレーム': '{n} frames', '{s}秒': '{s}s', '{n} フレームを超えています': 'Over {n} frames', 'GIFは50fpsまで': 'GIF max 50 fps',
  '{s} を書き出し': '{s} exported', '{n} 件は目標 {t} MB を超えています': '{n} over the {t} MB target', '目標 {t} MB に届きません（最小 {s}）': 'Can’t reach {t} MB (smallest {s})',
  '範囲が長すぎるかサイズが大きすぎます。範囲・サイズ・FPSを下げてください': 'Range or size is too large. Lower the range, size or FPS',
  'フレーム取得 {i}/{n}': 'Reading frames {i}/{n}', '{f}作成 {n}回目': '{f} encoding, try {n}', 'WebP作成 {i}/{n}': 'WebP encoding {i}/{n}', 'MP4作成 {i}/{n}': 'MP4 encoding {i}/{n}',
  'このブラウザはWebP書き出しに対応していません': 'This browser can’t export WebP', 'このブラウザはMP4書き出しに対応していません': 'This browser can’t export MP4',
  'この解像度のMP4はこのブラウザで書き出せません': 'This browser can’t export MP4 at this size', 'この動画は読み込めません': 'Can’t open this video',
};
