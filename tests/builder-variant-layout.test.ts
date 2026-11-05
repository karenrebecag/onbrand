import { expect, test } from 'bun:test'
import { sideBySide, type Instance } from '../apps/builder/src/lib/variant-layout'
import { chatBase } from '../apps/builder/src/lib/chat-routes'

const inst = (id: string, x: number, extra: Partial<Instance> = {}): Instance => ({ id, x, y: 0, width: 1280, height: 900, ...extra })
const byId = (list: Instance[]) => new Map(list.map((i) => [i.id, i]))

// SideBySide de Stitch (I18nStore :22408-22516): placeholders en fila a la derecha de la fuente, 64 entre cada uno, y
// lo que estaba a la derecha en la franja se corre el ancho total más 64.
test('las variantes entran como placeholders a la derecha de la fuente y corren lo que estaba ahí', () => {
  const source = inst('src', 0, { source: 's0' })
  const other = inst('otra', 1344, { source: 's9' })
  const below = inst('abajo', 1344, { y: 2000, source: 's8' })
  const { creates, mutations } = sideBySide([source], byId([source, other, below]), [
    { id: 'v1', source: 'p1', width: 1280, height: 900, pending: true },
    { id: 'v2', source: 'p2', width: 1280, height: 900, pending: true },
  ])
  expect(creates.map((c) => [c.id, c.x, c.y, c.pending])).toEqual([['v1', 1344, 0, 'p1'], ['v2', 2688, 0, 'p2']])
  expect(mutations).toEqual([{ type: 'move', id: 'otra', x: 1344 + 2624 + 64 }])
})

// BaseLayout :22080-22210: el placeholder toma su pantalla con el tamaño final y la fila se vuelve a espaciar.
test('al llegar cada variante el placeholder se commitea y la fila se re-espacia con su ancho', () => {
  const source = inst('src', 0, { source: 's0' })
  const v1 = inst('v1', 1344, { pending: 'p1' })
  const v2 = inst('v2', 2688, { pending: 'p2' })
  const existing = byId([source, v1, v2])
  const stillPending = sideBySide([source], existing, [{ id: 'v1', source: 'p1', width: 1280, height: 900, pending: true }])
  expect(stillPending).toEqual({ creates: [], mutations: [] })
  const { mutations } = sideBySide([source], existing, [{ id: 'v1', source: 'p1', width: 1440, height: 4000, pending: false }])
  expect(mutations).toEqual([
    { type: 'commit', id: 'v1', source: 'p1', width: 1440, height: 4000 },
    { type: 'move', id: 'v2', x: 1344 + 1440 + 64 },
  ])
})

test('sin nada a la derecha no se corre nada y una pantalla ya commiteada no se repite', () => {
  const source = inst('src', 0, { source: 's0' })
  const done = inst('v1', 1344, { source: 'p1' })
  expect(sideBySide([source], byId([source, done]), [{ id: 'v1', source: 'p1', width: 1280, height: 900, pending: false }])).toEqual({ creates: [], mutations: [] })
  const { creates, mutations } = sideBySide([source], byId([source]), [{ id: 'v3', source: 'p3', width: 1280, height: 900, pending: true }])
  expect(mutations).toEqual([])
  expect(creates[0]?.x).toBe(1344)
})

// Contrato S5 (6f08d0d): pending hasta message.end; el pan espera los N settled; el orden es el de creación.
test('cada variante pasa de pending a su desenlace y el grupo cierra con las N settled', async () => {
  const { groupSettled, variantScreens, variantStatus } = await import('../apps/builder/src/lib/variant-layout')
  const run = (messageId: string, index: number, status: 'streaming' | 'stop' | 'error' | 'stopped', settled = false) =>
    ({ messageId, index, settled, state: { messageId, status, steps: [], text: '' } })
  expect(['streaming', 'stop', 'error', 'stopped'].map((s) => variantStatus(run('a', 0, s as 'stop')))).toEqual(['pending', 'done', 'error', 'stopped'])
  const group = { groupId: 'g', sourceId: 'src', runs: [run('b', 1, 'stop', true), run('a', 0, 'streaming')] }
  expect(groupSettled(group)).toBe(false)
  expect(groupSettled({ ...group, runs: group.runs.map((r) => ({ ...r, settled: true })) })).toBe(true)
  expect(groupSettled({ ...group, runs: [] })).toBe(false)
  expect(variantScreens(group, { width: 1280, height: 3000 })).toEqual([
    { id: 'a', source: 'a', width: 1280, height: 3000, pending: true },
    { id: 'b', source: 'b', width: 1280, height: 3000, pending: false },
  ])
})

