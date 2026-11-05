import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CATALOG_PATH } from '../src/catalog/load';
import { blockCandidatesAt } from '../src/directions';

// El paquete publicado no lleva catalog/ (files de package.json): serve tiene que importar igual.
test('sin catalog/index.json no hay candidatos de bloque, y con él sí', () => {
  expect(blockCandidatesAt(join(mkdtempSync(join(tmpdir(), 'sin-catalogo-')), 'index.json'))).toEqual([]);
  expect(blockCandidatesAt(CATALOG_PATH).length).toBeGreaterThan(0);
});
