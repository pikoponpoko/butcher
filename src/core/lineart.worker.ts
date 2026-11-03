// Runs the line-art analysis off the main thread. The luminance is sent once per image.
import { analyze, type LineSettings } from './lineart';

let src: { L: Uint8Array; W: number; H: number } | null = null;
self.onmessage = (e: MessageEvent) => {
  const m = e.data as { src?: { L: Uint8Array; W: number; H: number }; id?: number; s?: LineSettings };
  if (m.src) { src = m.src; return; }
  if (!src || m.id == null || !m.s) return;
  const la = analyze(new Uint8Array(0), src.W, src.H, m.s, src.L);
  (self as unknown as Worker).postMessage({ id: m.id, la }, [la.alpha.buffer, la.region.buffer]);
};
