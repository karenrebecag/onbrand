// BlobClient sobre un directorio: el almacén del orquestador para local y tests, sin cuenta ni SDK. Mismo contrato que cualquier
// otro adaptador (chat-index.ts): create falla si existe, replace solo escribe si el etag no cambió.
// HACK: la exclusión de escritores es un candado en memoria de ESTE proceso; dos procesos sobre el mismo directorio pueden
// pisarse entre el chequeo del etag y el rename. Candado de archivo (o un adaptador de red) cuando haya más de un orquestador.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { BlobConflictError, BlobExistsError, type BlobClient } from './chat-index';

const etagOf = (text: string): string => createHash('sha1').update(text).digest('hex');

/** Un pathname del índice son segmentos [A-Za-z0-9._=-] separados por `/`: base64url y ids de chat, nada que salga del directorio. */
function safe(root: string, pathname: string): string {
  if (!/^[\w=.-]+(\/[\w=.-]+)*$/.test(pathname) || pathname.split('/').some((s) => s === '.' || s === '..')) throw new Error(`fs-blob: pathname inválido "${pathname}"`);
  return join(root, ...pathname.split('/'));
}

export function fsBlobClient(root: string): BlobClient {
  mkdirSync(root, { recursive: true });
  // Una cola por proceso: leer-comparar-escribir de un mismo archivo no se entrelaza con otro.
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => T): Promise<T> => { const run = chain.then(fn, fn); chain = run.catch(() => undefined); return run; };

  const readFile = (file: string): { text: string; etag: string } | undefined => {
    if (!existsSync(file)) return undefined;
    const text = readFileSync(file, 'utf8');
    return { text, etag: etagOf(text) };
  };
  // temp + rename: un corte a mitad no deja un JSON truncado que el índice leería como corrupto.
  const write = (file: string, body: string): { etag: string } => {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, file);
    return { etag: etagOf(body) };
  };

  return {
    read: (pathname) => exclusive(() => readFile(safe(root, pathname))),
    create: (pathname, body) => exclusive(() => {
      const file = safe(root, pathname);
      if (existsSync(file)) throw new BlobExistsError(pathname);
      return write(file, body);
    }),
    replace: (pathname, body, ifMatch) => exclusive(() => {
      const file = safe(root, pathname);
      if (readFile(file)?.etag !== ifMatch) throw new BlobConflictError(pathname);
      return write(file, body);
    }),
    list: (prefix) => exclusive(() => {
      const out: string[] = [];
      const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else if (!name.endsWith('.tmp')) out.push(relative(root, full).split(sep).join('/'));
        }
      };
      walk(root);
      return out.filter((p) => p.startsWith(prefix)).sort();
    }),
  };
}
