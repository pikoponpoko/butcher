// Name / credit text stamped at the bottom-right of exported images and videos. Shared by both tools and
// remembered in localStorage. Sizes are relative to the shorter side, so preview and export look the same.
import { useSyncExternalStore } from 'react';

export type SignColor = '#ffffff' | '#000000';
export interface Sign { on: boolean; text: string; size: 's' | 'm' | 'l'; color: SignColor | 'auto' }
const KEY = 'sign';
const RATIO = { s: 0.025, m: 0.035, l: 0.05 };

let cur: Sign = { on: false, text: '', size: 'm', color: '#ffffff' };
try { cur = { ...cur, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch {}
const subs = new Set<() => void>();

export const getSign = () => cur;
export const signActive = (s: Sign = cur) => s.on && !!s.text.trim();
export function setSign(p: Partial<Sign>) {
  cur = { ...cur, ...p };
  try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch {}
  subs.forEach(f => f());
}
export const useSign = () => useSyncExternalStore(f => { subs.add(f); return () => subs.delete(f); }, getSign);

const fontOf = (px: number) => `600 ${px}px "IBM Plex Sans JP", system-ui, sans-serif`;
// Resolves once the web font can draw the text (canvas text doesn't trigger font loading by itself).
export async function signReady(s: Sign = cur) {
  if (!signActive(s) || !document.fonts) return;
  try { await document.fonts.load(fontOf(16), s.text); } catch {}
}

let scratch: CanvasRenderingContext2D | null = null;
// Font size, margin and the rect the text covers, for the box (x, y, w, h).
export function signLayout(x: number, y: number, w: number, h: number, s: Sign = cur) {
  const px = Math.max(8, Math.round(Math.min(w, h) * RATIO[s.size])), m = Math.round(px * 0.6);
  scratch ||= document.createElement('canvas').getContext('2d')!;
  scratch.font = fontOf(px);
  const tw = scratch.measureText(s.text.trim()).width;
  return { px, m, rect: { x: x + w - m - tw, y: y + h - m - px * 0.8, w: tw, h: px } };
}

// White or black, whichever contrasts more with the pixels (alpha-weighted; mostly transparent = black).
const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
export function contrastColor(px: Uint8ClampedArray): SignColor {
  let y = 0, a = 0;
  for (let p = 0; p < px.length; p += 16) { const k = px[p + 3] / 255; y += k * (0.2126 * lin(px[p]) + 0.7152 * lin(px[p + 1]) + 0.0722 * lin(px[p + 2])); a += k; }
  if (a < px.length / 16 * 0.25) return '#000000';
  return y / a > 0.179 ? '#000000' : '#ffffff';
}
// Read the pixels under the text from a context drawn without a transform.
export function sampleUnder(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, x: number, y: number, w: number, h: number, s: Sign = cur) {
  const { rect: r } = signLayout(x, y, w, h, s), cw = ctx.canvas.width, ch = ctx.canvas.height;
  const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y)), x1 = Math.min(cw, Math.ceil(r.x + r.w)), y1 = Math.min(ch, Math.ceil(r.y + r.h));
  return x1 > x0 && y1 > y0 ? ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data : new Uint8ClampedArray(0);
}

// Draw into the box (x, y, w, h) of a 2D context. With 'auto' and no `color`, the context's own pixels decide.
export function drawSign(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, x: number, y: number, w: number, h: number, s: Sign = cur, color?: SignColor) {
  if (!signActive(s)) return;
  const fill = s.color !== 'auto' ? s.color : color ?? contrastColor(sampleUnder(ctx, x, y, w, h, s));
  const { px, m } = signLayout(x, y, w, h, s);
  ctx.save();
  ctx.font = fontOf(px); ctx.fillStyle = fill; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(s.text.trim(), x + w - m, y + h - m);
  ctx.restore();
}
