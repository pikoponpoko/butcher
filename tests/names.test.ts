import { expect, test } from 'vitest';
import { makeNamer, safe } from '../src/app/image/model';

test('same names and names that sanitize to the same text get numbered', () => {
  const n = makeNamer(false), t = (s: string) => n.take(safe(s), ['.png']) + '.png';
  expect([t('a'), t('a'), t('a:b'), t('a?b'), t('a_b'), t('A')]).toEqual(['a.png', 'a_2.png', 'a_b.png', 'a_b_2.png', 'a_b_3.png', 'A_3.png']);
});
test('a numbered name never takes a name used later as-is, and every tail of a target is checked', () => {
  const n = makeNamer(false);
  expect(n.take('x_2', ['.png'])).toBe('x_2');
  expect(n.take('x', ['.png'])).toBe('x');
  expect(n.take('x', ['.png'])).toBe('x_3');
  // favicon set: .ico + PNGs share one stem
  expect(n.take('icon', ['.ico', '-180.png'])).toBe('icon');
  expect(n.take('icon-180', ['.png'])).toBe('icon-180_2');
});
test('folders: the same name in different folders is kept, flattened output compares the flat name', () => {
  const tree = makeNamer(false);
  expect([tree.take('f1/a', ['.png']), tree.take('f2/a', ['.png'])]).toEqual(['f1/a', 'f2/a']);
  const flat = makeNamer(true);
  expect([flat.take('f/a', ['.png']), flat.take('f_a', ['.png'])]).toEqual(['f/a', 'f_a_2']);
});
test('reserved names are skipped', () => {
  const n = makeNamer(false); n.reserve('warnings.txt');
  expect(n.take('warnings', ['.txt'])).toBe('warnings_2');
});
