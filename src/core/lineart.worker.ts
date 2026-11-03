// Runs the line-art analysis off the main thread. The luminance is sent once per image; each step's
// result is kept, so changing only the gap setting skips the levels, specks and line shaping, and a new
// push stroke is applied on top of the previous ones.
import { type LineSettings, lineAlpha, regionsOf, strokeWidth } from './lineart';
import { type Push, type ShapeSettings, pushLine, shapeLine } from './lineshape';

let src: { L: Uint8Array; W: number; H: number } | null = null;
let last: { key: string; alpha: Uint8Array; sw: number } | null = null;
let shaped: { key: string; alpha: Uint8Array } | null = null;
let pushed: { keys: string[]; alpha: Uint8Array } | null = null;
self.onmessage = (e: MessageEvent) => {
  const m = e.data as { src?: { L: Uint8Array; W: number; H: number }; id?: number; s?: LineSettings; shape?: ShapeSettings; pushes?: Push[]; joins?: number[][] };
  if (m.src) { src = m.src; last = shaped = pushed = null; return; }
  if (!src || m.id == null || !m.s) return;
  const { W, H, L } = src, key = `${m.s.black},${m.s.white},${m.s.speck}`, sh = m.shape || { smooth: 0, thick: 0 };
  if (last?.key !== key) { const alpha = lineAlpha(L, W, H, m.s); last = { key, alpha, sw: strokeWidth(alpha, W, H) }; shaped = null; }
  const k2 = `${sh.smooth},${sh.thick}`;
  if (shaped?.key !== k2) { shaped = { key: k2, alpha: shapeLine(last.alpha, W, H, last.sw, sh) }; pushed = null; }
  const pk = (m.pushes || []).map(p => JSON.stringify(p));
  if (!pushed || pushed.keys.length > pk.length || pushed.keys.some((k, i) => k !== pk[i])) pushed = { keys: [], alpha: shaped.alpha };
  let alpha = pushed.alpha;
  for (let i = pushed.keys.length; i < pk.length; i++) alpha = pushLine(alpha, W, H, last.sw, m.pushes![i]);
  pushed = { keys: pk, alpha };
  const la = regionsOf(alpha, W, H, m.s.gap, alpha === last.alpha ? last.sw : strokeWidth(alpha, W, H), m.joins || []);
  // the line layer stays here for the next run: send a copy
  if (la.alpha === alpha) la.alpha = alpha.slice();
  (self as unknown as Worker).postMessage({ id: m.id, la }, [la.region.buffer, la.alpha.buffer]);
};
