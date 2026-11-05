import { expect, test } from 'bun:test'
import { chatBase } from '../apps/builder/src/lib/chat-routes'

const runState = () => import('../apps/builder/src/lib/run-state')

const planApproval = { callId: 'p', toolName: 'mcp__wt__exit_plan_mode', app: 'wt', input: { planPath: '.wt/plans/m.md', summary: 'Landing en 5 secciones' }, kind: 'plan' as const }
const closed = { messageId: 'm', status: 'stop' as const, text: 'Plan enviado', steps: [] }

// plan-mode.md §3: exit_plan_mode termina el turno; el plan se decide con el turno cerrado, así que su tarjeta
// pendiente no se descarta como las de conector (las no decididas se van al cerrar).
test('el plan pendiente sigue en el turno cerrado y marca la fase de aprobación', async () => {
  const { planPhaseOf, toRunState } = await runState()
  const message = { ...closed, approvals: [planApproval as never] }
  expect(toRunState(message, 1000, []).approvals?.map((a) => a.callId)).toEqual(['p'])
  expect(planPhaseOf(message)).toBe('awaiting_plan_approval')
  expect(planPhaseOf({ ...closed, status: 'streaming' as const }, 'plan')).toBe('planning')
  expect(planPhaseOf(closed)).toBeNull()
  expect(planPhaseOf({ ...closed, approvals: [{ ...planApproval, decision: 'allow' } as never] })).toBe('building')
})

// §5 y Lovable CANCELLED_BY_USER_MESSAGE_AWAITING_APPROVAL: un mensaje nuevo con el plan pendiente lo cancela.
test('un mensaje nuevo cancela el plan pendiente y no toca lo ya decidido', async () => {
  const { cancelPendingPlan, planPhaseOf, toRunState } = await runState()
  const spend = { ...planApproval, callId: 's', kind: 'spend' as const }
  const cancelled = cancelPendingPlan({ ...closed, approvals: [planApproval as never, spend] })
  expect(planPhaseOf(cancelled)).toBe('cancelled')
  expect(toRunState(cancelled, 0, []).approvals?.find((a) => a.callId === 'p')).toMatchObject({ decision: 'skip', cancelReason: 'user-message' })
  expect(cancelled.approvals?.find((a) => a.callId === 's')?.decision).toBeUndefined()
  const approved = { ...closed, approvals: [{ ...planApproval, decision: 'allow' } as never] }
  expect(cancelPendingPlan(approved)).toBe(approved)
})

// Al recargar con un borrador guardado (PUT), el GET devuelve {plan, edited}: ese texto manda sobre input.plan del evento,
// que queda de respaldo mientras carga o si el GET falla.
test('la tarjeta del plan pinta el plan del GET con su borrador y cae a input.plan sin él', async () => {
  const { fetchPlan } = await import('../apps/builder/src/lib/run-client')
  const { planText } = await import('../apps/builder/src/components/arc/blocks/agent-run/tool-approval')
  const real = globalThis.fetch
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ plan: '# Plan editado', edited: true }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const loaded = await fetchPlan(chatBase('/api', 'c'), 'm')
    expect(loaded).toEqual({ plan: '# Plan editado', edited: true })
    expect(planText(loaded, '# Plan del agente')).toBe('# Plan editado')
    globalThis.fetch = (async () => new Response('no', { status: 404 })) as unknown as typeof fetch
    await expect(fetchPlan(chatBase('/api', 'c'), 'm')).rejects.toThrow('todavía no está disponible')
  } finally {
    globalThis.fetch = real
  }
  expect(planText(null, '# Plan del agente')).toBe('# Plan del agente')
  expect(planText(null, undefined)).toBeNull()
})

