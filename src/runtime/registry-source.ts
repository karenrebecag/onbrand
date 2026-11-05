// Fuente del catálogo para two-step, agnóstica del almacén: loadIndex (para shortlist/shortIndex) y getItem (el item
// autosuficiente con files[]+schema que el runner materializa, sin tocar el vault). El `read` lo pone quien llama
// (fileReader en el core; un lector de red en una distro): aquí no hay default de red. Pin por corrida: se fija
// index@<sha> UNA vez y todo resuelve contra ese sha (WT_REGISTRY_PIN salta el puntero latest). Nunca escribe. Falla
// cerrada: si el lector falla, el error se propaga; no hay fallback silencioso al vault.

import type { ExtensionPoints } from '../extension-points';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isBrandId, writeBrandPack, writePackFiles, type BrandPackItem } from '../brand-registry';
import type { SkillPackItem } from '../skill-registry';
import type { AllowEntry } from '../ds-skill';
import type { SchemaStore, JsonSchema } from './verify';

// TEMP: reconciliar con los tipos de Arq (su src/runtime/registry.ts) al integrar; forma ya acordada.
export interface RegistryItem {
  name: string;
  type: string;
  files: { path: string; content: string }[];
  registryDependencies?: string[];
  dependencies?: string[];
  schema?: JsonSchema;
  allow?: AllowEntry;
}
export interface RegistrySource {
  pin: string;
  loadIndex(): Promise<Record<string, AllowEntry>>;
  getItem(slug: string): Promise<RegistryItem>;
  makeSchemaStore(): SchemaStore;
  /** Ids de las marcas que publica este pin (brand-store y run-cycle lo leen si existe). */
  brandIds?(): string[];
  /** Baja el brand pack `id` de este pin a un directorio local y devuelve su ruta (para applyBrand). */
  brandPack?(id: string): Promise<string>;
  /** Baja el skill `id` de este pin a un directorio local y devuelve su ruta; undefined si el pin no lo publica. */
  skillPack?(id: string): Promise<string | undefined>;
  /** Puntos de extensión que publica este pin; undefined si el index no los trae. */
  extensionPoints?(): Promise<ExtensionPoints | undefined>;
}

// Forma real del index.json versionado (verificado contra el registry publicado por Secondary,
// index@554e2eb0b9ce120a). `items[slug].path` ya trae el sha (r/<slug>@<sha>.json), `allow` es el
// AllowEntry completo para shortlist, y `references` son las guías de categoría.
interface RegistryIndex {
  version: string;
  items: Record<string, { path: string; allow: AllowEntry; hasSchema: boolean }>;
  references?: Record<string, { path: string }>;
  brands?: Record<string, string>;
  skills?: Record<string, string>;
  extensionPoints?: string;
}

/** Lector del almacén: devuelve el JSON de `path` (ruta del índice). */
export type BlobReader = (path: string) => Promise<unknown>;

export interface BlobRegistryOpts {
  pin?: string;
  read: BlobReader;
  /** Dónde se bajan los brand packs; por pin, porque el pack de un pin no cambia. */
  brandCacheDir?: string;
  skillCacheDir?: string;
}

// El pin entra a una ruta de disco: solo el sha hex que produce build-registry.
function pinDir(pin: string): string {
  if (!/^[0-9a-f]{8,64}$/.test(pin)) throw new Error(`registry: pin inválido "${pin}" para bajar un pack`);
  return pin;
}

/** Baja un pack inmutable a `dir` una sola vez. A un directorio aparte y luego rename: una bajada cortada no deja un
 * pack a medias que parezca completo (`marker` es el archivo que lo da por completo). */