// POST /runs del contrato S5: las opciones van dentro de `variants`; el modelo vacío no viaja.
test('el pedido de variantes anida las opciones y valida la respuesta', async () => {
  const { startVariants } = await import('../apps/builder/src/lib/run-client')
  const sent: unknown[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify({ groupId: 'g1', sourceId: 'src', variants: [{ messageId: 'm0', index: 0 }] }), { status: 202 })
  }) as typeof fetch
  try {
    const out = await startVariants(chatBase('http://t', 'c'), { sourceId: 'src', count: 1, creativeRange: 'yolo', aspects: ['layout'], model: '' })
    expect(sent[0]).toEqual({ variants: { sourceId: 'src', count: 1, creativeRange: 'yolo', aspects: ['layout'] }, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
    expect(out).toEqual({ groupId: 'g1', sourceId: 'src', variants: [{ messageId: 'm0', index: 0 }] })
  } finally {
    globalThis.fetch = realFetch
  }
})

// A8: unchanged sale del commit, no de snapshot.files. V2 b5a6614e cerró en 07fda3ed, el commit de su fuente; las
// variantes de c7c7ec26 solo reemplazaron fotos con generate_image (files vacío) y sí cambiaron la página.
test('una variante es unchanged solo si su snapshot cierra en el commit de la fuente, y lleva su chat propio', async () => {
  const { variantStatus } = await import('../apps/builder/src/lib/variant-layout')
  const { variantTurn } = await import('../apps/builder/src/lib/use-builder')
  const state = (commit?: string) => ({ messageId: 'v2', status: 'stop' as const, steps: [], text: 'No cambié ningún archivo.', snapshot: { dir: '/ws', files: [], ...(commit ? { commit } : {}) } })
  const run = (commit?: string, sourceCommit: string | null = '07fda3ed') => ({ messageId: 'v2', index: 1, settled: true, state: state(commit), ...(sourceCommit ? { sourceCommit } : {}) })
  expect([variantStatus(run('07fda3ed')), variantStatus(run('aa285249')), variantStatus(run()), variantStatus(run('07fda3ed', null))]).toEqual(['unchanged', 'done', 'done', 'done'])
  const turn = variantTurn({ ...run('07fda3ed'), elapsedMs: 14185, state: { ...state('07fda3ed'), variant: { groupId: 'g', sourceId: 's', index: 1, count: 2, title: 'Variante 2', prompt: 'Fotos reales' } } })
  expect([turn.messageId, turn.prompt, turn.elapsedMs, turn.settled, turn.state.text]).toEqual(['v2', 'Fotos reales', 14185, true, 'No cambié ningún archivo.'])
})

// A8: el transport propaga imageGeneration y thinking a cada variante (contrato de 0751efa); el builder no los mandaba.
test('las variantes heredan modelo, modelo de imagen y razonamiento del último pedido del chat', async () => {
  const { variantsRequest } = await import('../apps/builder/src/lib/use-builder')
  const { startVariants } = await import('../apps/builder/src/lib/run-client')
  const req = variantsRequest({ count: 2, creativeRange: 'medium' }, 'src', { model: 'm1', imageGeneration: { modelId: 'img-1' }, thinking: { effort: 'high' } })
  const sent: unknown[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify({ groupId: 'g', sourceId: 'src', variants: [] }), { status: 202 })
  }) as typeof fetch
  try {
    await startVariants(chatBase('http://t', 'c'), req)
    expect(sent[0]).toEqual({ variants: { count: 2, creativeRange: 'medium', sourceId: 'src' }, model: 'm1', imageGeneration: { modelId: 'img-1' }, thinking: { effort: 'high' }, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
  } finally {
    globalThis.fetch = realFetch
  }
  expect(variantsRequest({ count: 1 }, 'src', undefined)).toEqual({ count: 1, sourceId: 'src' })
})

