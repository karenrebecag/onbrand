// QA B9 paso 4: commitAll confía en el .gitignore del scaffold para dejar fuera node_modules y dist (git-workspace.ts:27).
// El base no traía uno: cada versión de un chat versionaba el install del ws (559 archivos, 24 MB de .git en un chat de 2
// turnos medido en vivo con serve.ts --fixture).
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { config } from '../src/config';
import { commitAll } from '../src/runtime/git-workspace';
import { prepareWorkspace } from '../src/runtime/workspace';

const tmp = mkdtempSync(join(tmpdir(), 'wt-base-gitignore-'));
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

test('una versión del scaffold por defecto no versiona node_modules ni dist del ws', () => {
  const ws = join(tmp, 'ws');
  prepareWorkspace(ws, { scaffoldDir: config().scaffoldDir });
  for (const dir of ['node_modules/react', 'node_modules/.vite/deps', 'dist/assets']) mkdirSync(join(ws, dir), { recursive: true });
  writeFileSync(join(ws, 'node_modules/react/index.js'), 'module.exports = {};\n');
  writeFileSync(join(ws, 'node_modules/.vite/deps/react.js'), 'export {};\n');
  writeFileSync(join(ws, 'dist/assets/index.js'), 'export {};\n');
  writeFileSync(join(ws, 'src/sections/01-hero.tsx'), 'export default function Hero() { return <section />; }\n');
  commitAll(ws, 'turno');
  const tracked = execFileSync('git', ['-C', ws, 'ls-files'], { encoding: 'utf8' }).trim().split('\n');
  expect(tracked).toContain('src/sections/01-hero.tsx');
  expect(tracked.filter((f) => f.startsWith('node_modules/') || f.startsWith('dist/'))).toEqual([]);
});
