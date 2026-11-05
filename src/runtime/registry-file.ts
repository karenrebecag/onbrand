// El registry del DS desde una carpeta del repo (registry/, lo escribe `build-registry --local`): el mismo formato y el
// mismo lector que el Blob, con otro `read`. Es lo que monta el DS en un clon del core, que no tiene el store de una distro.
// No publica marcas: brands/ es la fuente viva, y un pack copiado aquí dejaría de reflejar lo que se edita.

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { openRegistry, type BlobReader, type RegistrySource } from './registry-source';

/** Lee `path` (ruta del índice) dentro de `dir`; el índice es dato del repo, pero una ruta suya no sale de la carpeta. */
export function fileReader(dir: string): BlobReader {
  return async (path) => {
    const rel = normalize(path);
    if (isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new Error(`registry: ruta inválida "${path}" en ${dir}`);
    const file = join(dir, rel);
    if (!existsSync(file)) throw new Error(`registry: falta ${rel} en ${dir}; regenéralo con build-registry --local`);
    return JSON.parse(readFileSync(file, 'utf8'));
  };
}

/** Abre el registry de `dir` en `pin` (el de la versión padre) o en su latest. Sin brandPack ni brandIds: el transport
 * toma entonces las marcas de su brandsRoot. */
export async function fileRegistry(dir: string, pin?: string): Promise<RegistrySource> {
  if (!existsSync(join(dir, 'latest.json'))) throw new Error(`registry: no hay registry en ${dir}; corre build-registry --local donde esté el vault`);
  const { brandPack: _pack, brandIds: _ids, ...source } = await openRegistry({ read: fileReader(dir), ...(pin ? { pin } : {}) }) as RegistrySource & { brandIds?: () => string[] };
  return source;
}
