// Nodos libres del lienzo (imágenes del rail, como "Upload files to canvas" de Stitch: re-iteracion/stitch-ui/
// static-rail-tools.md §3b-3c). No son versiones de la página: viven en `.wt/` del workspace, que está fuera del commit y
// que discardChanges/restoreTree no tocan, así que deshacer una versión no borra imágenes del lienzo. El formato lo
// acordaron UI y ec (E3 lo carga al rehidratar el hilo). Todo lo que llega aquí es input externo.

import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { bytesMatchType } from './image-replace';

/** lu de Stitch (I18nStore l.12800): 20 MB por imagen. */
export const MAX_CANVAS_IMAGE = 20 * 1024 * 1024;
export const MAX_CANVAS_BODY = 64 * 1024;
export const MAX_NODES = 200;
const MAX_COORD = 1_000_000;
const MAX_SIDE = 20_000;
const MAX_NAME = 200;
// Sin SVG: puede llevar script y el lienzo lo pinta en la app del builder.
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const TYPE_BY_EXT: Record<string, string> = Object.fromEntries(Object.entries(EXT).map(([t, e]) => [e, t]));
/** Nombre de un archivo del lienzo: `<slug de 40>-<6 hex del SHA-256>.<ext>`, como `_t`/`ht` de Stitch. Nada de `/` ni `..`. */
export const CANVAS_FILE_NAME = /^[a-z0-9_-]{1,40}-[0-9a-f]{6}\.(png|jpg|webp|gif)$/;
/** Tope por workspace: sin él, subidas distintas de 20 MB llenan el disco (cada una es un archivo nuevo). */
// HACK: tope fijo y sin limpieza de huérfanos. Borrar los no referenciados cuando haya un GC por chat que no compita
// con una subida en curso de otra pestaña.
export const MAX_CANVAS_FILES = 200;
export const MAX_CANVAS_BYTES = 200 * 1024 * 1024;
export const MAX_FAVORITES = 200;
// La forma de un messageId del índice (uuid o hex de 32); que exista o no da igual: una estrella huérfana no se pinta.
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CanvasNode { id: string; kind: 'image'; src: string; name: string; x: number; y: number; width: number; height: number }
/** `favorites`: messageIds de las pantallas con estrella (isFavourite de Stitch, `stitch:tool-fav`). Va aquí y no en el
 * índice de mensajes porque es estado de la persona, como los nodos; solo viaja si hay alguno. */
export interface CanvasDoc { rev: number; nodes: CanvasNode[]; favorites?: string[] }

export class CanvasError extends Error {
  constructor(readonly status: number, message: string, readonly current?: CanvasDoc) {
    super(message);
  }
}

/** La URL con que el transport sirve un archivo del lienzo: es el único `src` que acepta un nodo. */
export const canvasFileUrl = (chatId: string, file: string): string => `/chats/${encodeURIComponent(chatId)}/canvas/files/${file}`;

const EMPTY: CanvasDoc = { rev: 0, nodes: [] };

/** `.wt` real del workspace, o null si es un symlink: el agente escribe en el workspace y un enlace llevaría la lectura
 * o la escritura fuera de él. */
function wtDir(wsDir: string): string | null {
  try {
    const p = join(realpathSync(wsDir), '.wt');
    try {
      if (lstatSync(p).isSymbolicLink()) return null;
    } catch {
      // Todavía no existe: se crea al escribir.
    }
    return p;
  } catch {
    return null;
  }
}

/** Lee sin seguir symlinks (O_NOFOLLOW sobre el descriptor, no un lstat previo que se puede cambiar entre medio), solo
 * archivos regulares con un único enlace (un hard link plantado apuntaría a un archivo de afuera) y con tope. */
function readNoFollow(path: string, max: number): Buffer | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > max) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Escribe en un temporal de nombre aleatorio creado con O_EXCL|O_NOFOLLOW y lo renombra: rename reemplaza un symlink
 * en el destino en vez de seguirlo, y nadie puede plantar el temporal antes. */