// ee252db7: el composer mostraba "Sonnet 5.5 High" con el chip de thinking apagado y el pedido salió sin esfuerzo.
test('el esfuerzo que muestra el composer viaja siempre en el pedido', async () => {
  const { composerChoice, variantsRequest } = await import('../apps/builder/src/lib/use-builder')
  const { startVariants } = await import('../apps/builder/src/lib/run-client')
  expect(composerChoice('sonnet-5.5', null, 'high')).toEqual({ model: 'sonnet-5.5', thinking: { effort: 'high' } })
  const sent: unknown[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify({ groupId: 'g', sourceId: 'src', variants: [] }), { status: 202 })
  }) as typeof fetch
  try {
    await startVariants(chatBase('http://t', 'c'), variantsRequest({ count: 1 }, 'src', composerChoice('sonnet-5.5', 'img-1', 'high')))
    expect(sent[0]).toMatchObject({ model: 'sonnet-5.5', imageGeneration: { modelId: 'img-1' }, thinking: { effort: 'high' } })
  } finally {
    globalThis.fetch = realFetch
  }
})

// 08dff459 y 8f185369 (acd8bf5): mientras solo lee, el ws de la variante es la copia de la fuente y se veía "igual".
test('el marco de variante espera la primera escritura del agente antes de mostrar su preview', async () => {
  const { variantWrote } = await import('../apps/builder/src/lib/variant-layout')
  const step = (kind: 'read' | 'write' | 'tool' | 'action', status: 'running' | 'ok', extra: Record<string, unknown> = {}) =>
    ({ id: `${kind}-${status}`, kind, label: '', status, output: '', startedAt: 0, parentStepId: 'agent:write', ...extra })
  const run = (...steps: ReturnType<typeof step>[]) => ({ messageId: 'v', index: 0, settled: false, state: { messageId: 'v', status: 'streaming' as const, steps, text: '' } })
  expect([
    variantWrote(run(step('read', 'ok'))),
    variantWrote(run(step('write', 'running'))),
    variantWrote(run(step('action', 'ok', { parentStepId: undefined, kind: 'write' }))),
    variantWrote(run(step('read', 'ok'), step('write', 'ok'))),
    variantWrote(run(step('tool', 'ok', { tool: 'generate_image' }))),
  ]).toEqual([false, false, false, true, true])
})

// R4.4 (verificacion-91f2cb1.md: al recargar solo quedaban Escritorio y Móvil): GET /chats trae las variantes; vuelven
// por grupo en el orden del hilo, cada grupo por index, con el commit de su fuente para el unchanged.
test('las variantes del hilo vuelven agrupadas, por index y con el commit de la fuente', async () => {
  const { groupsFromThread } = await import('../apps/builder/src/lib/variant-layout')
  const { threadVariants } = await import('../apps/builder/src/lib/run-client')
  const v = (messageId: string, groupId: string, index: number, extra: Record<string, unknown> = {}) =>
    ({ messageId, groupId, sourceId: groupId === 'g1' ? 's1' : 's2', index, count: 2, title: messageId, commit: null, at: 0, done: false, queued: false, ...extra })
  const raw = { variants: [v('b', 'g1', 1), v('c', 'g2', 0, { queued: true }), v('a', 'g1', 0), { messageId: 'x' }] }
  const list = threadVariants(raw)
  expect(list.map((x) => x.messageId)).toEqual(['b', 'c', 'a'])
  const groups = groupsFromThread(list, (id) => (id === 's1' ? 'c0ffee' : null))
  expect(groups.every((g) => g.restored)).toBe(true)
  expect(groups.map((g) => [g.groupId, g.sourceId, g.runs.map((r) => [r.messageId, r.index, r.settled, r.sourceCommit])])).toEqual([
    ['g1', 's1', [['a', 0, false, 'c0ffee'], ['b', 1, false, 'c0ffee']]],
    ['g2', 's2', [['c', 0, false, undefined]]],
  ])
  expect(threadVariants({})).toEqual([])
})

