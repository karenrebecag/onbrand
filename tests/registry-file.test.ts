import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileReader, fileRegistry } from '../src/runtime/registry-file';
import { Runtime } from '../src/runtime/server';

const PIN = 'abc12345';
const allowOf = (name: string) => ({ export: name, importPath: `@/components/arc/${name}`, kind: 'component', schema: null, propless: false, accepts: [] });

/** Un registry con la forma que escribe build-registry --local: puntero, índice inmutable e items por sha. */
function registryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wt-registry-'));
  const write = (path: string, json: unknown) => { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), JSON.stringify(json)); };
  write('latest.json', { index: `index@${PIN}.json`, version: PIN });
  write(`index@${PIN}.json`, { version: PIN, items: { badge: { path: 'r/badge@1.json', allow: allowOf('Badge'), hasSchema: true } } });
  write('r/badge@1.json', { name: 'badge', type: 'registry:ui', files: [{ path: 'src/components/arc/badge/badge.tsx', content: 'export const Badge = () => null;' }], schema: { type: 'object' } });
  return dir;
}

describe('registry desde una carpeta del repo', () => {
  test('monta índice, item y schemas como el del Blob, y no publica marcas', async () => {
    const r = await fileRegistry(registryDir());
    expect(r.pin).toBe(PIN);
    expect(Object.keys(await r.loadIndex())).toEqual(['badge']);
    expect((await r.getItem('badge')).files[0].path).toBe('src/components/arc/badge/badge.tsx');
    expect(r.makeSchemaStore()('badge')).toEqual({ type: 'object' });
    expect('brandPack' in r || 'brandIds' in r).toBe(false);
  });

  // Fail-loud: un slug que el índice no tiene rompe la corrida en vez de dejar un import a un componente inexistente.
  test('un slug fuera del índice, un pin que ya no está o una carpeta sin registry fallan con su causa', async () => {
    const dir = registryDir();
    await expect((await fileRegistry(dir)).getItem('accordion')).rejects.toThrow(`slug desconocido 'accordion'`);
    await expect(fileRegistry(dir, 'deadbeef')).rejects.toThrow('falta index@deadbeef.json');
    await expect(fileRegistry(mkdtempSync(join(tmpdir(), 'wt-empty-')))).rejects.toThrow('build-registry --local');
  });

  test('una ruta del índice no sale de la carpeta', async () => {
    await expect(fileReader(registryDir())('../afuera.json')).rejects.toThrow('ruta inválida');
    await expect(fileReader(registryDir())('/etc/passwd')).rejects.toThrow('ruta inválida');
  });

  test('con un registry sin marcas, /brands lista los packs del brandsRoot', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'wt-registry-brands-'));
    mkdirSync(join(tmp, 'brands', 'brand-pack-acme'), { recursive: true });
    writeFileSync(join(tmp, 'brands', 'brand-pack-acme', 'brand.json'), JSON.stringify({ name: 'Acme', accent: 'orange' }));
    const dir = registryDir();
    const t = new Runtime({ root: join(tmp, 'root'), allow: {}, compose: async () => { throw new Error('sin compose'); }, build: false, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'), registry: () => fileRegistry(dir) });
    const srv = t.listen(0);
    await new Promise((r) => srv.once('listening', r));
    try {
      const body = (await (await fetch(`http://127.0.0.1:${(srv.address() as { port: number }).port}/brands`)).json()) as { brands: string[]; items: { id: string; name: string; preset: string }[] };
      expect(body.brands).toEqual(['acme']);
      expect(body.items).toEqual([{ id: 'acme', name: 'Acme', preset: 'orange' }]);
    } finally {
      srv.close();
    }
  });
});
