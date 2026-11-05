import { useCallback, useEffect, useState } from 'react'
import { applyEvent, emptyMessage, type EngineEvent, type MessageState } from '@engine/runtime/event-model'
import { replayDelays } from './replay-delays'

export interface Replay {
  state: MessageState
  /** seq del último evento aplicado: es el cursor con el que un resume real seguiría. */
  cursor: number
  /** Tiempo de la corrida según los `at` del log, no según el reloj del navegador. */
  elapsedMs: number
  restart: () => void
}

/** Reproduce un log como si llegara por el stream. Usa el mismo applyEvent que leería un resume, así
 * lo que se ve aquí es lo que pintaría el builder conectado al motor. */
export function useReplay(events: EngineEvent[], speed = 1): Replay {
  const [state, setState] = useState<MessageState>(emptyMessage)
  const [cursor, setCursor] = useState(-1)
  const [elapsedMs, setElapsed] = useState(0)
  const [run, setRun] = useState(0)

  useEffect(() => {
    const delays = replayDelays(events, speed)
    const start = events[0]?.at ?? 0
    let elapsed = 0
    setState(emptyMessage())
    setCursor(-1)
    setElapsed(0)
    const timers = events.map((event, i) => {
      elapsed += delays[i]
      return window.setTimeout(() => {
        setState((s) => applyEvent(s, event))
        setCursor(event.seq)
        setElapsed(event.at - start)
      }, elapsed)
    })
    return () => timers.forEach((t) => window.clearTimeout(t))
  }, [events, speed, run])

  const restart = useCallback(() => setRun((r) => r + 1), [])
  return { state, cursor, elapsedMs, restart }
}
