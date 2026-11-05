// Imágenes generadas como archivos del workspace. En v0 la parte task-generate-image-v1 escribe el
// asset en public/images/ y el código lo cita por ruta (VERIFIED con una corrida real,
// v0-endpoint-map.md §6.6). El paso de imagen del motor deja los bytes en `page.assets` y aquí se
// escriben con su nombre semántico. Las URL de CDN que cite una página (fal.media, el camino anterior)
// se siguen bajando a public/images/ para que la imagen entre al commit y no caduque con el CDN.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Solo el CDN del proveedor configurado: el transport no baja URLs arbitrarias que el modelo escriba.
const ASSET_HOST = /^(?:[a-z0-9-]+\.)*fal\.media$/;
const MAX_ASSET = 15 * 1024 * 1024;
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const TIMEOUT_MS = 30_000;

export const isAssetUrl = (v: string): boolean => {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && ASSET_HOST.test(u.hostname);
  } catch {
    return false;
  }
};

function collect(node: unknown, out: Set<string>): void {
  if (typeof node === 'string') {
    if (isAssetUrl(node)) out.add(node);
  } else if (Array.isArray(node)) {
    for (const n of node) collect(n, out);
  } else if (node && typeof node === 'object') {
    for (const v of Object.values(node)) collect(v, out);
  }
}

function replace<T>(node: T, map: Map<string, string>): T {
  if (typeof node === 'string') return (map.get(node) ?? node) as T;
  if (Array.isArray(node)) return node.map((n) => replace(n, map)) as T;
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, replace(v, map)])) as T;
  }
  return node;
}

export type Fetcher = (url: string) => Promise<{ contentType: string; body: Buffer }>;

export const httpFetch: Fetcher = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
  if (!r.ok) throw new Error(`${url} respondió ${r.status}`);
  const body = Buffer.from(await r.arrayBuffer());
  if (body.length > MAX_ASSET) throw new Error(`${url} pesa más de ${MAX_ASSET} bytes`);
  return { contentType: (r.headers.get('content-type') ?? '').split(';')[0].trim(), body };
};

/** Baja las imágenes del CDN que cite la página y devuelve una página nueva con rutas locales, más
 * las rutas escritas. El nombre es el hash del contenido: la misma imagen no se duplica entre mensajes. */
export async function localizeAssets<T>(page: T, wsDir: string, fetcher: Fetcher = httpFetch): Promise<{ page: T; written: string[] }> {
  const own = writePageAssets(page, wsDir);
  const urls = new Set<string>();
  collect(own.page, urls);
  if (!urls.size) return own;
  mkdirSync(join(wsDir, 'public', 'images'), { recursive: true });
  const map = new Map<string, string>();
  const written: string[] = [...own.written];
  for (const url of urls) {
    const { contentType, body } = await fetcher(url);
    const ext = EXT[contentType];
    if (!ext) throw new Error(`${url} no es una imagen aceptada (${contentType || 'sin content-type'})`);
    const name = `${createHash('sha256').update(body).digest('hex').slice(0, 16)}.${ext}`;
    const rel = join('public', 'images', name);
    if (!existsSync(join(wsDir, rel))) writeFileSync(join(wsDir, rel), body);
    map.set(url, `/images/${name}`);
    written.push(rel);
  }
  return { page: replace(own.page, map), written };
}

const SAFE_FILE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.(?:png|jpg|webp)$/;

/** Assets del paso de imagen (`page.assets[].base64`): se escriben en public/images con su nombre
 * semántico y la página sigue sin los bytes, así page.json no carga la imagen. */
function writePageAssets<T>(page: T, wsDir: string): { page: T; written: string[] } {
  const assets = (page as { assets?: { file?: unknown; base64?: unknown }[] } | null)?.assets;
  if (!Array.isArray(assets) || !assets.length) return { page, written: [] };
  mkdirSync(join(wsDir, 'public', 'images'), { recursive: true });
  const written: string[] = [];
  for (const a of assets) {
    // El nombre lo validó el paso de imagen; se revalida porque se usa como ruta en disco.
    if (typeof a.file !== 'string' || !SAFE_FILE.test(a.file) || typeof a.base64 !== 'string') throw new Error(`asset inválido: ${String(a.file)}`);
    const rel = join('public', 'images', a.file);
    writeFileSync(join(wsDir, rel), Buffer.from(a.base64, 'base64'));
    written.push(rel);
  }
  const { assets: _, ...rest } = page as Record<string, unknown>;
  return { page: rest as T, written };
}
