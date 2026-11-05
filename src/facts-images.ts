// Imágenes de los hechos (logos de clientes y fotos de reseñas) dentro del workspace: el agente las usa como rutas
// locales, igual que el logo de la marca, y la página no depende del CDN de Webflow ni de su disponibilidad.
// Ya llegan con la URL validada (assetUrl); aquí se baja cada una con tope de bytes y se acepta solo si sus primeros
// bytes son de una imagen. Una imagen que no se puede bajar se quita del hecho: el hecho sigue, sin foto ni logo.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrandFacts } from './brand-facts';
import { readCappedBytes } from './brand-facts-source';

export const FACTS_IMAGE_DIR = 'brand/facts';
export const MAX_FACT_IMAGE = 1_500_000;
const TIMEOUT_MS = 10_000;

export type FetchBytes = (url: string) => Promise<Uint8Array>;

export const httpFetchBytes: FetchBytes = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
  if (!r.ok) throw new Error(`${url} respondió ${r.status}`);
  return readCappedBytes(r, MAX_FACT_IMAGE);
};

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0): boolean => sig.every((x, i) => b[at + i] === x);

/** Extensión por magic bytes, no por la URL ni por content-type: los dos vienen de fuera. SVG no entra: servido desde
 * public/ corre en el origen del sitio, y una lista negra se evade (prefijos de namespace, entidades, `/` como separador). */
export function imageExt(b: Uint8Array): string | undefined {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'jpg';
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
  if (startsWith(b, [0x47, 0x49, 0x46, 0x38])) return 'gif';
  if (startsWith(b, [0x66, 0x74, 0x79, 0x70], 4) && /^avi[fs]$/.test(Buffer.from(b.subarray(8, 12)).toString('latin1'))) return 'avif';
  return undefined;
}

export interface LocalizedFacts { facts: BrandFacts; written: string[]; dropped: number }

/** Baja cada logo y foto a public/brand/facts/<hash>.<ext> y deja en el hecho la ruta pública. El nombre sale de la
 * URL: una imagen ya bajada en este workspace no se vuelve a pedir. */
export async function localizeFactImages(facts: BrandFacts, dir: string, fetchBytes: FetchBytes = httpFetchBytes): Promise<LocalizedFacts> {
  const outDir = join(dir, 'public', FACTS_IMAGE_DIR);
  const written: string[] = [];
  let dropped = 0;
  const fetchOne = async (url: string): Promise<string | undefined> => {
    const name = createHash('sha256').update(url).digest('hex').slice(0, 16);
    try {
      // Solo se reutiliza un archivo que sigue siendo una imagen aceptada: uno a medias o cambiado se vuelve a bajar.
      const have = existsSync(outDir) ? readdirSync(outDir).find((f) => f.startsWith(`${name}.`) && !f.includes('.tmp-')) : undefined;
      if (have && imageExt(readFileSync(join(outDir, have))) === have.slice(name.length + 1)) return `/${FACTS_IMAGE_DIR}/${have}`;
      const bytes = await fetchBytes(url);
      if (bytes.byteLength > MAX_FACT_IMAGE) throw new Error('pasa del tope');
      const ext = imageExt(bytes);
      if (!ext) throw new Error('no es una imagen');
      mkdirSync(outDir, { recursive: true });
      // Escritura atómica: el preview y una corrida en paralelo nunca ven un archivo a medias.
      const tmp = join(outDir, `${name}.tmp-${randomUUID()}`);
      writeFileSync(tmp, bytes);
      renameSync(tmp, join(outDir, `${name}.${ext}`));
      written.push(`public/${FACTS_IMAGE_DIR}/${name}.${ext}`);
      return `/${FACTS_IMAGE_DIR}/${name}.${ext}`;
    } catch {
      dropped += 1;
      return undefined;
    }
  };
  // Una URL repetida (dos casos del mismo cliente) se baja una vez: dos escrituras del mismo archivo en paralelo competirían.
  const pending = new Map<string, Promise<string | undefined>>();
  const local = (url: string): Promise<string | undefined> => {
    if (!pending.has(url)) pending.set(url, fetchOne(url));
    return pending.get(url)!;
  };
  const clients = facts.clients && await Promise.all(facts.clients.map(async ({ logo, ...c }) => {
    const path = logo ? await local(logo) : undefined;
    return path ? { ...c, logo: path } : c;
  }));
  const testimonials = facts.testimonials && await Promise.all(facts.testimonials.map(async ({ photo, ...t }) => {
    const path = photo ? await local(photo) : undefined;
    return path ? { ...t, photo: path } : t;
  }));
  return { facts: { ...facts, ...(clients ? { clients } : {}), ...(testimonials ? { testimonials } : {}) }, written, dropped };
}
