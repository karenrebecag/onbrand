import { expect, test } from 'bun:test'
import ts from 'typescript'
import { composeEdits, parseElements, parsePlan } from '../src/runtime/patch-ai'

const hero = `export function Hero() {\n  return (\n    <section>\n      <h1>Planes para crecer</h1>\n      <p>Sin tarjeta</p>\n    </section>\n  )\n}\n`
const faq = `export function Faq() {\n  return (\n    <section>\n      <h2>Preguntas</h2>\n      <img src="https://cdn.example.com/faq.png" alt="" />\n    </section>\n  )\n}\n`
const files = { 'src/sections/01-hero.tsx': hero, 'src/sections/02-faq.tsx': faq }

// El plan viene de un modelo: lo que no está en el schema v1 o apunta fuera de src/ no se aplica, vuelve al turno.
test('un plan con una op fuera del schema o un archivo fuera de src/ vuelve al turno', () => {
  expect(parsePlan({ route: 'patch', ops: [{ op: 'set_style', file: 'src/sections/01-hero.tsx', style: 'color:red' }] })).toMatchObject({ route: 'full', reason: 'op fuera del schema' })
  expect(parsePlan({ route: 'patch', ops: [{ op: 'set_text', file: '../secrets.tsx', before: 'a', after: 'b' }] })).toMatchObject({ route: 'full' })
  expect(parsePlan({ route: 'full', reason: 'cambia colores' })).toEqual({ route: 'full', reason: 'cambia colores' })
  expect(parsePlan('texto suelto')).toMatchObject({ route: 'full' })
  // Sin el origen en el código de cada elemento no hay a dónde apuntar: el pedido sigue el turno normal.
  expect(parseElements([{ kind: 'text', tagName: 'h1', text: 'Hola' }])).toBeUndefined()
  expect(parseElements([{ source: { file: 'src/sections/01-hero.tsx', line: 4, col: 6 }, kind: 'text', tagName: 'h1', text: 'Hola' }])).toHaveLength(1)
})

test('set_text y remove en dos archivos dan una sola edición con los dos archivos cambiados', () => {
  const r = composeEdits(ts, files, [
    { op: 'set_text', file: 'src/sections/01-hero.tsx', before: 'Planes para crecer', after: 'Planes que crecen' },
    { op: 'remove', file: 'src/sections/02-faq.tsx', kind: 'image', src: 'https://cdn.example.com/faq.png' },
  ])
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(Object.keys(r.writes).sort()).toEqual(['src/sections/01-hero.tsx', 'src/sections/02-faq.tsx'])
  expect(r.writes['src/sections/01-hero.tsx']).toContain('<h1>Planes que crecen</h1>')
  expect(r.writes['src/sections/02-faq.tsx']).not.toContain('<img')
  expect(r.copyOnly).toBe(false)
})

// Sin parches parciales: la primera op que no encaja tira todo el plan.
test('una op que no encaja aborta el parche entero', () => {
  const twice = { 'src/sections/01-hero.tsx': `export const A = () => <div><p>Hola</p><p>Hola</p></div>\n` }
  expect(composeEdits(ts, twice, [{ op: 'set_text', file: 'src/sections/01-hero.tsx', before: 'Hola', after: 'Chau' }])).toMatchObject({ ok: false, reason: 'set_text: ambiguous' })
  expect(composeEdits(ts, files, [
    { op: 'set_text', file: 'src/sections/01-hero.tsx', before: 'Planes para crecer', after: 'Planes que crecen' },
    { op: 'set_text', file: 'src/sections/02-faq.tsx', before: 'No existe', after: 'x' },
  ])).toMatchObject({ ok: false, reason: 'set_text: not-found' })
})
