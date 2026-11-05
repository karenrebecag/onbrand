import { useCallback, useRef, useState } from 'react'
import type { CanvasDoc } from './run-client'
import type { CanvasWriter, PutResult } from './canvas-writer'

// Favorito del rail (H14, isFavourite de Stitch: `stitch:tool-fav`). La estrella va en cada variante y se guarda en el
// doc del lienzo con el mismo rev que las imágenes; el botón del rail deja a la vista solo las favoritas.

/** La lista con el id agregado o quitado, sin repetidos. */
export function toggleFavorite(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
}

/** ¿Se pinta el marco? Los de la página vigente siempre; una variante, solo con estrella si el filtro está puesto. */
export function frameVisible(frame: { id: string; variant?: unknown }, favorites: readonly string[], onlyFavorites: boolean): boolean {
  return !onlyFavorites || !frame.variant || favorites.includes(frame.id)
}

export interface Favorites {
  ids: readonly string[]
  only: boolean
  setOnly: (on: boolean) => void
  toggle: (id: string) => void
  error: string | null
}

const SAVE_FAILED = 'No se pudo guardar la estrella. Intenta de nuevo.'
const CONFLICT_RETRIES = 3

/** Guarda las estrellas de a un PUT por vez. Cada estrella se pinta al instante y queda en cola como "alternar este id";
 * al responder el server, lo que siga en cola se vuelve a aplicar sobre lo guardado. Un 409 (otra pestaña o el autosave
 * de las imágenes subió el rev) reaplica la cola sobre el doc actual y reintenta. Antes, dos estrellas seguidas con
 * latencia mandaban el mismo rev y la segunda se perdía sin aviso (QA Q3 sobre H14). */
export function createFavoriteSync(deps: { read: () => CanvasDoc | undefined; write: (doc: CanvasDoc) => void; put: (rev: number, favorites: string[]) => Promise<PutResult>; fail: () => void }) {
  let pending: string[] = []
  let inflight = false
  let server: string[] = []
  const apply = (base: readonly string[], ops: readonly string[]) => ops.reduce<string[]>((list, id) => toggleFavorite(list, id), [...base])

  const flush = async (retries: number): Promise<void> => {
    const doc = deps.read()
    if (inflight || !pending.length || !doc) return
    inflight = true
    const sent = pending.length
    let result: PutResult
    try {
      result = await deps.put(doc.rev, doc.favorites ?? [])
    } catch {
      pending = []
      inflight = false
      const now = deps.read()
      if (now) deps.write({ ...now, favorites: server })
      deps.fail()
      return
    }
    inflight = false
    if ('conflict' in result) {
      server = result.conflict.favorites ?? []
      if (retries >= CONFLICT_RETRIES) {
        pending = []
        deps.write(result.conflict)
        deps.fail()
        return
      }
      deps.write({ ...result.conflict, favorites: apply(server, pending) })
      return flush(retries + 1)
    }
    server = result.saved.favorites ?? []
    pending = pending.slice(sent)
    const now = deps.read() ?? doc
    deps.write({ ...now, rev: result.saved.rev, favorites: apply(server, pending) })
    return flush(0)
  }

  return {
    toggle(id: string, persist: boolean) {
      const doc = deps.read()
      if (!doc) return
      if (!pending.length && !inflight) server = doc.favorites ?? []
      // Misma lista de nodos: useCanvasNodes solo toma el rev y no pisa un movimiento sin guardar.
      deps.write({ ...doc, favorites: toggleFavorite(doc.favorites ?? [], id) })
      if (!persist) return
      pending = [...pending, id]
      void flush(0)
    },
  }
}

export function useFavorites(chatId: string | undefined, canvas: CanvasDoc | undefined, setCanvas: ((doc: CanvasDoc) => void) | undefined, writer: CanvasWriter | null): Favorites {
  const [only, setOnly] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef(canvas)
  latest.current = canvas
  const ids = canvas?.favorites ?? []
  const target = useRef({ writer, setCanvas })
  target.current = { writer, setCanvas }
  const sync = useRef<ReturnType<typeof createFavoriteSync> | null>(null)
  // Una cola por chat: la de otro chat mandaría su rev al lienzo equivocado.
  const syncChat = useRef<string | undefined>(undefined)
  if (!sync.current || syncChat.current !== chatId) {
    syncChat.current = chatId
    sync.current = createFavoriteSync({
      read: () => latest.current,
      // Se actualiza la referencia ya: la próxima estrella del mismo tick parte de esta, no del render anterior.
      write: (doc) => { latest.current = doc; target.current.setCanvas?.(doc) },
      put: (rev, favorites) => target.current.writer?.write(rev, { favorites }) ?? Promise.reject(new Error('sin chat')),
      fail: () => setError(SAVE_FAILED),
    })
  }

  const toggle = useCallback((id: string) => {
    if (!target.current.setCanvas) return
    setError(null)
    sync.current?.toggle(id, Boolean(target.current.writer))
  }, [])

  return { ids, only: only && ids.length > 0, setOnly, toggle, error }
}
