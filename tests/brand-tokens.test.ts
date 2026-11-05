import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertBrandCoverage, brandCoverage, identityCss, parseBrandPack, resolveBrandTrace, resolveIdentity, setHtmlTheme } from '../src/brand';
import { packTokens } from '../src/brand-pack';

const base = { name: 'X', accent: 'blue' as const };
// El contrato del core vive en el base (B9 paso 4); el test de WhatsApp de abajo mide Arc y lo lee aparte.
const CONTRACT = join(import.meta.dir, '..', 'templates', 'base-scaffold', 'src', 'theme', 'tokens.css');
const contractNames = [...readFileSync(CONTRACT, 'utf8').matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]);

describe('token map — la marca ancla tokens del contrato Arc (spec token-map-identidad)', () => {
  test('CA1: un token válido llega a identity.css como declaración :root', () => {
    const css = identityCss(parseBrandPack({ ...base, tokens: { '--radius-control': '0.25rem' } }));
    expect(css).toContain('--radius-control: 0.25rem;');
  });

  test('CA2: una clave fuera del contrato se rechaza en el parse', () => {
    expect(() => parseBrandPack({ ...base, tokens: { '--no-existe': '1rem' } })).toThrow(/no es un token del contrato/);
  });

  test('CA3: un valor con inyección CSS se rechaza (frontera de confianza)', () => {
    expect(() => parseBrandPack({ ...base, tokens: { '--accent': 'red; } body { display: none' } })).toThrow(/no permitido/);
    expect(() => parseBrandPack({ ...base, tokens: { '--background': '@import url(x)' } })).toThrow(/no permitido/);
  });

  test('CA4: tokens gana sobre el accent tipado (canal general al final)', () => {
    const brand = parseBrandPack({ name: 'X', accent: { base: '#000', strong: '#111', subtle: '#222' }, tokens: { '--accent': '#abcdef' } });
    const decls = resolveIdentity(brand).rootDeclarations;
    const accentDecls = decls.filter((d) => d.startsWith('--accent:'));
    expect(accentDecls.at(-1)).toBe('--accent: #abcdef;'); // la del token queda después de la del accent tipado
  });

  test('CA5: el allowlist coincide con el contrato — todo --x de foundation.css se acepta; uno ajeno no', () => {
    expect(contractNames.length).toBeGreaterThan(50); // el contrato real tiene ~109 tokens
    for (const name of new Set(contractNames)) {
      expect(() => parseBrandPack({ ...base, tokens: { [name]: '1rem' } })).not.toThrow();
    }
    expect(() => parseBrandPack({ ...base, tokens: { '--zzz-no-contract': '1rem' } })).toThrow(/no es un token del contrato/);
  });
});

