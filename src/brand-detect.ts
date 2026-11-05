// Marca detectada en el brief: si el texto nombra el id de un pack publicado ("Acme (acme.com)" → `acme`), se carga
// ese pack en vez de la identidad efímera. Solo ids de 3+ letras como palabra completa; `base` nunca (es el pack por
// defecto y "base de datos" lo dispararía).
import { existsSync, readdirSync } from 'node:fs';
import { brandIdOfDir } from './brand-registry';

const MIN_ID = 3;
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function detectBrand(prompt: string, ids: readonly string[]): string | undefined {
  const text = prompt.toLowerCase();
  const hits = ids.filter((id) => id !== 'base' && id.length >= MIN_ID && new RegExp(`(^|[^a-z0-9])${escape(id).replace(/-/g, '[-\\s]')}(?=$|[^a-z0-9])`).test(text));
  // El id más largo gana: "acme-academy" sobre "acme" cuando el brief nombra la academia.
  return hits.sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
}

/** Sin registry: ids de los packs locales (carpetas brand-pack[-<id>] de brandsRoot). */
export function localBrandIds(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (brandIdOfDir(e.name) ? [brandIdOfDir(e.name) as string] : []) : []));
}
