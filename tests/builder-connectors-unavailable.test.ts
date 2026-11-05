import { expect, test } from 'bun:test'
import { fetchConnectorAccounts, NotConnectedError } from '../apps/builder/src/lib/run-client'

// Sin puerto connectors (orquestador, B8 #833) o sin Pipedream (Runtime, #887) /connectors/* responde 501 connectors-unavailable:
// el panel se apaga en vez de mostrar un error. Otro 501, o un 404, ya no es "no disponible": es un error que se ve.
test('solo un 501 connectors-unavailable es "no disponible"; otro 501 o un 404 es error', async () => {
  const realFetch = globalThis.fetch
  const replies = [
    new Response(JSON.stringify({ code: 'connectors-unavailable' }), { status: 501, headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ error: 'otra cosa' }), { status: 501, headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ error: 'conectores no configurados' }), { status: 404, headers: { 'content-type': 'application/json' } }),
  ]
  globalThis.fetch = (async () => replies.shift()!) as unknown as typeof fetch
  try {
    const unavailable = await fetchConnectorAccounts('http://t').catch((e: unknown) => e)
    expect(unavailable).toBeInstanceOf(NotConnectedError)
    expect((unavailable as Error).message).toBe('Los conectores no están disponibles en este servidor.')
    const other = await fetchConnectorAccounts('http://t').catch((e: unknown) => e)
    expect(other).not.toBeInstanceOf(NotConnectedError)
    const missing = await fetchConnectorAccounts('http://t').catch((e: unknown) => e)
    expect([missing instanceof Error, missing instanceof NotConnectedError]).toEqual([true, false])
  } finally {
    globalThis.fetch = realFetch
  }
})
