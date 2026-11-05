// docs/estandares.md A9: un solo escritor de CanvasDoc en el builder (#649). Con dos `PUT` del mismo doc y el mismo
// `rev`, el segundo perdía el cambio sin aviso (H14/Q3). nodes y favorites le mandan parches al escritor; ninguno
// más importa putCanvas.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codeFiles, ROOT } from './estandares-scan';

// run-client.ts define putCanvas; definirla no es escribir el doc.
const DEFINES = 'apps/builder/src/lib/run-client.ts';
const WRITER = 'apps/builder/src/lib/canvas-writer.ts';
const IMPORTS_PUT = /import\s*\{[^}]*\bputCanvas\b[^}]*\}\s*from|import\s*\*\s*as\s+\w+\s+from\s*['"][^'"]*run-client['"]/;

const importers = codeFiles(['apps/builder/src']).filter((f) => f !== DEFINES && IMPORTS_PUT.test(readFileSync(join(ROOT, f), 'utf8')));

test('A9: putCanvas tiene un solo importador en apps/builder/src, el escritor de CanvasDoc', () => {
  expect(importers).toEqual([WRITER]);
});
