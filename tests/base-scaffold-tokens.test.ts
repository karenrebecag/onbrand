// B9 paso 2 (docs/spec/ds-base-neutral.md §2.1): el contrato del DS base declara los mismos tokens que clasifica
// contract-roles.json, así ningún brand pack de brands/ se queda sin destino sobre el base.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import contractRoles from '../src/theme/contract-roles.json';

const TOKENS = join(import.meta.dir, '..', 'templates', 'base-scaffold', 'src', 'theme', 'tokens.css');

test('tokens.css del base declara exactamente los tokens del contrato', () => {
  const declared = new Set([...readFileSync(TOKENS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]!));
  const contract = Object.keys(contractRoles.tokens);
  expect([...declared].sort()).toEqual([...contract].sort());
});
