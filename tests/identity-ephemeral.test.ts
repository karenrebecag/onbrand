import { describe, expect, test } from 'bun:test';
import { checkIdentity, ephemeralExpect, googleFontsHref, identitySensors } from '../src/identity-ephemeral';
import { identityReference } from '../src/ds-skill-agent';
import { contrast, MIN_CONTRAST, parseColor } from '../src/color-contrast';

const LIGHT = `--accent: #1f4d3a; --accent-strong: #163829; --accent-subtle: rgb(31 77 58 / 0.1); --accent-foreground: #ffffff; --background: #fbfaf7; --foreground: #14130f; --font-display: 'Fraunces', serif; --font-body: 'Inter Variable', sans-serif;`;
const DARK = `--accent: #7fc8a4; --accent-strong: #a9dcc2; --accent-subtle: rgb(127 200 164 / 0.16); --accent-foreground: #0d1a13; --background: #12130f; --foreground: #f4f2ec; --font-display: 'Fraunces', serif; --font-body: 'Inter Variable', sans-serif;`;
const CSS = `/* identidad de Lumbre */\n:root,\n[data-theme] { ${LIGHT} }\n[data-theme="dark"] { ${DARK} }\n`;
const HTML = `<html lang="es" data-theme="light"><head><link rel="stylesheet" href="${googleFontsHref(['Fraunces'])}" /></head></html>`;

const errorsOf = (css: string, html = HTML, changed = true): string[] => {
  const r = checkIdentity(css, html, changed);
  return r.status === 'invalid' ? r.errors : [];
};

describe('identidad efímera (sin pack)', () => {
  test('una hoja completa con fuentes de la lista enlazadas queda declarada', () => {
    const r = checkIdentity(CSS, HTML, true);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(ephemeralExpect(r.identity)).toEqual({ name: 'identidad declarada', accent: { base: '#1f4d3a' }, fonts: { display: 'Fraunces', body: 'Inter' }, surface: { background: '#fbfaf7' } });
  });

  test('la hoja vacía del starter pide declarar la identidad', () => {
    expect(errorsOf('/* Capa de identidad: vacía = contrato puro. */\n', HTML, false)[0]).toMatch(/sin marca: declara/);
  });

  test('la hoja de un pack sin tocar pasa; tocada es error', () => {
    expect(checkIdentity('/* brand-pack: Acme */\n', HTML, false).status).toBe('pack');
    expect(errorsOf('/* brand-pack: Acme */\n:root { --accent: red; }', HTML, true)[0]).toMatch(/marca del pack/);
  });

  // F1 b9314ba3 (#389, "acento azul"): el prompt manda el cambio global a identity.css y el sensor lo rechazaba.
  test('con un pedido de identidad en el turno, la hoja del pack editada pasa si se lee; ilegible es error', () => {
    const pack = (accent: string) => `/* brand-pack: Acme */\n:root,\n[data-theme] { --accent: ${accent}; --accent-foreground: #ffffff; }\n[data-theme="dark"] { --accent: ${accent}; --accent-foreground: #ffffff; }\n`;
    expect(checkIdentity(pack('#1d4ed8'), HTML, true, undefined, true).status).toBe('pack');
    const r = checkIdentity(pack('#93c5fd'), HTML, true, undefined, true);
    expect(r.status === 'invalid' ? r.errors.join('\n') : '').toMatch(/texto de un CTA sobre --accent tiene contraste/);
  });

  test('en un cambio global sobre el pack, un DESIGN.md que sigue con el acento anterior es error; actualizado pasa', () => {
    const pack = `/* brand-pack: Acme */\n:root,\n[data-theme] { --accent: #1d4ed8; --accent-foreground: #ffffff; }\n[data-theme="dark"] { --accent: #1d4ed8; --accent-foreground: #ffffff; }\n`;
    const design = (primary: string) => `---\ncolors:\n  primary: '${primary}'\n  background: '#ffffff'\n---\n## Brand & Style\n`;
    const r = checkIdentity(pack, HTML, true, design('#ff6600'), true);
    expect(r.status === 'invalid' ? r.errors.join('\n') : '').toMatch(/colors\.primary es #ff6600 y --accent en identity\.css es #1d4ed8/);
    expect(checkIdentity(pack, HTML, true, design('#1d4ed8'), true).status).toBe('pack');
    expect(checkIdentity(pack, HTML, true, null, true).status).toBe('pack');
  });

  test('pasa por el guard de brand.json: token fuera del contrato o valor con url() se rechazan', () => {
    expect(errorsOf(CSS.replace('--background: #fbfaf7;', '--brand-x: #fff;').replace('--background: #12130f;', '--brand-x: #000;')).join('\n')).toMatch(/--brand-x" no es un token del contrato/);
    expect(errorsOf(CSS.replace('--background: #fbfaf7;', '--background: url(https://x.y/a.png);')).join('\n')).toMatch(/valor CSS no permitido/);
  });

  test('@import, otros selectores y propiedades que no son tokens se rechazan', () => {
    const errors = errorsOf(`@import url('https://fonts.googleapis.com/css2?family=Sora');\n${CSS}\nbody { color: red; }`).join('\n');
    expect(errors).toMatch(/selector "body"/);
    expect(errors).toMatch(/"color: red" no es un token/);
    expect(errors).toMatch(/nada de @import/);
  });

  test('cada token claro necesita su valor oscuro', () => {
    expect(errorsOf(CSS.replace("--background: #12130f; ", '')).join('\n')).toMatch(/faltan en `\[data-theme="dark"\]`.*--background/);
  });

  test('fuente fuera de la lista, sin link, o data-accent en <html> son errores', () => {
    expect(errorsOf(CSS.replaceAll("'Fraunces'", "'Comic Neue'")).join('\n')).toMatch(/"Comic Neue" no está en la lista cerrada/);
    expect(errorsOf(CSS, '<html lang="es"></html>').join('\n')).toMatch(/"Fraunces" no tiene <link>/);
    expect(errorsOf(CSS, HTML.replace('data-theme="light"', 'data-theme="light" data-accent="orange"')).join('\n')).toMatch(/quita data-accent/);
  });

  test('el link de identity.md es el que acepta el validador', () => {
    const doc = identityReference([['--accent', '#000']]);
    const href = /<link rel="stylesheet" href="([^"]+)"/.exec(doc)?.[1];
    expect(href).toBe(googleFontsHref(['Fraunces', 'Manrope']) ?? undefined);
    expect(checkIdentity(CSS.replaceAll("'Inter Variable'", "'Manrope'"), `<html><link rel="stylesheet" href="${href}" /></html>`, true).status).toBe('ok');
  });
});

