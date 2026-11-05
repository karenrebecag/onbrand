// docs/estandares.md A1: ≤ 800 líneas por archivo de código propio, sin excepciones escritas (ADR 0014:255-262).
// El código portado de terceros vive en templates/ y queda fuera. src/brand.ts se partió en brand-util/
// brand-fonts/brand-identity/brand-pack (< 800 cada uno); sin infractores. El test impide que un archivo nuevo cruce el tope.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codeFiles, ROOT } from './estandares-scan';

const MAX_LINES = 800;

const lines = (f: string): number => readFileSync(join(ROOT, f), 'utf8').split('\n').length - 1;
const over = codeFiles(['src', 'apps/builder/src', 'scripts', 'tests']).filter((f) => lines(f) > MAX_LINES);

test('A1: ningún archivo propio pasa de 800 líneas', () => {
  expect(over).toEqual([]);
});
