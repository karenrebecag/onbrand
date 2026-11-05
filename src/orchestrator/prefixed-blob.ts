// BlobClient con prefijo (WT_BLOB_PREFIX): varias pruebas o ambientes comparten un store sin pisarse y se pueden borrar por prefijo.
// El resto del orquestador ve rutas sin prefijo; solo el SDK lo ve.

import type { BlobClient } from './chat-index';

const PREFIX = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*\/$/;

/** Lanza con un prefijo que no termine en `/` o traiga `..`, `//` o mayúsculas: un prefijo mal escrito escribiría fuera de su zona. */
export function prefixedBlob(inner: BlobClient, prefix: string): BlobClient {
  if (!PREFIX.test(prefix)) throw new Error(`prefijo de blob inválido "${prefix}": usa segmentos [a-z0-9_-] separados por "/" y terminado en "/"`);
  return {
    read: (pathname) => inner.read(prefix + pathname),
    create: (pathname, body) => inner.create(prefix + pathname, body),
    replace: (pathname, body, ifMatch) => inner.replace(prefix + pathname, body, ifMatch),
    list: async (p) => (await inner.list(prefix + p)).map((x) => x.slice(prefix.length)),
  };
}
