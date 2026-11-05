import { expect, test } from 'bun:test'
import { chatBase, chatRoutes, rootRoutes } from '../apps/builder/src/lib/chat-routes'
import { matchOwnerRoute, matchRoute } from '../src/orchestrator/route-table'

// Condición 6 de Arq: cada URL de chat que arma el builder es una fila de la allowlist del orquestador, con su método y solo
// los parámetros de query que esa fila reenvía. Una ruta que solo existe en el Runtime local daría 404 detrás del orquestador.
const API = 'https://api.test'
const CHAT = '0b6c7f3e-6a51-4c6e-9d1f-2f1f6b1c9a10'
const M = '7d2a1f40-3b9e-4c55-8f0a-1e2d3c4b5a69'
const base = chatBase(API, CHAT)

type Name = keyof typeof chatRoutes
const CALLS: Record<Exclude<Name, 'mediaUrls'>, [method: string, url: string]> = {
  thread: ['GET', chatRoutes.thread(base)],
  runs: ['POST', chatRoutes.runs(base)],
  events: ['GET', chatRoutes.events(base, M, -1)],
  cancel: ['POST', chatRoutes.cancel(base, M)],
  publish: ['POST', chatRoutes.publish(base, M)],
  files: ['GET', chatRoutes.files(base, M)],
  diff: ['GET', chatRoutes.diff(base, M)],
  versions: ['GET', chatRoutes.versions(base, M)],
  export: ['GET', chatRoutes.export(base, M, 'site')],
  shot: ['GET', chatRoutes.shot(base, M, 'step-1.png')],
  variantCancel: ['POST', chatRoutes.variantCancel(base, M)],
  canvas: ['PUT', chatRoutes.canvas(base)],
  canvasUpload: ['POST', chatRoutes.canvasUpload(base, 'foto.png')],
  canvasFile: ['GET', chatRoutes.canvasFile(base, 'foto.png')],
  plan: ['GET', chatRoutes.plan(base, M)],
  approval: ['POST', chatRoutes.approval(base, 'toolu_01')],
  uploads: ['POST', chatRoutes.uploads(base)],
  transcribe: ['POST', chatRoutes.transcribe(base)],
  enhance: ['POST', chatRoutes.enhance(base)],
  heartbeat: ['POST', chatRoutes.heartbeat(base)],
  brands: ['GET', chatRoutes.brands(base)],
  brandInstructions: ['PUT', chatRoutes.brandInstructions(base, 'acme')],
  brandMemory: ['GET', chatRoutes.brandMemory(base, 'acme')],
}

test('cada constructor de chatRoutes casa con una fila de route-table.ts', () => {
  // Un constructor nuevo sin fila aquí también falla: mediaUrls es la única excepción (§4, lo firma el orquestador).
  expect(Object.keys(chatRoutes).filter((k) => k !== 'mediaUrls').sort()).toEqual(Object.keys(CALLS).sort())
  const prefix = `${API}/chats/${CHAT}`
  for (const [name, [method, url]] of Object.entries(CALLS)) {
    expect({ name, url: url.startsWith(prefix) }).toEqual({ name, url: true })
    const parsed = new URL(url)
    const rest = parsed.pathname.slice(new URL(prefix).pathname.length)
    const hit = matchRoute(method, rest)
    expect({ name, hit: typeof hit === 'object' }).toEqual({ name, hit: true })
    const allowed = typeof hit === 'object' ? hit.route.query ?? [] : []
    expect({ name, query: [...parsed.searchParams.keys()].filter((k) => !allowed.includes(k)) }).toEqual({ name, query: [] })
  }
})

// A1(a), #880: los conectores son del dueño y van a la raíz sin chat; cada URL casa con su fila de matchOwnerRoute, con su método
// y solo los parámetros de query que esa fila reenvía.
test('los conectores del builder van a /connectors/* en la raíz y casan con matchOwnerRoute', () => {
  const calls: [string, string][] = [
    ['GET', rootRoutes.connectorApps(API, 'slack', 'cursor-1')],
    ['GET', rootRoutes.connectorAccounts(API)],
    ['POST', rootRoutes.connect(API)],
    ['DELETE', rootRoutes.disconnect(API, 'apn_1')],
  ]
  for (const [method, url] of calls) {
    const parsed = new URL(url)
    expect({ url, chat: parsed.pathname.includes('/chats/') }).toEqual({ url, chat: false })
    const hit = matchOwnerRoute(method, parsed.pathname)
    expect({ url, hit: typeof hit === 'object' }).toEqual({ url, hit: true })
    const allowed = typeof hit === 'object' ? hit.route.query ?? [] : []
    expect({ url, query: [...parsed.searchParams.keys()].filter((k) => !allowed.includes(k)) }).toEqual({ url, query: [] })
  }
})
