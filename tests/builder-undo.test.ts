import { expect, test } from 'bun:test'
import { redoTarget, undoTarget } from '../apps/builder/src/lib/undo'
import type { Version } from '../apps/builder/src/lib/run-client'

const v = (messageId: string, restoreFrom: string | null = null, head = false): Version => ({ messageId, parentId: null, commit: messageId, title: messageId, at: null, restoreFrom, head })

// Deshacer dos veces vuelve dos pasos aunque cada undo sea una versión nueva; rehacer vuelve hacia adelante.
test('deshacer y rehacer recorren los cambios, no las versiones de restore', () => {
  expect(undoTarget([v('a'), v('b'), v('c', null, true)])?.messageId).toBe('b')
  expect(redoTarget([v('a'), v('b'), v('c', null, true)])).toBeNull()
  const afterUndo = [v('a'), v('b'), v('c'), v('r1', 'b', true)]
  expect(undoTarget(afterUndo)?.messageId).toBe('a')
  expect(redoTarget(afterUndo)?.messageId).toBe('c')
  const afterRedo = [v('a'), v('b'), v('c'), v('r1', 'b'), v('r2', 'c', true)]
  expect(redoTarget(afterRedo)).toBeNull()
  expect(undoTarget(afterRedo)?.messageId).toBe('b')
})

test('sin versión anterior no hay nada que deshacer', () => {
  expect(undoTarget([v('a', null, true)])).toBeNull()
  expect(undoTarget([])).toBeNull()
})