async function fetchPack(dir: string, marker: string, write: (part: string) => Promise<void>): Promise<string> {
  if (existsSync(join(dir, marker))) return dir;
  const part = `${dir}.part-${randomUUID()}`;
  await write(part);
  if (!existsSync(join(part, marker))) throw new Error(`registry: el pack de ${dir} no trae ${marker}`);
  mkdirSync(dirname(dir), { recursive: true });
  try {
    renameSync(part, dir);
  } catch (e) {
    // Otra corrida con el mismo pin llegó antes: su pack es el mismo, se descarta el propio.
    if (!existsSync(join(dir, marker))) throw e;
  } finally {
    rmSync(part, { recursive: true, force: true });
  }
  return dir;
}

/** Abre el registry UNA vez: fija el pin y devuelve loadIndex/getItem/makeSchemaStore contra ese pin. */
export async function openRegistry(opts: BlobRegistryOpts): Promise<RegistrySource> {
  const read = opts.read;
  const wantPin = opts.pin ?? process.env.WT_REGISTRY_PIN; // salta el puntero latest, para reproducibilidad
  // Puntero latest -> version; luego se lee el índice INMUTABLE index@<version>.json (evita el 60s de CDN
  // sobre latest). Con WT_REGISTRY_PIN se salta el puntero. Si latest ya trae items, se usa directo.
  const pointer = wantPin ? { version: wantPin } : ((await read('latest.json')) as Partial<RegistryIndex>);
  const pin = pointer.version ?? wantPin;
  if (!pin) throw new Error('registry: no se pudo resolver la versión (latest.json sin version)');
  const index = (pointer.items ? pointer : (await read(`index@${pin}.json`))) as RegistryIndex;
  const cache = new Map<string, RegistryItem>();
  let points: Promise<ExtensionPoints> | undefined;

  const getItem = async (slug: string): Promise<RegistryItem> => {
    const hit = cache.get(slug);
    if (hit) return hit;
    const entry = index.items[slug];
    if (!entry) throw new Error(`registry: slug desconocido '${slug}' en ${pin}`);
    const item = (await read(entry.path)) as RegistryItem;
    cache.set(slug, item);
    return item;
  };

  return {
    pin,
    async loadIndex() {
      const allow: Record<string, AllowEntry> = {};
      // Algunos items del índice (motion tokens, lib, items rotos) no traen AllowEntry: no son
      // componentes emitibles. Se omiten para que el shortlist/verify solo vea entradas usables.
      for (const [slug, e] of Object.entries(index.items)) if (e.allow) allow[slug] = e.allow;
      return allow;
    },
    getItem,
    // Sync sobre lo ya traído por getItem (los slugs elegidos en el paso 2): es el MISMO set que va a
    // check_layout, así lo no inyectado sale como unknown-component.
    makeSchemaStore(): SchemaStore {
      return (slug: string) => cache.get(slug)?.schema ?? null;
    },
    brandIds(): string[] {
      return Object.keys(index.brands ?? {});
    },
    async brandPack(id: string): Promise<string> {
      if (!isBrandId(id)) throw new Error(`registry: id de marca inválido "${id}"`);
      const path = index.brands?.[id];
      if (!path) throw new Error(`registry: la marca "${id}" no está publicada en ${pin}`);
      return fetchPack(join(opts.brandCacheDir ?? join(tmpdir(), 'wt-brands'), pinDir(pin), id), 'brand.json', async (part) => { writeBrandPack((await read(path)) as BrandPackItem, part); });
    },
    async extensionPoints(): Promise<ExtensionPoints | undefined> {
      if (!index.extensionPoints) return undefined;
      points ??= read(index.extensionPoints) as Promise<ExtensionPoints>;
      return points;
    },
    async skillPack(id: string): Promise<string | undefined> {
      if (!isBrandId(id)) throw new Error(`registry: id de skill inválido "${id}"`);
      const path = index.skills?.[id];
      if (!path) return undefined;
      return fetchPack(join(opts.skillCacheDir ?? join(tmpdir(), 'wt-skills'), pinDir(pin), id), 'SKILL.md', async (part) => {
        const item = (await read(path)) as SkillPackItem;
        writePackFiles(item.id, item.files, part);
      });
    },
  };
}
