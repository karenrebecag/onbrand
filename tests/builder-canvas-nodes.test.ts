import { expect, test } from 'bun:test'
import { moveNodes, placeImages, removeNodes, snap, toggleSelect } from '../apps/builder/src/lib/canvas-nodes'

// Et + snapGrid [16,16] de Stitch (useImageUploadNotice l.531, DesignPage l.57917).
test('la subida entra en fila desde el punto de drop, escalada y en la grilla', () => {
  const nodes = placeImages([], [{ id: 'a', src: 'blob:a', name: 'a.png', width: 1024, height: 512 }, { id: 'b', src: 'blob:b', name: 'b.png' }], { x: 101, y: 50 })
  expect(nodes.map(({ id, x, y, width, height }) => ({ id, x, y, width, height }))).toEqual([
    { id: 'a', x: 96, y: 48, width: 512, height: 256 },
    { id: 'b', x: 672, y: 48, width: 512, height: 512 },
  ])
})

test('mover suma al origen del arrastre y cae en la grilla; borrar quita los seleccionados', () => {
  const nodes = placeImages([], [{ id: 'a', src: 's', name: 'a' }, { id: 'b', src: 's', name: 'b' }], { x: 0, y: 0 })
  const moved = moveNodes(nodes, new Map([['a', { x: 0, y: 0 }]]), 23, -9)
  expect(moved.map((n) => [n.id, n.x, n.y])).toEqual([['a', 16, -16], ['b', 576, 0]])
  expect(removeNodes(moved, new Set(['a'])).map((n) => n.id)).toEqual(['b'])
  expect(snap(8)).toBe(16)
})

// multiSelectionKeyCode [Shift, Meta] de Stitch (DesignPage l.57929).
test('click selecciona uno; con Shift o Meta suma y quita', () => {
  expect([...toggleSelect(new Set(['a']), 'b', false)]).toEqual(['b'])
  expect([...toggleSelect(new Set(['a']), 'b', true)]).toEqual(['a', 'b'])
  expect([...toggleSelect(new Set(['a', 'b']), 'a', true)]).toEqual(['b'])
})

// NodeResizer de imagen en Stitch (DesignPage l.32531): proporción fija y ancho mínimo 100.
test('redimensionar mantiene la proporción y no baja de 100 de ancho', async () => {
  const { resizeNode } = await import('../apps/builder/src/lib/canvas-nodes')
  const [n] = placeImages([], [{ id: 'a', src: 's', name: 'a', width: 512, height: 256 }], { x: 0, y: 0 })
  expect(resizeNode([n!], n!, 250, 'se')[0]).toMatchObject({ x: 0, y: 0, width: 256, height: 128 })
  expect(resizeNode([n!], n!, 10, 'se')[0]).toMatchObject({ width: 100, height: 50 })
  // Desde la esquina superior izquierda la opuesta (abajo a la derecha) queda en su lugar.
  expect(resizeNode([n!], n!, 256, 'nw')[0]).toMatchObject({ x: 256, y: 128, width: 256, height: 128 })
})

// add de Stitch devuelve el nodo existente con el mismo sourceUri (index-BNt8DXHu l.4186).
test('la misma imagen no crea otro nodo', async () => {
  const { newUploads } = await import('../apps/builder/src/lib/canvas-nodes')
  const nodes = placeImages([], [{ id: 'a', src: 'uploads/x-abc123.png', name: 'x' }], { x: 0, y: 0 })
  expect(newUploads(nodes, [{ src: 'uploads/x-abc123.png' }, { src: 'uploads/y-def456.png' }, { src: 'uploads/y-def456.png' }])).toEqual([{ src: 'uploads/y-def456.png' }])
})
