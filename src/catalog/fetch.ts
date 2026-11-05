// Fetch on-demand de UN item Arc desde el vault al scaffold (spec RF5, CA8). Copia solo ese item y
// las registryDependencies transitivas que falten; nunca la librería entera y nunca encima de un
// archivo que ya está (el scaffold puede llevar ajustes locales, p. ej. lib/media.ts). Todo lo que
// puede fallar —item ausente, dep npm ausente, sha256 que no coincide— falla ANTES de copiar nada,
// para no dejar el scaffold a medias. El vault es READ-ONLY: aquí solo se lee.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { sha256 } from './hash';
import { registryDepsOf } from './manifest-arc';
import type { CatalogEntry, CatalogKind } from './schema';

export interface FetchOptions {
  vaultRoot: string;
  /** Carpeta del scaffold (la que contiene package.json y src/). */
  scaffoldRoot: string;
  /** Raíz contra la que se escribe `source` (relativa al repo). */
  repoRoot: string;
}

export interface FetchPlan {
  /** Items en orden de copia: el pedido y después sus deps transitivas. */
  items: string[];
  copies: { from: string; to: string }[];
  /** Destinos que ya existían y no se tocan. */
  skipped: string[];
}

/** Plan de un re-port: además de lo de fetch, los archivos propios del item que se reemplazan y el
 * sha256 nuevo del archivo principal del vault. */
export interface RefetchPlan extends FetchPlan {
  replaces: { from: string; to: string }[];
  sha256: string;
}

export interface FetchResult {
  entry: CatalogEntry;
  plan: FetchPlan;
}

interface ArcRegistryFile {
  dependencies?: unknown;
  files?: unknown;
}

const UI = 'ui-react';
const ARC_DIR = posix.join('src', 'components', 'arc');

const kindDir = (kind: CatalogKind): string => (kind === 'block' ? 'blocks' : 'components');

/** El archivo principal del item relativo a su `files/` en el vault, sacado de origin.path: un bloque
 * puede vivir en registry/components/ y una variante apunta al source de su base. */
function registryFileOf(entry: CatalogEntry): string {
  const at = entry.origin.path.indexOf('/files/');
  return at >= 0 ? entry.origin.path.slice(at + '/files/'.length) : posix.join('registry', kindDir(entry.kind), entry.slug, `${entry.slug}.tsx`);
}

/** Ruta de un archivo del vault (`registry/blocks/x/y`, `registry/components/c/y`, `lib/y`)
 * dentro del scaffold. Es el mismo mapa que siguieron las copias a mano de F1/F1b. */
export function scaffoldPathFor(vaultFile: string): string {
  const m = /^registry\/(blocks|components)\/([\w-]+)\/(.+)$/.exec(vaultFile);
  if (m) return posix.join(ARC_DIR, ...(m[1] === 'blocks' ? ['blocks', m[2]] : [m[2]]), m[3]);
  if (vaultFile.startsWith('lib/')) return posix.join(ARC_DIR, vaultFile);
  throw new Error(`fetch: ruta del vault sin destino en el scaffold: ${vaultFile}`);
}

interface LocatedItem {
  slug: string;
  dir: string;
  npmDeps: string[];
  registryDeps: string[];
  files: string[];
}

/** Localiza un item por slug en blocks/ o components/ del vault y lee su registry.json. */
export function locateArcItem(slug: string, vaultRoot: string): LocatedItem | undefined {
  for (const kind of ['blocks', 'components'] as const) {
    const dir = join(vaultRoot, UI, kind, slug);
    const regPath = join(dir, 'registry.json');
    if (!existsSync(regPath)) continue;
    const raw = readFileSync(regPath, 'utf8');
    const reg = JSON.parse(raw) as ArcRegistryFile;
    const files = Array.isArray(reg.files)
      ? reg.files.map((f) => (f as { path?: unknown }).path).filter((p): p is string => typeof p === 'string')
      : [];
    const npmDeps = Array.isArray(reg.dependencies) ? reg.dependencies.filter((d): d is string => typeof d === 'string') : [];
    return { slug, dir, npmDeps, registryDeps: registryDepsOf(raw), files };
  }
  return undefined;
}

/** Cierre transitivo de registryDependencies, en orden de descubrimiento, sin repetir. */
function resolveItems(slug: string, vaultRoot: string): LocatedItem[] {
  const seen = new Set<string>();
  const out: LocatedItem[] = [];
  const queue = [slug];
  while (queue.length) {
    const next = queue.shift() as string;
    if (seen.has(next)) continue;
    seen.add(next);
    const item = locateArcItem(next, vaultRoot);
    if (!item) throw new Error(`fetch (${slug}): "${next}" no está en el vault (${join(vaultRoot, UI)}/{blocks,components}/${next})`);
    out.push(item);
    queue.push(...item.registryDeps);
  }
  return out;
}

