import { expect, test } from 'bun:test'
import { dsStatus } from '../apps/builder/src/lib/chat-ds'
import { chatBase } from '../apps/builder/src/lib/chat-routes'
import { createChatStarter } from '../apps/builder/src/lib/chat-start'
import { createMediaUrls, MEDIA_BATCH, RENEW_BEFORE_MS, type Signed } from '../apps/builder/src/lib/media-urls'
import { fetchExportFormats, StatusError } from '../apps/builder/src/lib/run-client'

const tick = () => new Promise((r) => setTimeout(r, 0))

// Spec §3.1/§3.4: el chat reservado sirve a las rutas del dueño y lo consume la primera corrida. Una reserva perdida (el
// Runtime local la guarda en memoria) da 404 en esa corrida: se crea otro chat una vez; un segundo 404 ya es un error.
test('la primera corrida usa el chat reservado y reintenta un 404 una sola vez con un chat nuevo', async () => {
  let n = 0
  const starter = createChatStarter(async () => `chat-${++n}`)
  expect(await starter.peek()).toBe('chat-1')
  expect(await starter.peek()).toBe('chat-1')
  const tried: string[] = []
  const id = await starter.first(async (chat) => {
    tried.push(chat)
    if (chat === 'chat-1') throw new StatusError(404, 'no hay chat')
    return chat
  })
  expect([id, tried]).toEqual(['chat-2', ['chat-1', 'chat-2']])
  const twice = await starter.first(async () => { throw new StatusError(404, 'no hay chat') }).catch((e: unknown) => e)
  expect((twice as StatusError).status).toBe(404)
  expect(n).toBe(4)
  const other = await starter.first(async () => { throw new StatusError(409, 'ocupado') }).catch((e: unknown) => e)
  expect([(other as StatusError).status, n]).toEqual([409, 5])
})

// Arq (#858, MEDIUM): la reserva se anota en cuanto existe y, al recargar con ese ?chat= sin corridas, la primera corrida usa
// ese mismo id: detrás del orquestador cada POST /chats deja un chat en el índice del dueño.
test('la reserva se anota al crearla y un chat adoptado de la URL es el que usa la primera corrida, sin otro POST /chats', async () => {
  let created = 0
  const noted: string[] = []
  const first = createChatStarter(async () => `chat-${++created}`, (id) => noted.push(id))
  await first.peek()
  await first.peek()
  expect([created, noted]).toEqual([1, ['chat-1']])
  const reloaded = createChatStarter(async () => `chat-${++created}`, (id) => noted.push(id))
  reloaded.adopt('chat-1')
  expect(await reloaded.peek()).toBe('chat-1')
  expect(await reloaded.first(async (chat) => chat)).toBe('chat-1')
  expect([created, noted]).toEqual([1, ['chat-1']])
})

// Arq (#860, LOW): un ?chat= adoptado que no sirve (reserva perdida, de otro dueño, mal escrito) se descarta en el primer 404;
// dos llamadas concurrentes que lo ven fallar comparten la reserva nueva, y un 404 de un chat que no era adoptado no se reintenta.
test('un chat adoptado con 404 se descarta una vez y las llamadas concurrentes comparten la reserva nueva', async () => {
  let created = 0
  const noted: string[] = []
  const starter = createChatStarter(async () => `chat-${++created}`, (id) => noted.push(id))
  starter.adopt('ajeno')
  expect(await starter.peek()).toBe('ajeno')
  expect([starter.discard('ajeno'), starter.discard('ajeno')]).toEqual([true, true])
  const [a, b] = await Promise.all([starter.peek(), starter.peek()])
  expect([a, b, created, noted]).toEqual(['chat-1', 'chat-1', 1, ['chat-1']])
  expect(starter.discard('chat-1')).toBe(false)
  // Un adoptado que ya respondió bien es del dueño: un 404 posterior (una ruta que ese servidor no tiene) no lo descarta.
  starter.adopt('mio')
  starter.vouch('mio')
  expect([starter.discard('mio'), await starter.peek()]).toEqual([false, 'mio'])
})