// 38d35ade (banco, caso 3): la variante fallida era un marco gris. Con escrituras, su última versión va detrás del aviso;
// sin escrituras el ws es la copia de la fuente y queda solo el aviso.
test('una variante fallida muestra su preview solo si llegó a escribir', async () => {
  const { variantShowsPreview } = await import('../apps/builder/src/lib/variant-layout')
  const wrote = { id: 'w', kind: 'write' as const, label: '', status: 'ok' as const, output: '', startedAt: 0, parentStepId: 'agent:write' }
  const run = (status: 'error' | 'stop' | 'streaming', steps: typeof wrote[] = []) =>
    ({ messageId: 'v', index: 0, settled: status !== 'streaming', state: { messageId: 'v', status, steps, text: '', ...(status === 'error' ? { error: { message: 'boom' } } : {}) } })
  expect([run('error', [wrote]), run('error'), run('stop'), run('streaming')].map(variantShowsPreview)).toEqual([true, false, true, false])
})

// QA caso 5 (2+5+5 variantes): al recargar los tres grupos llegaban juntos, calculaban contra el mismo lienzo y la fila
// salía intercalada. En una pasada cada grupo ve lo anterior: queda igual que cuando llegaron de a uno.
test('varios grupos rehidratados quedan en la misma fila que creados de a uno', async () => {
  const { sideBySideGroups } = await import('../apps/builder/src/lib/variant-layout')
  const source = inst('src', 0, { source: 's0' })
  const screens = (ids: string[]) => ids.map((id) => ({ id, source: id, width: 1280, height: 900, pending: false }))
  const groups = [screens(['a1', 'a2']), screens(['b1', 'b2'])]
  const together = sideBySideGroups(groups.map((s) => ({ source, screens: s })), byId([source]))
  const first = sideBySide([source], byId([source]), groups[0]!)
  const second = sideBySide([source], byId([source, ...first.creates]), groups[1]!)
  const moved = new Map(second.mutations.flatMap((m) => (m.type === 'move' ? [[m.id, m.x] as const] : [])))
  const oneByOne = [...first.creates.map((c) => ({ ...c, x: moved.get(c.id) ?? c.x })), ...second.creates]
  const row = (list: Instance[]) => [...list].sort((p, q) => p.x - q.x).map((i) => [i.id, i.x])
  expect(row(together.creates)).toEqual(row(oneByOne))
  expect(new Set(together.creates.map((c) => c.x)).size).toBe(4)
})

// QA caso 5: V4 y V5 decían "En espera" ya corriendo; la cola sale del `queued` de GET /chats y del log, no de la falta
// de eventos.
test('una variante rehidratada arranca en cola solo si GET /chats lo dice', async () => {
  const { groupsFromThread } = await import('../apps/builder/src/lib/variant-layout')
  const [g] = groupsFromThread([
    { messageId: 'v1', groupId: 'g', sourceId: 's', index: 0, queued: false },
    { messageId: 'v2', groupId: 'g', sourceId: 's', index: 1, queued: true },
  ], () => null)
  expect(g!.runs.map((r) => r.state.queued === true)).toEqual([false, true])
})

// rb-qa2 hallazgo 6 + A8: el marco se remonta una vez cuando la variante que esta vista vio correr cierra, y otra vez
// solo si cierra con otra versión; una variante ya cerrada al abrir el chat no se remonta.
test('remonta la variante al cerrar, una sola vez por versión', async () => {
  const { variantsToRemount } = await import('../apps/builder/src/lib/variant-layout')
  const v = (messageId: string, status: 'streaming' | 'stop', commit?: string) =>
    ({ messageId, index: 0, settled: status === 'stop', state: { messageId, status, steps: [], text: '', ...(commit ? { snapshot: { commit } } : {}) } }) as never
  let r = variantsToRemount(new Map(), [v('a', 'streaming'), v('b', 'stop', 'c1')])
  expect(r.ids).toEqual([])
  r = variantsToRemount(r.seen, [v('a', 'stop', 'c2'), v('b', 'stop', 'c1')])
  expect(r.ids).toEqual(['a'])
  r = variantsToRemount(r.seen, [v('a', 'stop', 'c2'), v('b', 'stop', 'c1')])
  expect(r.ids).toEqual([])
  expect(variantsToRemount(r.seen, [v('a', 'stop', 'c3')]).ids).toEqual(['a'])
})
