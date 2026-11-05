import { expect, test } from 'bun:test'

const card = () => import('../apps/builder/src/components/arc/blocks/agent-run/tool-approval')

// 400aeb5 manda kind 'spend' para generate_image: la tarjeta lo conoce, y un kind nuevo no la tumba.
test('un kind desconocido se trata como escritura en vez de romper la tarjeta', async () => {
  const { kindInfo } = await card()
  expect(kindInfo('spend').label).toBe('Usa créditos')
  expect(kindInfo('read').label).toBe('Lectura')
  expect(kindInfo('futuro').label).toBe('Escritura')
})

// MediaGenerationApprovalCard de Lovable (:153-157): el prompt se muestra recortado a 200 caracteres.
test('el prompt de la imagen se recorta a 200 caracteres y conserva el completo', async () => {
  const { promptPreview } = await card()
  const long = 'a '.repeat(150)
  const p = promptPreview({ prompt: long })
  expect(p.clipped).toBe(true)
  expect(p.preview.endsWith('…')).toBe(true)
  expect(p.preview.length).toBeLessThanOrEqual(201)
  expect(p.full).toBe(long)
  expect(promptPreview({ prompt: 'Una foto del equipo' })).toEqual({ full: 'Una foto del equipo', preview: 'Una foto del equipo', clipped: false })
  expect(promptPreview(null)).toEqual({ full: '', preview: '', clipped: false })
})

// QA G3 (4421fb97): la tarjeta resuelta sigue en el turno terminado, como la de Lovable (MediaGenerationApprovalCard
// :155-160, :197); la que nunca se decidió no se arrastra.
test('al terminar el turno quedan las aprobaciones decididas', async () => {
  const { toRunState } = await import('../apps/builder/src/lib/run-state')
  const base = { callId: 'c', toolName: 'mcp__wt__generate_image', app: 'wt', input: { prompt: 'equipo celebrando' }, kind: 'spend' as const }
  const message = {
    messageId: 'm', status: 'stop' as const, text: 'Listo', steps: [],
    approvals: [{ ...base, decision: 'allow' as const }, { ...base, callId: 'd' }],
  }
  expect(toRunState(message, 1000, []).approvals?.map((a) => a.callId)).toEqual(['c'])
  expect(toRunState({ ...message, approvals: [] }, 1000, []).approvals).toBeUndefined()
  expect(toRunState({ ...message, status: 'streaming' }, 1000, []).approvals?.length).toBe(2)
})
