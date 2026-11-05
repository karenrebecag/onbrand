import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { brandpackCases, EQUIVALENCE_FILE, snapshotAll, snapshotOf } from '../scripts/brandpack-red';


// Red del brandpack v2 (PR #1): lo que cada pack produce hoy queda fijado. El refactor del schema tiene que dejar este
// test verde sin regenerar equivalencia.json; un cambio intencional de salida se regenera en su propio PR y se lee el diff.
describe('brandpack v2: equivalencia de salida (old == old)', () => {
  const golden = JSON.parse(readFileSync(EQUIVALENCE_FILE, 'utf8')) as Record<string, Record<string, unknown>>;

  test('cada pack produce la misma identidad, cobertura, DESIGN.md, appearance y brand.ts que el snapshot', () => {
    expect(snapshotAll()).toEqual(golden);
  });

  test('los packs del repo cierran el contrato', () => {
    const cases = brandpackCases();
    for (const id of ['repo-base', 'repo-ejemplo']) {
      expect({ id, missing: (snapshotOf(cases[id]!).coverage as { missing: string[] }).missing }).toEqual({ id, missing: [] });
    }
  });

  // El snapshot compara valores efectivos, no texto: sin esto, reordenar declaraciones rompería la red sin cambiar nada.
  test('el snapshot guarda el valor que gana por token, no el orden de las declaraciones', () => {
    const { light } = snapshotOf(brandpackCases()['sint-highlight']!) as { light: Record<string, string> };
    expect(light['--accent']).toBe('#0a0a0a');
    expect(light['--brand-highlight']).toBe('#ff6600');
  });
});
