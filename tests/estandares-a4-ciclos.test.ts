// docs/estandares.md A4: entre módulos solo `import type` cierra un ciclo; un ciclo de valor hace que el orden de
// evaluación decida qué export está vivo. El componente brand ↔ identity-ephemeral ↔ identity-design se cerró
// extrayendo las hojas brand-util/brand-fonts/brand-identity/brand-pack (brand.ts quedó de fachada). El del builder
// (canvas-chrome ↔ publish-menu ↔ theme-panel) se cerró en #648. El test impide que entre un ciclo nuevo sin que nadie lo vea.
import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import ts from '../templates/base-scaffold/node_modules/typescript';
import { codeFiles, ROOT } from './estandares-scan';

const ALIASES: [string, string][] = [['@/', 'apps/builder/src/'], ['@engine/', 'src/']];
const EXTS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

function resolveSpec(from: string, spec: string): string | undefined {
  let base: string | undefined;
  if (spec.startsWith('.')) base = join(dirname(from), spec);
  for (const [alias, dir] of ALIASES) if (spec.startsWith(alias)) base = dir + spec.slice(alias.length);
  if (!base) return undefined;
  // Los imports con .js apuntan al .ts en TS con moduleResolution bundler.
  const stem = base.replace(/\.js$/, '');
  for (const ext of EXTS) {
    const p = relative(ROOT, join(ROOT, stem + ext)).split('\\').join('/');
    if (/\.(ts|tsx)$/.test(p) && existsSync(join(ROOT, p))) return p;
  }
  return undefined;
}

/** ¿El import/export trae algún valor? `import type`, `import { type A }` y `export type` no. */
function carriesValue(n: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isImportDeclaration(n)) {
    const c = n.importClause;
    if (!c) return true;
    if (c.isTypeOnly) return false;
    if (c.name) return true;
    const b = c.namedBindings;
    if (!b || ts.isNamespaceImport(b)) return true;
    return b.elements.length === 0 || b.elements.some((e) => !e.isTypeOnly);
  }
  if (n.isTypeOnly) return false;
  const c = n.exportClause;
  return !c || !ts.isNamedExports(c) || c.elements.some((e) => !e.isTypeOnly);
}

function valueGraph(files: string[]): Map<string, Set<string>> {
  const g = new Map<string, Set<string>>();
  for (const f of files) {
    const sf = ts.createSourceFile(f, readFileSync(join(ROOT, f), 'utf8'), ts.ScriptTarget.ESNext, false);
    const out = new Set<string>();
    for (const st of sf.statements) {
      if (!(ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) || !st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier)) continue;
      if (!carriesValue(st)) continue;
      const to = resolveSpec(f, st.moduleSpecifier.text);
      if (to && to !== f) out.add(to);
    }
    g.set(f, out);
  }
  return g;
}

/** Componentes fuertemente conexos de más de un nodo (Tarjan): cada uno es un ciclo de valor. */
function cycles(g: Map<string, Set<string>>): string[][] {
  let i = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const on = new Set<string>();
  const out: string[][] = [];
  const visit = (v: string): void => {
    idx.set(v, i);
    low.set(v, i++);
    stack.push(v);
    on.add(v);
    for (const w of g.get(v) ?? []) {
      if (!g.has(w)) continue;
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) !== idx.get(v)) return;
    const scc: string[] = [];
    let w: string;
    do {
      w = stack.pop()!;
      on.delete(w);
      scc.push(w);
    } while (w !== v);
    if (scc.length > 1) out.push(scc.sort());
  };
  for (const v of g.keys()) if (!idx.has(v)) visit(v);
  return out.sort((a, b) => a[0]!.localeCompare(b[0]!));
}

const found = cycles(valueGraph(codeFiles(['src', 'apps/builder/src']).filter((f) => /\.(ts|tsx)$/.test(f))));

test('A4: sin ciclos de valor entre módulos', () => {
  expect(found).toEqual([]);
});
