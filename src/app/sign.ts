// Name / credit text stamped at the bottom-right of exported images and videos. Shared by both tools and
// remembered in localStorage. Sizes are relative to the shorter side, so preview and export look the same.
import { useSyncExternalStore } from 'react';

export interface Sign { on: boolean; text: string; size: 's' | 'm' | 'l'; color: '#ffffff' | '#000000' }
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

// Draw into the box (x, y, w, h) of a 2D context.
export function drawSign(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, x: number, y: number, w: number, h: number, s: Sign = cur) {
  if (!signActive(s)) return;
  const px = Math.max(8, Math.round(Math.min(w, h) * RATIO[s.size])), m = Math.round(px * 0.6);
  ctx.save();
  ctx.font = fontOf(px); ctx.fillStyle = s.color; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(s.text.trim(), x + w - m, y + h - m);
  ctx.restore();
}
