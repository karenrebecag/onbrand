// B9 paso 3b (docs/spec/ds-base-neutral.md §2.5 y §3): el registry del DS base se arma desde templates/base-scaffold sin
// vault, el catálogo del skill nombra exactamente lo que el código exporta, y registry/ versionado es el que sale
// de las fuentes de hoy y monta todo el DS (lo mismo que D3 de e2e-core-clone pide al registry del core).
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptsOf, BASE, exportsOf, readCatalog } from '../scripts/build-base-registry';
import { BASE_AGENT_SKILL_ID } from '../src/skill-registry';
import { materializeItems, resolveItems } from '../src/runtime/registry';
import { fileRegistry } from '../src/runtime/registry-file';

const ROOT = join(import.meta.dir, '..');
const DIRS = ['components/ui', 'components/blocks', 'components/layout'];

test('el catálogo del skill nombra cada export de ui, blocks y layout una vez, y nada que no exista', () => {
  const exported = DIRS.flatMap((d) => readdirSync(join(BASE, 'src', d)).filter((f) => f.endsWith('.tsx')).flatMap((f) => exportsOf(readFileSync(join(BASE, 'src', d, f), 'utf8')).map((e) => `${d}/${f}#${e}`)));
  const listed = readCatalog().map((c) => `${c.file.replace(/^components\//, 'components/')}#${c.export}`);
  expect([...listed].sort()).toEqual([...exported].sort());
});

test('accepts toma solo las props de primer nivel que reciben JSX', () => {
  expect(acceptsOf(' title: string; media?: ReactNode; items: { content: ReactNode }[]; children: ReactNode ')).toEqual([
    { prop: 'media', type: 'ReactNode', required: false },
    { prop: 'children', type: 'ReactNode', required: true },
  ]);
});

test('registry/ es el que sale de las fuentes de hoy', () => {
  const out = mkdtempSync(join(tmpdir(), 'base-registry-'));
  try {
    const r = spawnSync('bun', [join(ROOT, 'scripts', 'build-base-registry.ts'), '--out', out], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(ROOT, 'registry', 'latest.json'), 'utf8'), 'registry/ desactualizado: corre bun scripts/build-base-registry.ts').toBe(readFileSync(join(out, 'latest.json'), 'utf8'));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('registry/ materializa cada componente que ofrece y publica el skill base-agent', async () => {
  const src = await fileRegistry(join(ROOT, 'registry'));
  const allow = await src.loadIndex!();
  const out = mkdtempSync(join(tmpdir(), 'base-ds-'));
  try {
    materializeItems(await resolveItems(Object.keys(allow), src), out);
    const missing = Object.entries(allow).filter(([, a]) => !existsSync(join(out, 'src', `${a.importPath.replace('@/', '')}.tsx`))).map(([k]) => k);
    expect([Object.keys(allow).length, missing]).toEqual([28, []]);
    const skill = await src.skillPack!(BASE_AGENT_SKILL_ID);
    expect(skill && existsSync(join(skill, 'SKILL.md'))).toBe(true);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// El bin instalado (decisión 17) hacía el build completo al pedir --help. Con --out apuntando a un tmp, el caso previo al
// fix escribe ahí y no en registry/ del repo.
test('--help imprime el uso y sale sin escribir el registry', () => {
  const parent = mkdtempSync(join(tmpdir(), 'base-registry-help-'));
  const out = join(parent, 'out');
  try {
    const r = spawnSync('bun', [join(ROOT, 'scripts', 'build-base-registry.ts'), '--help', '--out', out], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Uso: onbrand-build-registry [--out <dir>]');
    expect(existsSync(out)).toBe(false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
