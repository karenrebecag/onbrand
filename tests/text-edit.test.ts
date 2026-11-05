import { expect, test } from 'bun:test'
import ts from 'typescript'
import { quickEditText } from '../src/runtime/text-edit'

const hero = `export function Hero() {\n  return (\n    <section>\n      <h1>Planes para\n        crecer</h1>\n      <p>Empieza hoy &amp; paga después</p>\n    </section>\n  )\n}\n`
const cta = `const items = ['Hablar con ventas', 'Ver precios']\n`

// Mismo orden que Mp de Stitch: el texto del DOM llega con el salto de línea de JSX colapsado, con & sin escapar o en
// otro caso; cada forma cae en su estrategia.
test('encuentra el texto visible en el TSX con las estrategias de Stitch', () => {
  const files = { 'src/sections/01-hero.tsx': hero, 'src/sections/02-cta.tsx': cta }
  expect(quickEditText(ts, files, 'Ver precios', 'Ver planes')).toMatchObject({ ok: true, path: 'src/sections/02-cta.tsx', strategy: 'exact' })
  const wrapped = quickEditText(ts, files, 'Planes para crecer', 'Planes que crecen')
  expect(wrapped).toMatchObject({ ok: true, strategy: 'br-tolerant' })
  expect(wrapped.ok && wrapped.source).toContain('<h1>Planes que crecen</h1>')
  expect(quickEditText(ts, files, 'Empieza hoy & paga después', 'Empieza hoy & paga luego')).toMatchObject({ ok: true, strategy: 'html-entity' })
  expect(quickEditText(ts, files, 'HABLAR CON VENTAS', 'Hablar con nosotros')).toMatchObject({ ok: true, strategy: 'case-insensitive' })
})

// Stitch toma la primera coincidencia de un solo HTML; con varias secciones eso cambiaría otra sin avisar.
test('un texto repetido o ausente no se toca y pide Editar con IA', () => {
  const files = { 'src/sections/01-a.tsx': `<p>Precios</p>`, 'src/sections/02-b.tsx': `<h2>Precios</h2>` }
  expect(quickEditText(ts, files, 'Precios', 'Planes')).toMatchObject({ ok: false, reason: 'ambiguous' })
  expect(quickEditText(ts, files, 'Contacto', 'Hablemos')).toMatchObject({ ok: false, reason: 'not-found' })
})

test('el texto nuevo no puede abrir JSX ni expandir patrones de replace', () => {
  const files = { 'src/App.tsx': `<p>Hola</p>` }
  expect(quickEditText(ts, files, 'Hola', '{process.env.X}')).toMatchObject({ ok: false, reason: 'unsafe' })
  expect(quickEditText(ts, files, 'Hola', '<script>')).toMatchObject({ ok: false, reason: 'unsafe' })
  const dollar = quickEditText(ts, files, 'Hola', 'Desde $& al mes')
  expect(dollar.ok && dollar.source).toBe(`<p>Desde $& al mes</p>`)
})

// Un texto corto también aparece en clases, rutas e imports: solo cuenta el que se ve en la página.
test('no cambia className, href, ids ni imports aunque contengan el texto', () => {
  const files = { 'src/sections/01-hero.tsx': `import Precios from './precios'\nconst links = [{ href: '/precios', label: 'Ver' }]\nexport const A = () => <a className="precios" id="precios" href="/precios">Precios</a>\n` }
  const r = quickEditText(ts, files, 'precios', 'planes')
  expect(r).toMatchObject({ ok: true, strategy: 'case-insensitive' })
  expect(r.ok && r.source).toContain(`href="/precios">planes</a>`)
  expect(r.ok && r.source).toContain(`import Precios from './precios'`)
  expect(r.ok && r.source).toContain(`{ href: '/precios', label: 'Ver' }`)
})

// Reportado por security-reviewer: una comilla del texto nuevo cerraba el literal y metía código que compila.
test('dentro de un string la comilla del texto nuevo queda escapada', () => {
  const files = { 'src/sections/02-cta.tsx': `const items = ['Hablar con ventas']\n` }
  const r = quickEditText(ts, files, 'Hablar con ventas', "x', alert(1), '")
  expect(r.ok && r.source).toBe(`const items = ['x\\', alert(1), \\'']\n`)
})

// Security re-review 2026-10-29: un match pegado a la \ de \n apareaba el escape del texto nuevo con ella y la comilla
// cerraba el literal; en un atributo JSX no hay escapes, así que la comilla se rechaza.
test('el texto nuevo no puede cerrar el literal apoyándose en una barra del fuente ni en un atributo JSX', () => {
  expect(quickEditText(ts, { 'src/App.tsx': `export const t = 'Hola\\nmundo'` }, 'nmundo', "'+alert(1)//")).toMatchObject({ ok: false, reason: 'not-found' })
  const attr = { 'src/App.tsx': `export const A = () => <Hero title="Hola mundo" />` }
  expect(quickEditText(ts, attr, 'Hola mundo', 'x" href="javascript:alert(1)')).toMatchObject({ ok: false, reason: 'unsafe' })
  const ok = quickEditText(ts, attr, 'Hola mundo', "Hola, ¿qué tal?")
  expect(ok.ok && ok.source).toContain(`title="Hola, ¿qué tal?"`)
})

// E2 del audit: texto JSX y un atributo de texto (title="...", 5 s de tsc medidos por Orq) se guardan sin tsc; un
// literal de datos (puede estar tipado como unión) no.
test('marca si el reemplazo cayó en texto JSX, en un atributo de texto o en un literal de datos', () => {
  const files = { 'src/sections/01-hero.tsx': hero, 'src/sections/02-cta.tsx': cta, 'src/sections/03-faq.tsx': `export const F = () => <Faq title="Preguntas frecuentes" />\n` }
  expect(quickEditText(ts, files, 'Planes para crecer', 'Planes que crecen')).toMatchObject({ ok: true, typeSafe: true })
  expect(quickEditText(ts, files, 'Preguntas frecuentes', 'Lo que quieres saber')).toMatchObject({ ok: true, typeSafe: true })
  expect(quickEditText(ts, files, 'Ver precios', 'Ver planes')).toMatchObject({ ok: true, typeSafe: false })
})
