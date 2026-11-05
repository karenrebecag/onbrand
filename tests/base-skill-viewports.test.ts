// El skill base-agent nombra los anchos que la tool browser acepta (workspace-tools.ts, REVIEW_VIEWPORTS), en su paso de
// verificación como el skill agent-browser de v0 (calidad-re/carbon-skill/x3/skill-copy3/agent-browser/SKILL.md:31), con
// los anchos que v0 corrió (calidad-re/RE-verificacion-visual.md:12,15). Se lee la fuente y el publicado en registry/:
// si solo cambia uno, el agente leería otros anchos.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REVIEW_VIEWPORTS } from '../src/render-review';

const ROOT = join(import.meta.dir, '..');
const viewportsOf = (md: string): number[] => [...md.matchAll(/"viewport":\s*(\d+)/g)].map((m) => Number(m[1]));

test('SKILL.md fuente y publicado nombran exactamente los anchos de la tool browser', () => {
  const source = readFileSync(join(ROOT, 'templates', 'base-scaffold', 'skill', 'SKILL.md'), 'utf8');
  const latest = JSON.parse(readFileSync(join(ROOT, 'registry', 'latest.json'), 'utf8')) as { index: string };
  const index = JSON.parse(readFileSync(join(ROOT, 'registry', latest.index), 'utf8')) as { skills: Record<string, string> };
  const skill = JSON.parse(readFileSync(join(ROOT, 'registry', index.skills['base-agent']!), 'utf8')) as { files: { path: string; base64: string }[] };
  const published = Buffer.from(skill.files.find((f) => f.path === 'SKILL.md')!.base64, 'base64').toString('utf8');
  for (const md of [source, published]) expect(viewportsOf(md).sort()).toEqual([...REVIEW_VIEWPORTS].sort());
  expect(published).toBe(source);
});
