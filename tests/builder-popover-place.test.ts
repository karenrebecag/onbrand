import { expect, test } from 'bun:test'
import { placePopover } from '../apps/builder/src/lib/popover-place'

const area = { width: 1440, height: 900 }
const size = { width: 200, height: 190 }

// QA 2026-10-29: con un texto largo en el frame móvil el popover salía del lienzo. Stitch elige lado por espacio (320 px)
// y se ancla a la altura del clic.
test('a la derecha si cabe, a la izquierda si no, a la altura del clic', () => {
  const r = placePopover({ x: 100, y: 100, width: 300, height: 40 }, 120, area, size)
  expect(r).toMatchObject({ side: 'right', anchor: { x: 406, y: 120 }, popover: { x: 446 } })
  const l = placePopover({ x: 1200, y: 100, width: 200, height: 2000 }, 600, area, size)
  expect(l.side).toBe('left')
  expect(l.anchor).toEqual({ x: 1194, y: 600 })
  expect(l.popover.x + size.width + 40).toBe(1194)
})

test('el popover no sale del lienzo aunque el elemento sea más alto que la vista', () => {
  const r = placePopover({ x: 100, y: -500, width: 300, height: 3000 }, 2000, area, size)
  expect(r.anchor.y).toBe(892)
  expect(r.popover.y).toBe(900 - 190 - 8)
  expect(r.connectorEnd).toEqual({ x: r.popover.x, y: r.anchor.y })
})

test('sin lugar a los lados va abajo, centrado y dentro del ancho', () => {
  const r = placePopover({ x: 10, y: 100, width: 1420, height: 40 }, 120, area, size)
  expect(r.side).toBe('bottom')
  expect(r.popover).toEqual({ x: 620, y: 186 })
})
