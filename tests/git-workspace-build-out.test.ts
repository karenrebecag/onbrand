// commitAll deja fuera el install y el build sin depender del .gitignore del scaffold: una distro puede no traerlo y el
// agente puede borrarlo (escribe en el ws). Los ws del base creados entre #852 y #856 ya los versionaron y se migran solos.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedFiles, commitAll, diffCommits, diffStats, initRepo, restoreTree } from '../src/runtime/git-workspace';
import { prepareWorkspace } from '../src/runtime/workspace';

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'wt-build-out-')); });
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const tracked = (ws: string): string[] => execFileSync('git', ['-C', ws, 'ls-files'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const isBuild = (f: string): boolean => /(^|\/)node_modules(\/|$)/.test(f) || /^dist(-ssr)?\//.test(f);
const write = (ws: string, rel: string, body = 'x\n'): void => {
  mkdirSync(join(ws, rel, '..'), { recursive: true });
  writeFileSync(join(ws, rel), body);
};

test('un scaffold sin .gitignore no versiona node_modules (ni symlink ni anidado) ni dist, y un restore no los borra', () => {
  const scaffold = join(tmp, 'scaffold');
  write(scaffold, 'src/main.tsx');
  const ws = join(tmp, 'ws');
  prepareWorkspace(ws, { scaffoldDir: scaffold });
  const base = execFileSync('git', ['-C', ws, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  write(ws, 'node_modules/react/index.js');
  write(ws, 'packages/ui/node_modules/x/index.js');
  write(ws, 'dist/assets/index.js');
  write(ws, 'src/dist/keep.ts');
  mkdirSync(join(tmp, 'deps'));
  symlinkSync(join(tmp, 'deps'), join(ws, 'packages', 'node_modules'));
  write(ws, 'src/sections/01-hero.tsx');
  commitAll(ws, 'turno');
  expect(tracked(ws).filter(isBuild)).toEqual([]);
  expect(tracked(ws)).toEqual(expect.arrayContaining(['src/sections/01-hero.tsx', 'src/dist/keep.ts']));
  restoreTree(ws, base);
  expect(existsSync(join(ws, 'node_modules/react/index.js'))).toBe(true);
  expect(existsSync(join(ws, 'dist/assets/index.js'))).toBe(true);
  expect(existsSync(join(ws, 'src/sections/01-hero.tsx'))).toBe(false);
});

test('un ws que ya versionó node_modules y dist los deja de versionar en el commit siguiente, sin borrarlos del disco', () => {
  const ws = join(tmp, 'old');
  mkdirSync(ws);
  initRepo(ws);
  write(ws, 'src/App.tsx');
  write(ws, 'node_modules/react/index.js');
  write(ws, 'dist/index.html');
  // Así quedó un ws del base entre #852 y #856: el add sin exclusiones y sin .gitignore.
  execFileSync('git', ['-C', ws, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A']);
  execFileSync('git', ['-C', ws, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'viejo']);
  expect(tracked(ws).filter(isBuild).length).toBe(2);
  commitAll(ws, 'turno');
  expect(tracked(ws)).toEqual(['src/App.tsx']);
  expect(existsSync(join(ws, 'node_modules/react/index.js'))).toBe(true);
  expect(execFileSync('git', ['-C', ws, 'show', '--name-only', '--format=', 'HEAD'], { encoding: 'utf8' }).trim().split('\n').sort()).toEqual(['dist/index.html', 'node_modules/react/index.js']);
});

// QA #864 en vivo (serve.ts sobre un ws de #852-#856): la versión que migra mostraba en /runs/:m/diff 562 archivos, 559
// borrados de node_modules, y el picker de versiones lo mismo. Lo que nunca es de la página tampoco sale en sus diffs.
test('los diffs de versiones no listan node_modules ni dist, ni en la versión que migra ni en las viejas', () => {
  const ws = join(tmp, 'diffs');
  mkdirSync(ws);
  initRepo(ws);
  write(ws, 'src/App.tsx');
  execFileSync('git', ['-C', ws, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'raiz']);
  const root = execFileSync('git', ['-C', ws, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  write(ws, 'node_modules/react/index.js');
  write(ws, 'dist/index.html');
  execFileSync('git', ['-C', ws, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A']);
  execFileSync('git', ['-C', ws, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'viejo']);
  const old = execFileSync('git', ['-C', ws, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  write(ws, 'src/App.tsx', 'y\n');
  const migrated = commitAll(ws, 'turno');
  for (const [a, b] of [[root, old], [old, migrated]] as const) {
    expect([...diffStats(ws, a, b).map((f) => f.path), ...diffCommits(ws, a, b).map((f) => f.path), ...changedFiles(ws, a, b)].filter(isBuild)).toEqual([]);
  }
  expect(diffCommits(ws, old, migrated).map((f) => f.path)).toEqual(['src/App.tsx']);
});
