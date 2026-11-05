// Migración de los registries por librería al índice unificado, y vuelta (spec §5).
//   bun scripts/catalog-migrate.ts arc              # registry.arc.json -> índice (F1)
//   bun scripts/catalog-migrate.ts relume           # registry.json -> índice, manifiesto derivado (F2b)
//   bun scripts/catalog-migrate.ts --reverse        # índice -> registry.arc.json + registry.json
// El manifiesto Arc nace null (lo puebla catalog-import); el Relume se deriva aquí mismo porque no
// hay doc que parsear. Reverse descarta manifest/origin; para Relume además reconstruye layoutStyle
// desde geometría + superficie (pierde la diferencia [] vs ["standard"], que no cambia nada).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sha256 } from '../src/catalog/hash';
import { CATALOG_PATH, REPO_ROOT, VAULT_ROOT, loadCatalog } from '../src/catalog/load';
import { deriveRelumeManifest, exportOf, findRelumeVaultItem, type RelumeSibling } from '../src/catalog/manifest-relume';
import { hasRole, serializeCatalog, type CatalogEntry, type CatalogOrigin } from '../src/catalog/schema';
import { relumeGeometry, relumeSurface } from '../src/registry';
import type { Role, SurfaceByTheme } from '../src/types';

/** Entrada del registry Arc previo al índice (lo que registry.arc.json guardaba). */
export interface LegacyArcEntry {
  slug: string;
  name: string;
  role: Role;
  category: string;
  tags: string[];
  surface: SurfaceByTheme;
  geometry: string;
  variant?: string;
  emittable?: boolean;
  verified: boolean;
  source: string;
  export: string;
  importPath: string;
  notes?: string;
}

/** Entrada del registry Relume previo al índice (lo que registry.json guardaba). */
export interface LegacyRelumeEntry {
  slug: string;
  name: string;
  role: Role;
  category: string;
  tags: string[];
  layoutStyle: string[];
  verified: boolean;
  source?: string;
  notes?: string;
}

export const LEGACY_ARC_PATH = join(REPO_ROOT, 'registry.arc.json');
export const LEGACY_RELUME_PATH = join(REPO_ROOT, 'registry.json');

/** Ruta en el vault del archivo principal de un bloque Arc, relativa a VAULT_ROOT. */
export const arcVaultPath = (slug: string): string => `ui-react/blocks/${slug}/files/registry/blocks/${slug}/${slug}.tsx`;

export { sha256 };

const vaultHash = (rel: string): string => sha256(readFileSync(join(VAULT_ROOT, rel)));

/** legacy Arc -> índice. `hashFor` es inyectable para no depender del vault en tests. */
export function migrateArc(legacy: LegacyArcEntry[], hashFor: (slug: string) => string = (s) => vaultHash(arcVaultPath(s))): CatalogEntry[] {
  return legacy.map((e) => {
    const origin: CatalogOrigin = { kind: 'vault', path: arcVaultPath(e.slug), sha256: hashFor(e.slug) };
    return {
      library: 'arc',
      kind: 'block',
      slug: e.slug,
      name: e.name,
      role: e.role,
      category: e.category,
      tags: [...e.tags],
      surface: { ...e.surface },
      geometry: e.geometry,
      ...(e.variant !== undefined ? { variant: e.variant } : {}),
      ...(e.emittable !== undefined ? { emittable: e.emittable } : {}),
      verified: e.verified,
      source: e.source,
      origin,
      export: e.export,
      importPath: e.importPath,
      manifest: null,
      ...(e.notes !== undefined ? { notes: e.notes } : {}),
    };
  });
}

/** índice -> legacy Arc. Descarta manifest/origin/kind: es lo que el legacy no tenía. */
export function reverseArc(entries: CatalogEntry[]): LegacyArcEntry[] {
  return entries
    .filter(hasRole)
    .filter((e) => e.library === 'arc' && e.source !== null)
    .map((e) => ({
      slug: e.slug,
      name: e.name,
      role: e.role,
      category: e.category,
      tags: [...e.tags],
      surface: { ...e.surface },
      geometry: e.geometry,
      ...(e.variant !== undefined ? { variant: e.variant } : {}),
      ...(e.emittable !== undefined ? { emittable: e.emittable } : {}),
      verified: e.verified,
      source: e.source as string,
      export: e.export,
      importPath: e.importPath,
      ...(e.notes !== undefined ? { notes: e.notes } : {}),
    }));
}

export interface RelumeMigrateOptions {
  /** Conserva el `verified` del legacy. Solo para el registry ya renderizado: una entrada derivada
   * NUEVA nace verified:false (RF4) y pasa a true a mano. */
  keepVerified?: boolean;
  /** Lectura del vault inyectable (tests con fixtures). */
  vaultRoot?: string;
}

