import { describe, expect, test } from 'bun:test';
import { measureAA } from '../scripts/brandpack-red';
import { brandAaTables, parseBrandPack, type BrandPack } from '../src/brand';
import { pairRatios } from '../src/brand-aa';


// El gate de applyBrand mide sin navegador (src/brand-aa.ts); esto confirma en chromium que esa medida es la que pinta la
// página, con packs que no están en la red: acentos translúcidos, superficie parcial y tokensDark a medias.
const GENERATED: Record<string, unknown> = {
  'translucido': { name: 'T', accent: { base: '#2b59c3', strong: '#1d3f8f', subtle: 'rgb(43 89 195 / 0.14)', foreground: '#ffffff' }, surface: { background: '#f7f4ee' } },
  'oscuro-parcial': { name: 'O', accent: { base: '#c2410c', strong: '#9a3412', subtle: 'rgb(194 65 12 / 0.1)', foreground: '#ffffff' }, tokensDark: { '--background': '#1a1410' } },
  'superficie-entera': { name: 'S', accent: { base: '#0f766e', strong: '#115e59', subtle: '#ccfbf1', foreground: '#f0fdfa' }, surface: { background: '#ffffff', surface: '#f8fafc', foreground: '#0f172a', textSecondary: '#475569' }, tokensDark: { '--background': '#020617', '--surface': '#0f172a', '--foreground': '#f8fafc', '--text-secondary': '#94a3b8', '--accent': '#5eead4', '--accent-foreground': '#042f2e' } },
  'v2-preset': { name: 'P', theme: { preset: 'green', colorMode: 'dark' } },
  'v2-overrides': { name: 'V', overrides: { '--accent': '#7c3aed', '--accent-strong': '#6d28d9', '--accent-subtle': 'rgb(124 58 237 / 0.12)', '--accent-foreground': '#ffffff', '--surface-muted': '#f3f0ff' }, overridesDark: { '--accent': '#c4b5fd', '--accent-foreground': '#1e1b4b' } },
};

describe('gate AA sin navegador == chromium', () => {
  test('cada par medible da la misma razón (±2 %) en claro y en oscuro', async () => {
    const packs = Object.fromEntries(Object.entries(GENERATED).map(([id, raw]) => [id, parseBrandPack(raw, { skipComponents: true })])) as Record<string, BrandPack>;
    const browser = await measureAA(packs);
    let compared = 0;
    for (const [id, brand] of Object.entries(packs)) {
      const { tables } = brandAaTables(brand);
      for (const mode of ['light', 'dark'] as const) {
        for (const [pair, r] of Object.entries(pairRatios(tables[mode]))) {
          if (r === null) continue;
          const want = browser[id]![mode][pair]!;
          compared++;
          expect(Math.abs(r - want) / want, `${id} ${mode} ${pair}: ${r} vs chromium ${want}`).toBeLessThan(0.02);
        }
      }
    }
    expect(compared).toBeGreaterThan(80);
    // Levanta un navegador: bajo carga pasa de los 5 s por defecto sin que nada esté mal.
  }, 60_000);
});
