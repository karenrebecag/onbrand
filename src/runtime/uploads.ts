// Adjuntos del mensaje. La API pública de v0 no tiene endpoint de upload: el cliente pasa una URL o un
// data URI (VERIFIED, v0-endpoint-map.md §6.4). Aquí el cliente sube primero a POST /uploads y el
// mensaje solo puede citar URLs de este store: el transport nunca descarga URLs arbitrarias (SSRF).

import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { basename, join } from 'node:path';
import { imageSize } from './image-step';
import type { PageAsset } from './layout';

export const MAX_UPLOAD = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
export const UPLOAD_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml',
  'application/pdf', 'text/plain', 'text/markdown',
]);
const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'text/markdown': 'md',
};
// El multipart trae boundary y headers por parte además del archivo.
const MULTIPART_OVERHEAD = 64 * 1024;
const UPLOAD_ID = /^[0-9a-f]{32}$/;

export interface Upload {
  url: string;
  name: string;
  contentType: string;
  size: number;
}

/** Lo que recibe el composer: el adjunto ya copiado al workspace. */
export interface Attachment {
  path: string;
  name: string;
  contentType: string;
  size: number;
  /** Solo imágenes: el asset ya escrito en public/images, colocable con {"image": id} como la imagen generada. */
  asset?: PageAsset;
}

// Las que el runner puede emitir como asset y de las que imageSize lee el tamaño real.
const ASSET_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg' };
// Firma completa del formato declarado: imageSize solo mira los primeros 2 bytes y acepta los dos.
const MAGIC: Record<string, number[]> = { png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], jpg: [0xff, 0xd8, 0xff] };

/** Nombre de archivo seguro (el SAFE_FILE de assets.ts) a partir del nombre que puso la usuaria, más un
 * hash del contenido para que dos adjuntos no se pisen y el mismo no se duplique entre mensajes. */
function assetFile(name: string, body: Buffer, ext: string): string {
  const stem = name.replace(/\.[^.]+$/, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'adjunto';
  return `${stem}-${createHash('sha256').update(body).digest('hex').slice(0, 8)}.${ext}`;
}

/** Imagen adjunta → asset en public/images: Vite la sirve en dev y la copia a dist en el build, y el runner
 * solo emite src bajo /images/. El tipo lo validó el upload; aquí se exige además que los bytes sean de ese
 * tipo (imageSize lee la cabecera real), porque el content-type lo declara el cliente. */
function placeImage(file: string, hit: Upload, wsDir: string, ext: string): { path: string; asset: PageAsset } {
  const body = readFileSync(file);
  const size = MAGIC[ext].every((b, i) => body[i] === b) ? imageSize(new Uint8Array(body)) : undefined;
  if (!size) throw new UploadError(400, `el adjunto ${hit.name} no es un ${ext.toUpperCase()} válido`);
  const name = assetFile(hit.name, body, ext);
  const path = join('public', 'images', name);
  mkdirSync(join(wsDir, 'public', 'images'), { recursive: true });
  writeFileSync(join(wsDir, path), body);
  const alt = hit.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
  return { path, asset: { id: name.replace(/\.[^.]+$/, ''), file: name, alt, width: size.width, height: size.height, mediaType: hit.contentType } };
}

export class UploadError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// Solo letras, dígitos, punto, guion y guion bajo: el nombre termina en una ruta del workspace.
const safeName = (name: string): string => basename(name).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 100) || 'file';

