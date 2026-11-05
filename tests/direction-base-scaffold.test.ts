import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BLOCK_CANDIDATES, DIRECTIONS, candidatesIn, directionBlockPicks, directionReference } from '../src/directions';
import { createAgentComposer } from '../src/runtime/agent-composer';
import type { RunAgentCli } from '../src/runtime/agent-loop';

// Con la base neutra el core no lleva los bloques de la distro: el candidato que direction.md o la traza nombran tiene que existir en el scaffold del workspace.
const BASE_SRC = join(import.meta.dir, '..', 'templates', 'base-scaffold', 'src');
const resolves = (src: string, importPath: string): boolean => {
  const base = join(src, importPath.replace(/^@\//, ''));
  return ['.tsx', '.ts', '/index.tsx', '/index.ts'].some((ext) => existsSync(base + ext));
};
const SEEDS = ['a', 'b', 'c', 'd'];

test('los bloques que elige la dirección existen en el scaffold base, para toda dirección y semilla', () => {
  const missing = new Set<string>();
  for (const d of DIRECTIONS) {
    for (const seed of SEEDS) {
      for (const { block } of directionBlockPicks(d, undefined, seed, candidatesIn(BASE_SRC))) if (block && !resolves(BASE_SRC, block.importPath)) missing.add(block.importPath);
      const md = directionReference(d, undefined, seed, candidatesIn(BASE_SRC));
      for (const m of md.matchAll(/`import \{ \w+ \} from "([^"]+)"/g)) if (!resolves(BASE_SRC, m[1]!)) missing.add(m[1]!);
    }
  }
  expect([...missing]).toEqual([]);
});

test('candidatesIn deja solo los candidatos cuyo importPath resuelve en ese src', () => {
  expect(candidatesIn(BASE_SRC)).toEqual([]);
  const fake = mkdtempSync(join(tmpdir(), 'cands-'));
  try {
    const one = BLOCK_CANDIDATES[0]!;
    const file = join(fake, one.importPath.replace(/^@\//, '') + '.tsx');
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, 'export {};\n');
    const kept = candidatesIn(fake);
    expect(kept.length).toBeGreaterThan(0);
    expect(new Set(kept.map((c) => c.importPath))).toEqual(new Set([one.importPath]));
  } finally { rmSync(fake, { recursive: true, force: true }); }
});

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'dir-base-')); });
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const run: RunAgentCli = async (_bin, _args, _input, cwd, onLine) => {
  mkdirSync(join(cwd, 'src', 'sections'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'sections', '01-hero.tsx'), 'export default function Hero() { return <section id="inicio" data-wt-role="hero" />; }\n');
  writeFileSync(join(cwd, 'index.html'), '<!doctype html><html lang="es"><head><title>Acme</title></head><body></body></html>');
  onLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'Resumen.', session_id: 's', duration_ms: 1 }));
  return 0;
};

test('el composer sobre un workspace con el scaffold base no escribe bloques de la distro en direction.md ni en la traza', async () => {
  const skill = join(tmp, 'skill');
  mkdirSync(join(skill, 'references'), { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '# skill\n');
  const ws = join(tmp, 'ws');
  mkdirSync(join(ws, 'src', 'components', 'blocks'), { recursive: true });
  writeFileSync(join(ws, 'src', 'components', 'blocks', 'hero.tsx'), 'export {};\n');
  writeFileSync(join(ws, 'index.html'), '<!doctype html><html lang="en"><head><title>x</title></head><body></body></html>');
  const emitted: unknown[] = [];
  const page = await createAgentComposer(skill, { run })({ prompt: 'landing', messageId: 'm1', workspace: { dir: ws }, direction: { seed: 'a', sector: [], tone: [], recent: [] } }, { emit: (e: unknown) => emitted.push(e) } as never);
  const md = readFileSync(join(ws, '.wt', 'skill', 'references', 'direction.md'), 'utf8');
  expect(md).not.toMatch(/@\/components\/(arc|morphin|bencho)\//);
  expect(md).toContain('ninguno: escribe la sección');
  expect(page.agent?.trace?.blocks ?? []).toEqual([]);
});