// El sessionId del turno de plan se guarda en message.end: aprobar antes da 409, así que se decide con el turno cerrado.
test('el plan no se puede decidir hasta que su turno cierra', async () => {
  const { canDecidePlan } = await import('../apps/builder/src/components/arc/blocks/agent-run/tool-approval')
  expect(canDecidePlan({ pending: true, turnClosed: false, sending: false })).toBe(false)
  expect(canDecidePlan({ pending: true, turnClosed: true, sending: false })).toBe(true)
  expect(canDecidePlan({ pending: true, turnClosed: true, sending: true })).toBe(false)
  expect(canDecidePlan({ pending: false, turnClosed: true, sending: false })).toBe(false)
})

// QA plan mode 2026-11-04: el transport busca el plan en el mensaje de la URL. Con el id del chat (el primer mensaje), el
// rechazo del plan de un follow-up respondía 400 "decision debe ser allow|always|skip".
test('la decisión va al mensaje que pidió la aprobación, no al primero del chat', async () => {
  const { approvalTarget } = await import('../apps/builder/src/lib/use-builder')
  const turn = (messageId: string, callIds: string[]) => ({ messageId, prompt: 'p', elapsedMs: 0, request: {}, state: { messageId, status: 'stop' as const, steps: [], text: '', approvals: callIds.map((callId) => ({ ...planApproval, callId })) } }) as never
  const turns = [turn('chat', ['a']), turn('follow', ['b'])]
  expect(approvalTarget(turns, 'b', 'chat')).toBe('follow')
  expect(approvalTarget(turns, 'a', 'chat')).toBe('chat')
  expect(approvalTarget(turns, 'zz', 'chat')).toBe('chat')
  expect(approvalTarget([], 'zz', undefined)).toBeUndefined()
})

// El log del plan ya cerró cuando la persona rechaza: sin esto la tarjeta se quedaba en "Rechazando el plan…".
test('el rechazo confirmado deja el veredicto en la tarjeta y la fase en cancelado', async () => {
  const { rejectPlanLocally, planPhaseOf } = await runState()
  const message = { ...closed, approvals: [planApproval as never] }
  const rejected = rejectPlanLocally(message, 'p')
  expect(rejected.approvals?.[0]?.decision).toBe('skip')
  expect(planPhaseOf(rejected)).toBe('cancelled')
  expect(rejectPlanLocally(rejected, 'p')).toBe(rejected)
})

// planOnly (#554): plan aprobado cuya fase build no cambió nada fuera de .wt/; cierra normal con el commit del padre o sin
// commit. No es un fallo y no ofrece archivos cambiados.
test('un plan aplicado sin cambios se reconoce y no presta los archivos de la versión anterior', async () => {
  const { planOnlyOf, ownStats } = await runState()
  const approved = { ...closed, approvals: [{ ...planApproval, decision: 'allow' } as never] }
  const stats = [{ path: 'src/App.tsx', additions: 3 }]
  expect(planOnlyOf(approved, 'abc')).toBe(true)
  expect(planOnlyOf({ ...approved, snapshot: { dir: 'd', files: [], commit: 'abc' } } as never, 'abc')).toBe(true)
  expect(ownStats({ ...approved, snapshot: { dir: 'd', files: [], commit: 'abc' } } as never, stats, 'abc')).toEqual([])
  const built = { ...approved, snapshot: { dir: 'd', files: [], commit: 'new' } } as never
  expect(planOnlyOf(built, 'abc')).toBe(false)
  expect(ownStats(built, stats, 'abc')).toEqual(stats)
  expect(planOnlyOf({ ...closed, approvals: [planApproval as never] }, 'abc')).toBe(false)
  expect(planOnlyOf({ ...approved, status: 'streaming' as const }, 'abc')).toBe(false)
})