// Spec §4: hasta 50 rutas por pedido, URL relativa a la base del chat, y renovación antes de expiresAt. Un valor del server
// que no empieza por la ruta pedida no llega a un src.
test('media-urls pide en lotes de 50, compone la URL relativa, descarta una ajena y renueva antes de vencer', async () => {
  let clock = 1_000_000
  const timers: { fn: () => void; at: number }[] = []
  const batches: string[][] = []
  const base = chatBase('/api', 'c')
  const media = createMediaUrls({
    base,
    now: () => clock,
    setTimer: (fn, ms) => { timers.push({ fn, at: clock + ms }); return timers.length },
    clearTimer: () => undefined,
    onChange: () => undefined,
    sign: async (paths): Promise<Signed> => {
      batches.push(paths)
      return { urls: Object.fromEntries(paths.map((p) => [p, p === 'canvas/files/x.png' ? '//evil.test/x.png' : `${p}?wt_media=t${batches.length}`])), expiresAt: clock + 300_000 }
    },
  })
  const paths = [...Array.from({ length: MEDIA_BATCH + 1 }, (_, i) => `runs/m/shots/${i}.png`), 'canvas/files/x.png']
  expect(paths.map((p) => media.url(p)).every((u) => u === undefined)).toBe(true)
  await tick()
  expect(batches.map((b) => b.length)).toEqual([MEDIA_BATCH, 2])
  expect(media.url('runs/m/shots/0.png')).toBe('/api/chats/c/runs/m/shots/0.png?wt_media=t1')
  expect(media.url('canvas/files/x.png')).toBe('/api/chats/c/canvas/files/x.png')
  expect(timers.map((t) => t.at - clock)).toEqual([300_000 - RENEW_BEFORE_MS, 300_000 - RENEW_BEFORE_MS])
  clock = timers[0]!.at
  timers[0]!.fn()
  await tick()
  expect(batches.length).toBe(3)
  expect(media.url('runs/m/shots/0.png')).toBe('/api/chats/c/runs/m/shots/0.png?wt_media=t3')
})

// #852: con el DS del chat distinto del que publica el perfil, Actualizar DS respondería 409: no se ofrece.
test('Actualizar DS se bloquea (sin opción en el menú) si el skill del chat no es el del registry', () => {
  expect(dsStatus({ pin: 'aaaaaaaa1', latest: 'bbbbbbbb2', skill: 'arc', latestSkill: 'base' })).toEqual({ pin: 'aaaaaaaa', update: null, blocked: true })
  expect(dsStatus({ pin: 'aaaaaaaa1', latest: 'bbbbbbbb2', skill: 'base', latestSkill: 'base' })?.update).toBe('bbbbbbbb')
  expect(dsStatus({ pin: 'aaaaaaaa1', latest: 'bbbbbbbb2', latestSkill: 'base' })?.update).toBe('bbbbbbbb')
})

// Spec §1.2: el orquestador responde 404/405 de su allowlist solo con `code`; la persona lee el motivo, no el JSON.
test('un 404 o 405 de la allowlist sale con texto, no con el JSON', async () => {
  const real = globalThis.fetch
  try {
    globalThis.fetch = (async () => Response.json({ code: 'not-found' }, { status: 404 })) as unknown as typeof fetch
    await expect(fetchExportFormats(chatBase('/api', 'c'), 'm')).rejects.toThrow('Este servidor no tiene esa ruta o ese chat.')
    globalThis.fetch = (async () => Response.json({ code: 'method-not-allowed' }, { status: 405 })) as unknown as typeof fetch
    await expect(fetchExportFormats(chatBase('/api', 'c'), 'm')).rejects.toThrow('Este servidor no acepta esa operación.')
  } finally {
    globalThis.fetch = real
  }
})
