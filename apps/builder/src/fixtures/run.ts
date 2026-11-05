// Corrida de ejemplo con los pasos reales del runner (feat/v0-runner, ArqWebTransformer). Mientras el
// motor no emita, el builder se prueba reproduciendo este log: si falta un campo para pintar algo,
// aparece aquí y no cuando el motor ya esté cerrado.

import { EVENT_VERSION, type EngineEvent, type EventBody } from '@engine/runtime/event-model'

const MESSAGE_ID = 'msg_nimbus_1'
const START = 1_792_690_000_000

type Timed = [delayMs: number, body: EventBody]

// Como agent-composer: el turno del agente es un paso y sus escrituras cuelgan de él.
const AGENT_STEP = 'agent:write'

const sections = ['hero', 'logos', 'features', 'stats', 'testimonials', 'pricing', 'faq', 'cta', 'footer']

const writeSteps: Timed[] = sections.flatMap((role, i) => {
  const id = `w${i}`
  const path = `src/sections/${String(i + 1).padStart(2, '0')}-${role}.tsx`
  const label = role === 'faq' ? 'FAQ' : role
  return [
    [450, { type: 'step.start', stepId: id, kind: 'write', label: `Writing ${label}`, parentStepId: AGENT_STEP }],
    [900, { type: 'step.end', stepId: id, label: `Wrote ${label}`, status: 'ok', detail: { kind: 'write', path, op: 'create' } }],
  ]
})

const timeline: Timed[] = [
  [0, { type: 'message.start' }],
  [200, { type: 'step.start', stepId: 't0', kind: 'thinking', label: 'Thinking' }],
  [400, { type: 'step.output', stepId: 't0', text: 'Nimbus es una herramienta de gestión para equipos remotos. ' }],
  [500, { type: 'step.output', stepId: 't0', text: 'La página necesita hero con waitlist, prueba social, features en columnas, precios con toggle anual y un cierre con CTA.' }],
  [700, { type: 'step.end', stepId: 't0', label: 'Thought for 2s', status: 'ok' }],
  [300, { type: 'step.start', stepId: 's1', kind: 'tool', label: 'Checking components' }],
  [800, { type: 'step.end', stepId: 's1', label: 'Checked components', status: 'ok', detail: { kind: 'tool', name: 'allowlist', output: { unknown: [], layoutErrors: [] } } }],
  [300, { type: 'step.start', stepId: 's2', kind: 'action', label: 'Preparing workspace' }],
  [900, { type: 'step.end', stepId: 's2', label: 'Prepared workspace', status: 'ok', detail: { kind: 'action', name: 'scaffold', summary: 'scaffold + starter' } }],
  [300, { type: 'step.start', stepId: 's3', kind: 'read', label: 'Fetching Arc sources' }],
  [800, { type: 'step.end', stepId: 's3', label: 'Fetched Arc sources', status: 'ok', detail: { kind: 'read', paths: ['arc/hero-signup', 'arc/logo-marquee', 'arc/feature-bento', 'arc/stats-band', 'arc/faq-section'] } }],
  [300, { type: 'step.start', stepId: AGENT_STEP, kind: 'action', label: 'Escribiendo la página' }],
  ...writeSteps,
  [400, { type: 'step.start', stepId: 'w9', kind: 'write', label: 'Writing page', parentStepId: AGENT_STEP }],
  [600, { type: 'step.end', stepId: 'w9', label: 'Wrote page', status: 'ok', detail: { kind: 'write', path: 'src/App.tsx', op: 'create' } }],
  [200, { type: 'step.end', stepId: AGENT_STEP, label: 'Escribió la página', status: 'ok', detail: { kind: 'action', name: 'agent', summary: '10 archivos' } }],
  [300, { type: 'step.start', stepId: 'b1', kind: 'bash', label: 'Installing dependencies' }],
  [600, { type: 'step.output', stepId: 'b1', text: 'bun install v1.3.14\n' }],
  [900, { type: 'step.output', stepId: 'b1', text: '+ 214 packages installed [2.31s]\n' }],
  [200, { type: 'step.end', stepId: 'b1', label: 'Installed dependencies', status: 'ok', detail: { kind: 'bash', command: 'bun install --frozen-lockfile', exitCode: 0 } }],
  [300, { type: 'step.start', stepId: 'b2', kind: 'bash', label: 'Building' }],
  [700, { type: 'step.output', stepId: 'b2', text: 'vite v8.3.4 building for production...\n' }],
  [1200, { type: 'step.output', stepId: 'b2', text: '✓ 412 modules transformed.\ndist/index.html  0.46 kB\n✓ built in 1.84s\n' }],
  [200, { type: 'step.end', stepId: 'b2', label: 'Built', status: 'ok', detail: { kind: 'bash', command: 'vite build', exitCode: 0 } }],
  [400, { type: 'text.delta', text: 'Armé la landing de **Nimbus** con 9 secciones: ' }],
  [250, { type: 'text.delta', text: 'hero con waitlist, logos, features, stats, testimonios, precios con toggle anual, FAQ, CTA y footer.\n\n' }],
  [250, { type: 'text.delta', text: 'Los logos y los testimonios son de ejemplo; cámbialos por los reales antes de publicar.' }],
  [300, { type: 'message.end', finishReason: 'stop', usage: { credits: 2.15 } }],
  [1800, { type: 'snapshot', dir: 'generated/nimbus-waitlist/dist', files: ['index.html'] }],
]

/** El log ya serializado, con seq y `at` como los escribiría openEventLog. */
export const fixtureEvents: EngineEvent[] = timeline.reduce<{ at: number; out: EngineEvent[] }>(
  (acc, [delay, body], seq) => {
    const at = acc.at + delay
    const event = { ...body, v: EVENT_VERSION, messageId: MESSAGE_ID, seq, at } as EngineEvent
    return { at, out: [...acc.out, event] }
  },
  { at: START, out: [] },
).out

export const fixturePrompt =
  'Landing para Nimbus, gestión de proyectos para equipos remotos. Waitlist en el hero, precios con toggle anual y FAQ.'
