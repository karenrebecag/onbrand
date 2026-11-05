import { describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyBrand, logoSrc, parseBrandPack } from '../src/brand';
import { motionBudget } from '../src/motion-budget';
import { prepareWorkspace } from '../src/runtime/workspace';

describe('presupuesto de motion de la página', () => {
  test('una sola entrada, en el hero; el resto none', () => {
    expect(motionBudget(['navbar', 'hero', 'features', 'hero', 'cta'])).toEqual(['none', 'entrance', 'none', 'none', 'none']);
  });

  test('sin hero no anima ninguna sección (como v0)', () => {
    expect(motionBudget(['features', 'stats', 'cta'])).toEqual(['none', 'none', 'none']);
  });
});

describe('prepareWorkspace aplica la marca en el camino v0', () => {
  test('el workspace sale con identity.css y data-accent de la marca, no con el default del scaffold', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-brand-'));
    const scaffold = join(root, 'scaffold');
    mkdirSync(join(scaffold, 'src'), { recursive: true });
    writeFileSync(join(scaffold, 'index.html'), '<html lang="es" data-theme="light" data-accent="orange"><body></body></html>');
    writeFileSync(join(scaffold, 'src', 'identity.css'), '');
    // El starter trae su propio identity.css vacío: la marca tiene que aplicarse después.
    const starter = join(root, 'starter');
    mkdirSync(join(starter, 'src'), { recursive: true });
    writeFileSync(join(starter, 'src', 'identity.css'), '/* vacío */');
    const brand = join(root, 'brand');
    mkdirSync(brand);
    writeFileSync(join(brand, 'brand.json'), JSON.stringify({ name: 'Prueba', accent: 'blue', fonts: { display: 'Grift', import: 'https://cdn.example.com/grift.css' } }));

    const out = join(root, 'ws');
    prepareWorkspace(out, { scaffoldDir: scaffold, starterDir: starter, brandDir: brand });

    expect(readFileSync(join(out, 'index.html'), 'utf8')).toContain('data-accent="blue"');
    expect(readFileSync(join(out, 'src', 'identity.css'), 'utf8')).toContain('--font-geist: Grift;');
  });

  test('sin marca, el paso de preparación dice que el agente declara la identidad (#212), no "contrato neutro"', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-nobrand-'));
    const scaffold = join(root, 'scaffold');
    mkdirSync(join(scaffold, 'src'), { recursive: true });
    writeFileSync(join(scaffold, 'src', 'identity.css'), '');
    const summaries: string[] = [];
    const log = { emit: (e: { type: string; detail?: { summary?: string } }) => { if (e.type === 'step.end' && e.detail?.summary) summaries.push(e.detail.summary); return e; } };
    prepareWorkspace(join(root, 'ws'), { scaffoldDir: scaffold, log: log as never });
    expect(summaries[0]).toMatch(/\(sin marca: el agente declara la identidad\)$/);
  });
});

describe('logo de la marca', () => {
  const setup = (brandJson: object, withLogo: boolean) => {
    const root = mkdtempSync(join(tmpdir(), 'wt-logo-'));
    const out = join(root, 'ws');
    mkdirSync(join(out, 'src'), { recursive: true });
    const brand = join(root, 'brand');
    mkdirSync(join(brand, 'assets'), { recursive: true });
    writeFileSync(join(brand, 'brand.json'), JSON.stringify({ name: 'Prueba', accent: 'blue', ...brandJson }));
    if (withLogo) writeFileSync(join(brand, 'assets', 'mark.svg'), '<svg/>');
    return { out, brand };
  };

  test('applyBrand copia el logo del pack a public/brand y logoSrc lo nombra', () => {
    const { out, brand } = setup({ logo: 'assets/mark.svg' }, true);
    const pack = applyBrand(out, brand);
    expect(logoSrc(pack)).toBe('/brand/logo.svg');
    expect(readFileSync(join(out, 'public', 'brand', 'logo.svg'), 'utf8')).toBe('<svg/>');
  });

  test('applyBrand escribe src/brand.ts con el logo claro y el oscuro para BrandMark', () => {
    const { out, brand } = setup({ logo: 'assets/mark.svg', logoDark: 'assets/mark.svg' }, true);
    applyBrand(out, brand);
    const mod = readFileSync(join(out, 'src', 'brand.ts'), 'utf8');
    expect(mod).toContain('"logoSrc":"/brand/logo.svg"');
    expect(mod).toContain('"logoDarkSrc":"/brand/logo-dark.svg"');
    expect(readFileSync(join(out, 'public', 'brand', 'logo-dark.svg'), 'utf8')).toBe('<svg/>');
  });

  test('sin logo, src/brand.ts lleva solo el nombre y BrandMark pinta el nombre', () => {
    const { out, brand } = setup({ name: 'Nimbus "beta"' }, false);
    applyBrand(out, brand);
    const mod = readFileSync(join(out, 'src', 'brand.ts'), 'utf8');
    expect(mod).toContain('export const brand: BrandIdentity = {"name":"Nimbus \\"beta\\""};');
  });

  test('applyBrand pisa DESIGN.md con el del pack y borra el de la identidad anterior si el pack no trae uno', () => {
    const { out, brand } = setup({}, false);
    writeFileSync(join(out, 'DESIGN.md'), '---\ncolors:\n  primary: \'#ff6600\'\n---\n');
    applyBrand(out, brand);
    expect(existsSync(join(out, 'DESIGN.md'))).toBe(false);
    // Un DESIGN.md del pack tiene que validar contra su brand.json: el del ejemplo del repo es uno que sí.
    const ejemplo = join(import.meta.dir, '..', 'brands', 'brand-pack-ejemplo');
    cpSync(ejemplo, brand, { recursive: true });
    applyBrand(out, brand);
    expect(readFileSync(join(out, 'DESIGN.md'), 'utf8')).toBe(readFileSync(join(ejemplo, 'DESIGN.md'), 'utf8'));
    writeFileSync(join(out, 'DESIGN.md'), '# editado en un turno\n');
    rmSync(join(brand, 'DESIGN.md'));
    applyBrand(out, brand, { keepIdentity: true });
    expect(readFileSync(join(out, 'DESIGN.md'), 'utf8')).toBe('# editado en un turno\n');
  });

  test('un logo declarado que no existe falla en voz alta', () => {
    const { out, brand } = setup({ logo: 'assets/mark.svg' }, false);
    expect(() => applyBrand(out, brand)).toThrow(/declara logo/);
  });

  test('un logo fuera del pack o con formato no admitido se rechaza al parsear', () => {
    expect(() => parseBrandPack({ name: 'x', accent: 'blue', logo: '../../etc/passwd.svg' })).toThrow(/dentro del pack/);
    expect(() => parseBrandPack({ name: 'x', accent: 'blue', logo: 'logo.gif' })).toThrow(/tiene que ser/);
  });
});
