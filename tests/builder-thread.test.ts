import { expect, test } from 'bun:test'
import type { EngineEvent } from '../src/runtime/event-model'
import { chatFromUrl, parentAfter, withChat } from '../apps/builder/src/lib/thread'

const run = (parent: string | undefined, id: string, events: EngineEvent[]) => events.reduce((p, e) => parentAfter(p, id, e), parent)

// Revisión de ec 2026-10-29: un Editar texto que no encontraba el texto (o que tsc rechazaba) quedaba como último turno
// y todo envío posterior daba 404/409 hasta recargar.
test('una edición que falla no cambia el padre: el siguiente envío cuelga de la última versión buena', () => {
  const ok = run(undefined, 'm1', [{ type: 'message.start', at: 1 }, { type: 'message.end', finishReason: 'stop', at: 2 }, { type: 'snapshot', dir: '/w', files: [], commit: 'c1', at: 3 }] as EngineEvent[])
  expect(ok).toBe('m1')
  const rejected = run(ok, 't1', [{ type: 'message.start', at: 4 }, { type: 'error', message: 'el cambio rompe 01-hero.tsx', at: 5 }, { type: 'message.end', finishReason: 'error', at: 6 }] as EngineEvent[])
  expect(rejected).toBe('m1')
})

// Un 409 al arrancar (corrida en vuelo, texto ausente) no llega a emitir eventos: el padre queda igual.
test('un turno sin eventos tampoco mueve el padre', () => {
  expect(run('m1', 't2', [])).toBe('m1')
})

// QA en vivo, paso 11: recargar perdía el hilo entero. El chat vive en la URL y sobrevive al reload.
test('el chat queda en la URL sin pisar otros parámetros y se vuelve a leer al recargar', () => {
  const href = withChat('http://localhost:5352/?debug=1', 'm-root')
  expect(chatFromUrl(new URL(href).search)).toBe('m-root')
  expect(new URL(href).searchParams.get('debug')).toBe('1')
  expect(chatFromUrl('')).toBeNull()
})