describe('sensor de identidad sin pack', () => {
  const measure = (accent: string, family: string) => ({ accent: { attr: '', rgb: accent }, fonts: [{ family, loaded: true, count: 10, generic: false }], sections: [] }) as unknown as Parameters<typeof identitySensors>[0];

  test('sin identidad declarada es defecto brand.declared; con pack no afirma nada', () => {
    expect(identitySensors(measure('rgb(0,0,0)', 'Inter'), '', HTML).map((d) => d.field)).toEqual(['brand.declared']);
    expect(identitySensors(measure('rgb(0,0,0)', 'Inter'), '/* brand-pack: Acme */', HTML)).toEqual([]);
  });

  test('la página tiene que pintar el acento y la fuente declarados', () => {
    expect(identitySensors(measure('rgb(31, 77, 58)', 'Fraunces'), CSS, HTML).map((d) => d.field)).toEqual(['brand.typeface']);
    expect(identitySensors(measure('rgb(244, 129, 32)', 'Geist'), CSS, HTML).map((d) => d.field).sort()).toEqual(['brand.accent', 'brand.typeface', 'brand.typeface']);
  });
});

describe('contraste de la identidad declarada', () => {
  test('un CTA ilegible en el bloque oscuro (cierre inverse) es error y propone el tono derivado del acento', () => {
    const errors = errorsOf(CSS.replace('--accent-foreground: #0d1a13;', '--accent-foreground: #ffffff;')).join('\n');
    expect(errors).toMatch(/bloque oscuro: texto de un CTA sobre --accent tiene contraste 1\.\d+:1/);
    const fix = /usa --accent: (#[\da-f]{6})/.exec(errors)?.[1];
    expect(fix).toBeDefined();
    expect(contrast(parseColor(fix)!, [255, 255, 255])).toBeGreaterThanOrEqual(MIN_CONTRAST);
  });

  test('texto sobre fondo bajo 4.5:1 es error, también en oklch; un par a medias o un color-mix no se puede medir', () => {
    expect(errorsOf(CSS.replace('--background: #12130f;', '--background: #9a9a9a;')).join('\n')).toMatch(/bloque oscuro: texto sobre --background tiene contraste/);
    expect(errorsOf(CSS.replace('--accent: #1f4d3a;', '--accent: oklch(85% 0.1 160);')).join('\n')).toMatch(/bloque claro: texto de un CTA sobre --accent tiene contraste/);
    expect(errorsOf(CSS.replace('--accent: #1f4d3a;', '--accent: color-mix(in oklab, red, blue);')).join('\n')).toMatch(/bloque claro: --accent tiene que ser hex, rgb\(\) u oklch\(\)/);
    expect(errorsOf(CSS.replace('--foreground: #f4f2ec;', '')).join('\n')).toMatch(/bloque oscuro: declara --foreground y --background juntos/);
  });
});
