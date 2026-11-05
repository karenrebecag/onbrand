// --fixture (ADR 0017) ya no reproduce un page.json por el runner: copia un directorio snapshot (TSX verbatim) al
// workspace del agente y lo reporta como agent.files, sin LLM ni créditos. Este test guarda que el snapshot que usa
// --fixture siga siendo un workspace de agente válido (App.tsx + al menos una sección), que es lo que fixtureComposer copia.
import { expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..');
const FIXTURES = join(REPO, 'tests', 'fixtures');

test('el snapshot de --fixture es un workspace de agente válido (App.tsx + secciones)', () => {
  const dir = join(FIXTURES, 'page-provenance-snapshot');
  expect(existsSync(join(dir, 'src', 'App.tsx'))).toBe(true);
  expect(readdirSync(join(dir, 'src', 'sections')).filter((n) => n.endsWith('.tsx')).length).toBeGreaterThan(0);
});
