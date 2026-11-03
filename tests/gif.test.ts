import { describe, expect, test } from 'vitest';
import { encodeGif, frameDelays } from '../src/app/gif/encoders';
import { parseGif } from './gifparse';

// W×H frame of pseudo-random opaque colors (far more than 256), with the listed pixels transparent
function noisy(W: number, H: number, seed: number, clear: number[] = []) {
  const f = new Uint8ClampedArray(W * H * 4); let s = seed + 1;
  for (let i = 0; i < W * H; i++) { s = (s * 1103515245 + 12345) >>> 0; f[i * 4] = s & 255; f[i * 4 + 1] = s >> 8 & 255; f[i * 4 + 2] = s >> 16 & 255; f[i * 4 + 3] = 255; }
  for (const i of clear) f[i * 4 + 3] = 0;
  return f;
}
const gif = async (frames: Uint8ClampedArray[], W: number, H: number, fps: number, step = 1, useAlpha = false, colors = 256) =>
  parseGif(new Uint8Array(await (await encodeGif(frames, W, H, colors, step, { fps, loop: 0, useAlpha })).arrayBuffer()));

describe('GIF timing', () => {
  test.each([[24, 24], [30, 30], [25, 25], [50, 50], [12, 12], [24, 48]])('%i fps, %i frames keeps n / fps seconds', async (fps, n) => {
    const g = await gif(Array.from({ length: n }, (_, i) => noisy(4, 4, i)), 4, 4, fps);
    expect(g.frames.length).toBe(n);
    expect(g.total).toBe(Math.round(n / fps * 100));
    for (const f of g.frames) expect(f.delay).toBeGreaterThanOrEqual(2);
  });
  test('30 fps alternates 3/3/4 centiseconds', () => {
    expect(frameDelays(30, 30, 1, 10).slice(0, 6)).toEqual([3, 4, 3, 3, 4, 3]);
  });
  test('dropped frames: the last kept frame lasts until the clip ends', async () => {
    const g = await gif(Array.from({ length: 25 }, (_, i) => noisy(4, 4, i)), 4, 4, 24, 3);
    expect(g.frames.length).toBe(9);
    expect(g.total).toBe(104); // 25 / 24 s
    expect(g.frames[8].delay).toBe(4); // frame 24 alone: 1/24 s
  });
  test('WebP durations (ms) add up the same way', () => {
    expect(frameDelays(24, 24, 1, 1).reduce((a, b) => a + b, 0)).toBe(1000);
    expect(frameDelays(30, 30, 2, 1).reduce((a, b) => a + b, 0)).toBe(1000);
  });
});

describe('GIF palette', () => {
  test('transparent background with fully opaque many-color frames stays within 256 colors', async () => {
    const g = await gif(Array.from({ length: 3 }, (_, i) => noisy(64, 64, i)), 64, 64, 10, 1, true);
    expect(g.gct).toBeLessThanOrEqual(256);
    for (const f of g.frames) { expect(f.transparent).toBe(true); expect(f.idx.includes(f.tIdx)).toBe(false); }
  });
  test('transparent pixels that appear only in a late, unsampled frame are written transparent', async () => {
    // 12 frames: the palette samples frames 0,1,3,4,6,7,9,10; frame 11 alone has transparent pixels
    const frames = Array.from({ length: 12 }, (_, i) => noisy(64, 64, i, i === 11 ? [0, 5, 4095] : []));
    const g = await gif(frames, 64, 64, 10, 1, true);
    expect(g.gct).toBeLessThanOrEqual(256);
    const last = g.frames[11];
    expect([0, 5, 4095].map(p => last.idx[p])).toEqual([last.tIdx, last.tIdx, last.tIdx]);
    expect(last.idx.filter(v => v === last.tIdx).length).toBe(3);
  });
  test('without transparency the frame-delta marker also fits in 256', async () => {
    const g = await gif(Array.from({ length: 3 }, (_, i) => noisy(64, 64, i)), 64, 64, 10);
    expect(g.gct).toBe(256);
  });
});