describe('token map en oscuro — tokensDark bajo [data-theme="dark"] (alcance de ancestro)', () => {
  test('CA6: tokensDark emite en el bloque dark, no en :root', () => {
    const css = identityCss(parseBrandPack({ ...base, tokens: { '--background': '#fff' }, tokensDark: { '--background': '#000' } }));
    expect(css).toMatch(/:root,\s*\[data-theme\]\s*\{[^}]*--background: #fff;[^}]*\}/);
    expect(css).toMatch(/^\[data-theme="dark"\]\s*\{[^}]*--background: #000;[^}]*\}/m);
  });

  test('CA7: tokensDark aplica el mismo allowlist y guard de valor', () => {
    expect(() => parseBrandPack({ ...base, tokensDark: { '--no-existe': '1rem' } })).toThrow(/no es un token del contrato/);
    expect(() => parseBrandPack({ ...base, tokensDark: { '--background': 'x; } html { }' } })).toThrow(/no permitido/);
  });

  test('sin tokensDark no hay bloque dark', () => {
    const css = identityCss(parseBrandPack({ name: 'X', accent: 'blue' }));
    expect(css).not.toContain('data-theme');
  });
});

describe('modo oscuro coherente — la marca gana en dark (paso 2b, C2)', () => {
  test('el accent de marca se reemite bajo [data-theme=dark] para ganar a foundation.css, también en una zona', () => {
    const css = identityCss(parseBrandPack({
      name: 'X', accent: { base: '#ff6600', strong: '#a44200', subtle: '#ffe' },
      tokens: { '--space-4': '16px' }, tokensDark: { '--background': '#0a0a0a' },
    }));
    const dark = css.match(/^\[data-theme="dark"\]\s*\{([^}]*)\}/m)?.[1] ?? '';
    expect(dark).toContain('--accent: #ff6600'); // identidad invariante reemitida
    expect(dark).toContain('--space-4: 16px');
    expect(dark).toContain('--background: #0a0a0a'); // tokensDark gana al valor claro
  });

  test('setHtmlTheme reemplaza o inserta data-theme en el <html>', () => {
    expect(setHtmlTheme('<html lang="es" data-theme="light">', 'dark')).toContain('data-theme="dark"');
    expect(setHtmlTheme('<html lang="es">', 'dark')).toContain('data-theme="dark"');
    expect(setHtmlTheme('<html lang="es" data-theme="light">', 'dark')).not.toContain('"light"');
  });
});

describe('resolveBrandTrace — procedencia y huella de la marca (paso 1, C13)', () => {
  const packDir = mkdtempSync(join(tmpdir(), 'wt-brand-'));
  // Pack completo: cierra el contrato con inherit (resolveBrandTrace valida la cobertura al cargar).
  const accentCovered = ['--accent', '--accent-strong', '--accent-subtle', '--accent-foreground'];
  const inherit = Object.fromEntries(contractNames.filter((t) => !accentCovered.includes(t)).map((t) => [t, 'contrato']));
  writeFileSync(join(packDir, 'brand.json'), JSON.stringify({ name: 'Tmp', accent: 'blue', inherit }));

  test('brief.brand gana la precedencia (origin brief) con sha256 del brand.json y conteo del contrato', () => {
    const t = resolveBrandTrace(packDir);
    expect(t.origin).toBe('brief');
    expect(t.path).toBe(packDir);
    expect(t.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(t.contractTokens).toBeGreaterThan(0);
  });

  test('sin ref pero con WT_BRAND_PACK → origin env', () => {
    const prev = process.env.WT_BRAND_PACK;
    process.env.WT_BRAND_PACK = packDir;
    try {
      expect(resolveBrandTrace().origin).toBe('env');
    } finally {
      if (prev === undefined) delete process.env.WT_BRAND_PACK;
      else process.env.WT_BRAND_PACK = prev;
    }
  });

  test('el brief nombra una marca sin brand.json → falla explícito, no cae en silencio al base', () => {
    expect(() => resolveBrandTrace(join(packDir, 'no-existe'))).toThrow(/no existe su brand\.json/);
  });
});

describe('cobertura del contrato — cerrar los 97 tokens (paso 2, C1)', () => {
  test('una marca que deja tokens del contrato sin definir ni heredar falla explícito', () => {
    expect(() => assertBrandCoverage(parseBrandPack({ name: 'X', accent: 'blue' }))).toThrow(/tokens del contrato sin definir ni heredar/);
  });

  test('declarar un token en inherit lo cuenta como cubierto (y reduce los que faltan)', () => {
    const t = brandCoverage(parseBrandPack({ name: 'X', accent: 'blue' })).missing[0];
    const after = brandCoverage(parseBrandPack({ name: 'X', accent: 'blue', inherit: { [t]: 'motivo del contrato' } }));
    expect(after.covered.has(t)).toBe(true);
    expect(after.missing).not.toContain(t);
  });

  test('inherit con un token fuera del contrato se rechaza en la carga', () => {
    expect(() => parseBrandPack({ name: 'X', accent: 'blue', inherit: { '--no-existe': 'x' } })).toThrow(/no es un token del contrato/);
  });

  test('inherit sin motivo (string vacío) se rechaza', () => {
    expect(() => parseBrandPack({ name: 'X', accent: 'blue', inherit: { '--accent': '' } })).toThrow(/necesita un motivo/);
  });
});

describe('brand.json del registry es input: accent, surface y fonts no inyectan CSS', () => {
  const pack = (extra: object) => ({ name: 'x', accent: 'blue', ...extra });

  test('un color que cierra la regla o cuela @import se rechaza en accent y surface', () => {
    expect(() => parseBrandPack({ name: 'x', accent: { base: 'red;}@import url(//x)', strong: '#000', subtle: '#eee' } })).toThrow(/accent.base/);
    expect(() => parseBrandPack(pack({ surface: { background: '#fff}body{display:none' } }))).toThrow(/surface.background/);
  });

  test('una familia con comilla suelta se rechaza; con comillas cerradas pasa', () => {
    expect(() => parseBrandPack(pack({ fonts: { display: "Grift'" } }))).toThrow(/fonts.display/);
    expect(parseBrandPack(pack({ fonts: { display: "'Grift', sans-serif" } })).fonts?.display).toBe("'Grift', sans-serif");
  });

  test('fonts.import solo acepta ./fonts/… o https sin comillas; Google Fonts sigue pasando', () => {
    expect(() => parseBrandPack(pack({ fonts: { import: "x'); } body { display:none } @import url('//evil" } }))).toThrow(/fonts.import/);
    expect(() => parseBrandPack(pack({ fonts: { import: './fonts/../../secret.css' } }))).toThrow(/fonts.import/);
    expect(() => parseBrandPack(pack({ fonts: { import: 'http://x/f.css' } }))).toThrow(/fonts.import/);
    expect(parseBrandPack(pack({ fonts: { import: './fonts/fonts.css' } })).fonts?.import).toBe('./fonts/fonts.css');
    const google = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap';
    expect(parseBrandPack(pack({ fonts: { import: google } })).fonts?.import).toBe(google);
  });
});

test('la banda de sección es un derivado del contrato: un pack que no la fija no deja tokens sin cubrir', () => {
  expect(brandCoverage(parseBrandPack({ name: 'x', accent: 'blue' })).missing).not.toContain('--surface-band');
});

// Schema v2 (#7): `overrides`/`overridesDark` son el canal de tokens y heredan las mismas reglas que tokens/tokensDark.
describe('token map en v2: overrides y overridesDark', () => {
  const ACCENT_TRIO = ['--accent', '--accent-strong', '--accent-subtle'];

  test('el allowlist es el contrato: todo --x de foundation.css entra por overrides; uno ajeno no', () => {
    for (const name of new Set(contractNames)) {
      if (ACCENT_TRIO.includes(name)) continue; // el acento propio va en trío, como el accent de v1
      expect(() => parseBrandPack({ name: 'X', overrides: { [name]: '1rem' } }), name).not.toThrow();
    }
    expect(() => parseBrandPack({ name: 'X', overrides: { '--zzz-no-contract': '1rem' } })).toThrow(/overrides."--zzz-no-contract" no es un token del contrato/);
    expect(() => parseBrandPack({ name: 'X', overridesDark: { '--zzz-no-contract': '1rem' } })).toThrow(/overridesDark."--zzz-no-contract" no es un token del contrato/);
  });

  test('un valor con inyección CSS se rechaza en los dos canales', () => {
    expect(() => parseBrandPack({ name: 'X', overrides: { '--background': 'red; } body { display: none' } })).toThrow(/no permitido/);
    expect(() => parseBrandPack({ name: 'X', overridesDark: { '--background': '@import url(x)' } })).toThrow(/no permitido/);
  });

  test('overrides llega a :root y a la zona oscura; overridesDark solo a la oscura y gana', () => {
    const css = identityCss(parseBrandPack({ name: 'X', overrides: { '--radius-control': '0.25rem', '--background': '#fff' }, overridesDark: { '--background': '#000' } }));
    expect(css).toMatch(/:root,\s*\[data-theme\]\s*\{[^}]*--background: #fff;[^}]*\}/);
    const dark = css.match(/^\[data-theme="dark"\]\s*\{([^}]*)\}/m)?.[1] ?? '';
    expect(dark).toContain('--radius-control: 0.25rem;');
    expect(dark).toContain('--background: #000;');
    expect(dark).not.toContain('--background: #fff;');
  });

  test('resolveBrandTrace carga un pack v2 sin inherit: en v2 lo no fijado es contrato', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-brand-v2-'));
    writeFileSync(join(dir, 'brand.json'), JSON.stringify({ name: 'Tmp', theme: { preset: 'blue' } }));
    const t = resolveBrandTrace(dir);
    expect(t.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(t.contractTokens).toBeGreaterThan(0);
  });
});

// B9 paso 4: el allowlist del pack es el core más el contrato del scaffold del perfil. Con el default (base) un token de
// otro DS se rechaza; el caso con Arc montado vive en tests/arc/brand-tokens-arc.test.ts.
describe('allowlist del pack según scaffoldDir', () => {
  test('con el default (base) un token de otro DS se rechaza con su nombre', () => {
    const prev = process.env.WT_SCAFFOLD_DIR;
    delete process.env.WT_SCAFFOLD_DIR;
    try {
      expect(() => parseBrandPack({ name: 'X', overrides: { '--whatsapp': '#25d366' } }, { skipComponents: true })).toThrow(/"--whatsapp" no es un token del contrato/);
    } finally { if (prev !== undefined) process.env.WT_SCAFFOLD_DIR = prev; }
  });

  test('un scaffold sin tokens legibles falla explícito, no cae al core', () => {
    const empty = mkdtempSync(join(tmpdir(), 'wt-scaffold-'));
    expect(() => packTokens(empty)).toThrow(/no hay src\/index\.css/);
    mkdirSync(join(empty, 'src'));
    writeFileSync(join(empty, 'src', 'index.css'), "@import './identity.css';\n");
    expect(() => packTokens(empty)).toThrow(/no declaran tokens/);
    writeFileSync(join(empty, 'src', 'index.css'), "@import '../../fuera.css';\n");
    expect(() => packTokens(empty)).toThrow(/fuera del scaffold/);
  });
});
