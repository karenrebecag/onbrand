import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { definedTokens, undefinedTokenReport, undefinedTokens, usedTokens } from '../src/css-tokens';

describe('css-tokens', () => {
  test('un var(--x) sin definición en el DS, identity ni la propia hoja se reporta con su archivo', () => {
    const ds = ':root { --background: #fff; --surface-band: color-mix(in oklab, var(--background), #000 4%); }\n[data-wt-surface="muted"] { --background: var(--surface-band); }';
    const identity = ':root,\n[data-theme] {\n  --accent: #0b6b5c;\n}';
    const sections = new Map([
      ['03-beneficios.module.css', '.features { background: var(--surface-muted); color: var(--accent); }'],
      ['02-hero.module.css', '.hero { --hero-gap: 2rem; gap: var(--hero-gap); background: var(--background); }'],
    ]);
    expect(definedTokens(ds)).toEqual(new Set(['--background', '--surface-band']));
    expect(usedTokens(sections.get('03-beneficios.module.css')!)).toEqual(new Set(['--surface-muted', '--accent']));
    expect(undefinedTokens(sections, [ds, identity])).toEqual(new Map([['--surface-muted', ['03-beneficios.module.css']]]));
  });

  test('el reporte lee el workspace: hojas del DS en src/components, identity.css y src/sections', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-css-tokens-'));
    mkdirSync(join(dir, 'src', 'components', 'arc'), { recursive: true });
    mkdirSync(join(dir, 'src', 'sections'));
    writeFileSync(join(dir, 'src', 'components', 'arc', 'foundation.css'), ':root { --surface-band: #eee; }');
    writeFileSync(join(dir, 'src', 'identity.css'), ':root { --accent: #000; }');
    writeFileSync(join(dir, 'src', 'sections', '03-beneficios.module.css'), '.a { background: var(--surface-muted); color: var(--accent); }');
    expect(undefinedTokenReport(dir)).toBe('1 token CSS que no existen en src/sections (caen a transparente o al valor inicial; usa los del DS o defínelos): --surface-muted (03-beneficios.module.css)');
    writeFileSync(join(dir, 'src', 'sections', '03-beneficios.module.css'), '.a { background: var(--surface-band); color: var(--accent); }');
    expect(undefinedTokenReport(dir)).toBe('Tokens CSS: todos los var(--x) de src/sections existen.');
  });
});

describe('css-tokens: falsos positivos', () => {
  test('ni un var con fallback ni un --x que fija el TSX se reportan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-css-tokens-'));
    mkdirSync(join(dir, 'src', 'sections'), { recursive: true });
    writeFileSync(join(dir, 'src', 'sections', '02-hero.tsx'), "export const Hero = () => items.map((x, i) => <li style={{ '--i': i } as React.CSSProperties} />);");
    writeFileSync(join(dir, 'src', 'sections', '02-hero.module.css'), '.li { animation-delay: calc(var(--i) * 80ms); color: var(--brand-x, #000); background: var(--nope); }');
    expect(undefinedTokenReport(dir)).toBe('1 token CSS que no existen en src/sections (caen a transparente o al valor inicial; usa los del DS o defínelos): --nope (02-hero.module.css)');
  });
});
