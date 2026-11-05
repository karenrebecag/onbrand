import { expect, test } from 'bun:test'
import { doneMessage, shouldNotify } from '../apps/builder/src/lib/use-done-notification'

// Los componentes importan CSS modules: se cargan dentro de cada test para que un fallo de carga no tape a los demás.
const chat = () => import('../apps/builder/src/components/builder/chat-panel')
const agent = () => import('../apps/builder/src/components/builder/agent-panel')
const canvas = () => import('../apps/builder/src/components/builder/artboard-canvas')

// Vx de Stitch: el tip siguiente nunca repite el que se está viendo.
test('el tip siguiente es al azar y distinto del actual', async () => {
  const { nextTip } = await chat()
  const tips = ['a', 'b', 'c']
  expect(nextTip(tips, 'a', () => 0)).toBe('b')
  expect(nextTip(tips, 'a', () => .99)).toBe('c')
  expect(nextTip(['solo'], 'solo')).toBe('solo')
})

// eV de Stitch: dos puntos quietos los primeros 550 ms del turno.
test('la pastilla pasa a tres puntos a los 550 ms', async () => {
  const { dotsStage } = await agent()
  expect(dotsStage(0)).toBe('two-dots')
  expect(dotsStage(549)).toBe('two-dots')
  expect(dotsStage(550)).toBe('three-dots')
})

// v0: rueda hacia arriba, toque o teclas de subir pausan; volver a 50 px del fondo reanuda.
test('el auto-follow se pausa con gestos de subir y se reanuda cerca del fondo', async () => {
  const { pausesFollow, nearBottom } = await agent()
  expect(pausesFollow({ type: 'wheel', deltaY: -10 })).toBe(true)
  expect(pausesFollow({ type: 'wheel', deltaY: 10 })).toBe(false)
  expect(pausesFollow({ type: 'touchstart' })).toBe(true)
  expect(pausesFollow({ type: 'keydown', code: 'PageUp' })).toBe(true)
  expect(pausesFollow({ type: 'keydown', code: 'ArrowDown' })).toBe(false)
  expect(nearBottom({ scrollTop: 450, scrollHeight: 1000, clientHeight: 500 })).toBe(true)
  expect(nearBottom({ scrollTop: 449, scrollHeight: 1000, clientHeight: 500 })).toBe(false)
})

// isScreenInView de Stitch: la página entera dentro del lienzo, con 20 px de margen; si no, el aviso ofrece "Ver".
test('el frame cuenta como a la vista solo si entra entero, con 20 px de margen', async () => {
  const { frameInView } = await canvas()
  const box = { width: 1000, height: 800 }
  expect(frameInView({ x: 0, w: 1000, h: 800 }, { zoom: 1, x: 0, y: 0 }, box)).toBe(true)
  expect(frameInView({ x: 0, w: 1000, h: 800 }, { zoom: 1, x: -20, y: 20 }, box)).toBe(true)
  expect(frameInView({ x: 0, w: 1000, h: 800 }, { zoom: 1, x: -21, y: 0 }, box)).toBe(false)
  expect(frameInView({ x: 0, w: 1280, h: 3000 }, { zoom: .5, x: 0, y: 0 }, box)).toBe(false)
})

// CX de Lovable: cada salto suma su incremento más hasta 2 al azar y se detiene en 75 %.
test('la barra de carga avanza a saltos y frena en 75 %', async () => {
  const { progressStep, PROGRESS_STEPS, PROGRESS_CAP } = await import('../apps/builder/src/components/builder/preview-progress')
  expect(progressStep(0, 15, () => 0)).toBe(15)
  expect(progressStep(74, 1, () => .5)).toBe(76)
  expect(progressStep(76, 1, () => .5)).toBe(76)
  const end = PROGRESS_STEPS.reduce((d, s) => progressStep(d, s.inc, () => 1), 0)
  expect(end).toBeGreaterThanOrEqual(PROGRESS_CAP)
  expect(end).toBeLessThan(PROGRESS_CAP + 4)
})

