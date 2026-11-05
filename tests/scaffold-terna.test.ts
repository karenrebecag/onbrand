// Arq sobre #852: scaffoldDir, agentSkillId y el registry se configuran por separado. Un scaffold de un DS con el skill de
// otro tiene que frenar el arranque en vez de copiar un DS y dar al agente el catálogo del otro.
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffoldMismatch } from '../src/skill-registry';

const dirWith = (rel: string, css?: string): string => {
  const d = mkdtempSync(join(tmpdir(), 'wt-terna-'));
  if (css !== undefined) {
    mkdirSync(join(d, rel), { recursive: true });
    writeFileSync(join(d, rel, 'index.css'), css);
  }
  return d;
};

test('el skill y el scaffold son del mismo DS solo si el starter trae el index.css del scaffold', () => {
  const base = "@import './theme/tokens.css';\n";
  const arc = "@import './components/arc/foundation.css';\n";
  const skill = dirWith('assets/starter/src', base);
  expect(scaffoldMismatch(skill, 'base-agent', dirWith('src', base))).toBeUndefined();
  expect(scaffoldMismatch(skill, 'base-agent', dirWith('src', arc))).toContain('es de otro DS que el scaffold');
  expect(scaffoldMismatch(dirWith('assets/starter/src'), 'x-agent', dirWith('src', base))).toContain('no trae assets/starter/src/index.css');
});
