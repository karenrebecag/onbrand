// Carga del índice unificado desde disco y raíces del proyecto/vault. Los adaptadores filtran por
// `library`; el router consulta todo el catálogo (spec RF1, DA4: el índice vive en la raíz).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCatalog, type CatalogEntry, type Library, type ParseOptions } from './schema';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const CATALOG_PATH = join(REPO_ROOT, 'catalog', 'index.json');

/** Raíz del knowledge local de Karen (READ-ONLY). `WT_VAULT_ROOT` la sobreescribe en tests/CI. */
export const VAULT_ROOT = process.env.WT_VAULT_ROOT ?? join(homedir(), 'Desktop', 'SoftwareDevProjects', 'Knowledge', 'Frontend', 'Components');

/** Desde F2 una entrada verified sin manifiesto es error (spec RF2); el import pasa
 * `requireManifest: false` porque justamente las está poblando. */
export function loadCatalog(opts: ParseOptions = { requireManifest: true }, path: string = CATALOG_PATH): CatalogEntry[] {
  return parseCatalog(readFileSync(path, 'utf8'), opts);
}

export const catalogFor = (library: Library, entries: CatalogEntry[] = loadCatalog()): CatalogEntry[] =>
  entries.filter((e) => e.library === library);
