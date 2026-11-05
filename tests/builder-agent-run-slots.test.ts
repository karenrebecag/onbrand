import { expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import { join, sep } from 'node:path'
import { BUILDER_SRC, REPO, blockImports, resolveSpec, typeOnly } from './helpers/block-imports'

const load = createRequire(import.meta.url)
const { createElement } = load('../apps/builder/node_modules/react')
const { renderToStaticMarkup } = load('../apps/builder/node_modules/react-dom/server')
const BLOCK = join(BUILDER_SRC, 'components/arc/blocks/agent-run')

const approval = { toolName: 'mcp__slack__post', app: 'slack', input: { text: 'hola' } }
const run = {
  status: 'done' as const,
  elapsedMs: 64_000,
  steps: [{ id: 's1', mark: 'read' as const, verb: 'Leyendo', doneVerb: 'Leído', target: 'index.html', status: 'done' as const }],
  approvals: [
    { ...approval, callId: 'c1', kind: 'write' as const, decision: 'allow' as const },
    { ...approval, callId: 'c2', kind: 'plan' as const, decision: 'skip' as const, feedback: 'más corto', input: {} },
  ],
  result: { summary: 'Listo el hero', files: [{ path: 'index.html', additions: 3, deletions: 1 }], tests: { passed: 4, total: 5 } },
}

const block = () => import('../apps/builder/src/components/arc/blocks/agent-run/agent-run')
const slotsModule = () => import('../apps/builder/src/components/arc/blocks/agent-run/agent-run-slots')

// Karen (decisión 16): el bloque se queda en el core y el builder lo adapta solo en lo visual (marcas, tipos, modelo, textos).
// Sin slot tiene que salir el default del proyecto byte a byte, para que la captura antes/después se compare por texto.
test('sin slot el HTML es el del default del proyecto byte a byte', async () => {
  const { AgentRun } = await block()
  const { defaultSlots, DEFAULT_COPY } = await slotsModule()
  const html = (slots?: object) => renderToStaticMarkup(createElement(AgentRun, { run, task: 'Hero', slots }))
  const plain = html()
  expect(html({ mark: defaultSlots.mark, kind: defaultSlots.kind, copy: DEFAULT_COPY })).toBe(plain)
  for (const text of ['Leído', 'Listo el hero', '4 de 5 tests pasaron', 'Permitido', 'Rechazado', 'más corto', '1 paso · 1m 04s']) expect(plain).toContain(text)
})

test('cada slot cambia solo su parte visual: marca, tipo, modelo y textos', async () => {
  const { AgentRun } = await block()
  const html = renderToStaticMarkup(createElement(AgentRun, {
    run: { ...run, status: 'working' as const, approvals: [{ ...approval, callId: 'c3', kind: 'write' as const }] },
    task: 'Hero',
    onDecideTool: async () => undefined,
    slots: {
      mark: (m: string) => createElement('i', { 'data-mark': m }),
      kind: (k: string) => ({ label: `tipo-${k}`, icon: createElement('b', null, 'K') }),
      model: createElement('em', null, 'marca-host'),
      copy: { allow: 'Dale', skip: 'Paso' },
    },
  }))
  for (const text of ['<i data-mark="read"></i>', 'tipo-write', '<b>K</b>', '<em>marca-host</em>', '>Dale<', '>Paso<', 'Nada cambia en Slack hasta que lo permitas.']) expect(html).toContain(text)
  expect(html).not.toContain('>Permitir<')
})

test('el bloque no importa el core y de apps/builder/src/lib solo importa tipos', () => {
  const { offenders, libTypeImports } = blockImports(BLOCK)
  expect(offenders).toEqual([])
  // ToolDecision/PlanDecision son los de run-client: si alguien vuelve a copiarlos, este contador baja a 0.
  expect(libTypeImports).toBeGreaterThan(0)
})

test('el detector de imports marca un import mixto o del core', () => {
  expect(typeOnly(undefined, '{ type A, type B }')).toBe(true)
  expect(typeOnly('type ', '{ A }')).toBe(true)
  expect(typeOnly(undefined, '{ type A, b }')).toBe(false)
  expect(typeOnly(undefined, 'Def')).toBe(false)
  const f = join(BLOCK, 'x.tsx')
  expect(resolveSpec(f, '@/lib/run-client')).toBe(join(BUILDER_SRC, 'lib/run-client'))
  expect(resolveSpec(f, '../../../../lib/run-client')).toBe(join(BUILDER_SRC, 'lib/run-client'))
  expect(resolveSpec(f, '../../../../../../../src/runtime/server')!.startsWith(join(REPO, 'src') + sep)).toBe(true)
  expect(resolveSpec(f, 'react')).toBeNull()
})
