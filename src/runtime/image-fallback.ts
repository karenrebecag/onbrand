// §18 fallback sin imagen (arnes/526043c3 A7): con el cupo agotado o el Gateway sin credencial, generate_image falla y
// el agente igual puede dejar `src="/images/x.jpg"`. El preview lo tapa (wt-reveal-bridge data-wt-broken-src), el dist
// exportado no lleva puentes (P3) y mostraría la imagen rota. Al cerrar el turno, cada /images/ referenciado sin
// archivo recibe un placeholder gris válido de su formato y queda en `agent.images.pending`, que alimenta el sensor
// image.pending (scripts/page-sensors.ts workspacePending). No se reescribe el JSX del agente: tocar su código por regex
// rompe más de lo que arregla.
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { IMAGE_SRC_RE, imageFileIn } from './image-tool';

// 4x3 rgb(229,229,229): mismo gris que PLACEHOLDER_IMG del puente, en cada formato que acepta IMAGE_SRC_RE.
const PLACEHOLDER: Readonly<Record<'png' | 'jpg' | 'webp', string>> = {
  png: 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAABKADAAQAAAABAAAAAwAAAAB3TCISAAAAFUlEQVQIHWN8+vQpAwwwwRggGoUDAGPnArWHoXRNAAAAAElFTkSuQmCC',
  jpg: '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAABKADAAQAAAABAAAAAwAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAwAEAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A/ZSiiigD/9k=',
  webp: 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoEAAMAAgA0JaQAA3AA/vlAAAA=',
};

// Tope de rutas por turno: el código del agente puede listar cientos de /images/ y cada una es un archivo escrito y una
// entrada de page.json (security-reviewer fila 4, M1). 32 cubre una landing con galería; más es generación desbocada.
export const MAX_PENDING_IMAGES = 32;

const CODE_FILE = /\.(?:[cm]?[jt]sx?|css|html)$/;
// Delimitado por comilla o url(...): `/images/a.jpg` dentro de un texto suelto no es una referencia.
const IMAGE_REF = /["'`(]\s*(\/images\/[a-z0-9][a-z0-9._-]*\.(?:png|jpe?g|webp))(?=\s*["'`)?#])/gi;

function codeFiles(dir: string): string[] {
  const src = join(dir, 'src');
  const inSrc = existsSync(src) ? readdirSync(src, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && CODE_FILE.test(e.name)).map((e) => join(e.parentPath, e.name)) : [];
  const html = join(dir, 'index.html');
  // lstat: un index.html symlink leería un archivo de fuera del ws.
  return lstatSync(html, { throwIfNoEntry: false })?.isFile() ? [html, ...inSrc] : inSrc;
}

/** Todas las rutas /images/ válidas que el código del ws referencia, ordenadas y sin repetir. */
function imageRefs(dir: string): string[] {
  const refs = new Set(codeFiles(dir).flatMap((f) => [...readFileSync(f, 'utf8').matchAll(IMAGE_REF)].map((m) => m[1]!)));
  return [...refs].filter((src) => IMAGE_SRC_RE.test(src)).sort();
}

/** public/images del ws si no es un symlink fuera de él (imageFileIn), comprobado una vez por turno y no por ruta. */
function imagesDirOf(dir: string): string | null {
  const probe = imageFileIn(dir, '/images/probe.png');
  return probe ? dirname(probe) : null;
}

/** Ruta absoluta de `src` en public/images, o null si ahí hay algo que no es un archivo (symlink, carpeta). */
function fileIn(imagesDir: string, src: string): string | null {
  const file = join(imagesDir, src.slice('/images/'.length));
  const st = lstatSync(file, { throwIfNoEntry: false });
  return st && !st.isFile() ? null : file;
}

/** Rutas /images/ que el código referencia y no existen en public/images, ordenadas, sin repetir y con tope. */
export function missingImageRefs(dir: string, limit: number = MAX_PENDING_IMAGES): string[] {
  const imagesDir = imagesDirOf(dir);
  if (!imagesDir) return [];
  return imageRefs(dir).filter((src) => {
    const file = fileIn(imagesDir, src);
    return file !== null && !existsSync(file);
  }).slice(0, Math.max(0, limit));
}

const formatOf = (src: string): keyof typeof PLACEHOLDER => {
  const ext = src.slice(src.lastIndexOf('.') + 1).toLowerCase();
  return ext === 'png' || ext === 'webp' ? ext : 'jpg';
};
const bytesOf = (src: string): Buffer => Buffer.from(PLACEHOLDER[formatOf(src)], 'base64');

/** ¿El archivo de `src` sigue siendo el placeholder? Un pendiente de un turno anterior ya tiene archivo y missingImageRefs
 *  no lo ve: sigue pendiente hasta que generate_image o una subida lo reemplacen. El tamaño va antes que leerlo entero. */
function stillPlaceholder(imagesDir: string, src: string): boolean {
  const file = fileIn(imagesDir, src);
  const st = file ? lstatSync(file, { throwIfNoEntry: false }) : undefined;
  const bytes = bytesOf(src);
  return Boolean(file && st?.isFile() && st.size === bytes.length && readFileSync(file).equals(bytes));
}

/** `wx` crea sin seguir un symlink puesto después de la comprobación (O_EXCL); si la escritura falla a medias, el archivo
 *  parcial se borra para que no quede una imagen rota con nombre válido. */
function writePlaceholder(file: string, bytes: Buffer): void {
  const fd = openSync(file, 'wx');
  try {
    writeSync(fd, bytes);
    closeSync(fd);
  } catch (e) {
    closeSync(fd);
    rmSync(file, { force: true });
    throw e;
  }
}

/** Lo pendiente heredado de page.json: viene de disco, no del tipo. */
export function previousPending(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string' && IMAGE_SRC_RE.test(p)) : [];
}

export interface FallbackResult {
  /** Las nuevas y las heredadas que siguen referenciadas y siguen siendo placeholder, con tope. */
  readonly pending: string[];
  /** Rutas que no se pudieron escribir (ruta: error); no entran en pending. */
  readonly errors: string[];
}

/** Escribe el placeholder de cada referencia rota. Un error de fs en una ruta la deja fuera y sigue con las demás; uno
 *  global (leer src/, public/images) devuelve lo heredado tal cual: el fallback nunca tumba el turno. */
export function fillMissingImages(dir: string, previous: readonly string[] = []): FallbackResult {
  try {
    const imagesDir = imagesDirOf(dir);
    if (!imagesDir) return { pending: [...previous], errors: ['public/images no es una carpeta del workspace'] };
    const refs = new Set(imageRefs(dir));
    const errors: string[] = [];
    // Los heredados van primero y las nuevas llenan el resto del tope: escribir más que eso dejaría grises sin pending,
    // fuera del sensor (revisión de Arq sobre #748).
    const kept = previous.filter((src) => refs.has(src) && stillPlaceholder(imagesDir, src)).slice(0, MAX_PENDING_IMAGES);
    const added = missingImageRefs(dir, MAX_PENDING_IMAGES - kept.length).filter((src) => {
      const file = fileIn(imagesDir, src);
      if (!file) return false;
      try {
        writePlaceholder(file, bytesOf(src));
        return true;
      } catch (e) {
        errors.push(`${src}: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
    });
    return { pending: [...new Set([...kept, ...added])].sort(), errors };
  } catch (e) {
    return { pending: [...previous], errors: [e instanceof Error ? e.message : String(e)] };
  }
}