/** legacy Relume -> índice con manifiesto DERIVADO. export y props salen del source limpio del vault;
 * importPath sigue la convención del futuro scaffold Relume portado (ADR 0001, DA1). */
export function migrateRelume(legacy: LegacyRelumeEntry[], opts: RelumeMigrateOptions = {}): CatalogEntry[] {
  const vaultRoot = opts.vaultRoot ?? VAULT_ROOT;
  const siblings: RelumeSibling[] = legacy.map((e) => ({ slug: e.slug, role: e.role, tags: e.tags }));
  return legacy.map((e) => {
    const item = findRelumeVaultItem(e.slug, vaultRoot);
    if (!item) throw new Error(`migrate relume (${e.slug}): no está en el vault (${vaultRoot}/sections-react)`);
    const tsx = readFileSync(join(vaultRoot, item.file), 'utf8');
    const exportName = exportOf(tsx);
    if (!exportName) throw new Error(`migrate relume (${e.slug}): sin export principal en ${item.file}`);
    const input = { slug: e.slug, name: e.name, role: e.role, category: e.category, tags: e.tags, ...(item.preview ? { preview: item.preview } : {}) };
    return {
      library: 'relume',
      kind: 'block',
      slug: e.slug,
      name: e.name,
      role: e.role,
      category: e.category,
      tags: [...e.tags],
      surface: relumeSurface(e.tags, e.layoutStyle),
      geometry: relumeGeometry(e.layoutStyle),
      verified: opts.keepVerified ? e.verified : false,
      source: e.source ?? null,
      origin: { kind: 'vault', path: item.file, sha256: sha256(tsx) },
      export: exportName,
      importPath: `@/components/relume/${item.dir.replace(/^sections-react\//, '')}/${item.dir.split('/').pop()}`,
      manifest: deriveRelumeManifest(input, tsx, siblings),
      manifestOrigin: 'derived',
      ...(e.notes !== undefined ? { notes: e.notes } : {}),
    };
  });
}

/** Vuelve a derivar SOLO el manifiesto de una entrada Relume existente (RF6: nada más cambia). */
export function rederiveRelume(entry: CatalogEntry, tsx: string, siblings: readonly RelumeSibling[]): CatalogEntry {
  if (!hasRole(entry)) throw new Error(`rederiveRelume (${entry.slug}): sin rol`);
  const input = { slug: entry.slug, name: entry.name, role: entry.role, category: entry.category, tags: entry.tags };
  return { ...entry, manifest: deriveRelumeManifest(input, tsx, siblings), manifestOrigin: 'derived' };
}

/** índice -> legacy Relume. layoutStyle se reconstruye desde geometría + superficie. */
export function reverseRelume(entries: CatalogEntry[]): LegacyRelumeEntry[] {
  return entries
    .filter(hasRole)
    .filter((e) => e.library === 'relume')
    .map((e) => ({
      slug: e.slug,
      name: e.name,
      role: e.role,
      category: e.category,
      tags: [...e.tags],
      layoutStyle: [...(e.geometry !== 'standard' ? [e.geometry] : []), ...(e.surface.light === 'media' ? ['background'] : [])],
      verified: e.verified,
      ...(e.source !== null ? { source: e.source } : {}),
      ...(e.notes !== undefined ? { notes: e.notes } : {}),
    }));
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

function writeCatalog(entries: CatalogEntry[]): void {
  mkdirSync(dirname(CATALOG_PATH), { recursive: true });
  writeFileSync(CATALOG_PATH, serializeCatalog(entries));
}

function main(): void {
  const mode = process.argv[2];
  if (mode === '--reverse') {
    const all = loadCatalog({ requireManifest: false });
    writeFileSync(LEGACY_ARC_PATH, `${JSON.stringify(reverseArc(all), null, 2)}\n`);
    writeFileSync(LEGACY_RELUME_PATH, `${JSON.stringify(reverseRelume(all), null, 2)}\n`);
    console.log('registry.arc.json y registry.json regenerados desde el índice');
    return;
  }
  if (mode === 'arc') {
    writeCatalog(migrateArc(readJson<LegacyArcEntry[]>(LEGACY_ARC_PATH)));
    console.log('catalog/index.json: entradas arc migradas (manifest null)');
    return;
  }
  if (mode === 'relume') {
    const current = loadCatalog({ requireManifest: false }).filter((e) => e.library !== 'relume');
    const relume = migrateRelume(readJson<LegacyRelumeEntry[]>(LEGACY_RELUME_PATH), { keepVerified: true });
    writeCatalog([...current, ...relume]);
    console.log(`catalog/index.json: ${relume.length} entradas relume con manifiesto derivado`);
    return;
  }
  throw new Error('uso: bun scripts/catalog-migrate.ts arc | relume | --reverse');
}

if (import.meta.main) main();
