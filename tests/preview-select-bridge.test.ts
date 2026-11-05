import { afterEach, expect, test } from 'bun:test'
import { describe, labelOf, parseSelectMessage, plainText, selectorOf } from '../templates/base-scaffold/src/wt-select-bridge'

// Los tests de describe() ponen un window/document falsos en globalThis. bun corre todos los archivos en el mismo proceso:
// sin restaurarlos, los tests que corren después (bloques con motion, run-client) ven un "navegador" sin addEventListener
// ni setTimeout y fallan según el orden de archivos (CI en Linux).
const realGlobals = { window: Object.getOwnPropertyDescriptor(globalThis, 'window'), document: Object.getOwnPropertyDescriptor(globalThis, 'document') }
afterEach(() => {
  for (const [k, d] of Object.entries(realGlobals)) {
    if (d) Object.defineProperty(globalThis, k, d)
    else delete (globalThis as Record<string, unknown>)[k]
  }
})

const BUILDER = 'http://localhost:5320'

type N = { tagName: string; classList: string[]; parentElement: N | null; previousElementSibling: N | null; nextElementSibling: N | null }
const node = (tagName: string, classList: string[] = [], parentElement: N | null = null): N => ({ tagName, classList, parentElement, previousElementSibling: null, nextElementSibling: null })
const siblings = (...ns: N[]) => ns.forEach((n, i) => { n.previousElementSibling = ns[i - 1] ?? null; n.nextElementSibling = ns[i + 1] ?? null })

// El selector viaja al agente y vuelve para editar: tiene que ubicar el mismo elemento aunque el puente no esté.
test('el selector sube hasta body con hasta 3 clases y nth-of-type solo entre hermanos de la misma etiqueta', () => {
  const body = node('BODY')
  const main = node('MAIN', ['page'], body)
  const a = node('SECTION', ['hero', 'dark', 'wide', 'extra'], main)
  const b = node('SECTION', ['pricing', 'wt-selected'], main)
  siblings(a, b)
  const h2 = node('H2', [], b)
  expect(selectorOf(h2)).toBe('main.page > section.pricing:nth-of-type(2) > h2')
  expect(selectorOf(node('P', [], a))).toBe('main.page > section.hero.dark.wide:nth-of-type(1) > p')
  expect(selectorOf(a)).toBe('main.page > section.hero.dark.wide:nth-of-type(1)')
})

test('la etiqueta del elemento sigue las categorías de Stitch', () => {
  expect(['IMG', 'H3', 'BUTTON', 'A', 'INPUT', 'LI', 'P', 'DIV'].map((t) => labelOf(t))).toEqual(['Imagen', 'Título', 'Botón', 'Enlace', 'Campo', 'Elemento de lista', 'Texto', 'Contenedor'])
  expect(labelOf('SVG', true)).toBe('Icono')
})

// Cualquier página que embeba el preview podría encender el modo edición si el puente no filtra el origen.
test('solo el origen del builder enciende o limpia la selección', () => {
  expect(parseSelectMessage({ type: 'wt:select-mode', active: true }, BUILDER, BUILDER)).toEqual({ mode: true })
  expect(parseSelectMessage({ type: 'wt:select-clear' }, BUILDER, BUILDER)).toEqual({ clear: true })
  expect(parseSelectMessage({ type: 'wt:select-mode', active: true }, 'https://evil.example', BUILDER)).toBeNull()
  expect(parseSelectMessage({ type: 'wt:select-mode', active: 'yes' }, BUILDER, BUILDER)).toBeNull()
})

// Edit Text y Delete: el builder pide editar u ocultar y, si el transport no pudo guardar, que la página vuelva a lo que dice el código.
test('editar, ocultar y revertir solo llegan desde el builder', () => {
  expect(parseSelectMessage({ type: 'wt:edit-text' }, BUILDER, BUILDER)).toEqual({ editText: true })
  expect(parseSelectMessage({ type: 'wt:edit-revert' }, BUILDER, BUILDER)).toEqual({ revert: true })
  expect(parseSelectMessage({ type: 'wt:hide-selected' }, BUILDER, BUILDER)).toEqual({ hide: true })
  expect(parseSelectMessage({ type: 'wt:edit-text' }, 'https://evil.example', BUILDER)).toBeNull()
  expect(plainText('  Planes para\n        crecer ')).toBe('Planes para crecer')
})

