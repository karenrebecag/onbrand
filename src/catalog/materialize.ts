// Materialización on-demand de un bloque elegido dentro del scaffold YA generado (generated/<brief>/).
// El runtime NO transforma: copia el artefacto que el porter (tooling) ya dejó en out/ported/<slug>/
// y verifica su outputSha256 contra catalog/ported.json (RF2). Un item Arc se trae del vault (fetch).
// El vault es READ-ONLY. Generar el artefacto es cosa de `bun scripts/port.ts`, no de aquí.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './load';
import { outputSha256 } from './hash';
import { vaultSlug, type CatalogEntry } from './schema';
import { fetchArcComponents, fetchItem } from './fetch';

// WT_PORTER_OUT_ROOT redirige la salida del porter a un tmp en tests; perezoso para leer el env
// después del import.
const outRoot = (): string => process.env.WT_PORTER_OUT_ROOT ?? REPO_ROOT;
const outPortedDir = (): string => join(outRoot(), 'out', 'ported');
const portedJsonPath = (): string => join(outRoot(), 'catalog', 'ported.json');

/** Carpeta local (dentro de outDir) y basename del archivo de un importPath `@/a/b/c`. */
function targetOf(importPath: string): { dir: string; name: string } {
  const rel = importPath.replace(/^@\//, '');
  const parts = rel.split('/');
  return { dir: parts.slice(0, -1).join('/'), name: parts[parts.length - 1] };
}

/** outputSha256 esperado del artefacto según el manifiesto committeado (undefined si no está). */
function expectedSha(slug: string): string | undefined {
  try {
    const m = JSON.parse(readFileSync(portedJsonPath(), 'utf8')) as { items: { slug: string; outputSha256?: string }[] };
    return m.items.find((i) => i.slug === slug)?.outputSha256;
  } catch {
    return undefined;
  }
}

/** Lee todos los archivos del artefacto (rutas relativas al dir del slug). */
function readArtifactFiles(slug: string): { name: string; content: string }[] {
  const dir = join(outPortedDir(), slug);
  const out: { name: string; content: string }[] = [];
  const walk = (rel: string): void => {
    for (const n of readdirSync(join(dir, rel || '.'))) {
      const r = rel ? `${rel}/${n}` : n;
      const abs = join(dir, r);
      if (statSync(abs).isDirectory()) walk(r);
      else out.push({ name: r, content: readFileSync(abs, 'utf8') });
    }
  };
  walk('');
  return out;
}

/** Copia el artefacto portado de un bloque Relume a outDir/src/... verificando outputSha256 (RF2) y
 * trae los components Arc que su inner referencia. Falla con el slug y el comando si falta el artefacto. */
export function materializeRelume(entry: CatalogEntry, outDir: string, vaultRoot: string): void {
  // El porter nombra el artefacto por la carpeta del vault (header-116), no por el slug del catálogo
  // (section_header116); sin esta traducción ensurePorted/materialize nunca encuentran el bloque.
  const slug = vaultSlug(entry);
  const dir = join(outPortedDir(), slug);
  if (!existsSync(dir)) {
    throw new Error(`materialize: falta el artefacto portado de "${slug}" en ${dir}. Pórtalo con: bun scripts/port.ts ${slug}`);
  }
  const files = readArtifactFiles(slug);
  const expected = expectedSha(slug);
  const actual = outputSha256(files);
  if (expected && expected !== actual) {
    throw new Error(`materialize: outputSha256 de "${slug}" no coincide (manifiesto ${expected.slice(0, 12)} vs disco ${actual.slice(0, 12)}); re-portar: bun scripts/port.ts ${slug}`);
  }
  const { dir: targetDir } = targetOf(entry.importPath);
  const absDir = join(outDir, 'src', targetDir);
  for (const f of files) {
    const abs = join(absDir, f.name);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, f.content);
  }
  const tsx = files.find((f) => f.name.endsWith('.tsx'))?.content ?? '';
  const arcSlugs = [...new Set([...tsx.matchAll(/from\s+["']\.\.\/\.\.\/\.\.\/arc\/([\w-]+)\//g)].map((m) => m[1]))];
  fetchArcComponents(arcSlugs, { vaultRoot, scaffoldRoot: outDir });
}

/** Trae un item Arc del vault al scaffold generado (fetch verifica deps npm y sha256). */
export function materializeArc(entry: CatalogEntry, outDir: string, vaultRoot: string): void {
  fetchItem(entry, { vaultRoot, scaffoldRoot: outDir, repoRoot: outDir });
}

/** Materializa un bloque dentro de outDir según su librería (Arc = fetch del vault, Relume = copia
 * del artefacto portado). */
export async function materializeEntry(entry: CatalogEntry, outDir: string, vaultRoot: string): Promise<void> {
  if (entry.library === 'arc') materializeArc(entry, outDir, vaultRoot);
  else materializeRelume(entry, outDir, vaultRoot);
}