/** El cuerpo crudo con tope: un content-length declarado mayor se rechaza antes de leer un byte. */
// Buffer<ArrayBuffer>: lo que da Buffer.concat; así entra como BodyInit de Request sin cast.
export function readRaw(req: IncomingMessage, limit: number): Promise<Buffer<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] ?? 0) > limit) {
      req.resume();
      return reject(new UploadError(413, 'archivo demasiado grande'));
    }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        return reject(new UploadError(413, 'archivo demasiado grande'));
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export class UploadStore {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  /** POST /uploads: multipart con el campo `file`. */
  async accept(req: IncomingMessage): Promise<Upload> {
    const type = req.headers['content-type'] ?? '';
    if (!type.startsWith('multipart/form-data')) throw new UploadError(415, 'se espera multipart/form-data');
    const raw = await readRaw(req, MAX_UPLOAD + MULTIPART_OVERHEAD);
    const form = await new Request('http://127.0.0.1/uploads', { method: 'POST', headers: { 'content-type': type }, body: raw }).formData()
      .catch(() => { throw new UploadError(400, 'multipart inválido'); });
    const file = form.get('file');
    if (!(file instanceof Blob)) throw new UploadError(400, 'falta el campo file');
    const contentType = file.type.split(';')[0].trim();
    if (!UPLOAD_TYPES.has(contentType)) throw new UploadError(415, `tipo no aceptado "${contentType}"`);
    if (file.size > MAX_UPLOAD) throw new UploadError(413, 'archivo demasiado grande');
    const id = randomUUID().replaceAll('-', '');
    // La extensión sale del tipo aceptado, no del nombre: un "x.html" declarado text/plain no debe
    // llegar al workspace como .html, que el dev server serviría como página.
    const name = `${safeName((file as File).name ?? 'file').replace(/\.[^.]*$/, '') || 'file'}.${EXT_BY_TYPE[contentType]}`;
    writeFileSync(join(this.dir, id), Buffer.from(await file.arrayBuffer()));
    const meta: Upload = { url: `/uploads/${id}`, name, contentType, size: file.size };
    writeFileSync(join(this.dir, `${id}.json`), JSON.stringify(meta));
    return meta;
  }

  /** El upload citado por una URL de este store, o null si no es una. Acepta la ruta relativa o la
   * absoluta en loopback, que es lo que el cliente tiene a mano según cómo armó la URL. */
  resolve(url: string): (Upload & { file: string }) | null {
    let u: URL;
    try {
      u = new URL(url, 'http://127.0.0.1');
    } catch {
      return null;
    }
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return null;
    const m = /^\/uploads\/([0-9a-f]{32})$/.exec(u.pathname);
    if (!m || !UPLOAD_ID.test(m[1])) return null;
    const metaPath = join(this.dir, `${m[1]}.json`);
    if (!existsSync(metaPath)) return null;
    return { ...(JSON.parse(readFileSync(metaPath, 'utf8')) as Upload), file: join(this.dir, m[1]) };
  }

  /** GET /uploads/:id: el archivo con su tipo, para que el front pinte la miniatura. */
  read(id: string): { body: Buffer; contentType: string } | null {
    const hit = this.resolve(`/uploads/${id}`);
    return hit ? { body: readFileSync(hit.file), contentType: hit.contentType } : null;
  }
}

/** Copia los adjuntos citados al workspace (entran al commit del mensaje) y devuelve sus rutas. Las imágenes
 * PNG/JPEG van como asset; el resto queda en attachments/ como material de referencia, fuera del build. */
export function placeAttachments(store: UploadStore, urls: Upload[], wsDir: string, messageId: string): Attachment[] {
  const rel = join('attachments', messageId);
  return urls.map((a, i) => {
    const hit = store.resolve(a.url) as Upload & { file: string };
    const ext = ASSET_EXT[hit.contentType];
    if (ext) {
      const { path, asset } = placeImage(hit.file, hit, wsDir, ext);
      return { path, name: hit.name, contentType: hit.contentType, size: statSync(join(wsDir, path)).size, asset };
    }
    mkdirSync(join(wsDir, rel), { recursive: true });
    // El índice evita que dos adjuntos con el mismo nombre se pisen.
    const path = join(rel, `${i + 1}-${hit.name}`);
    copyFileSync(hit.file, join(wsDir, path));
    return { path, name: hit.name, contentType: hit.contentType, size: statSync(join(wsDir, path)).size };
  });
}