/** Deps npm declaradas por el scaffold; fetch no instala nada (decisión de Karen, spec §restricciones). */
function declaredNpmDeps(scaffoldRoot: string): Set<string> {
  const pkg = JSON.parse(readFileSync(join(scaffoldRoot, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  return new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
}

/** Items resueltos, deps npm verificadas y sha256 actual del archivo principal del vault. Todo lo que
 * puede fallar antes de escribir. */
function checkedItems(entry: CatalogEntry, opts: FetchOptions, cmd: string): { items: LocatedItem[]; actual: string } {
  const items = resolveItems(entry.slug, opts.vaultRoot);
  const declared = declaredNpmDeps(opts.scaffoldRoot);
  const missingNpm = [...new Set(items.flatMap((i) => i.npmDeps))].filter((d) => !declared.has(d)).sort();
  if (missingNpm.length) throw new Error(`${cmd} (${entry.slug}): deps npm ausentes en ${join(opts.scaffoldRoot, 'package.json')}: ${missingNpm.join(', ')}. Instalarlas es decisión de Karen.`);
  const mainPath = join(opts.vaultRoot, entry.origin.path);
  if (!existsSync(mainPath)) throw new Error(`${cmd} (${entry.slug}): falta en el vault ${mainPath}`);
  return { items, actual: sha256(readFileSync(mainPath)) };
}

/** Archivos propios del item pedido (`registry/<kind>/<slug>/*`): los únicos que refetch reemplaza.
 * `lib/` y las deps quedan con la semántica de fetch porque el scaffold puede llevar ajustes locales. */
const isOwnFile = (entry: CatalogEntry, file: string): boolean => file.startsWith(`${posix.dirname(registryFileOf(entry))}/`);

function planCopies(entry: CatalogEntry, items: LocatedItem[], opts: FetchOptions, cmd: string, replaceOwn: boolean) {
  const copies: FetchPlan['copies'] = [];
  const replaces: RefetchPlan['replaces'] = [];
  const skipped: string[] = [];
  for (const item of items) {
    for (const file of item.files) {
      const from = join(item.dir, 'files', file);
      if (!existsSync(from)) throw new Error(`${cmd} (${entry.slug}): ${item.slug} declara ${file} pero no está en ${from}`);
      const to = join(opts.scaffoldRoot, scaffoldPathFor(file));
      if (!existsSync(to)) copies.push({ from, to });
      else if (replaceOwn && item.slug === entry.slug && isOwnFile(entry, file)) replaces.push({ from, to });
      else skipped.push(to);
    }
  }
  return { items: items.map((i) => i.slug), copies, replaces, skipped };
}

/** Arma el plan sin tocar disco de escritura: item + deps transitivas, deps npm verificadas,
 * sha256 del archivo principal verificado contra el índice. */
export function planFetch(entry: CatalogEntry, opts: FetchOptions): FetchPlan {
  const { items, actual } = checkedItems(entry, opts, 'fetch');
  if (actual !== entry.origin.sha256) throw new Error(`fetch (${entry.slug}): sha256 del vault (${actual.slice(0, 12)}…) no coincide con el índice (${entry.origin.sha256.slice(0, 12)}…); re-importar antes de copiar`);
  const { items: slugs, copies, skipped } = planCopies(entry, items, opts, 'fetch', false);
  return { items: slugs, copies, skipped };
}

/** Plan de re-port de un item ya vendorizado (ADR 0005): el cambio vive en el vault y llega aquí por
 * esta vía, nunca editando el scaffold a mano. El sha256 no se compara: se recomputa. */
export function planRefetch(entry: CatalogEntry, opts: FetchOptions): RefetchPlan {
  const { items, actual } = checkedItems(entry, opts, 'refetch');
  return { ...planCopies(entry, items, opts, 'refetch', true), sha256: actual };
}

/** Copia los components Arc (y sus registryDependencies del vault) que una sección Relume portada
 * referencia por `../../../arc/<slug>/<slug>`. Las deps npm no se verifican aquí: el scaffold las
 * declara (el gate ya lo exigió). Un slug que no es component del vault se omite en silencio. */
export function fetchArcComponents(slugs: readonly string[], opts: { vaultRoot: string; scaffoldRoot: string }): string[] {
  const copied: string[] = [];
  const seen = new Set<string>();
  const queue = [...slugs];
  while (queue.length) {
    const slug = queue.shift() as string;
    if (seen.has(slug)) continue;
    seen.add(slug);
    const item = locateArcItem(slug, opts.vaultRoot);
    if (!item) continue;
    for (const file of item.files) {
      const from = join(item.dir, 'files', file);
      if (!existsSync(from)) continue;
      const to = join(opts.scaffoldRoot, scaffoldPathFor(file));
      if (existsSync(to)) continue;
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      copied.push(scaffoldPathFor(file));
    }
    queue.push(...item.registryDeps);
  }
  return copied;
}

const toPosix = (p: string): string => p.split(sep).join(posix.sep);

const writeCopies = (copies: ReadonlyArray<{ from: string; to: string }>): void => {
  for (const { from, to } of copies) {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
};

const sourceOf = (entry: CatalogEntry, opts: FetchOptions): string =>
  posix.join(toPosix(relative(opts.repoRoot, opts.scaffoldRoot)), scaffoldPathFor(registryFileOf(entry)));

/** Copia según el plan y devuelve la entrada con `source` apuntando al archivo principal. */
export function fetchItem(entry: CatalogEntry, opts: FetchOptions): FetchResult {
  const plan = planFetch(entry, opts);
  writeCopies(plan.copies);
  return { entry: { ...entry, source: sourceOf(entry, opts) }, plan };
}

/** Re-porta según el plan y devuelve la entrada con el sha256 nuevo y `source`. */
export function refetchItem(entry: CatalogEntry, opts: FetchOptions): { entry: CatalogEntry; plan: RefetchPlan } {
  const plan = planRefetch(entry, opts);
  writeCopies([...plan.copies, ...plan.replaces]);
  return { entry: { ...entry, source: sourceOf(entry, opts), origin: { ...entry.origin, sha256: plan.sha256 } }, plan };
}
