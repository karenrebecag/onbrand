// El chat antes de su primera corrida (docs/spec/orquestador-enrutamiento.md §3.1 y §3.4): POST /chats da el id, que es también
// el messageId de la primera corrida. El mismo chat sirve antes para marcas, conectores, adjuntos y voz.
import { useCallback, useMemo, useRef, useState } from 'react'
import { chatBase, type ChatBase } from './chat-routes'
import { connectApp, createChat, disconnectAccount, fetchConnectorAccounts, fetchConnectorApps, StatusError, transcribe, uploadFile } from './run-client'
import type { Connectors } from './use-builder'
import { chatFromUrl, withChat } from './thread'

/** Corre `call` con la base de las rutas del dueño: la del chat vigente, o la de la reserva antes de la primera corrida. */
export type OwnerCall = <T>(call: (base: ChatBase) => Promise<T>) => Promise<T>

export interface ChatStarter {
  /** El chat reservado para las rutas del dueño antes de la primera corrida; lo crea si no hay uno. No lo consume. */
  peek: () => Promise<string>
  /** El chat de la URL sin corridas (lo reservó una carga anterior): es la reserva que usará la primera corrida. */
  adopt: (chatId: string) => void
  /** Un chat adoptado que respondió 404 (reserva perdida, de otro dueño, id mal escrito): deja de ser la reserva y el próximo
   * peek() pide otra. true si `chatId` fue adoptado, aunque otra llamada concurrente ya lo haya descartado. */
  discard: (chatId: string) => boolean
  /** El chat adoptado ya respondió bien: es del dueño, y un 404 posterior es de la ruta (p. ej. un servidor sin esa función), no del chat. */
  vouch: (chatId: string) => void
  /** Consume el reservado (o crea uno) y corre `run(chatId)`. Un 404 es una reserva perdida (el Runtime local las guarda en
   * memoria, chat-reservations.ts): se reintenta una sola vez con un chat nuevo. Otro error, o un segundo 404, se propaga. */
  first: <T>(run: (chatId: string) => Promise<T>) => Promise<T>
}

/** `onReserved`: la reserva de peek() ya existe en el índice del dueño; quien la recibe la anota (la URL) para no pedir otra. */
export function createChatStarter(create: () => Promise<string>, onReserved?: (chatId: string) => void): ChatStarter {
  let reserved: Promise<string> | undefined
  let adopted: string | undefined
  let dropped = new Set<string>()
  const peek = () => {
    reserved ??= create().then((id) => {
      onReserved?.(id)
      return id
    }, (e: unknown) => {
      reserved = undefined
      throw e
    })
    return reserved
  }
  return {
    peek,
    adopt: (chatId) => {
      adopted = chatId
      reserved = Promise.resolve(chatId)
    },
    discard: (chatId) => {
      if (adopted === chatId) {
        adopted = undefined
        reserved = undefined
        dropped = new Set(dropped).add(chatId)
      }
      return dropped.has(chatId)
    },
    vouch: (chatId) => {
      if (adopted === chatId) adopted = undefined
    },
    first: async (run) => {
      const pending = reserved ?? create()
      reserved = undefined
      adopted = undefined
      try {
        return await run(await pending)
      } catch (e) {
        if (!(e instanceof StatusError && e.status === 404)) throw e
        return run(await create())
      }
    },
  }
}

/** El chat vigente del builder: el de la URL al recargar, el de la primera corrida después. `baseOf` lee el ref al llamar, así
 * un callback creado antes de la primera corrida ya usa su chat. La reserva va a ?chat= en cuanto existe: detrás del
 * orquestador POST /chats persiste, y una recarga que pidiera otra dejaría un chat vacío más en la lista del dueño (tope 100). */
export function useChatBase(api: string) {
  const ref = useRef(chatFromUrl(window.location.search) ?? undefined)
  const [chatId, setChatId] = useState(ref.current)
  const starter = useMemo(() => createChatStarter(() => createChat(api), (id) => window.history.replaceState(null, '', withChat(window.location.href, id))), [api])
  const baseOf = useCallback(() => chatBase(api, ref.current ?? ''), [api])
  // Las rutas del dueño esperan a saber si el ?chat= tiene corridas: marcas y conectores se piden al montar, en paralelo con el
  // hilo, y sin esperar irían a un chat que quizá no es de este dueño y nadie las repetiría.
  const verdict = useMemo(() => {
    let done = () => {}
    const p = new Promise<void>((resolve) => { done = resolve })
    if (!ref.current) done()
    return { p, done }
  }, [])
  // Las rutas del dueño antes de la primera corrida van por la reserva. Si era un ?chat= adoptado que no sirve, un 404 la
  // descarta, se reserva otro (con su replaceState) y la llamada se repite una vez, como first() con su corrida.
  const ownerBase: OwnerCall = useCallback(async <T,>(call: (base: ChatBase) => Promise<T>): Promise<T> => {
    await verdict.p
    if (ref.current) return call(chatBase(api, ref.current))
    const chat = await starter.peek()
    try {
      const out = await call(chatBase(api, chat))
      starter.vouch(chat)
      return out
    } catch (e) {
      if ((e as { status?: unknown }).status !== 404 || !starter.discard(chat)) throw e
      return call(chatBase(api, await starter.peek()))
    }
  }, [api, starter, verdict])
  /** Primera corrida con el chat reservado; si entra, ese chat pasa a ser el vigente y la URL lo recuerda. */
  const startFirst = useCallback((start: (base: ChatBase, chat: string) => Promise<string>) => starter.first(async (chat) => {
    const id = await start(chatBase(api, chat), chat)
    ref.current = chat
    setChatId(chat)
    window.history.replaceState(null, '', withChat(window.location.href, chat))
    return id
  }), [api, starter])
  /** Al recargar, el veredicto del hilo sobre el ?chat= (use-builder): sin corridas (GET da 404 o sin mensajes) no es el vigente
   * sino la reserva. Devuelve `hasRuns` para que el llamador siga o corte. */
  const settle = useCallback((id: string, hasRuns: boolean) => {
    if (ref.current === id && !hasRuns) {
      ref.current = undefined
      setChatId(undefined)
      starter.adopt(id)
    }
    verdict.done()
    return hasRuns
  }, [starter, verdict])
  return { chatId, baseOf, ownerBase, startFirst, settle }
}

/** Adjuntos y voz cuelgan del chat y antes de la primera corrida van por la reserva (spec §3.4). Los conectores son del dueño
 * en la raíz (#880): no pasan por ownerBase, así que no esperan el veredicto del hilo ni crean una reserva. */
export function useOwnerCalls(api: string, ownerBase: OwnerCall) {
  const upload = useCallback((file: File, onProgress: (p: number) => void, signal: AbortSignal) => ownerBase((b) => uploadFile(b, file, onProgress, signal)), [ownerBase])
  const transcribeAudio = useCallback((audio: Blob) => ownerBase((b) => transcribe(b, audio)), [ownerBase])
  const connectors = useMemo<Connectors>(() => ({
    apps: (q, after) => fetchConnectorApps(api, q, after).then(({ apps, next }) => ({ apps, next })),
    accounts: () => fetchConnectorAccounts(api).then((r) => r.accounts),
    connect: (app) => connectApp(api, app).then((r) => r.url),
    disconnect: (id) => disconnectAccount(api, id).then(() => undefined),
  }), [api])
  return { upload, transcribeAudio, connectors }
}