// ec mueve assertCanBuildPlan antes de writePlanEdit: un 409 workspace-busy o un 429 en `edit`/`approve` no registra nada
// y el plan sigue pendiente; la tarjeta queda donde estaba (el editor conserva la edición) con cómo reintentar. Los otros
// 409 (plan ya decidido, sin sesión, sin plan, sin original, o sin code) dan 409 en cada reintento: "Ya no espera tu decisión".
test('solo un 409 workspace-busy o un 429 invitan a reintentar; el resto de 409 no', async () => {
  const { decideApproval } = await import('../apps/builder/src/lib/run-client')
  const { planDecisionFailure } = await import('../apps/builder/src/components/arc/blocks/agent-run/tool-approval')
  const real = globalThis.fetch
  const edit = { decision: 'edit' as const, plan: '# Plan con mi línea' }
  const approve = { decision: 'approve' as const }
  const failWith = async (status: number, code?: string) => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'x', ...(code ? { code } : {}) }), { status })) as unknown as typeof fetch
    try { await decideApproval(chatBase('/api', 'm2'), 'p', edit); return null } catch (e) { return e }
  }
  try {
    expect(planDecisionFailure(await failWith(409, 'workspace-busy'), edit, 'editing')).toEqual({ stage: 'editing', error: 'Hay otra construcción en curso. Guarda de nuevo cuando termine.', status: 409 })
    expect(planDecisionFailure(await failWith(409, 'workspace-busy'), approve, 'idle').error).toBe('Hay otra construcción en curso. Aprueba de nuevo cuando termine.')
    expect(planDecisionFailure(await failWith(429), approve, 'idle').error).toBe('Hay demasiadas construcciones en curso. Aprueba de nuevo en un momento.')
    expect(planDecisionFailure(await failWith(409, 'plan-decided'), approve, 'idle')).toEqual({ stage: 'idle', error: 'Ya no espera tu decisión.', status: 409 })
    expect(planDecisionFailure(await failWith(409), edit, 'editing').error).toBe('Ya no espera tu decisión.')
    expect(planDecisionFailure(await failWith(500), edit, 'editing')).toEqual({ stage: 'editing', error: 'No se pudo enviar la decisión. Intenta de nuevo.', status: 500 })
  } finally {
    globalThis.fetch = real
  }
})

// Arq (§3): "Qué cambiarías" se mandaba y nadie lo leía. Rechazar con nota marca el plan rechazado con la nota a la vista
// y el transport responde {ok, messageId} de un mensaje nuevo en plan con prompt = nota: el builder lo suma como turno.
test('rechazar con nota deja la nota en la tarjeta y suma el turno en plan que abre el transport', async () => {
  const { decideApproval } = await import('../apps/builder/src/lib/run-client')
  const { rejectWithFollowUp } = await import('../apps/builder/src/lib/use-builder')
  const { toRunState } = await runState()
  const real = globalThis.fetch
  const answer = (body: unknown) => { globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch }
  const reject = { decision: 'reject' as const, feedback: '  sin sección de precios ' }
  const planTurn = { messageId: 'm2', prompt: 'una landing', state: { ...closed, approvals: [planApproval as never] }, elapsedMs: 0, request: { prompt: 'una landing', model: 'opus', mode: 'plan' as const } }
  try {
    answer({ ok: true, messageId: 'm3' })
    const { messageId } = await decideApproval(chatBase('/api', 'm2'), 'p', reject)
    expect(messageId).toBe('m3')
    const turns = rejectWithFollowUp([planTurn], 'm2', 'p', reject.feedback, messageId)
    expect(toRunState(turns[0]!.state, 0, []).approvals?.[0]).toMatchObject({ decision: 'skip', feedback: 'sin sección de precios' })
    expect(turns[1]).toMatchObject({ messageId: 'm3', prompt: 'sin sección de precios', request: { prompt: 'sin sección de precios', mode: 'plan', model: 'opus' } })
    expect(rejectWithFollowUp(turns, 'm2', 'p', reject.feedback, 'm3')).toHaveLength(2)
    answer({ ok: true })
    const plain = await decideApproval(chatBase('/api', 'm2'), 'p', { decision: 'reject' })
    expect(rejectWithFollowUp([planTurn], 'm2', 'p', undefined, plain.messageId)).toHaveLength(1)
  } finally {
    globalThis.fetch = real
  }
})
