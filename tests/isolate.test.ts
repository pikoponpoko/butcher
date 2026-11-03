import { describe, expect, it } from 'vitest';
import { crossedOut, detectDrawings, detectSlices } from '../src/app/image/panels';
import { isolateDrawing } from '../src/app/image/isolate';

// white sheet with black rings ("drawings") that have dots inside ("eyes")
function sheet(W: number, H: number) {
  const px = new Uint8ClampedArray(W * H * 4).fill(255);
  const ring = (cx: number, cy: number, R: number, t = 6) => {
    for (let y = cy - R; y <= cy + R; y++) for (let x = cx - R; x <= cx + R; x++) {
      const d = Math.hypot(x - cx, y - cy), eye = Math.hypot(x - cx + R / 3, y - cy) < R / 6 || Math.hypot(x - cx - R / 3, y - cy) < R / 6;
      if (x >= 0 && y >= 0 && x < W && y < H && ((d <= R && d > R - t) || eye)) px.set([0, 0, 0, 255], (y * W + x) * 4);
    }
  };
  return { px, ring };
}

describe('detectDrawings', () => {
  it('finds one padded slice per drawing, eyes included, left to right', () => {
    const { px, ring } = sheet(600, 300);
    ring(100, 150, 60); ring(300, 150, 60); ring(500, 150, 60);
    const r = detectDrawings(px, 600, 300);
    expect(r).toHaveLength(3);
    expect(r.map(q => q.x + q.w / 2)).toEqual([100.5, 300.5, 500.5]);
    for (const q of r) { expect(q.w).toBe(121 + 6); expect(q.y).toBe(150 - 60 - 3); }
  });
  it('is used by auto slice when there are no frames', () => {
    const { px, ring } = sheet(600, 300);
    ring(150, 150, 80); ring(450, 150, 80);
    expect(detectSlices(px, 600, 300)).toHaveLength(2);
  });
});

describe('isolateDrawing', () => {
  it('removes a neighbor reaching in from the edge and keeps the center drawing with its eyes', () => {
    const { px, ring } = sheet(300, 200);
    ring(120, 100, 60); ring(290, 100, 50); // neighbor cut by the right edge
    const out = isolateDrawing(px, 300, 200);
    const dark = (x: number, y: number) => out.px[(y * 300 + x) * 4] < 128;
    expect(dark(60 + 2, 100)).toBe(true); // own outline
    expect(dark(100, 100)).toBe(true); // own eye
    expect(dark(240 + 2, 100)).toBe(false); // neighbor outline gone
    expect(out.ink).toEqual({ x: 59, y: 39, w: 123, h: 123 });
  });
  it('keeps the own drawing when a tight slice cuts it', () => {
    const { px, ring } = sheet(120, 96);
    ring(60, 50, 48);
    expect(isolateDrawing(px, 120, 96).px).toEqual(px);
  });
  it('clears to transparent on a transparent background', () => {
    const W = 100, H = 60, px = new Uint8ClampedArray(W * H * 4);
    for (let y = 20; y < 40; y++) { for (let x = 30; x < 60; x++) px.set([0, 0, 0, 255], (y * W + x) * 4); for (let x = 90; x < 100; x++) px.set([0, 0, 0, 255], (y * W + x) * 4); }
    const out = isolateDrawing(px, W, H);
    expect(out.clear).toBe(true);
    expect(out.px[(30 * W + 95) * 4 + 3]).toBe(0);
    expect(out.px[(30 * W + 40) * 4 + 3]).toBe(255);
  });
});

describe('crossedOut', () => {
  const W = 200, H = 200;
  const mask = (draw: (put: (x: number, y: number) => void) => void) => {
    const m = new Uint8Array(W * H);
    draw((x, y) => { for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) { const a = Math.round(x) + i, b = Math.round(y) + j; if (a >= 0 && b >= 0 && a < W && b < H) m[b * W + a] = 1; } });
    return m;
  };
  const ring = (put: (x: number, y: number) => void) => { for (let a = 0; a < 720; a++) put(100 + 80 * Math.cos(a * Math.PI / 360), 100 + 80 * Math.sin(a * Math.PI / 360)); };
  const line = (put: (x: number, y: number) => void, x0: number, y0: number, x1: number, y1: number) => { for (let t = 0; t <= 1; t += 0.002) put(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t); };
  const all = { x: 0, y: 0, w: W, h: H };
  it('finds an X drawn over a drawing', () => {
    expect(crossedOut(mask(p => { ring(p); line(p, 25, 25, 175, 175); line(p, 175, 25, 25, 175); }), W, all)).toBe(true);
  });
  it('ignores plain drawings and two strokes meeting at a point (the bottom of a heart)', () => {
    expect(crossedOut(mask(ring), W, all)).toBe(false);
    expect(crossedOut(mask(p => { line(p, 20, 30, 100, 180); line(p, 180, 30, 100, 180); }), W, all)).toBe(false);
  });
});
