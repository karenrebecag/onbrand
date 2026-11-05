import { describe, expect, test } from 'bun:test';
import { migrateV1ToV2 as toV2 } from '../scripts/brandpack-migrate-v2';
import { brandAaTables, parseBrandPack } from '../src/brand';
import { AA_PAIRS, packAaErrors } from '../src/brand-aa';
import { contrast, parseColor } from '../src/color-contrast';

// AA del pack por propiedad (#7): con colores al azar, el gate de applyBrand tiene que coincidir con un oráculo que solo
// mira los valores literales del brand.json. La red de ejemplos fija los packs que existen; esta, cualquiera que se escriba.

/** PRNG con semilla (mulberry32): la misma corrida en local y en CI, sin dependencia nueva. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Sesgo hacia los extremos y los grises medios, donde viven los casos límite de 4.5:1 y 3:1.
function color(r: () => number): string {
  const band = r();
  const base = band < 0.3 ? r() * 40 : band < 0.6 ? 215 + r() * 40 : 90 + r() * 80;
  const ch = () => Math.max(0, Math.min(255, Math.round(base + (r() - 0.5) * 60)));
  return `#${[ch(), ch(), ch()].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

const SURFACE = { background: '--background', surface: '--surface', foreground: '--foreground', textSecondary: '--text-secondary' } as const;

function randomV1(r: () => number, i: number): Record<string, unknown> {
  const surface = Object.fromEntries(Object.keys(SURFACE).filter(() => r() < 0.7).map((k) => [k, color(r)]));
  const dark = Object.fromEntries(['--background', '--foreground', '--accent', '--accent-foreground', '--surface'].filter(() => r() < 0.5).map((t) => [t, color(r)]));
  return {
    name: `Gen ${i}`,
    accent: { base: color(r), strong: color(r), subtle: color(r), foreground: color(r) },
    ...(Object.keys(surface).length ? { surface } : {}),
    ...(Object.keys(dark).length ? { tokensDark: dark } : {}),
  };
}

/** Lo que el brand.json fija por modo, leído del JSON y no del código: en oscuro valen los mismos valores salvo tokensDark. */
function literals(v1: Record<string, unknown>): { light: Record<string, string>; dark: Record<string, string> } {
  const accent = v1.accent as Record<string, string>;
  const surface = (v1.surface ?? {}) as Record<string, string>;
  const light: Record<string, string> = {
    '--accent': accent.base!, '--accent-strong': accent.strong!, '--accent-subtle': accent.subtle!, '--accent-foreground': accent.foreground!,
    ...Object.fromEntries(Object.entries(surface).map(([k, v]) => [SURFACE[k as keyof typeof SURFACE], v])),
  };
  return { light, dark: { ...light, ...((v1.tokensDark ?? {}) as Record<string, string>) } };
}

const ratio = (fg: string, bg: string) => Math.round(contrast(parseColor(fg)!, parseColor(bg)!) * 100) / 100;
const MODE = { light: 'claro', dark: 'oscuro' } as const;
const N = 300;

describe('gate AA del pack, por propiedad', () => {
  const r = prng(20261103);
  const packs = Array.from({ length: N }, (_, i) => randomV1(r, i));

  test('todo par que el pack fija entero y no llega a su umbral es error del gate, y ningún error lo contradice', () => {
    let violations = 0;
    for (const v1 of packs) {
      const { tables, touched } = brandAaTables(parseBrandPack(v1, { skipComponents: true }));
      const errors = new Set(packAaErrors(tables, touched).map((e) => e.replace(/ tiene [\d.]+:1/, '')));
      const lit = literals(v1);
      for (const mode of ['light', 'dark'] as const) {
        for (const { fg, bg, min } of AA_PAIRS) {
          const [f, b] = [lit[mode][fg], lit[mode][bg]];
          if (!f || !b) continue;
          const key = `${fg} sobre ${bg} en ${MODE[mode]}, mínimo ${min}:1`;
          const below = ratio(f, b) < min;
          if (below) violations++;
          expect({ pack: v1.name, key, gate: errors.has(key) }).toEqual({ pack: v1.name, key, gate: below });
        }
      }
    }
    // Sin dientes la propiedad pasaría con un generador que nunca cae bajo el umbral.
    expect(violations).toBeGreaterThan(N / 10);
  });

  test('el mismo pack escrito en v2 da exactamente los mismos errores', () => {
    for (const v1 of packs) {
      const gate = (raw: unknown) => { const t = brandAaTables(parseBrandPack(raw, { skipComponents: true })); return packAaErrors(t.tables, t.touched); };
      expect(gate(toV2(v1)), String(v1.name)).toEqual(gate(v1));
    }
  });

  test('cada error nombra un par que el pack tocó', () => {
    for (const v1 of packs.slice(0, 50)) {
      const { tables, touched } = brandAaTables(parseBrandPack(v1, { skipComponents: true }));
      for (const e of packAaErrors(tables, touched)) {
        const [, fg, bg, band] = /^(--[\w-]+) sobre (--[\w-]+)( \(banda)?/.exec(e)!;
        // La banda es color-mix de --background y --foreground (tokens.css): fijar cualquiera de los dos la mueve.
        const named = band ? [fg!, bg!, '--background', '--foreground'] : [fg!, bg!];
        expect(named.some((t) => touched.has(t)), e).toBe(true);
      }
    }
  });
});
