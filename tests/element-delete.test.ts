import { expect, test } from 'bun:test'
import tsRuntime from '../templates/base-scaffold/node_modules/typescript'
import { deleteElement } from '../src/runtime/element-delete'

// El scaffold se resuelve por symlink a otro checkout: mismo módulo, identidad de tipos distinta para tsc.
const ts = tsRuntime as unknown as typeof import('typescript')

const hero = `import { Badge } from '@/components/arc/badge/badge'
import styles from './01-hero.module.css'

export function Hero() {
  return (
    <section className={styles.hero}>
      <Badge>Planes transparentes
        sin letra chica</Badge>
      <h1>Invierte en resultados</h1>
      <img src="/images/panel.png" alt="Panel" />
    </section>
  )
}
`

// Como el remove_element de Stitch: sale el elemento entero, y aquí también su import si era el último uso, porque
// noUnusedLocals no dejaría compilar el archivo.
test('borra el elemento del texto elegido y el import que queda sin uso', () => {
  const r = deleteElement(ts, { 'src/sections/01-hero.tsx': hero }, { kind: 'text', text: 'Planes transparentes sin letra chica' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.source).not.toContain('Badge')
  expect(r.source).toContain("import styles from './01-hero.module.css'\n")
  expect(r.source).toContain('<section className={styles.hero}>\n      <h1>Invierte en resultados</h1>')
})

test('una imagen se ubica por su src aunque el DOM lo traiga absoluto', () => {
  const r = deleteElement(ts, { 'src/sections/01-hero.tsx': hero }, { kind: 'image', src: 'http://127.0.0.1:5360/images/panel.png' })
  expect(r.ok && r.source).not.toContain('<img')
})

test('texto repetido, que sale de datos o que es la raíz no se borra', () => {
  const twice = { 'src/sections/01-a.tsx': `export const A = () => <div><p>Precios</p></div>`, 'src/sections/02-b.tsx': `export const B = () => <div><p>Precios</p></div>` }
  expect(deleteElement(ts, twice, { kind: 'text', text: 'Precios' })).toMatchObject({ ok: false, reason: 'ambiguous' })
  const data = { 'src/App.tsx': `const items = ['Hola']\nexport const L = () => <ul>{items.map((i) => <li key={i}>{i}</li>)}</ul>` }
  expect(deleteElement(ts, data, { kind: 'text', text: 'Hola' })).toMatchObject({ ok: false, reason: 'not-found' })
  const root = { 'src/App.tsx': `export const R = () => <p>Solo</p>` }
  expect(deleteElement(ts, root, { kind: 'text', text: 'Solo' })).toMatchObject({ ok: false, reason: 'unsafe' })
})