// showNotification de Lovable: solo con permiso y con la pestaña oculta.
test('la notificación de terminado solo sale con permiso y la pestaña oculta', () => {
  expect(shouldNotify('granted', true)).toBe(true)
  expect(shouldNotify('granted', false)).toBe(false)
  expect(shouldNotify('default', true)).toBe(false)
  expect(shouldNotify('denied', true)).toBe(false)
  expect(doneMessage(true, 'Nimbus').body).toBe('Tu página está lista.')
  expect(doneMessage(false, undefined)).toEqual({ title: 'Terminó de trabajar', body: 'Tus cambios están listos.' })
})

// Auto-pan de Stitch: el encuadre no pasa del 100 % y, con preventZoomIn, no acerca más que el zoom actual.
test('el encuadre automático no pasa del 100 % ni acerca después del primero', async () => {
  const { fitZoom, AUTO_FIT, easeCubicInOut } = await canvas()
  const avail = { w: 2000, h: 1600 }, small = { w: 500, h: 400 }
  expect(fitZoom(avail, small, .3, AUTO_FIT)).toBe(1)
  expect(fitZoom(avail, small, .3, { ...AUTO_FIT, preventZoomIn: true })).toBe(.3)
  expect(fitZoom(avail, { w: 4000, h: 3200 }, .9, { ...AUTO_FIT, preventZoomIn: true })).toBe(.5)
  expect(easeCubicInOut(0)).toBe(0)
  expect(easeCubicInOut(.5)).toBe(.5)
  expect(easeCubicInOut(1)).toBe(1)
})

// Lovable editor-body-shared :364-406: la fase activa es la más avanzada que arrancó; las de antes quedan hechas por índice.
test('las fases del turno salen por índice del último paso top-level y el reloj de la activa cuenta desde su primer paso', async () => {
  const { activePhase, flowOf, formatPhaseTime, phaseOffsetMs, PHASES, phaseState } = await import('../apps/builder/src/lib/turn-phases')
  expect(flowOf({ prompt: 'x' }, true)).toBe('t1')
  expect(flowOf({ prompt: 'x' }, false)).toBe('follow-up')
  expect(flowOf({ restoreFrom: 'm1' }, false)).toBe('restore')
  expect(flowOf({ textEdit: { before: 'a', after: 'b' } }, false)).toBe('patch')
  const s = (id: string, parentStepId?: string) => ({ id, kind: 'action' as const, label: id, status: 'running' as const, output: '', startedAt: 0, ...(parentStepId ? { parentStepId } : {}) })
  const t1 = PHASES.t1
  expect(activePhase(t1, [], false)).toBe(0)
  expect(activePhase(t1, [s('runner:prepare'), s('agent:write'), s('r1', 'agent:write'), s('desconocido')], false)).toBe(1)
  expect(activePhase(t1, [s('agent:write'), s('transport:build')], false)).toBe(3)
  expect([0, 1, 2].map((i) => phaseState(i, 1))).toEqual(['done', 'active', 'pending'])
  expect(phaseState(0, activePhase(t1, [s('agent:write')], true))).toBe('pending')
  expect(formatPhaseTime(42_900)).toBe('42s')
  expect(formatPhaseTime(185_000)).toBe('3m 05s')
  const at = (id: string, startedAt: number) => ({ ...s(id), startedAt })
  expect(phaseOffsetMs(t1[1]!, [at('runner:prepare', 1000), at('agent:write', 5000)])).toBe(4000)
  expect(phaseOffsetMs(t1[2]!, [at('runner:prepare', 1000)])).toBeUndefined()
})

// Tv de Stitch: la edición con IA de lo seleccionado tiene su par pendiente/hecho; el resto cae en la línea de estado.
test('solo la edición de la selección tiene texto propio de pendiente y hecho', async () => {
  const { turnLabel } = await import('../apps/builder/src/lib/turn-phases')
  expect(turnLabel({ prompt: 'x', selectedSections: ['hero'] })).toEqual({ pending: 'Actualizando la selección…', done: 'Selección actualizada' })
  expect(turnLabel({ prompt: 'x', selectedSections: [] })).toBeUndefined()
  expect(turnLabel({ prompt: 'x' })).toBeUndefined()
})
