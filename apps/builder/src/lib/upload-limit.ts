// En staging las subidas pasan por el rewrite de Vercel, que puede compartir el tope de 4.5 MB de las Functions
// (vercel.com/docs/functions/limitations, "Request body size"). VITE_MAX_UPLOAD_BYTES baja los topes propios para
// avisar en el cliente en vez de recibir un 413; sin ella quedan los de Stitch y del transport.

/** El tope de subida del orquestador (route-table.ts UPLOAD_MAX_BYTES, spec §7): una Function no recibe más de 4,5 MiB y el
 * builder es el mismo en los dos modos, así que el local no deja subir lo que en producción daría 413. */
export const UPLOAD_MAX_BYTES = 4 * 1024 * 1024

/** El menor entre el tope propio y el del host; un valor del host que no es un entero positivo no cuenta. */
export function capBytes(base: number, host: string | undefined): number {
  const n = Number(host)
  return Number.isInteger(n) && n > 0 ? Math.min(base, n) : base
}

export const hostCap = (base: number): number => capBytes(base, import.meta.env?.VITE_MAX_UPLOAD_BYTES as string | undefined)

export const formatMB = (bytes: number): string => `${+(bytes / 1024 / 1024).toFixed(1)} MB`
