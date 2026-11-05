import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyBrand, brandPackErrors } from '../src/brand';

const HTML = '<!doctype html>\n<html lang="es">\n  <head>\n    <title>x</title>\n  </head>\n  <body></body>\n</html>\n';

function pack(json: object): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'wt-brand-fonts-')), 'brand-pack-fuente');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'brand.json'), JSON.stringify({ name: 'Fuente', accent: 'blue', ...json }));
  return dir;
}
function workspace(): string {
  const out = mkdtempSync(join(tmpdir(), 'wt-brand-fonts-ws-'));
  mkdirSync(join(out, 'src'), { recursive: true });
  writeFileSync(join(out, 'index.html'), HTML);
  return out;
}
const links = (out: string) => readFileSync(join(out, 'index.html'), 'utf8').match(/<link\b[^>]*data-brand-fonts[^>]*>/g) ?? [];

// identity.css solo nombra la familia (--font-geist: Fraunces); sin cargarla, la página la pintaba en sans (#473).
describe('fuentes de la marca', () => {
  test('applyBrand enlaza las familias que el scaffold no trae instaladas', () => {
    const out = workspace();
    applyBrand(out, pack({ fonts: { display: 'Fraunces', body: 'Inter' } }));
    expect(links(out)).toHaveLength(1);
    expect(links(out)[0]).toContain('https://fonts.googleapis.com/css2?family=Fraunces');
    expect(links(out)[0]).not.toContain('Inter');
  });

  test('aplicar otra marca reemplaza o quita el link, sin acumular', () => {
    const out = workspace();
    applyBrand(out, pack({ fonts: { display: 'Fraunces' } }));
    applyBrand(out, pack({ fonts: { display: 'Sora' } }));
    expect(links(out)).toHaveLength(1);
    expect(links(out)[0]).toContain('family=Sora');
    applyBrand(out, pack({ fonts: { display: 'Geist', body: 'Inter' } }));
    expect(links(out)).toEqual([]);
    expect(readFileSync(join(out, 'index.html'), 'utf8').replace(/ data-accent="[^"]*"/, '')).toBe(HTML);
  });

  test('un follow-up que conserva la identidad no toca el link', () => {
    const out = workspace();
    applyBrand(out, pack({ fonts: { display: 'Fraunces' } }));
    applyBrand(out, pack({ fonts: { display: 'Sora' } }), { keepIdentity: true });
    expect(links(out)[0]).toContain('family=Fraunces');
  });

  test('con fonts.import el pack carga las suyas y no se agrega link', () => {
    const out = workspace();
    applyBrand(out, pack({ fonts: { display: 'Grift', import: 'https://cdn.example.com/grift.css' } }));
    expect(links(out)).toEqual([]);
  });

  test('una familia que nadie cargaría es un error del pack', () => {
    expect(brandPackErrors(pack({ fonts: { display: 'Grift' } }))).toEqual([expect.stringContaining('fonts.display "Grift" no es una fuente que se pueda cargar')]);
    expect(brandPackErrors(pack({ fonts: { display: 'Fraunces', body: 'Inter' } }))).toEqual([]);
  });
});
