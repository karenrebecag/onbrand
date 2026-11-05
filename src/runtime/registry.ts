// Fuentes de componentes desde el registry (shadcn-style) en vez del vault. Diseño:
// DISENO-two-step-retrieval.md (aprobado por Karen 2026-10-22): cada item `r/<slug>@<sha>.json` es
// autosuficiente (files[] con el código + registryDependencies), la corrida fija un `sha` del índice y
// lo usa para todo, y si el registry no responde la corrida falla: nunca cae en silencio al vault.
// El cliente del store (Vercel Blob, OIDC o URL presignada) es un adaptador aparte: aquí solo se
// consume `getItem`, así el runner no depende de cómo se autentica.

import type { ExtensionPoints } from '../extension-points';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import type { AllowEntry } from '../ds-skill';
import type { SchemaStore } from './verify';

export interface RegistryFile {
  /** Relativa a la raíz del workspace; solo puede caer bajo una de ITEM_ROOTS o ser una lib suelta (ROOT_LIB). */
  path: string;
  content: string;
}

export interface RegistryItem {
  name: string;
  files: RegistryFile[];
  registryDependencies?: string[];
}

/** Lo mínimo que el runner necesita. El adaptador del store (openRegistry, de orq) devuelve un objeto
 * con esto más loadIndex/makeSchemaStore para el composer. */
export interface RegistrySource {
  /** sha del índice fijado para esta corrida. */
  pin: string;
  getItem(slug: string): Promise<RegistryItem>;
  /** Los componentes del índice fijado: lo que el composer pudo elegir, y por eso lo que el runner acepta. */
  loadIndex?(): Promise<Record<string, AllowEntry>>;
  /** Schemas de los items ya traídos por getItem. */
  makeSchemaStore?(): SchemaStore;
  /** Brand pack de este pin bajado a un directorio local (para applyBrand). */
  brandPack?(id: string): Promise<string>;
  /** Ids de los packs publicados en este pin: para detectar la marca en el brief sin bajar ningún pack. */
  brandIds?(): string[];
  skillPack?(id: string): Promise<string | undefined>;
  /** Ranuras de marca del pin; undefined en un pin anterior a ellas (quien valida un pack con `components` falla
   * cerrado ahí, spec ranuras-de-marca §4). */
  extensionPoints?(): Promise<ExtensionPoints | undefined>;
}

// Las librerías portadas al scaffold (Arc, secciones Relume, bloques Morphin y Bencho) y el DS base del core (ui, blocks y
// layout, B9 §3: se materializa como Arc para que el pin y "Actualizar DS" lo cubran); nada más del workspace es del
// registry. Sin Morphin y Bencho aquí, el pin que los trae aborta la instalación (gen 2026-10-27 sobre 5ceb5a7c).
const ITEM_ROOTS = ['src/components/arc/', 'src/components/relume/', 'src/components/morphin/', 'src/components/bencho/', 'src/components/ui/', 'src/components/blocks/', 'src/components/layout/'];
// Libs sueltas de la raíz de src/components (brand-icons, social-icons): un archivo, sin carpeta.
const ROOT_LIB = /^src\/components\/[a-z0-9-]+\.tsx?$/;
// Los slugs Relume del catálogo llevan guion bajo (cta3_shell).
const SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/;

export class RegistryError extends Error {}

/** Un item viene de la red: se valida antes de escribir una sola línea en el workspace. */
export function validateItem(slug: string, raw: unknown): RegistryItem {
  const item = raw as Partial<RegistryItem> | null;
  if (!item || typeof item !== 'object' || item.name !== slug || !Array.isArray(item.files) || !item.files.length) {
    throw new RegistryError(`registry: el item ${slug} no tiene name=${slug} y files[]`);
  }
  for (const f of item.files) {
    const p = typeof f?.path === 'string' ? normalize(f.path) : '';
    // normalize resuelve los ../ antes de mirar el prefijo: un ../ no puede salir de la raíz de Arc.
    if (!(ITEM_ROOTS.some((root) => p.startsWith(root)) || ROOT_LIB.test(p)) || p.includes('..') || typeof f.content !== 'string') {
      throw new RegistryError(`registry: el item ${slug} trae un archivo fuera de ${ITEM_ROOTS.join(' y ')}: ${String(f?.path)}`);
    }
  }
  const deps = item.registryDependencies ?? [];
  if (!Array.isArray(deps) || deps.some((d) => typeof d !== 'string' || !SLUG.test(d))) {
    throw new RegistryError(`registry: registryDependencies inválidas en ${slug}`);
  }
  return { name: slug, files: item.files.map((f) => ({ path: normalize(f.path), content: f.content })), registryDependencies: deps };
}

/** Los items de los slugs pedidos más sus dependencias, una vez cada uno. */
export async function resolveItems(slugs: readonly string[], source: RegistrySource): Promise<RegistryItem[]> {
  const seen = new Map<string, RegistryItem>();
  const queue = [...new Set(slugs)];
  while (queue.length) {
    const slug = queue.shift() as string;
    if (seen.has(slug)) continue;
    if (!SLUG.test(slug)) throw new RegistryError(`registry: slug inválido "${slug}"`);
    let raw: unknown;
    try {
      raw = await source.getItem(slug);
    } catch (e) {
      throw new RegistryError(`registry@${source.pin}: no se pudo leer ${slug}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const item = validateItem(slug, raw);
    seen.set(slug, item);
    for (const d of item.registryDependencies ?? []) if (!seen.has(d)) queue.push(d);
  }
  return [...seen.values()];
}

/** Escribe los archivos de los items en el workspace; devuelve las rutas que cambiaron. */
export function materializeItems(items: readonly RegistryItem[], outDir: string): string[] {
  const written: string[] = [];
  for (const item of items) {
    for (const f of item.files) {
      const abs = join(outDir, f.path);
      if (existsSync(abs) && readFileSync(abs, 'utf8') === f.content) continue;
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.content);
      written.push(f.path);
    }
  }
  return written;
}
