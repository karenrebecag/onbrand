import { expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { BUILDER_SRC, blockImports } from './helpers/block-imports'

const load = createRequire(import.meta.url)
const { createElement, Fragment } = load('../apps/builder/node_modules/react')
const { renderToStaticMarkup } = load('../apps/builder/node_modules/react-dom/server')
const BLOCK = join(BUILDER_SRC, 'components/arc/blocks/ai-composer')

const composer = () => import('../apps/builder/src/components/arc/blocks/ai-composer/composer')
const data = () => import('../apps/builder/src/components/arc/blocks/ai-composer/composer-data')

async function render(extra: object) {
  const { Composer } = await composer()
  const { sampleModels } = await data()
  const props = {
    models: sampleModels, model: sampleModels[0], effort: 'medium', webSearch: true, thinking: false,
    onModel() {}, onEffort() {}, onTool() {}, busy: false, progress: null, progressSeconds: 0, run: 0,
    placeholder: 'Describe la página…', maxLength: 4000, reduced: true, onSubmit() {}, onStop() {}, announce() {},
    enhance: async () => '', ...extra,
  }
  return renderToStaticMarkup(createElement(Composer, props)) as string
}

// Karen (decisión 16): el composer se queda en el core y el builder lo adapta con marca, textos y tres zonas de contenido.
// Sin slot sale el default del proyecto byte a byte, así la captura antes/después se compara por texto.
test('sin slot el HTML es el del default del proyecto byte a byte', async () => {
  const { ModelMark } = await import('../apps/builder/src/components/arc/blocks/ai-composer/composer-parts')
  const { DEFAULT_COMPOSER_COPY } = await import('../apps/builder/src/components/arc/blocks/ai-composer/composer-slots')
  const plain = await render({})
  const explicit = await render({ slots: { mark: (mark: string) => createElement(ModelMark, { mark }), copy: DEFAULT_COMPOSER_COPY } })
  expect(explicit).toBe(plain)
  for (const text of ['aria-label="Mensaje"', 'Búsqueda web', 'Mejorar el prompt', 'Opus 5.5', 'Medio']) expect(plain).toContain(text)
})

// Arq (PR 2): el host decide qué va en las zonas, no dónde. El contexto va sobre el mensaje y los chips detrás de las
// herramientas y antes del modelo, con el contenido real del builder.
test('las zonas del builder caen donde las pone el bloque', async () => {
  const { PlanChip, RulesChip } = await import('../apps/builder/src/components/builder/composer-extras')
  const html = await render({
    slots: {
      chips: createElement(Fragment, null, createElement(PlanChip, { on: true, onToggle() {} }), createElement(RulesChip, { count: 2, onOpen() {} })),
      context: createElement('span', { 'data-ctx': '' }, 'Hero'),
    },
  })
  const at = (needle: string) => { const i = html.indexOf(needle); expect({ needle, found: i >= 0 }).toEqual({ needle, found: true }); return i }
  expect(at('data-ctx')).toBeLessThan(at('<textarea'))
  expect(at('Plan, encendido')).toBeGreaterThan(at('aria-label="Búsqueda web"'))
  expect(at('Plan, encendido')).toBeLessThan(at('Modelo: Claude Opus 5.5'))
  expect(await render({})).not.toContain('Plan, encendido')
})

test('mark y copy cambian solo su parte', async () => {
  const html = await render({ slots: { mark: (m: string) => createElement('i', { 'data-mark': m }), copy: { messageLabel: 'Pedido', searchLabel: 'Web' } } })
  for (const text of ['<i data-mark="claude"></i>', 'aria-label="Pedido"', 'aria-label="Web"', 'Mejorar el prompt']) expect(html).toContain(text)
  expect(html).not.toContain('aria-label="Mensaje"')
})

test('el composer no importa el core y de apps/builder/src/lib solo importaría tipos', () => {
  expect(blockImports(BLOCK).offenders).toEqual([])
})
