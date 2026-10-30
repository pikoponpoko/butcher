import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { initializeCanvas, readPsd } from 'ag-psd';
import type { PsdDoc } from '../src/core/psdcore';
import { depthMax } from '../src/core/psdcore';

// Node has no canvas; the reader only needs ImageData-shaped buffers.
initializeCanvas(
  () => { throw new Error('canvas not available in tests'); },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: 'srgb' }) as ImageData,
);

export const SAMPLE_DIR = fileURLToPath(new URL('../samples/', import.meta.url));
export const samples = () => readdirSync(SAMPLE_DIR).filter(f => f.endsWith('.psd')).sort();

export function loadSample(name: string): PsdDoc {
  const b = readFileSync(SAMPLE_DIR + name);
  return readPsd(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), { useImageData: true, skipThumbnail: true }) as PsdDoc;
}

export const sha = (d: ArrayLike<number>) => createHash('sha256').update(Uint8Array.from(d)).digest('hex').slice(0, 16);

// Largest per-channel difference after premultiplying both sides (8-bit scale).
export function maxDiff(a: ArrayLike<number>, ref: ArrayLike<number>) {
  const q = depthMax(ref as any);
  let m = 0;
  for (let i = 0; i < a.length; i += 4) {
    const ra = ref[i + 3] / q * 255;
    for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(a[i + c] * a[i + 3] / 255 - ref[i + c] / q * 255 * ra / 255));
    m = Math.max(m, Math.abs(a[i + 3] - ra));
  }
  return Math.round(m);
}
