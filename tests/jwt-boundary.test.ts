import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

// Fase 5: el adaptador JWT vive en src/adapters/jwt y el core solo lo conoce en los puntos de cableado: scripts/serve.ts
// (sessionProvider 'jwt') y el entrypoint del orquestador, que le inyecta `authenticate`. Ni src/runtime ni el resto del
// orquestador ni del core lo importan.
const WIRING = new Set(['orchestrator/main.ts']);
const SRC = join(import.meta.dir, '..', 'src');
const JWT = join(SRC, 'adapters', 'jwt');

const files = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name)).map((e) => join(e.parentPath, e.name));

test('ningún archivo de src/ fuera de src/adapters/jwt y del entrypoint del orquestador importa el adaptador JWT', () => {
  const offenders = files(SRC).filter((f) => !f.startsWith(`${JWT}/`) && !WIRING.has(relative(SRC, f))).flatMap((f) =>
    [...readFileSync(f, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].filter((m) => /(?:^|\/)adapters\/jwt(?:\/|$)/.test(m[1]!)).map((m) => `${relative(SRC, f)} -> ${m[1]}`));
  expect(offenders).toEqual([]);
});
