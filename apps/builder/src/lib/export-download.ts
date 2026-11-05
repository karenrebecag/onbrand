import { NOT_AT_COMMIT_PUBLISH } from './run-client'

// Descarga de un zip de la versión (H9, GET /runs/:id/export?format=, export-zip-mcp.md §1). Antes era un <a download>
// ciego: un 404 o un 413 bajaba un archivo con el texto del error o no hacía nada. Ahora se pide con fetch y el
// error se lee de la respuesta. El server responde síncrono: "preparando" es el tiempo que tarda la respuesta.

export type DownloadState<F extends string = string> =
  | { kind: 'idle' }
  | { kind: 'preparing'; format: F }
  | { kind: 'ready'; format: F; filename: string }
  | { kind: 'error'; format: F; message: string }

/** Copy por status, según el contrato de /export que confirmó Secondary (run-reads.ts exportVersion). */
export function downloadError(status: number, serverText: string | undefined, format: string, code?: string): string {
  // 404 en site/page es la falta de build; en design-md/brief, que ese archivo no está en el commit.
  if (status === 404) return format === 'site' || format === 'page' ? 'Esta versión todavía no tiene build: el sitio se puede bajar cuando la página compile.' : 'Esta versión no tiene ese archivo.'
  // El sitio y la página se construyen desde el commit de la versión del ws (P3, #688); formats ya apaga las versiones
  // viejas, así que este 409 queda para la carrera de una versión que entró con el menú abierto (copy de ec).
  if (status === 409 && code === 'not-at-commit') return 'Solo se puede exportar la última versión de este chat.'
  if (status === 409) return 'Todavía no hay una versión guardada para descargar.'
  if (status === 413) return 'El archivo pasa de 50 MiB y no se puede descargar desde aquí.'
  if (status === 422) return 'La versión tiene un enlace simbólico; por seguridad no se empaqueta.'
  return serverText ? `No se pudo descargar: ${serverText}` : `No se pudo descargar (HTTP ${status}).`
}

/** filename de Content-Disposition (`attachment; filename="slug-sha7-codigo.zip"`), o el de respaldo. */
export function filenameOf(disposition: string | null, fallback: string): string {
  const m = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)
  if (!m) return fallback
  try { return decodeURIComponent(m[1]) } catch { return m[1] }
}

async function errorBody(res: Response): Promise<{ text?: string; code?: string }> {
  try {
    const body = (await res.json()) as { error?: unknown; code?: unknown }
    return { ...(typeof body.error === 'string' ? { text: body.error } : {}), ...(typeof body.code === 'string' ? { code: body.code } : {}) }
  } catch {
    return {}
  }
}

export interface DownloadDeps<F extends string> {
  fetch: (url: string) => Promise<Response>
  urlOf: (format: F) => string
  save: (blob: Blob, filename: string) => void
  set: (state: DownloadState<F>) => void
}

export function createExportDownload<F extends string>(deps: DownloadDeps<F>) {
  // Id de generación (A7): si se pide otra descarga mientras una viaja, la tardía no pisa el estado de la nueva.
  let seq = 0
  return {
    async start(format: F): Promise<void> {
      const id = ++seq
      deps.set({ kind: 'preparing', format })
      let next: DownloadState<F>
      try {
        const res = await deps.fetch(deps.urlOf(format))
        if (res.ok) {
          const filename = filenameOf(res.headers.get('content-disposition'), format)
          const blob = await res.blob()
          if (id !== seq) return
          deps.save(blob, filename)
          next = { kind: 'ready', format, filename }
        } else {
          const body = await errorBody(res)
          next = { kind: 'error', format, message: downloadError(res.status, body.text, format, body.code) }
        }
      } catch {
        next = { kind: 'error', format, message: 'No se pudo conectar con el servidor para descargar.' }
      }
      if (id === seq) deps.set(next)
    },
  }
}

/** Guarda el blob con el nombre que dio el server; el object URL se suelta en cuanto el navegador tomó la descarga. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** Por qué "Publicar en este servidor" está apagado, sin pedir el gate: GET /publishable lanza el vite build la primera
 * vez (#694), así que abrir el menú no lo pide; el POST pasa por el mismo gate y su 409 dice el motivo. `site` en false
 * es una versión que no es la del ws (P3, #688): publicarla daría 409 not-at-commit. null si se puede intentar. */
export function publishBlockedBy(formats: { state: 'loading' } | { state: 'error' } | { state: 'ready'; formats: Partial<Record<string, boolean>> }): string | null {
  if (formats.state === 'loading') return 'Cargando…'
  if (formats.state === 'error') return 'No disponible'
  return formats.formats.site === false ? NOT_AT_COMMIT_PUBLISH.replace(/\.$/, '') : null
}
