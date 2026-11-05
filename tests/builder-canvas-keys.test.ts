import { afterEach, expect, test } from 'bun:test'
import { isFormatKey, pastedFiles } from '../apps/builder/src/lib/use-canvas-keys'

// typing() pregunta instanceof HTMLElement: bun no trae DOM, así que el test pone una clase mínima y la saca después.
const realHTMLElement = (globalThis as { HTMLElement?: unknown }).HTMLElement
class FakeElement { constructor(readonly tagName: string, readonly isContentEditable = false) {} }
afterEach(() => { (globalThis as { HTMLElement?: unknown }).HTMLElement = realHTMLElement })
const withDom = () => { (globalThis as { HTMLElement?: unknown }).HTMLElement = FakeElement }

// docs/spec/seleccion-lienzo.md §5.7: ⇧⌘F ordena y ⌘V pega (por el evento paste); con el foco en un input, ninguno.
test('⇧⌘F es Ordenar salvo mientras se escribe en un campo', () => {
  withDom()
  const canvas = new FakeElement('DIV') as unknown as EventTarget
  const input = new FakeElement('INPUT') as unknown as EventTarget
  expect(isFormatKey({ metaKey: true, ctrlKey: false, shiftKey: true, key: 'F', target: canvas })).toBe(true)
  expect(isFormatKey({ metaKey: false, ctrlKey: true, shiftKey: true, key: 'f', target: canvas })).toBe(true)
  expect(isFormatKey({ metaKey: true, ctrlKey: false, shiftKey: false, key: 'f', target: canvas })).toBe(false)
  expect(isFormatKey({ metaKey: true, ctrlKey: false, shiftKey: true, key: 'F', target: input })).toBe(false)
})

test('⌘V trae los archivos del portapapeles; vacío da []; en un campo no es del lienzo', () => {
  withDom()
  const file = new File(['x'], 'a.png', { type: 'image/png' })
  const canvas = new FakeElement('DIV') as unknown as EventTarget
  expect(pastedFiles({ target: canvas, clipboardData: { files: [file] } })).toEqual([file])
  expect(pastedFiles({ target: canvas, clipboardData: { files: [] } })).toEqual([])
  expect(pastedFiles({ target: new FakeElement('TEXTAREA') as unknown as EventTarget, clipboardData: { files: [file] } })).toBeNull()
  expect(pastedFiles({ target: new FakeElement('DIV', true) as unknown as EventTarget, clipboardData: { files: [file] } })).toBeNull()
})
