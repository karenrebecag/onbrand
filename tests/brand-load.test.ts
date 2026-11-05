import { describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyBrand, loadBrandPack } from '../src/brand';
import { Runtime } from '../src/runtime/server';

const EJEMPLO = join(import.meta.dir, '..', 'brands', 'brand-pack-ejemplo');

/** Copia del pack de ejemplo (válido) en una carpeta brands/ temporal, para romperle un archivo. */
function pack(id: string): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), 'wt-brand-load-'));
  const dir = join(root, `brand-pack-${id}`);
  cpSync(EJEMPLO, dir, { recursive: true });
  return { root, dir };
}

function workspace(): string {
  const out = mkdtempSync(join(tmpdir(), 'wt-brand-load-ws-'));
  mkdirSync(join(out, 'src'), { recursive: true });
  writeFileSync(join(out, 'index.html'), '<html lang="es"><body></body></html>');
  return out;
}

describe('loadBrandPack', () => {
  test('el pack de ejemplo carga entero: marca, hechos y DESIGN.md', () => {
    const loaded = loadBrandPack(EJEMPLO);
    expect(loaded.brand.name).toBe('Ejemplo');
    expect(loaded.facts?.domain).toBe('example.com');
    expect(loaded.design).toStartWith('---');
  });

  test('cada error nombra el archivo del pack que lo causa', () => {
    const json = pack('json');
    writeFileSync(join(json.dir, 'brand.json'), '{ "name": "Rota", ');
    expect(() => loadBrandPack(json.dir)).toThrow(/^brand-pack-json\/brand\.json: JSON inválido/);

    const accent = pack('accent');
    // Sin `accent` el pack es v2 (lector dual): el error de brand.json sale del parser v2 y sigue nombrando el archivo.
    writeFileSync(join(accent.dir, 'brand.json'), JSON.stringify({ name: 'Sin acento', theme: { preset: 'magenta' } }));
    expect(() => loadBrandPack(accent.dir)).toThrow(/^brand-pack-accent\/brand\.json: theme\.preset "magenta" no es un preset/);

    const facts = pack('facts');
    writeFileSync(join(facts.dir, 'facts.json'), JSON.stringify({ domain: 42 }));
    expect(() => loadBrandPack(facts.dir)).toThrow(/^brand-pack-facts\/facts\.json: /);

    const design = pack('design');
    writeFileSync(join(design.dir, 'DESIGN.md'), '# sin frontmatter\n');
    expect(() => loadBrandPack(design.dir)).toThrow(/^brand-pack-design\/DESIGN\.md: no coincide con brand\.json/);
  });

  // Antes el DESIGN.md se validaba después de escribir la hoja: la corrida fallaba con el workspace a medias.
  test('applyBrand no escribe nada si el pack no valida', () => {
    const { dir } = pack('mitad');
    writeFileSync(join(dir, 'DESIGN.md'), '# sin frontmatter\n');
    const out = workspace();
    expect(() => applyBrand(out, dir)).toThrow('DESIGN.md: no coincide');
    expect(existsSync(join(out, 'src', 'identity.css'))).toBe(false);
    expect(existsSync(join(out, 'public'))).toBe(false);
  });

  test('/brands muestra con su error un pack cuyo DESIGN.md fallaría al correr', async () => {
    const { root, dir } = pack('acme');
    writeFileSync(join(dir, 'DESIGN.md'), '# sin frontmatter\n');
    const tmp = mkdtempSync(join(tmpdir(), 'wt-brand-load-t-'));
    const t = new Runtime({ root: join(tmp, 'root'), allow: {}, compose: async () => { throw new Error('sin compose'); }, build: false, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), brandsRoot: root });
    const srv = t.listen(0);
    await new Promise((r) => srv.once('listening', r));
    try {
      const { items } = (await (await fetch(`http://127.0.0.1:${(srv.address() as { port: number }).port}/brands`)).json()) as { items: { id: string; name?: string; error?: string }[] };
      expect(items).toEqual([{ id: 'acme', name: 'acme', error: expect.stringContaining('brand-pack-acme/DESIGN.md') }]);
    } finally {
      srv.close();
    }
  });
});
