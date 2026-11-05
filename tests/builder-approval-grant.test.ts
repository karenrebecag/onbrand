import { expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import { chatBase } from '../apps/builder/src/lib/chat-routes'
import { decideApproval, fetchApproval, type ApprovalRecord } from '../apps/builder/src/lib/run-client'

const load = createRequire(import.meta.url)
const { createElement } = load('../apps/builder/node_modules/react')
const { renderToStaticMarkup } = load('../apps/builder/node_modules/react-dom/server')
const base = chatBase('http://t', 'c')

async function withFetch<T>(replies: Response[], run: (calls: { url: string; init?: RequestInit }[]) => Promise<T>): Promise<T> {
  const real = globalThis.fetch
  const calls: { url: string; init?: RequestInit }[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => { calls.push({ url: String(url), init }); return replies.shift()! }) as unknown as typeof fetch
  try { return await run(calls) } finally { globalThis.fetch = real }
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// §8.1 (#889): la tarjeta se pinta con GET approvals/:callId y el POST lleva solo la decisión; 409 already-decided y 403 de gasto
// dicen su motivo en vez de "intenta de nuevo".
test('fetchApproval lee el registro y 404 es "no disponible"; decideApproval manda solo la decisión y nombra 409 y 403', async () => {
  await withFetch([
    json(200, { callId: 'k1', tool: 'mcp__wt__generate_image', patterns: ['Tool(mcp__wt__generate_image:*)', 'Dynamic(mcp__wt__generate_image)'], rememberPatterns: ['Dynamic(mcp__wt__generate_image)'], input: { prompt: 'equipo' }, expiresAt: 99, decision: 'nope' }),
    json(404, { code: 'not-found' }),
    json(409, { code: 'already-decided' }),
    json(403, { code: 'scope', error: 'tu cuenta no puede gastar créditos' }),
  ], async (calls) => {
    expect(await fetchApproval(base, 'k1')).toEqual({ callId: 'k1', tool: 'mcp__wt__generate_image', patterns: ['Tool(mcp__wt__generate_image:*)', 'Dynamic(mcp__wt__generate_image)'], rememberPatterns: ['Dynamic(mcp__wt__generate_image)'], input: { prompt: 'equipo' }, expiresAt: 99 })
    const missing = await fetchApproval(base, 'k2').catch((e: unknown) => e) as { status?: number; message: string }
    expect([missing.status, missing.message]).toEqual([404, 'No disponible: este servidor no tiene el registro de esta aprobación.'])
    const decided = await decideApproval(base, 'k1', 'always').catch((e: unknown) => e) as { status?: number; message: string }
    expect([decided.status, decided.message]).toEqual([409, 'Ya decidida: esta aprobación se respondió antes.'])
    const spend = await decideApproval(base, 'k1', 'allow').catch((e: unknown) => e) as { status?: number; message: string }
    expect(spend.status).toBe(403)
    expect(spend.message).toContain('gastar créditos')
    expect([calls[0]!.url, calls[0]!.init?.method ?? 'GET']).toEqual(['http://t/chats/c/approvals/k1', 'GET'])
    expect(JSON.parse(String(calls[2]!.init?.body))).toEqual({ decision: 'always' })
  })
})

const approval = { callId: 'k1', toolName: 'mcp__evil__other', app: 'evil', input: { channel: '#todo-el-mundo' }, kind: 'write' as const }
const record = (o: Partial<ApprovalRecord> = {}): ApprovalRecord => ({ callId: 'k1', tool: 'mcp__slack__post_message', patterns: ['Tool(mcp__slack__post_message:*)'], rememberPatterns: [], input: { channel: '#ventas', text: 'hola' }, expiresAt: 99, ...o })

async function view(state: object) {
  const { ConnectorApprovalView } = await import('../apps/builder/src/components/arc/blocks/agent-run/tool-approval')
  return renderToStaticMarkup(createElement(ConnectorApprovalView, { approval, record: state, fromEvent: false, onDecide: async () => undefined })) as string
}

test('con registro la tarjeta muestra la tool y los argumentos del registro, no los del evento; "Permitir siempre" solo con patrón recordable', async () => {
  const plain = await view({ status: 'ready', record: record() })
  for (const text of ['mcp__slack__post_message', '#ventas', 'Slack quiere usar', '>Omitir<', '>Permitir<']) expect(plain).toContain(text)
  for (const text of ['mcp__evil__other', '#todo-el-mundo', 'Permitir siempre']) expect(plain).not.toContain(text)
  const remember = await view({ status: 'ready', record: record({ tool: 'mcp__wt__generate_image', rememberPatterns: ['Dynamic(mcp__wt__generate_image)'] }) })
  expect(remember).toContain('Permitir siempre <code')
  expect(remember).toContain('>mcp__wt__generate_image</code>')
})

test('cargando, sin registro (404) o ya decidida en el registro: sin botones y con el motivo', async () => {
  const loading = await view({ status: 'loading' })
  const missing = await view({ status: 'missing', text: 'No disponible: este servidor no tiene el registro de esta aprobación.' })
  const decided = await view({ status: 'ready', record: record({ decision: 'allow' }) })
  expect(loading).toContain('Cargando la aprobación…')
  expect(missing).toContain('No disponible: este servidor no tiene el registro de esta aprobación.')
  expect(decided).toContain('Ya decidida: esta aprobación se respondió antes.')
  for (const html of [loading, missing, decided]) {
    expect(html).not.toContain('>Permitir<')
    expect(html).not.toContain('>Omitir<')
    expect(html).not.toContain('#todo-el-mundo')
  }
})
