import { describe, expect, test } from 'bun:test';
import { brandAaTables, parseBrandPack } from '../src/brand';
import { contrast, MIN_CONTRAST, parseColor } from '../src/color-contrast';

// Los roles de estado de Arc (arc registry/foundation.css:44-57 claro, :119-129 oscuro) se usan como texto: badge,
// alert, deltas de un chart. El --warning claro anterior (oklch(58% .18 75)) daba 4.38:1 y no llegaba a AA.
const SUPPORT = ['--success', '--warning', '--danger', '--info'];

const resolve = (table: Record<string, string>, token: string, depth = 0): string | undefined => {
  const v = table[token]?.trim();
  const ref = v && /^var\(\s*(--[a-z0-9-]+)\s*\)$/.exec(v);
  return ref && depth < 8 ? resolve(table, ref[1], depth + 1) : v;
};

describe('roles de estado del contrato', () => {
  test('success, warning, danger e info pasan AA como texto sobre el fondo, en claro y en oscuro', () => {
    const { tables } = brandAaTables(parseBrandPack({ name: 'Base' }, { skipComponents: true }));
    for (const mode of ['light', 'dark'] as const) {
      const bg = parseColor(resolve(tables[mode], '--background'));
      expect(bg, mode).not.toBeNull();
      for (const token of SUPPORT) {
        const fg = parseColor(resolve(tables[mode], token));
        expect(fg, `${token} ${mode}`).not.toBeNull();
        expect(contrast(fg!, bg!), `${token} ${mode}`).toBeGreaterThanOrEqual(MIN_CONTRAST);
      }
    }
    // El caso que motivó el cambio: --warning claro, de 4.38:1 a ~5:1.
    const warning = contrast(parseColor(resolve(tables.light, '--warning'))!, parseColor(resolve(tables.light, '--background'))!);
    expect(warning).toBeGreaterThan(4.9);
  });
});