function writeNoFollow(dir: string, name: string, data: Uint8Array): void {
  if (lstatSync(dir).isSymbolicLink()) throw new CanvasError(400, 'la carpeta del lienzo no es del workspace');
  const real = realpathSync(dir);
  const tmp = join(dir, `.${name}.${randomUUID()}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    // O_NOFOLLOW solo cubre el último tramo: si la carpeta cambió por un symlink entre el lstat y el open, se aborta.
    if (realpathSync(dir) !== real || lstatSync(dir).isSymbolicLink()) throw new CanvasError(400, 'la carpeta del lienzo no es del workspace');
    writeSync(fd, data);
    closeSync(fd);
    renameSync(tmp, join(dir, name));
  } catch (e) {
    try { closeSync(fd); } catch { /* ya cerrado */ }
    try { unlinkSync(tmp); } catch { /* el temporal quedó en otra carpeta o ya no existe */ }
    throw e;
  }
}

/** El documento guardado, revalidado: el agente puede escribir `.wt/canvas.json` con sus herramientas, así que lo que
 * no pase la misma validación que el PUT se ignora y el lienzo vuelve a vacío. */
export function readCanvas(wsDir: string, chatId: string): CanvasDoc {
  const wt = wtDir(wsDir);
  const raw = wt ? readNoFollow(join(wt, 'canvas.json'), MAX_CANVAS_BODY) : null;
  if (!raw) return EMPTY;
  try {
    const doc = JSON.parse(raw.toString('utf8')) as { rev?: unknown; nodes?: unknown };
    if (!Number.isInteger(doc?.rev) || (doc.rev as number) < 0 || !Array.isArray(doc.nodes) || doc.nodes.length > MAX_NODES) return EMPTY;
    const nodes = doc.nodes.map((n) => parseNode(n, chatId));
    const favorites = parseFavorites((doc as { favorites?: unknown }).favorites ?? []);
    if (typeof favorites === 'string' || !nodes.every((n): n is CanvasNode => typeof n !== 'string')) return EMPTY;
    return withFavorites({ rev: doc.rev as number, nodes }, favorites);
  } catch {
    return EMPTY;
  }
}

/** Lista sin repetidos de messageIds con forma válida, o el motivo del rechazo. */
function parseFavorites(raw: unknown): string[] | string {
  if (!Array.isArray(raw) || raw.length > MAX_FAVORITES) return `favorites debe ser una lista de hasta ${MAX_FAVORITES}`;
  if (!raw.every((id): id is string => typeof id === 'string' && MESSAGE_ID.test(id))) return 'favorites debe tener messageIds';
  return [...new Set(raw)];
}

const withFavorites = (doc: CanvasDoc, favorites: string[]): CanvasDoc => (favorites.length ? { ...doc, favorites } : doc);

const finite = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/** Un nodo tal como lo manda el builder, o el motivo por el que no se acepta. */
function parseNode(raw: unknown, chatId: string): CanvasNode | string {
  if (typeof raw !== 'object' || raw === null) return 'nodo inválido';
  const n = raw as Record<string, unknown>;
  if (typeof n.id !== 'string' || !UUID.test(n.id)) return 'id debe ser un uuid';
  if (n.kind !== 'image') return 'kind debe ser image';
  const prefix = canvasFileUrl(chatId, '');
  if (typeof n.src !== 'string' || !n.src.startsWith(prefix) || !CANVAS_FILE_NAME.test(n.src.slice(prefix.length))) return 'src debe ser un archivo del lienzo de este chat';
  if (typeof n.name !== 'string' || n.name.length > MAX_NAME) return `name debe ser texto de hasta ${MAX_NAME} caracteres`;
  if (!finite(n.x, -MAX_COORD, MAX_COORD) || !finite(n.y, -MAX_COORD, MAX_COORD)) return 'x e y deben ser números finitos';
  if (!finite(n.width, Number.MIN_VALUE, MAX_SIDE) || !finite(n.height, Number.MIN_VALUE, MAX_SIDE)) return `width y height deben ser > 0 y <= ${MAX_SIDE}`;
  return { id: n.id, kind: 'image', src: n.src, name: n.name, x: n.x, y: n.y, width: n.width, height: n.height };
}

/** PUT del documento: valida cada nodo y exige el `rev` que leyó el cliente, para que dos pestañas no se pisen en
 * silencio con el autosave; si no coincide, 409 con el actual. Escribe con rename para no dejar un JSON a medias.
 * `nodes` y `favorites` son opcionales: lo que no viaja se conserva, así el autosave de las imágenes no borra las
 * estrellas ni la estrella pisa un nodo. */
export function writeCanvas(wsDir: string, chatId: string, body: unknown): CanvasDoc {
  if (typeof body !== 'object' || body === null) throw new CanvasError(400, 'se espera { rev, nodes?, favorites? }');
  const { rev, nodes, favorites } = body as { rev?: unknown; nodes?: unknown; favorites?: unknown };
  if (!Number.isInteger(rev) || (rev as number) < 0) throw new CanvasError(400, 'rev debe ser un entero >= 0');
  if (nodes === undefined && favorites === undefined) throw new CanvasError(400, 'se espera nodes o favorites');
  let parsed: CanvasNode[] | undefined;
  if (nodes !== undefined) {
    if (!Array.isArray(nodes) || nodes.length > MAX_NODES) throw new CanvasError(400, `nodes debe ser una lista de hasta ${MAX_NODES}`);
    const list = nodes.map((n) => parseNode(n, chatId));
    const bad = list.find((n): n is string => typeof n === 'string');
    if (bad) throw new CanvasError(400, bad);
    if (new Set(list.map((n) => (n as CanvasNode).id)).size !== list.length) throw new CanvasError(400, 'ids repetidos');
    parsed = list as CanvasNode[];
  }
  const stars = favorites === undefined ? undefined : parseFavorites(favorites);
  if (typeof stars === 'string') throw new CanvasError(400, stars);
  const current = readCanvas(wsDir, chatId);
  if (rev !== current.rev) throw new CanvasError(409, 'el lienzo cambió en otra pestaña', current);
  const next = withFavorites({ rev: current.rev + 1, nodes: parsed ?? current.nodes }, stars ?? current.favorites ?? []);
  const wt = wtDir(wsDir);
  if (!wt) throw new CanvasError(400, 'la carpeta del lienzo no es del workspace');
  mkdirSync(wt, { recursive: true });
  writeNoFollow(wt, 'canvas.json', new TextEncoder().encode(JSON.stringify(next)));
  return next;
}

/** `.wt/canvas` real, o null si `.wt` o `.wt/canvas` son symlinks. */
function canvasDir(wsDir: string): string | null {
  const wt = wtDir(wsDir);
  if (!wt) return null;
  const dir = join(wt, 'canvas');
  try {
    if (lstatSync(dir).isSymbolicLink()) return null;
  } catch {
    // Todavía no existe.
  }
  return dir;
}

/** Acepta el tipo antes de leer el cuerpo: lo que no es PNG, JPEG, WebP o GIF se rechaza sin recibir un byte. */
export const isCanvasImageType = (contentType: string): boolean => Object.hasOwn(EXT, contentType);

/** POST de una imagen: el tipo se comprueba por los bytes (el content-type lo declara el cliente), sin SVG y con tope.
 * El nombre sale del contenido, así que la misma imagen cae en el mismo archivo. */
export function saveCanvasFile(wsDir: string, chatId: string, name: string, contentType: string, body: Uint8Array): { src: string; file: string } {
  const ext = EXT[contentType];
  if (!ext || !bytesMatchType(contentType, body)) throw new CanvasError(415, 'solo PNG, JPEG, WebP o GIF');
  if (body.length > MAX_CANVAS_IMAGE) throw new CanvasError(413, 'la imagen pasa de 20 MB');
  const slug = name.replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9_]+/g, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '') || 'image';
  const file = `${slug}-${createHash('sha256').update(body).digest('hex').slice(0, 6)}.${ext}`;
  const dir = canvasDir(wsDir);
  if (!dir) throw new CanvasError(400, 'la carpeta del lienzo no es del workspace');
  mkdirSync(dir, { recursive: true });
  const existing = readdirSync(dir).filter((f) => CANVAS_FILE_NAME.test(f));
  if (!existing.includes(file)) {
    // Un archivo que desaparece entre readdir y lstat no cuenta, en vez de tirar un 500.
    const sizeOf = (f: string): number => { try { return lstatSync(join(dir, f)).size; } catch { return 0; } };
    const used = existing.reduce((sum, f) => sum + sizeOf(f), 0);
    if (existing.length >= MAX_CANVAS_FILES || used + body.length > MAX_CANVAS_BYTES) throw new CanvasError(507, 'el lienzo de este chat llegó a su tope de imágenes');
  }
  writeNoFollow(dir, file, body);
  return { src: canvasFileUrl(chatId, file), file };
}

/** GET de un archivo: solo nombres con la forma exacta, archivos regulares dentro del `.wt/canvas` real. */
export function readCanvasFile(wsDir: string, file: string): { body: Buffer; contentType: string } | null {
  if (!CANVAS_FILE_NAME.test(file)) return null;
  const dir = canvasDir(wsDir);
  const body = dir ? readNoFollow(join(dir, file), MAX_CANVAS_IMAGE) : null;
  return body ? { body, contentType: TYPE_BY_EXT[file.slice(file.lastIndexOf('.') + 1)]! } : null;
}
