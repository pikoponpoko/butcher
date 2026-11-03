import { describe, expect, it } from 'vitest';
import { analyze, autoLevels, distSq, lineAlpha, luminance } from '../src/core/lineart';

// white page with black rings (thick outlines), optionally broken
function page(W: number, H: number) {
  const px = new Uint8ClampedArray(W * H * 4).fill(255);
  const dot = (x: number, y: number) => { if (x >= 0 && y >= 0 && x < W && y < H) px.fill(0, (y * W + x) * 4, (y * W + x) * 4 + 3); };
  const ring = (cx: number, cy: number, r: number, t: number, gapFrom = 0, gapTo = 0) => {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - cx, y - cy), a = (Math.atan2(y - cy, x - cx) * 180 / Math.PI + 360) % 360;
      if (Math.abs(d - r) <= t / 2 && !(a >= gapFrom && a < gapTo)) dot(x, y);
    }
  };
  const disc = (cx: number, cy: number, r: number) => { for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) if (Math.hypot(x - cx, y - cy) <= r) dot(x, y); };
  return { px, ring, disc, dot };
}
const settings = (gap: number) => ({ black: 64, white: 180, speck: 4, gap });
const regionAt = (la: ReturnType<typeof analyze>, x: number, y: number) => la.region[y * la.W + x];

describe('lineart', () => {
  it('distSq matches brute force', () => {
    const W = 23, H = 17, m = new Uint8Array(W * H);
    [5, 77, 200, 391].forEach(i => m[i] = 1);
    const d = distSq(m, W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let b = Infinity; for (let i = 0; i < W * H; i++) if (m[i]) b = Math.min(b, (i % W - x) ** 2 + ((i / W | 0) - y) ** 2);
      expect(d[y * W + x]).toBe(b);
    }
  });

  it('levels: ink is opaque, paper transparent, specks removed', () => {
    const W = 60, H = 40, { px, ring, dot } = page(W, H);
    ring(30, 20, 14, 4); dot(3, 3);
    const L = luminance(px, W, H), a = lineAlpha(L, W, H, { black: 64, white: 180, speck: 3 });
    expect(a[20 * W + 44]).toBe(255); // on the ring
    expect(a[20 * W + 30]).toBe(0);   // paper
    expect(a[3 * W + 3]).toBe(0);     // speck
    const lv = autoLevels(L); expect(lv.black).toBeLessThan(lv.white);
  });

  it('fills a closed ring as one inside region, under the line up to its center', () => {
    const W = 120, H = 100, { px, ring } = page(W, H);
    ring(60, 50, 30, 6);
    const la = analyze(px, W, H, settings(10));
    const inside = regionAt(la, 60, 50), out = regionAt(la, 2, 2);
    expect(inside).not.toBe(out);
    expect(la.outside[inside]).toBe(0); expect(la.outside[out]).toBe(1);
    expect(regionAt(la, 60 + 28, 50)).toBe(inside); // inner half of the line
    expect(regionAt(la, 60 + 32, 50)).toBe(out);    // outer half
  });

  it('closes a break in the line, and only when it is within the gap setting', () => {
    const W = 140, H = 120, { px, ring } = page(W, H);
    ring(70, 60, 40, 6, 80, 95); // about 10 px missing at the bottom
    const open = analyze(px, W, H, settings(0));
    expect(regionAt(open, 70, 60)).toBe(regionAt(open, 2, 2));
    const closed = analyze(px, W, H, settings(16));
    expect(regionAt(closed, 70, 60)).not.toBe(regionAt(closed, 2, 2));
    expect(closed.gaps.length).toBeGreaterThan(0);
  });

  it('does not bridge from the outline to eyes', () => {
    const W = 140, H = 120, { px, ring, disc } = page(W, H);
    ring(70, 60, 45, 6); disc(55, 55, 7); disc(85, 55, 7);
    const la = analyze(px, W, H, settings(20));
    // the face stays one region around the eyes
    expect(regionAt(la, 70, 40)).toBe(regionAt(la, 70, 85));
    expect(regionAt(la, 40, 55)).toBe(regionAt(la, 70, 55));
  });
});
