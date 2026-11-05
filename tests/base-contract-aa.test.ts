// El contrato del DS base, sin pack, en cada superficie que puede quedar como --background: la raíz y las bandas de
// data-wt-surface. Umbrales WCAG 2.2: 4.5:1 para texto (SC 1.4.3) y 3:1 para el borde que identifica un control (SC
// 1.4.11). CONTRACT_DEBT exime a los packs de la deuda del contrato; al contrato mismo no lo exime.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import contract from '../src/theme/contract.json';
import { AA_PAIRS, BAND_PAIRS, BAND_REMAP, bandRatios, bandTable, pairRatios } from '../src/brand-aa';

const SRC = join(import.meta.dir, '..', 'templates', 'base-scaffold', 'src');
const TABLES = { light: contract.light, dark: { ...contract.light, ...contract.dark } } as Record<'light' | 'dark', Record<string, string>>;

// Ningún bloque ni átomo del base pinta --text-muted sobre --surface-muted (el test de abajo lo mantiene así), y ese par
// da 4.43:1 en claro. Si un bloque lo empieza a pintar, el test de la guarda falla antes que la página.
const UNUSED = new Set(['--text-muted / --surface-muted']);

describe('contrato base: AA por superficie', () => {
  for (const mode of ['light', 'dark'] as const) {
    test(`raíz y bandas en ${mode === 'light' ? 'claro' : 'oscuro'}`, () => {
      const below: string[] = [];
      const root = pairRatios(TABLES[mode]);
      for (const { fg, bg, min } of AA_PAIRS) {
        const key = `${fg} / ${bg}`;
        if (UNUSED.has(key)) continue;
        expect(root[key], key).not.toBeNull();
        if (root[key]! < min) below.push(`${key} ${root[key]}`);
      }
      const bands = bandRatios(TABLES[mode], mode);
      for (const [key, r] of Object.entries(bands)) {
        const min = BAND_PAIRS.find((p) => key.startsWith(`${p.fg} /`))!.min;
        expect(r, key).not.toBeNull();
        if (r! < min) below.push(`${key} ${r}`);
      }
      expect(below).toEqual([]);
    });
  }

  test('BANDS y BAND_REMAP del gate son los de tokens.css: si el CSS cambia la banda, el gate no mide otra cosa', () => {
    const css = readFileSync(join(SRC, 'theme', 'tokens.css'), 'utf8');
    const band = /\[data-wt-surface="muted"\],\s*\[data-wt-surface="raised"\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(band).toContain('--background: var(--surface-band)');
    expect(band).not.toContain('--text-muted');
    // El remap vive en la regla que excluye lo oscuro: es BAND_REMAP.light, y BAND_REMAP.dark queda vacío.
    const light = /\[data-wt-surface="raised"\]:not\(\[data-theme="dark"\], \[data-theme="dark"\] \*\)\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    for (const [token, value] of Object.entries(BAND_REMAP.light)) expect(light).toContain(`${token}: ${value}`);
    expect(BAND_REMAP.dark).toEqual({});
  });

  test('la banda clara es #f4f4f4 y su texto apagado es el secundario del pack', () => {
    // QA midió en chromium la banda de Stats como oklab(0.968…) = #f4f4f4: el color-mix en oklab da lo mismo.
    expect(bandTable(TABLES.light, '--surface-band', 'light')!['--background']).toBe('#f4f4f4');
    const pack = { ...TABLES.light, '--text-secondary': '#4a4a4a' };
    expect(bandRatios(pack, 'light')['--text-muted / band:muted']).toBe(bandRatios(pack, 'light')['--text-secondary / band:muted']);
  });
});

test('guarda: ninguna regla del base pinta --text-muted sobre --surface-muted', () => {
  const css = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? css(join(dir, e.name)) : e.name.endsWith('.css') ? [join(dir, e.name)] : []);
  const offenders = css(SRC).flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, , body]) => /background[^;]*var\(--surface-muted\)/.test(body!) && /(^|;)\s*color\s*:\s*var\(--text-muted\)/.test(body!))
    .map(([, sel]) => `${f.slice(SRC.length + 1)}: ${sel!.trim()}`));
  expect(offenders).toEqual([]);
});
