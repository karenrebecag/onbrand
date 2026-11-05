import { expect, test } from 'bun:test'
import { createJsxDEV, sourceOf, WT_SOURCE, type JsxDev, type SourceWindow, type WtSource } from '../templates/base-scaffold/src/wt-source'
import { wtSourcePlugin } from '../templates/base-scaffold/vite.config'

const ROOT = '/ws/abc'
const FRAGMENT = Symbol('fragment')
type El = { type: unknown; props: Record<string, unknown> & { ref: (n: unknown) => unknown } }
const base: JsxDev = (type, props) => ({ type, props })
const at = (file: string, line: number, col: number) => ({ fileName: `${ROOT}/${file}`, lineNumber: line, columnNumber: col })
const tagged = (n: object): WtSource | undefined => (n as { [WT_SOURCE]?: WtSource })[WT_SOURCE]

// S6: el elemento que se elige en el preview le llega al agente con su archivo:línea:col relativo al workspace.
test('un nodo host queda marcado con su archivo:línea:col y en el mapa, sin perder la ref que ya traía', () => {
  const win: SourceWindow = {}
  const jsx = createJsxDEV(base, FRAGMENT, ROOT, win)
  const own = { current: null as unknown }
  const el = jsx('h1', { ref: own, children: 'Hola' }, undefined, false, at('src/sections/02-hero.tsx', 4, 7)) as El
  const node = {}
  el.props.ref(node)
  expect(tagged(node)).toEqual({ file: 'src/sections/02-hero.tsx', line: 4, col: 7 })
  expect(own.current).toBe(node)
  expect([...win.wtSourceMap!.get('src/sections/02-hero.tsx:4:7')!].map((r) => r.deref())).toEqual([node])
  expect(jsx(FRAGMENT, {}, undefined, false, at('src/App.tsx', 1, 1))).toEqual({ type: FRAGMENT, props: {} })
})

// Un <a> del DS se engancha primero con la línea de action.tsx; el <Action> del hero la reemplaza porque es la editable.
test('la línea del DS cede ante la del JSX de la sección que lo usa, y no al revés', () => {
  const jsx = createJsxDEV(base, FRAGMENT, ROOT, {})
  const node = {}
  ;(jsx('a', {}, undefined, false, at('src/components/arc/action.tsx', 30, 5)) as El).props.ref(node)
  ;(jsx(() => null, {}, undefined, false, at('src/sections/02-hero.tsx', 17, 13)) as El).props.ref(node)
  expect(tagged(node)).toEqual({ file: 'src/sections/02-hero.tsx', line: 17, col: 13 })
  ;(jsx(() => null, {}, undefined, false, at('src/App.tsx', 12, 9)) as El).props.ref(node)
  expect(tagged(node)?.file).toBe('src/sections/02-hero.tsx')
})

test('sourceOf sube hasta el primer origen fuera del DS', () => {
  const section = { parentElement: null, [WT_SOURCE]: { file: 'src/sections/03-features.tsx', line: 9, col: 5 } }
  const inner = { parentElement: section, [WT_SOURCE]: { file: 'src/components/arc/card.tsx', line: 12, col: 3 } }
  expect(sourceOf(inner as unknown as Element)).toEqual({ file: 'src/sections/03-features.tsx', line: 9, col: 5 })
  expect(sourceOf({ parentElement: null } as unknown as Element)).toBeUndefined()
})

// QA H5: el h1 lo pinta un bloque del DS y el JSX de 02-hero.tsx no queda en el DOM; sin corte, subía hasta el <main> de
// App.tsx (App.tsx:17). En el borde de la sección va el archivo de la sección, sin línea inventada.
test('sourceOf corta en la sección y devuelve su archivo sin línea', () => {
  const attrs = (slug?: string) => ({ getAttribute: (n: string) => (n === 'data-wt-slug' ? slug ?? null : null) })
  const main = { parentElement: null, ...attrs(), [WT_SOURCE]: { file: 'src/App.tsx', line: 17, col: 7 } }
  const section = { parentElement: main, ...attrs('02-hero') }
  const h1 = { parentElement: section, ...attrs(), [WT_SOURCE]: { file: 'src/components/blocks/hero.tsx', line: 40, col: 9 } }
  expect(sourceOf(h1 as unknown as Element)).toEqual({ file: 'src/sections/02-hero.tsx' })
  // Un origen propio fuera del DS gana antes de llegar al borde; un slug con forma rara no arma una ruta.
  const own = { parentElement: section, ...attrs(), [WT_SOURCE]: { file: 'src/sections/02-hero.tsx', line: 21, col: 5 } }
  expect(sourceOf(own as unknown as Element)).toEqual({ file: 'src/sections/02-hero.tsx', line: 21, col: 5 })
  const odd = { parentElement: main, ...attrs('../x') }
  expect(sourceOf({ parentElement: odd, ...attrs() } as unknown as Element)).toEqual({ file: 'src/App.tsx', line: 17, col: 7 })
})

// El build no puede llevar el marcador, y el runtime virtual tiene que poder importar el jsx-dev-runtime real.
test('el plugin solo corre en serve y no se redirige a sí mismo', () => {
  const p = wtSourcePlugin(ROOT)
  expect(p.apply).toBe('serve')
  expect(p.enforce).toBe('pre')
  const resolve = p.resolveId as (id: string, importer?: string) => string | null
  const virtual = resolve('react/jsx-dev-runtime', `${ROOT}/src/sections/02-hero.tsx`)
  expect(virtual).toBe('\0wt-source/jsx-dev-runtime')
  expect(resolve('react/jsx-dev-runtime', virtual!)).toBeNull()
  expect(resolve('react', `${ROOT}/src/App.tsx`)).toBeNull()
  expect((p.load as (id: string) => string | null)(virtual!)).toContain(`createJsxDEV(R.jsxDEV, R.Fragment, "${ROOT}"`)
})
