import { describe, expect, it } from 'vitest';
import { contours, pushLine, shapeLine } from '../src/core/lineshape';

// a ring of width t (antialiased edges), optionally wobbly, plus a small solid dot
function ring(W: number, H: number, r: number, t: number, wob = 0) {
  const a = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = x + 0.5 - W / 2, dy = y + 0.5 - H / 2, ang = Math.atan2(dy, dx), rr = r + wob * Math.sin(ang * 9);
    const d = Math.abs(Math.hypot(dx, dy) - rr) - t / 2, v = Math.max(0, Math.min(1, 0.5 - d));
    a[y * W + x] = Math.round(v * 255);
  }
  return a;
}
const ink = (a: Uint8Array) => a.reduce((s, v) => s + v / 255, 0);

describe('lineshape', () => {
  it('traces a ring as two closed outlines', () => {
    const a = ring(80, 80, 25, 8);
    expect(contours(a, 80, 80).length).toBe(2);
  });

  it('off / as is leaves the line untouched', () => {
    const a = ring(80, 80, 25, 8);
    expect(shapeLine(a, 80, 80, 8, { smooth: 0, thick: 0 })).toBe(a);
  });

  it('smoothing keeps a clean ring about the same', () => {
    const W = 100, a = ring(W, W, 32, 8), b = shapeLine(a, W, W, 8, { smooth: 2, thick: 0 });
    expect(Math.abs(ink(b) - ink(a)) / ink(a)).toBeLessThan(0.03);
    expect(b[50 * W + 50 + 32]).toBe(255); expect(b[50 * W + 50]).toBe(0);
  });

  it('thickness: thinner < as is < bold 1 < bold 2', () => {
    const W = 100, a = ring(W, W, 32, 10), v = [-1, 1, 2].map(t => ink(shapeLine(a, W, W, 10, { smooth: 0, thick: t })));
    const base = ink(a);
    expect(v[0]).toBeLessThan(base * 0.9); expect(v[1]).toBeGreaterThan(base * 1.15); expect(v[2]).toBeGreaterThan(v[1] * 1.1);
  });

  it('push presses the wobble out near the brush only', () => {
    const W = 140, a = shapeLine(ring(W, W, 45, 8, 3), W, W, 8, { smooth: 1, thick: 0 });
    // drag along the right side of the ring
    const p: number[] = []; for (let k = -6; k <= 6; k++) { const t = k * 0.08; p.push(70 + 45 * Math.cos(t), 70 + 45 * Math.sin(t)); }
    let b = a; for (let i = 0; i < 4; i++) b = pushLine(b, W, W, 8, { p, r: 14 });
    // the far side is unchanged
    for (let y = 40; y < 100; y++) for (let x = 0; x < 40; x++) expect(b[y * W + x]).toBe(a[y * W + x]);
    // near the brush the outline follows the circle better: compare wobble along the right side
    const err = (m: Uint8Array) => { let e = 0; for (let k = -4; k <= 4; k++) { const t = k * 0.08; let s = 0, n = 0; for (let d = 30; d < 60; d += 0.25) { const x = Math.floor(70 + d * Math.cos(t)), y = Math.floor(70 + d * Math.sin(t)); s += m[y * W + x] / 255 * d; n += m[y * W + x] / 255; } e += Math.abs(s / n - 45); } return e; };
    expect(err(b)).toBeLessThan(err(a) * 0.7);
  });
});
