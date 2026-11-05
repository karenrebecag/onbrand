import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AA_FILE, brandpackCases } from '../scripts/brandpack-red';
import { applyBrand, brandAaTables } from '../src/brand';
import { packAaErrors, pairRatios } from '../src/brand-aa';


describe('gate de contraste del pack', () => {
  test('la medida sin navegador coincide con la de chromium en cada pack de la red', () => {
    // aa-report.json lo midió chromium (tests/brandpack-aa.browser.test.ts). El alpha compuesto redondea distinto:
    // la tolerancia es relativa y muy por debajo de la distancia a cualquier umbral.
    const browser = JSON.parse(readFileSync(AA_FILE, 'utf8')) as Record<string, Record<'light' | 'dark', Record<string, number>>>;
    for (const [id, brand] of Object.entries(brandpackCases())) {
      const { tables } = brandAaTables(brand);
      for (const mode of ['light', 'dark'] as const) {
        for (const [pair, ratio] of Object.entries(pairRatios(tables[mode]))) {
          const want = browser[id][mode][pair];
          expect(ratio, `${id} ${mode} ${pair}`).not.toBeNull();
          expect(Math.abs((ratio as number) - want) / want, `${id} ${mode} ${pair}: ${ratio} vs ${want}`).toBeLessThan(0.02);
        }
      }
    }
  });

  test('applyBrand no aplica un pack con el CTA ilegible y no escribe nada; los packs del repo pasan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-aa-'));
    const pack = join(dir, 'pack');
    const out = join(dir, 'out');
    mkdirSync(pack);
    mkdirSync(join(out, 'src'), { recursive: true });
    writeFileSync(join(pack, 'brand.json'), JSON.stringify({ name: 'Ilegible', accent: { base: '#ffeb3b', strong: '#c8b900', subtle: 'rgb(255 235 59 / .15)', foreground: '#ffffff' } }));
    expect(() => applyBrand(out, pack)).toThrow(/--accent-foreground sobre --accent tiene 1\.\d+:1 en claro, mínimo 4\.5:1/);
    expect(existsSync(join(out, 'src', 'identity.css'))).toBe(false);

    const { 'sint-highlight': _synthetic, ...real } = brandpackCases();
    // Los del repo: el gate no los bloquea. sint-highlight es sintético y sí falla
    // (texto oscuro sobre --surface-muted claro en zona oscura, aa-report.json), que es justo lo que el gate debe atrapar.
    for (const [id, brand] of Object.entries(real)) { const t = brandAaTables(brand); expect(packAaErrors(t.tables, t.touched), id).toEqual([]); }
    for (const id of ['repo-base', 'repo-ejemplo']) {
      const target = join(dir, id);
      mkdirSync(join(target, 'src'), { recursive: true });
      expect(() => applyBrand(target, join(import.meta.dir, '..', 'brands', id === 'repo-base' ? 'brand-pack' : 'brand-pack-ejemplo'))).not.toThrow();
    }
  });

  test('un token que el pack fija cuenta en los pares que lo leen por var()', () => {
    // --background es var(--neutral-0) en claro (base tokens.css:20): fijar la rampa y no el rol dejaba el par sin medir.
    const dir = mkdtempSync(join(tmpdir(), 'wt-aa-var-'));
    const pack = join(dir, 'pack');
    mkdirSync(pack);
    mkdirSync(join(dir, 'out', 'src'), { recursive: true });
    writeFileSync(join(pack, 'brand.json'), JSON.stringify({ name: 'Rampa', overrides: { '--neutral-0': '#000000' } }));
    expect(() => applyBrand(join(dir, 'out'), pack)).toThrow(/--foreground sobre --background tiene 1\.17:1 en claro, mínimo 4\.5:1/);
  });
});
