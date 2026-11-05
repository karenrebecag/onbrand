import type { EngineEvent } from '@engine/runtime/event-model'
import type { ThinkingEffort } from './run-client'

/** El mensaje del que cuelga el próximo turno: el último con versión, no el último turno. Uno que falló (409 al
 * arrancar, tsc que rechaza el cambio, corrida en vuelo) no tiene commit, y colgar de él hacía que el transport
 * rechazara todo lo que viniera después con 404/409 hasta recargar. Solo el snapshot trae commit. */
export const parentAfter = (current: string | undefined, messageId: string, event: EngineEvent): string | undefined =>
  event.type === 'snapshot' ? messageId : current

const CHAT_PARAM = 'chat'

/** El chat de la URL (?chat=<mensaje raíz>): con él, recargar vuelve al mismo hilo en vez de a una página nueva. */
export const chatFromUrl = (search: string): string | null => new URLSearchParams(search).get(CHAT_PARAM)

export function withChat(href: string, chatId: string): string {
  const url = new URL(href)
  url.searchParams.set(CHAT_PARAM, chatId)
  return url.toString()
}

const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'] satisfies ThinkingEffort[]

/** El thinking que guardó un mensaje del hilo (GET /chats, #748). Un valor desconocido se descarta: viene del server y
 * acabaría en el chip del composer. */
export function threadThinking(raw: unknown): { effort: ThinkingEffort } | undefined {
  const effort = (raw as { effort?: unknown } | null | undefined)?.effort
  return typeof effort === 'string' && EFFORTS.includes(effort) ? { effort: effort as ThinkingEffort } : undefined
}

/** El esfuerzo que muestra el composer: lo elegido; si no, el del turno que Continuar retoma (el transport hereda ese,
 * así que el chip dice lo que va a correr); si no, el default del modelo. El heredado no es una elección: Continuar
 * sigue mandando solo `chosen` (continueRequest). */
export function shownEffort(chosen: ThinkingEffort | undefined, resumed: { effort: ThinkingEffort } | undefined, fallback: ThinkingEffort): ThinkingEffort {
  return chosen ?? resumed?.effort ?? fallback
}

/** El modelo que muestra el composer, con la misma regla: lo elegido; si no, el del turno que Continuar retoma, si el
 * transport todavía lo anuncia; si no, el primero de la lista. */
export function shownModel(chosen: string | undefined, resumed: string | undefined, available: readonly { id: string }[]): string {
  return chosen ?? (resumed && available.some((m) => m.id === resumed) ? resumed : available[0].id)
}
