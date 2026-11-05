import { useMemo } from 'react'
import { putCanvas, type CanvasDoc, type CanvasPut } from './run-client'
import { chatBase } from './chat-routes'

// A9 (docs/estandares.md): el único que hace PUT del lienzo. Antes las imágenes (use-canvas-nodes) y las estrellas
// (use-favorites) mandaban cada una su PUT con el rev que habían leído; en vuelo a la vez, el segundo chocaba con el rev
// que había subido el primero de la misma pestaña y se leía como un 409 de otra pestaña.

export type CanvasPatch = Omit<CanvasPut, 'rev'>
export type PutResult = { saved: CanvasDoc } | { conflict: CanvasDoc }

export interface CanvasWriter {
  /** Guarda el parche con el rev que leyó quien llama; los PUT salen de a uno, en orden de llegada. */
  write: (rev: number, patch: CanvasPatch) => Promise<PutResult>
}

/** Cuántos saltos de rev propios se recuerdan; un parche en cola nunca va más atrás que unos pocos guardados. */
const OWN_HISTORY = 64

export function createCanvasWriter(deps: { put: (doc: CanvasPut) => Promise<PutResult> }): CanvasWriter {
  let tail: Promise<unknown> = Promise.resolve()
  // rev reemplazado por un guardado propio → rev que dejó. Solo los propios: un rev que subió otra pestaña tiene que
  // seguir llegando como 409 a quien no lo vio, o se pisaría lo que escribió.
  const own = new Map<number, number>()

  const current = (rev: number) => {
    let r = rev
    while (own.has(r)) r = own.get(r) as number
    return r
  }

  const run = async (rev: number, patch: CanvasPatch): Promise<PutResult> => {
    const sent = current(rev)
    const result = await deps.put({ ...patch, rev: sent })
    if ('saved' in result) {
      own.set(sent, result.saved.rev)
      if (own.size > OWN_HISTORY) own.delete(own.keys().next().value as number)
    }
    return result
  }

  return {
    write(rev, patch) {
      const next = tail.then(() => run(rev, patch))
      tail = next.catch(() => undefined)
      return next
    },
  }
}

/** Un escritor por chat: el de otro chat mandaría sus revs al lienzo equivocado. Sin transport o sin chat no hay dónde. */
export function useCanvasWriter(api: string | undefined, chatId: string | undefined): CanvasWriter | null {
  return useMemo(() => (api && chatId ? createCanvasWriter({ put: (doc) => putCanvas(chatBase(api, chatId), doc) }) : null), [api, chatId])
}
