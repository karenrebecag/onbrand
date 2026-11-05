import type { EngineEvent } from '@engine/runtime/event-model'

/** Espera antes de cada evento, escalada. El primero sale de inmediato; los demás respetan el hueco
 * de `at` entre eventos para que el ritmo se parezca al de una corrida real. */
export function replayDelays(events: EngineEvent[], speed: number): number[] {
  return events.map((e, i) => (i === 0 ? 0 : Math.max(0, (e.at - events[i - 1].at) / speed)))
}
