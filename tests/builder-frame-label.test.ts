import { expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import { frameA11yTitle, frameLabel, GENERATING_LABEL, screenTitle, UNTITLED } from '../apps/builder/src/lib/frame-label'

// react vive en apps/builder: la raíz del repo no lo instala, y sus tipos solo se alcanzan por ruta explícita.
const load = createRequire(import.meta.url)
const { createElement } = load('../apps/builder/node_modules/react') as typeof import('../apps/builder/node_modules/@types/react')
const { renderToStaticMarkup } = load('../apps/builder/node_modules/react-dom/server') as typeof import('../apps/builder/node_modules/@types/react-dom/server')

// docs/spec/nombre-pantalla.md §5.1, opción (a): encima de los marcos de la página va el título de la pantalla (DP l.10017).
test('la etiqueta de la página es el título; la variante, el suyo; generando, Generando pantalla', async () => {
  expect(frameLabel({ title: 'Landing Nimbus', generating: false })).toBe('Landing Nimbus')
  expect(frameLabel({ title: 'Landing Nimbus', generating: true })).toBe(GENERATING_LABEL)
  expect(frameLabel({ title: 'Landing Nimbus', generating: true, variantTitle: 'Más oscura' })).toBe('Más oscura')
  const { FrameLabel } = await import('../apps/builder/src/components/builder/frame-label')
  expect(renderToStaticMarkup(createElement(FrameLabel, { title: 'Landing Nimbus', generating: false }))).toContain('>Landing Nimbus</span>')
})

// §5.2: los dos marcos dicen lo mismo encima; el lector de pantalla los distingue por el title del iframe.
test('el title del iframe lleva título y dispositivo', () => {
  expect(frameA11yTitle('Landing Nimbus', 'Móvil')).toBe('Landing Nimbus, móvil')
})

// §5.3: page.title → primera línea del primer prompt → Nueva página.
test('el título sale de page.json, si no del prompt (primera línea), si no Nueva página', () => {
  expect(screenTitle('Landing Nimbus', 'Haz una landing')).toBe('Landing Nimbus')
  expect(screenTitle(undefined, '\nHaz una landing\ncon precios')).toBe('Haz una landing')
  expect(screenTitle('  ', undefined)).toBe(UNTITLED)
})
