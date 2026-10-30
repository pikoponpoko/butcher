import { expect, test } from 'vitest';
import { chunks } from '../src/core/clipreader';

const enc = (s: string) => new TextEncoder().encode(s);

test('rejects files that are not CLIP STUDIO documents', () => {
  expect(() => chunks(enc('8BPS' + '\0'.repeat(40)).buffer)).toThrow('CLIP STUDIOのファイルではありません');
});

test('reports a missing layer database', () => {
  const buf = new Uint8Array(24 + 16 + 4);
  buf.set(enc('CSFCHUNK'), 0);
  buf.set(enc('CHNKHead'), 24);
  new DataView(buf.buffer).setBigUint64(32, 4n);
  expect(() => chunks(buf.buffer)).toThrow('レイヤー情報が見つかりません');
});
