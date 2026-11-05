import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brandIdOfDir, localBrandDir, readBrandPacks, writeBrandPack } from '../src/brand-registry';
import { openRegistry, type BlobReader } from '../src/runtime/registry-source';

function pack(root: string, dir: string, brand: Record<string, unknown>, extra: Record<string, string> = {}): void {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, 'brand.json'), JSON.stringify(brand));
  for (const [p, c] of Object.entries(extra)) {
    mkdirSync(join(root, dir, p, '..'), { recursive: true });
    writeFileSync(join(root, dir, p), c);
  }
}

describe('brand packs en el registry', () => {
  test('publica solo brand.json, las fuentes que importa y el logo; el resto del pack (contract, README) queda fuera', () => {
    const root = mkdtempSync(join(tmpdir(), 'brands-'));
    pack(root, 'brand-pack', { name: 'Base', accent: 'neutral' }, { 'README.md': 'x' });
    pack(root, 'brand-pack-acme', { name: 'Acme', accent: 'orange', logo: 'logo/acme.svg', fonts: { display: 'Grift', import: './fonts/fonts.css' } }, { 'logo/acme.svg': '<svg/>', 'fonts/fonts.css': '@font-face{}', 'fonts/grift.woff2': 'bin', 'fonts/.env': 'SECRET=1', 'fonts/README.md': 'x', 'contract/x.css': 'y', 'resolve.ts': 'z' });
    pack(root, 'otra-cosa', { name: 'No', accent: 'blue' });
    const packs = readBrandPacks(root);
    expect(packs.map((p) => p.id)).toEqual(['acme', 'base']);
    expect(packs[0].files.map((f) => f.path)).toEqual(['brand.json', 'fonts/fonts.css', 'fonts/grift.woff2', 'logo/acme.svg']);
    expect(packs[1].files.map((f) => f.path)).toEqual(['brand.json']);
    expect(brandIdOfDir('brand-pack-Mala')).toBeUndefined();
    expect(() => localBrandDir('../x', root)).toThrow('id de marca inválido');
  });

  test('facts.json viaja con el pack y se valida al publicar', () => {
    const root = mkdtempSync(join(tmpdir(), 'brands-'));
    pack(root, 'brand-pack-zed', { name: 'Zed', accent: 'blue' }, { 'facts.json': JSON.stringify({ domain: 'zed.io' }) });
    expect(readBrandPacks(root)[0].files.map((f) => f.path)).toEqual(['brand.json', 'facts.json']);
    pack(root, 'brand-pack-mala', { name: 'Mala', accent: 'blue' }, { 'facts.json': JSON.stringify({ metrics: [{ label: 'x', value: '1' }] }) });
    expect(() => readBrandPacks(root)).toThrow('metrics[0].source');
  });

  test('un symlink dentro de fonts/ no se publica: el build falla en vez de subir el archivo al que apunta', () => {
    const root = mkdtempSync(join(tmpdir(), 'brands-'));
    pack(root, 'brand-pack-acme', { name: 'Acme', accent: 'orange', fonts: { import: './fonts/fonts.css' } }, { 'fonts/fonts.css': '@font-face{}' });
    const secret = join(mkdtempSync(join(tmpdir(), 'secret-')), 'id_rsa');
    writeFileSync(secret, 'PRIVATE');
    symlinkSync(secret, join(root, 'brand-pack-acme', 'fonts', 'x.woff2'));
    expect(() => readBrandPacks(root)).toThrow('symlink');
  });

  test('el pack se baja del pin al directorio de caché y una ruta que sale del pack se rechaza', async () => {
    const root = mkdtempSync(join(tmpdir(), 'brands-'));
    pack(root, 'brand-pack-acme', { name: 'Acme', accent: 'orange', logo: 'logo.svg' }, { 'logo.svg': '<svg/>' });
    const [acme] = readBrandPacks(root);
    const read: BlobReader = async (p) => {
      if (p === 'index@abcd1234.json') return { version: 'abcd1234', items: {}, brands: { acme: 'brands/acme@aa.json' } };
      if (p === 'brands/acme@aa.json') return acme;
      throw new Error(`404 ${p}`);
    };
    const cache = mkdtempSync(join(tmpdir(), 'brand-cache-'));
    const reg = await openRegistry({ pin: 'abcd1234', read, brandCacheDir: cache });
    const dir = await (reg.brandPack as (id: string) => Promise<string>)('acme');
    expect(dir).toBe(join(cache, 'abcd1234', 'acme'));
    expect(readFileSync(join(dir, 'logo.svg'), 'utf8')).toBe('<svg/>');
    await expect((reg.brandPack as (id: string) => Promise<string>)('nadie')).rejects.toThrow('no está publicada en abcd1234');
    const out = mkdtempSync(join(tmpdir(), 'brand-evil-'));
    expect(() => writeBrandPack({ id: 'x', name: 'X', files: [{ path: '../fuera.txt', base64: 'eA==' }] }, join(out, 'p'))).toThrow('ruta inválida');
    expect(existsSync(join(out, 'fuera.txt'))).toBe(false);
  });
});

