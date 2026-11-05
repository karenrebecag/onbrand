import { describe, expect, test } from 'bun:test';
import { runtimeDefects, slugOfSource } from '../src/runtime-sensors';

const SLUGS = ['01-navbar', '05-stats', '11-footer'];

describe('runtime-sensors', () => {
  test('una sección que tira sin boundary desmonta la página: el error y cada slug sin montar son defectos', () => {
    const d = runtimeDefects([{ kind: 'pageerror', message: 'stats.some is not a function', viewport: 1440 }], SLUGS, new Map([[1440, []]]));
    expect(d.map((x) => [x.kind, x.slug])).toEqual([['pageerror', null], ['unmounted', '01-navbar'], ['unmounted', '05-stats'], ['unmounted', '11-footer']]);
  });

  test('el stack de dev atribuye la sección y el mismo error en dos anchos cuenta una vez', () => {
    expect(slugOfSource('at StatsSection (http://127.0.0.1:5399/src/sections/05-stats.tsx?t=1:12:9)')).toBe('05-stats');
    const err = { kind: 'console' as const, message: 'Each child in a list should have a unique "key" prop.', source: 'http://x/src/sections/05-stats.tsx', viewport: 1440 };
    const d = runtimeDefects([err, { ...err, viewport: 375 }], SLUGS, new Map([[1440, SLUGS], [375, SLUGS]]));
    expect(d.map((x) => [x.kind, x.slug])).toEqual([['console', '05-stats']]);
  });

  test('una página montada entera y sin errores da 0', () => {
    expect(runtimeDefects([], SLUGS, new Map([[1440, SLUGS], [375, SLUGS]]))).toEqual([]);
  });
});
