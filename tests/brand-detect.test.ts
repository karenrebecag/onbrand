import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectBrand, localBrandIds } from '../src/brand-detect';

describe('marca detectada en el brief', () => {
  test('el id de un pack publicado como palabra completa carga ese pack; base y los prefijos no cuentan', () => {
    expect(detectBrand('Quiero una landing para Acme (acme.test), agentes de IA', ['acme', 'base'])).toBe('acme');
    expect(detectBrand('Una base de datos para acmeología industrial', ['acme', 'base'])).toBeUndefined();
    expect(detectBrand('Landing de Acme Academy, cursos de IA', ['acme', 'acme-academy'])).toBe('acme-academy');
    expect(detectBrand('Landing para zed', ['zed'])).toBe('zed');
    expect(detectBrand('cafetería en CDMX', ['acme'])).toBeUndefined();
  });

  test('sin registry, los ids salen de las carpetas brand-pack[-<id>] locales', () => {
    const root = mkdtempSync(join(tmpdir(), 'brands-'));
    for (const d of ['brand-pack', 'brand-pack-zed', 'otra']) mkdirSync(join(root, d));
    expect(localBrandIds(root).sort()).toEqual(['base', 'zed']);
    expect(localBrandIds(join(root, 'no-existe'))).toEqual([]);
  });
});