// QA e2e 2026-10-29: con text-transform: uppercase, innerText daba "PLANES…" y Eliminar no encontraba el texto en el código.
test('el texto del elemento sale como está en el código, no como lo pinta el CSS', () => {
  Object.assign(globalThis, { window: { scrollX: 0, scrollY: 0 } })
  const el = { tagName: 'SPAN', textContent: 'Planes\n        transparentes', innerText: 'PLANES TRANSPARENTES', children: [], classList: [], parentElement: null, previousElementSibling: null, nextElementSibling: null, getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }) }
  expect(describe(el as unknown as Element).text).toBe('Planes transparentes')
})

// El builder ofrece subir/bajar/duplicar/quitar la sección del elemento; los extremos salen de la posición en <main>.
test('el elemento viaja con su sección de <main> y su posición; fuera de <main> no lleva sección', () => {
  Object.assign(globalThis, { window: { scrollX: 0, scrollY: 0 } })
  const sec = (slug: string) => ({ getAttribute: (k: string) => (k === 'data-wt-slug' ? slug : null), parentElement: { closest: () => null } })
  const all = [sec('02-hero'), sec('03-casos'), sec('04-precios')]
  Object.assign(globalThis, { document: { querySelectorAll: () => all } })
  const el = (own: unknown) => ({ tagName: 'H2', textContent: 'Casos', children: [], classList: [], parentElement: null, previousElementSibling: null, nextElementSibling: null, closest: () => own, getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }) })
  expect(describe(el(all[1]) as unknown as Element).section).toEqual({ slug: '03-casos', index: 1, count: 3 })
  expect(describe(el(null) as unknown as Element).section).toBeUndefined()
})

// Cambiar imagen: el src nuevo entra al <img> de la página antes de guardarse; un esquema que no es de imagen no entra.
test('wt:replace-image solo acepta http(s) o un archivo de public/uploads', () => {
  expect(parseSelectMessage({ type: 'wt:replace-image', src: 'https://a.com/b.png' }, BUILDER, BUILDER)).toEqual({ replaceSrc: 'https://a.com/b.png' })
  expect(parseSelectMessage({ type: 'wt:replace-image', src: '/uploads/foto-abc123.png' }, BUILDER, BUILDER)).toEqual({ replaceSrc: '/uploads/foto-abc123.png' })
  expect(parseSelectMessage({ type: 'wt:replace-image', src: 'javascript:alert(1)' }, BUILDER, BUILDER)).toBeNull()
  expect(parseSelectMessage({ type: 'wt:replace-image', src: 'https://a.com/b.png' }, 'https://evil.test', BUILDER)).toBeNull()
})

// H14 Marco: la región manda primero lo que queda entero adentro, en orden de lectura, y después lo que solo toca,
// por cuánto de su caja cae dentro; con tope. El mensaje del builder exige una caja con lados positivos.
test('el marco elige lo contenido primero, después lo que más toca, con tope; y valida la región', async () => {
  const { pickInRect, WT_SELECT_RECT } = await import('../templates/base-scaffold/src/wt-select-bridge')
  const box = (id: string, x: number, y: number, width: number, height: number) => ({ id, rect: { x, y, width, height } })
  const items = [box('half', 50, 0, 100, 10), box('in1', 10, 10, 20, 20), box('out', 500, 500, 10, 10), box('in2', 40, 40, 10, 10), box('edge', 90, 90, 100, 100)]
  const area = { x: 0, y: 0, width: 100, height: 100 }
  expect(pickInRect(items, area).map((i) => i.id)).toEqual(['in1', 'in2', 'half', 'edge'])
  expect(pickInRect(items, area, 2).map((i) => i.id)).toEqual(['in1', 'in2'])
  expect(parseSelectMessage({ type: WT_SELECT_RECT, rect: area }, BUILDER, BUILDER)).toEqual({ rect: area })
  expect(parseSelectMessage({ type: WT_SELECT_RECT, rect: { ...area, width: 0 } }, BUILDER, BUILDER)).toBeNull()
  expect(parseSelectMessage({ type: WT_SELECT_RECT, rect: area }, 'https://evil.example', BUILDER)).toBeNull()
})
