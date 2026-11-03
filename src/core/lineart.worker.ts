// Runs the line-art analysis off the main thread. The luminance is sent once per image; the line layer
// is kept, so changing only the gap setting skips the levels and speck steps.
import { type LineSettings, lineAlpha, regionsOf, strokeWidth } from './lineart';

let src: { L: Uint8Array; W: number; H: number } | null = null;
let last: { key: string; alpha: Uint8Array; sw: number } | null = null;
self.onmessage = (e: MessageEvent) => {
  const m = e.data as { src?: { L: Uint8Array; W: number; H: number }; id?: number; s?: LineSettings };
  if (m.src) { src = m.src; last = null; return; }
  if (!src || m.id == null || !m.s) return;
  const { W, H, L } = src, key = `${m.s.black},${m.s.white},${m.s.speck}`;
  if (last?.key !== key) { const alpha = lineAlpha(L, W, H, m.s); last = { key, alpha, sw: strokeWidth(alpha, W, H) }; }
  const la = regionsOf(last.alpha, W, H, m.s.gap, last.sw);
  (self as unknown as Worker).postMessage({ id: m.id, la }, [la.region.buffer]);
};
