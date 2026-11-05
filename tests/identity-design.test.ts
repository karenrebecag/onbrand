import { describe, expect, test } from 'bun:test';
import { checkDesignMd } from '../src/identity-design';
import { checkIdentity, googleFontsHref } from '../src/identity-ephemeral';

const LIGHT = { '--accent': '#1f4d3a', '--accent-foreground': '#ffffff', '--background': '#fbfaf7', '--foreground': '#14130f', '--font-display': "'Fraunces', serif", '--font-body': "'Inter Variable', sans-serif" };
const DARK = { '--background': '#12130f', '--foreground': '#f4f2ec' };
const MD = `---
name: Lumbre
colors:
  primary: "#1f4d3a"
  on-primary: "#ffffff"
  background: "#fbfaf7"
  on-background: "#14130f"
  inverse-surface: "#12130f"
  inverse-on-surface: "#f4f2ec"
typography:
  display: { fontFamily: Fraunces, fontWeight: 500 }
  body: { fontFamily: Inter, fontWeight: 400 }
---

## Brand & Style
Editorial y cálida.

## Colors
El acento #1f4d3a solo en CTAs; el cierre va en inverse (#12130f).

## Typography
Fraunces en titulares, Inter en cuerpo.
`;

describe('DESIGN.md de la identidad (formato google-labs-code/design.md)', () => {
  test('un DESIGN.md que copia identity.css, claro y oscuro, no tiene errores', () => {
    expect(checkDesignMd(MD, LIGHT, DARK)).toEqual([]);
  });

  test('prosa y tokens que se contradicen (el caso S2 de Stitch) son error', () => {
    const errs = checkDesignMd(MD.replace('primary: "#1f4d3a"', 'primary: "#ff6600"').replace('El acento #1f4d3a', 'El acento #ff6600 y #0000ff'), LIGHT, DARK);
    expect(errs.join('\n')).toMatch(/colors\.primary es #ff6600 y --accent en identity\.css es #1f4d3a/);
    expect(errs.join('\n')).toMatch(/la prosa nombra #0000ff/);
  });

  test('la zona oscura viaja: inverse-surface tiene que ser el --background del bloque oscuro', () => {
    expect(checkDesignMd(MD.replace('inverse-surface: "#12130f"', 'inverse-surface: "#000000"'), LIGHT, DARK).join('\n')).toMatch(/inverse-surface es #000000 y --background del bloque oscuro/);
  });

  test('fuente distinta, peso fuera de Arc, sección o frontmatter que faltan', () => {
    const errs = checkDesignMd(MD.replace('fontFamily: Fraunces, fontWeight: 500', 'fontFamily: Sora, fontWeight: 800').replace('## Typography', '## Tipos'), LIGHT, DARK).join('\n');
    expect(errs).toMatch(/typography\.display\.fontFamily es Sora y --font-display es Fraunces/);
    expect(errs).toMatch(/fontWeight 800; Arc usa 400 o 500/);
    expect(errs).toMatch(/falta la sección "## Typography"/);
    expect(checkDesignMd('## Colors', LIGHT, DARK)[0]).toMatch(/falta el frontmatter/);
  });

  test('checkIdentity: sin pack exige DESIGN.md si se le pasa el workspace; con pack no', () => {
    const css = `:root,\n[data-theme] { --accent: #1f4d3a; --accent-strong: #163829; --accent-subtle: rgb(31 77 58 / 0.1); --accent-foreground: #ffffff; --background: #fbfaf7; --foreground: #14130f; --font-display: 'Fraunces', serif; --font-body: 'Inter Variable', sans-serif; }\n[data-theme="dark"] { --accent: #7fc8a4; --accent-strong: #a9dcc2; --accent-subtle: rgb(127 200 164 / 0.16); --accent-foreground: #0d1a13; --background: #12130f; --foreground: #f4f2ec; --font-display: 'Fraunces', serif; --font-body: 'Inter Variable', sans-serif; }`;
    const html = `<html><link rel="stylesheet" href="${googleFontsHref(['Fraunces'])}" /></html>`;
    expect(checkIdentity(css, html, true, MD).status).toBe('ok');
    const missing = checkIdentity(css, html, true, null);
    expect(missing.status === 'invalid' && missing.errors.join('\n')).toMatch(/falta DESIGN\.md/);
    expect(checkIdentity('/* brand-pack: Acme */\n', html, false, null).status).toBe('pack');
  });
});
