import { expect, test } from 'bun:test'
import { createApiFetch, localSessionProvider, sessionMenuOf, sessionProvider, setSessionProvider, type SessionProvider } from '../apps/builder/src/lib/session-provider'
import type { SessionProblem } from '../apps/builder/src/lib/session'
import { chatBase } from '../apps/builder/src/lib/chat-routes'

function harness(provider: SessionProvider, reply: Response) {
  const sent: { url: string; auth: string | null; type: string | null }[] = []
  const fetcher = createApiFetch({
    fetch: (async (url: string, init?: RequestInit) => {
      const h = new Headers(init?.headers)
      sent.push({ url, auth: h.get('authorization'), type: h.get('content-type') })
      return reply
    }) as unknown as typeof fetch,
    provider: () => provider,
  })
  return { fetcher, sent }
}

// ADR 0017: el core no trae login; el provider por defecto no manda nada y el modo local sigue igual.
test('sin token no va Authorization; con token va Bearer sin perder las cabeceras del pedido', async () => {
  const local = harness(localSessionProvider, new Response('{}'))
  await local.fetcher('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' } })
  expect(local.sent).toEqual([{ url: '/api/runs', auth: null, type: 'application/json' }])
  const distro = harness({ ...localSessionProvider, getToken: async () => 'tok-1' }, new Response('{}'))
  await distro.fetcher('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' } })
  expect(distro.sent).toEqual([{ url: '/api/runs', auth: 'Bearer tok-1', type: 'application/json' }])
})

// #663: el rechazo de sesión le llega al provider (la distro abre su sign-in); un 403 sin code (origen) no es de sesión.
test('un 401 con code avisa al provider y el pedido sigue viendo el status; un 403 sin code no', async () => {
  const seen: SessionProblem[] = []
  const provider = { ...localSessionProvider, onRejected: (p: SessionProblem) => seen.push(p) }
  const expired = harness(provider, Response.json({ code: 'expired' }, { status: 401 }))
  expect((await expired.fetcher('/api/chats/c1')).status).toBe(401)
  const origin = harness(provider, Response.json({ error: 'origen no permitido' }, { status: 403 }))
  await origin.fetcher('/api/runs')
  expect(seen.map((p) => [p.status, p.code])).toEqual([[401, 'expired']])
})

// Captura del bloque: un 401 al mandar un pedido decía "No se pudo iniciar la corrida (401)"; ahora el copy de #663.
test('un rechazo de sesión al iniciar una corrida muestra el copy de sesión, no el status', async () => {
  const { startRun } = await import('../apps/builder/src/lib/run-client')
  const real = globalThis.fetch
  globalThis.fetch = (async () => Response.json({ error: 'sesión vencida', code: 'expired' }, { status: 401 })) as unknown as typeof fetch
  try {
    await expect(startRun(chatBase('/api', 'c'), { prompt: 'Cambia el titular', messageId: 'm1' })).rejects.toThrow('Tu sesión venció. Vuelve a iniciar sesión para seguir.')
  } finally {
    globalThis.fetch = real
  }
})

// Arq (#787): "una vez por build" se fuerza; un segundo registro cambiaría el dueño de las requests a mitad de sesión.
test('setSessionProvider fija el provider una vez y un segundo registro lanza', () => {
  const distro: SessionProvider = { ...localSessionProvider, getToken: async () => 't' }
  setSessionProvider(distro)
  expect(sessionProvider()).toBe(distro)
  expect(() => setSessionProvider(localSessionProvider)).toThrow('ya está registrado')
  expect(sessionProvider()).toBe(distro)
})

// El menú de sesión muestra solo lo que el provider implementa; el local no muestra nada.
test('el menú de sesión sale del provider: dueño y cerrar sesión si los trae, nada con el local', async () => {
  let out = 0
  const full: SessionProvider = { ...localSessionProvider, user: () => ({ id: 'u1', label: 'ana@ejemplo.test' }), signOut: async () => { out++ } }
  const menu = sessionMenuOf(full)
  expect(menu?.user).toEqual({ id: 'u1', label: 'ana@ejemplo.test' })
  await menu?.signOut?.()
  expect(out).toBe(1)
  expect(sessionMenuOf({ ...localSessionProvider, user: () => null, signOut: async () => {} })).toMatchObject({ user: null })
  expect(sessionMenuOf(localSessionProvider)).toBeNull()
})
