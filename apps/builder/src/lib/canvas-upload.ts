// Herramienta Imagen del rail ("Upload files to canvas" de Stitch), parte del cliente. Port de useImageUploadNotice
// (re-iteracion/stitch-ui/deob/wakaru/useImageUploadNotice-CsOqUSGG.js, notas en static-rail-tools.md §3b): tipos y
// topes de I18nStore (cu, lu), validación tt/Je/Qe/et, cola Tt de 3, escala vt a 512 y fila de Et con 64 px de aire.
// Solo imágenes: Stitch acepta además texto en proyectos canvas, pero aquí no hay nodos de documento.
// El cliente filtra para avisar rápido; el server vuelve a validar (magic bytes y tope), porque esto es input externo.

import { formatMB, hostCap, UPLOAD_MAX_BYTES } from './upload-limit'

/** cu de Stitch: tipo → extensiones. */
export const IMAGE_TYPES: Readonly<Record<string, readonly string[]>> = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/webp': ['.webp'],
  'image/gif': ['.gif'],
}
/** El tope del orquestador por imagen (Stitch dejaba 20 MB), o menos si el host corta antes. */
export const MAX_IMAGE_BYTES = hostCap(UPLOAD_MAX_BYTES)
/** maxFiles del dropzone del rail. */
export const MAX_FILES = 6
/** Tt(o, 3, …): subidas en paralelo. */
export const UPLOAD_CONCURRENCY = 3
/** rt: ancho máximo con que entra una imagen al lienzo. */
export const NODE_MAX_WIDTH = 512
/** Et: aire horizontal entre imágenes de una misma subida. */
export const NODE_GAP = 64

/** Textos de Stitch (dist-DUGNOA9D: Bn, Rn, Nn, Lg, A_) en español. */
export const UPLOAD_MESSAGES = {
  invalidType: 'Solo se admiten imágenes PNG, JPEG, WebP y GIF',
  tooLarge: `Las imágenes deben pesar ${formatMB(MAX_IMAGE_BYTES)} o menos`,
  failed: 'No se pudieron subir los archivos. Vuelve a intentarlo más tarde.',
  tooMany: `Puedes subir hasta ${MAX_FILES} imágenes a la vez`,
  button: 'Subir imágenes',
  uploaded: 'Subido',
} as const

export interface UploadCheck {
  valid: File[]
  tooLarge: File[]
  unsupported: File[]
  errorMessages: string[]
}

const extOf = (name: string): string => {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i).toLowerCase() : ''
}

/** Je: el tipo declarado tiene que ser uno de la lista y la extensión, una de las suyas. */
export const isSupportedImage = (file: Pick<File, 'type' | 'name'>): boolean =>
  Object.hasOwn(IMAGE_TYPES, file.type) && IMAGE_TYPES[file.type]!.includes(extOf(file.name))

/** tt + et: reparte los archivos y arma un mensaje por cada clase de problema, no uno por archivo. Más de MAX_FILES
 * los rechaza el dropzone de Stitch antes de llegar aquí; sin dropzone, los que sobran quedan fuera con su aviso. */
export function checkUploads(files: readonly File[]): UploadCheck {
  const out: UploadCheck = { valid: [], tooLarge: [], unsupported: [], errorMessages: [] }
  for (const f of files) {
    if (!isSupportedImage(f)) out.unsupported.push(f)
    else if (f.size > MAX_IMAGE_BYTES) out.tooLarge.push(f)
    else out.valid.push(f)
  }
  const extra = out.valid.length > MAX_FILES
  if (extra) out.valid = out.valid.slice(0, MAX_FILES)
  out.errorMessages = [
    ...(out.unsupported.length ? [UPLOAD_MESSAGES.invalidType] : []),
    ...(out.tooLarge.length ? [UPLOAD_MESSAGES.tooLarge] : []),
    ...(extra ? [UPLOAD_MESSAGES.tooMany] : []),
  ]
  return out
}

/** Tt: corre `fn` sobre cada item con a lo sumo `limit` a la vez y devuelve los resultados en el orden de entrada. */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** vt: tamaño en el lienzo, a lo sumo NODE_MAX_WIDTH de ancho y con la proporción de la imagen; sin medidas, {}. */
export function nodeSize(width?: number, height?: number): { width?: number; height?: number } {
  if (!width || !height || width <= 0 || height <= 0) return {}
  const k = Math.min(1, NODE_MAX_WIDTH / width)
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) }
}

/** Et: la x de cada imagen en la fila que empieza en `originX`; la siguiente arranca tras el ancho de nodo y el aire. */
export function rowXs(count: number, originX = 0): number[] {
  return Array.from({ length: count }, (_, i) => originX + i * (NODE_MAX_WIDTH + NODE_GAP))
}

/** at y ot de Stitch: largo máximo del nombre en la ruta y caracteres del hash. */
const SLUG_MAX = 40
const HASH_CHARS = 6

/** ht de Stitch (useImageUploadNotice l.404): el nombre sin extensión en minúsculas y kebab, a lo sumo 40 caracteres. */
export function uploadSlug(name: string, fallback = 'image'): string {
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  return base.toLowerCase().replace(/[^a-z0-9_]+/g, '-').replace(/^-+/, '').slice(0, SLUG_MAX).replace(/-+$/, '') || fallback
}

/** _t + bt de Stitch (l.416, l.437): `uploads/<slug>-<6 hex del SHA-256><ext>`. La misma imagen da la misma ruta, que es
 * lo que Stitch usa para no duplicar el nodo (index-BNt8DXHu l.4186). */
export async function uploadPath(file: File): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, HASH_CHARS)
  return `uploads/${uploadSlug(file.name)}-${hex}${IMAGE_TYPES[file.type]?.[0] ?? ''}`
}
