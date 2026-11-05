// Puebla el manifiesto agéntico de las entradas Arc del índice desde el vault (spec F2a).
//   bun scripts/catalog-import.ts arc [slug...]        # todos los arc del índice si no se pasan slugs
//   bun scripts/catalog-import.ts arc --check-remote   # además compara keywords con uiarc.dev (solo reporta)
// Nunca reescribe surface, geometry, verified, emittable, source ni notes (RF6): el import solo
// toca `manifest`, `manifestOrigin` y `registryDependencies`.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG_PATH, VAULT_ROOT, loadCatalog } from '../src/catalog/load';
import { parseArcDoc, registryDepsOf, type KnownItem } from '../src/catalog/manifest-arc';
import { serializeCatalog, type CatalogEntry } from '../src/catalog/schema';

const REMOTE_CATALOG = 'https://uiarc.dev/r/catalog.json';

/** Carpeta del item en el vault (bloques y components viven en ramas distintas de ui-react). */
export const arcDocDir = (e: CatalogEntry): string => `ui-react/${e.kind === 'block' ? 'blocks' : 'components'}/${e.slug}`;

/** Entrada con manifiesto parseado; pura salvo la lectura del vault bajo `vaultRoot`. */
export function importArcEntry(e: CatalogEntry, known: readonly KnownItem[], vaultRoot: string): CatalogEntry {
  const dir = join(vaultRoot, arcDocDir(e));
  const md = readFileSync(join(dir, 'doc.md'), 'utf8');
  const registryDependencies = registryDepsOf(readFileSync(join(dir, 'registry.json'), 'utf8'));
  return {
    ...e,
    ...(registryDependencies.length ? { registryDependencies } : {}),
    manifest: parseArcDoc(md, e.export, e.slug, known),
    manifestOrigin: 'parsed',
  };
}

async function checkRemote(entries: CatalogEntry[]): Promise<void> {
  let remote: { items?: Array<{ name?: string; keywords?: string[] }> };
  try {
    remote = (await (await fetch(REMOTE_CATALOG)).json()) as typeof remote;
  } catch {
    console.log('sin red, cross-check omitido');
    return;
  }
  const byName = new Map((remote.items ?? []).map((it) => [it.name, it.keywords ?? []]));
  for (const e of entries) {
    const theirs = byName.get(e.slug);
    const ours = e.manifest?.keywords ?? [];
    if (!theirs) { console.log(`${e.slug}: no está en el catálogo remoto`); continue; }
    const missing = theirs.filter((k) => !ours.includes(k));
    const extra = ours.filter((k) => !theirs.includes(k));
    if (missing.length || extra.length) console.log(`${e.slug}: keywords remoto-local faltan [${missing.join(', ')}] sobran [${extra.join(', ')}]`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] !== 'arc') throw new Error('uso: bun scripts/catalog-import.ts arc [slug...] [--check-remote]');
  const slugs = args.slice(1).filter((a) => !a.startsWith('--'));
  const all = loadCatalog({ requireManifest: false });
  const known: KnownItem[] = all.map((e) => ({ slug: e.slug, name: e.name }));
  const target = (e: CatalogEntry): boolean => e.library === 'arc' && (slugs.length === 0 || slugs.includes(e.slug));
  const next = all.map((e) => (target(e) ? importArcEntry(e, known, VAULT_ROOT) : e));
  writeFileSync(CATALOG_PATH, serializeCatalog(next));
  const done = next.filter(target);
  console.log(`manifiestos parseados: ${done.map((e) => e.slug).join(', ')}`);
  if (args.includes('--check-remote')) await checkRemote(done);
}

if (import.meta.main) await main();
