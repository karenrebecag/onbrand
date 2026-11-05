import { describe, expect, test } from 'bun:test';
import { isUnit, unitsFirst } from '../src/unit';
import type { Candidate } from '../src/types';

const c = (over: Partial<Candidate>): Candidate => ({
  slug: 's', name: 'n', category: 'c', tags: [], geometry: 'standard',
  surface: { light: 'base', dark: 'base' }, ...over,
});

describe('organism-first (decisión A: Arc es la unidad)', () => {
  test('isUnit: organismo Arc y shell Relume sí; bloque Relume plano no', () => {
    expect(isUnit(c({ library: 'arc', kind: 'block' }))).toBe(true);
    expect(isUnit(c({ library: 'relume', kind: 'layout' }))).toBe(true); // shell que envuelve Arc
    expect(isUnit(c({ library: 'relume', kind: 'block' }))).toBe(false);
    expect(isUnit(c({}))).toBe(true); // sin library (hecho a mano) cuenta como unidad
  });

  test('unitsFirst recorta a unidades cuando las hay', () => {
    const pool = [c({ slug: 'arc1', library: 'arc', kind: 'block' }), c({ slug: 'rel1', library: 'relume', kind: 'block' }), c({ slug: 'shell1', library: 'relume', kind: 'layout' })];
    expect(unitsFirst(pool).map((x) => x.slug)).toEqual(['arc1', 'shell1']);
  });

  test('unitsFirst cae al pool Relume cuando el rol no tiene ninguna unidad Arc', () => {
    const pool = [c({ slug: 'rel1', library: 'relume', kind: 'block' }), c({ slug: 'rel2', library: 'relume', kind: 'block' })];
    expect(unitsFirst(pool).map((x) => x.slug)).toEqual(['rel1', 'rel2']);
  });
});
