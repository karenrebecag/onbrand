import { afterEach, expect, test } from 'bun:test'
import { sessionProblem } from '../apps/builder/src/lib/session'
import { fetchExportFormats, streamRun } from '../apps/builder/src/lib/run-client'
import { chatBase } from '../apps/builder/src/lib/chat-routes'

// streamRun pide window; se restaura como en builder-stream-settled.test.ts para no contaminar los tests que siguen.
const realWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  if (realWindow) Object.defineProperty(globalThis, 'window', realWindow)
  else delete (globalThis as { window?: unknown }).window
})

// identidad-sesion.md §7: solo los rechazos con code son de sesión; el 403 de origen sigue siendo otro error.
test('401 no-session/expired y 403 scope dan su copy; un 403 sin code no es de sesión', () => {
  expect(sessionProblem(401, { error: 'inicia sesión', code: 'no-session' })).toMatchObject({ code: 'no-session', message: expect.stringContaining('Inicia sesión') })
  expect(sessionProblem(401, { error: 'la sesión venció', code: 'expired' })).toMatchObject({ code: 'expired', message: expect.stringContaining('venció') })
  expect(sessionProblem(403, { error: 'tu cuenta no puede generar imágenes', code: 'scope' })?.message).toBe('tu cuenta no puede generar imágenes')
  expect(sessionProblem(403, { error: 'origen no permitido' })).toBeNull()
  expect(sessionProblem(401, { code: 'scope' })).toBeNull()
})

test('una ruta de run-client muestra el copy de sesión, no el JSON', async () => {
  globalThis.fetch = (async () => Response.json({ error: 'la sesión venció', code: 'expired' }, { status: 401 })) as unknown as typeof fetch
  await expect(fetchExportFormats(chatBase('/api', 'c'), 'm1')).rejects.toThrow('Tu sesión venció')
})

// Sin reintentos ciegos: un 401 en el stream corta en el primer intento con el copy, sin backoff.
test('el stream de la corrida no reintenta un 401', async () => {
  ;(globalThis as { window?: unknown }).window ??= globalThis
  let calls = 0
  globalThis.fetch = (async () => { calls++; return Response.json({ error: 'inicia sesión', code: 'no-session' }, { status: 401 }) }) as unknown as typeof fetch
  const waits: number[] = []
  await expect(streamRun(chatBase('/api', 'c'), 'm1', () => {}, new AbortController().signal, { wait: async (ms) => { waits.push(ms) } })).rejects.toThrow('Inicia sesión')
  expect(calls).toBe(1)
  expect(waits).toEqual([])
})
