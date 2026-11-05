import { expect, test } from 'bun:test'
import type { MessageState } from '../src/runtime/event-model'
import { ownStats } from '../apps/builder/src/lib/run-state'

const diff = [{ path: 'src/sections/01-hero.tsx', additions: 3, deletions: 1 }]

// E2E de Stop (UI): "Detenido antes de cambiar la página" salía junto a "7 archivos cambiados", que eran los de la versión anterior.
test('un turno detenido o en error sin versión propia no muestra los archivos de la versión anterior', () => {
  const stopped: MessageState = { messageId: 's1', status: 'stopped', steps: [], text: '' }
  const failed: MessageState = { messageId: 'e1', status: 'error', steps: [], text: '', error: { message: 'x' } }
  expect(ownStats(stopped, diff)).toEqual([])
  expect(ownStats(failed, diff)).toEqual([])
  expect(ownStats({ ...stopped, snapshot: { dir: '/w', files: ['src/sections/01-hero.tsx'] } }, diff)).toEqual(diff)
})
