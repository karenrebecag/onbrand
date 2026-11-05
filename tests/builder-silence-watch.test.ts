import { expect, test } from 'bun:test'
import { createSilenceWatch } from '../apps/builder/src/lib/silence-watch'

// QA a629b7c, variante 0158db20: un módulo pendiente retiene load; la espera se arma al montar, no en onLoad.
test('el marco que no reporta avisa aunque no haya cargado, una vez por elemento y src', () => {
  const timers: (() => void)[] = []
  const silent: (string | undefined)[] = []
  const watch = createSilenceWatch<object>(2500, (chat) => silent.push(chat), (fn) => { timers.push(fn) })
  const variant = {}
  const source = {}
  watch.mount(variant, 'http://p/v', 'v1', 'v1')
  watch.mount(variant, 'http://p/v', 'v1', 'v1')
  watch.mount(source, 'http://p/s', 'desktop', 'chat')
  watch.report('desktop')
  timers.forEach((fn) => fn())
  expect([timers.length, silent]).toEqual([2, ['v1']])
  watch.mount(variant, 'http://p/v2', 'v1', 'v1')
  expect(timers.length).toBe(3)
})

// QA 003305cf: #root quedó vacío tras un HMR fallido y el marco había reportado (0 secciones); al cerrar la corrida se
// remonta una vez el que está en blanco, y solo en el settled nuevo (no en una corrida que aparece ya cerrada).
test('al cerrar, un marco con root vacío o sin reporte cuenta como en blanco, y settled se detecta una vez', async () => {
  const { settledNow } = await import('../apps/builder/src/lib/silence-watch')
  const watch = createSilenceWatch<object>(2500, () => {}, () => {})
  watch.mount({}, 'http://p/a', 'a', 'a')
  watch.mount({}, 'http://p/b', 'b', 'b')
  watch.mount({}, 'http://p/c', 'c', 'c')
  watch.mount({}, 'http://p/d', 'd', 'd')
  watch.report('a', 0)
  watch.report('b', 10)
  watch.report('d')
  expect(['a', 'b', 'c', 'd'].map((id) => watch.blank(id))).toEqual([true, false, true, false])
  const before = new Map([['v1', false], ['v2', true]])
  const after = new Map([['v1', true], ['v2', true], ['v3', true]])
  expect([settledNow(before, after), settledNow(after, after)]).toEqual([['v1'], []])
})

// QA caso 5, 38f87e66: el index de vite cargó con #root vacío y el puente reportó 0 secciones; contaba como "habló".
test('un reporte con root vacío cuenta como silencio salvo a mitad de una corrida', () => {
  const timers: (() => void)[] = []
  const silent: (string | undefined)[] = []
  const busy = new Set(['gen'])
  const watch = createSilenceWatch<object>(2500, (chat) => silent.push(chat), (fn) => { timers.push(fn) }, (id) => busy.has(id))
  for (const id of ['empty', 'gen', 'full']) watch.mount({}, `http://p/${id}`, id, id)
  watch.report('empty', 0)
  watch.report('gen', 0)
  watch.report('full', 7)
  timers.forEach((fn) => fn())
  expect(silent).toEqual(['empty'])
})