describe('DESIGN.md y logo oscuro del pack', () => {
  const brand = { name: 'Acme', accent: { base: '#222020', strong: '#000000', subtle: 'rgb(0 0 0 / 0.1)', foreground: '#ffffff' }, surface: { background: '#fafafa', foreground: '#0a0a0a' }, fonts: { display: 'Grift', body: 'Inter Tight', import: 'https://cdn.example.com/grift.css' }, tokens: { '--brand-highlight': '#ff6600' }, tokensDark: { '--background': '#0a0a0a', '--foreground': '#fafafa' } };
  const md = (primary: string) => `---\nname: Acme\ncolors:\n  primary: '${primary}'\n  on-primary: '#ffffff'\n  background: '#fafafa'\n  on-background: '#0a0a0a'\n  tertiary: '#ff6600'\n  inverse-surface: '#0a0a0a'\n  inverse-on-surface: '#fafafa'\ntypography:\n  display:\n    fontFamily: Grift\n  body:\n    fontFamily: Inter Tight\n---\n\n## Brand & Style\n\nx\n\n## Colors\n\nEl naranja #ff6600 solo es acento.\n\n## Typography\n\nx\n`;

  test('publica el logo oscuro y un DESIGN.md que coincide con brand.json, incluido tertiary = --brand-highlight', () => {
    const root = mkdtempSync(join(tmpdir(), 'brands-'));
    pack(root, 'brand-pack-acme', { ...brand, logo: 'logo/a.svg', logoDark: 'logo/a-dark.svg' }, { 'logo/a.svg': '<svg/>', 'logo/a-dark.svg': '<svg/>', 'DESIGN.md': md('#222020') });
    expect(readBrandPacks(root)[0].files.map((f) => f.path)).toEqual(['DESIGN.md', 'brand.json', 'logo/a-dark.svg', 'logo/a.svg']);
  });

  test('un DESIGN.md que contradice al brand.json no se publica', () => {
    const root = mkdtempSync(join(tmpdir(), 'brands-'));
    pack(root, 'brand-pack-acme', brand, { 'DESIGN.md': md('#ff6600') });
    expect(() => readBrandPacks(root)).toThrow(/colors.primary es #ff6600/);
  });

  // Schema v2 (#7): tertiary sale de overrides --brand-highlight y primary del acento en overrides.
  test('un pack v2 publica su DESIGN.md si coincide y se rechaza si contradice', () => {
    const v2 = { name: 'Acme', theme: { fonts: brand.fonts }, overrides: { '--accent': '#222020', '--accent-strong': '#000000', '--accent-subtle': 'rgb(0 0 0 / 0.1)', '--accent-foreground': '#ffffff', '--background': '#fafafa', '--foreground': '#0a0a0a', '--brand-highlight': '#ff6600' }, overridesDark: brand.tokensDark };
    const ok = mkdtempSync(join(tmpdir(), 'brands-'));
    pack(ok, 'brand-pack-acme', v2, { 'DESIGN.md': md('#222020') });
    expect(readBrandPacks(ok)[0].files.map((f) => f.path)).toEqual(['DESIGN.md', 'brand.json']);
    const bad = mkdtempSync(join(tmpdir(), 'brands-'));
    pack(bad, 'brand-pack-acme', v2, { 'DESIGN.md': md('#ff6600') });
    expect(() => readBrandPacks(bad)).toThrow(/colors.primary es #ff6600/);
  });
});
