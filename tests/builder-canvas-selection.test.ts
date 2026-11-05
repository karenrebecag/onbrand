import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { contextSelection, formatNodes, mergeSelection, nodesInRect, rectFrom, type CanvasNode } from '../apps/builder/src/lib/canvas-nodes'

// docs/spec/seleccion-lienzo.md §5. La capa (canvas-selection.tsx) se importa dentro de cada test: trae React y Radix.
const node = (id: string, x: number, y: number, width = 100, height = 100): CanvasNode => ({ id, kind: 'image', src: id, name: id, x, y, width, height })

// §5.1 selectionMode Partial de Stitch (DP l.58799): basta con tocar el nodo; pegado al borde no es tocar.
test('el rectángulo elige lo que toca en cualquier dirección; pegado al borde no entra', () => {
  const nodes = [node('a', 0, 0), node('b', 200, 0)]
  expect(nodesInRect(nodes, rectFrom({ x: 90, y: 90 }, { x: 50, y: 50 }))).toEqual(['a'])
  expect(nodesInRect(nodes, rectFrom({ x: 250, y: 10 }, { x: 90, y: 20 }))).toEqual(['a', 'b'])
  expect(nodesInRect(nodes, rectFrom({ x: 100, y: 0 }, { x: 200, y: 50 }))).toEqual([])
})

// §5.2 multiSelectionKeyCode: con Shift se conserva lo de antes; sin Shift, la base vacía lo reemplaza.
test('selectMany con base suma; sin base reemplaza', () => {
  expect([...mergeSelection(['b'], new Set(['a']))]).toEqual(['a', 'b'])
  expect([...mergeSelection(['b'], new Set())]).toEqual(['b'])
})

// §5.3 SA de Stitch (DP l.46139-46181): filas por y con 50 de tolerancia, 64 entre nodos, 144 entre filas, salto a 5000.
test('Ordenar arma filas por y y x, salta al pasar 5000 y no muta la entrada', () => {
  const input = [node('c', 0, 900, 2000, 300), node('b', 500, 20, 2000, 300), node('a', 100, 0, 2000, 300), node('d', 9000, 30, 2000, 500)]
  const before = JSON.stringify(input)
  const at = Object.fromEntries(formatNodes(input, { x: 0, y: 1000 }).map((o) => [o.id, [o.x, o.y]]))
  expect(at.a).toEqual([0, 1000])
  expect(at.b).toEqual([2064, 1000])
  expect(at.d).toEqual([0, 1000 + 300 + 144])
  expect(at.c).toEqual([2064, 1000 + 300 + 144])
  expect(JSON.stringify(input)).toBe(before)
})

// §5.4 Ordenar escribe una sola vez y solo por images.format (que guarda por canvas-writer, #649); el encuadre llega
// después, con las cajas ya movidas.
test('Ordenar llama a format una vez y encuadra con las imágenes movidas', async () => {
  const { runFormat } = await import('../apps/builder/src/components/builder/canvas-selection')
  const formats: { x: number; y: number }[] = []
  const fits: unknown[] = []
  const later: (() => void)[] = []
  runFormat({ nodes: [node('a', 5, 5)], frames: [{ h: 900 }, { h: 844 }], format: (o) => formats.push(o), fit: (_id, o) => fits.push(o?.extra), later: (fn) => later.push(fn) })
  expect(formats).toEqual([{ x: 0, y: 900 + 144 }])
  expect(fits).toEqual([])
  later.forEach((fn) => fn())
  expect(fits).toEqual([[{ ...node('a', 0, 1044) }]])
})

// §5.5 onNodeContextMenu de Stitch: dentro de una selección múltiple la conserva; fuera, elige solo esa.
test('clic derecho en una imagen de la selección múltiple la conserva; en otra, elige solo esa', () => {
  expect(contextSelection(new Set(['a', 'b']), 'a')).toBeNull()
  expect(contextSelection(new Set(['a', 'b']), 'c')).toEqual(['c'])
  expect(contextSelection(new Set(['a']), 'a')).toEqual(['a'])
})

// §5.6 Pegar sin imágenes o sin permiso avisa en el toast y no escribe.
test('pegar sin imágenes o con el portapapeles bloqueado avisa y no coloca nada', async () => {
  const { pasteImages, CLIPBOARD_EMPTY, CLIPBOARD_DENIED } = await import('../apps/builder/src/components/builder/canvas-selection')
  const placed: File[][] = [], notes: string[][] = []
  await pasteImages(async () => [], async (f) => { placed.push(f) }, (m) => notes.push(m))
  await pasteImages(async () => { throw new Error('NotAllowedError') }, async (f) => { placed.push(f) }, (m) => notes.push(m))
  expect(notes).toEqual([[CLIPBOARD_EMPTY], [CLIPBOARD_DENIED]])
  expect(placed).toEqual([])
})

// §5.8 Guarda B3 de A9: la capa no escribe directo; todo pasa por useCanvasNodes → canvas-writer.
test('canvas-selection no importa run-client ni canvas-writer', () => {
  const src = readFileSync(join(import.meta.dir, '../apps/builder/src/components/builder/canvas-selection.tsx'), 'utf8')
  const imports = src.split('\n').filter((l) => l.startsWith('import '))
  expect(imports.filter((l) => /run-client|canvas-writer/.test(l))).toEqual([])
})
