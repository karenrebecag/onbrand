import { useEffect, useRef } from 'react'
import type { CanvasView, History } from '@/components/builder/artboard-canvas'
import { DELETE_KEYS } from './canvas-nodes'
import type { CanvasNodes } from './use-canvas-nodes'

// Atajos del lienzo (docs/spec/seleccion-lienzo.md §3). useCanvasKeys salió de artboard-canvas.tsx tal cual (B1); los de
// la capa de selección (⌘V y ⇧⌘F, PR3) van en useSelectionKeys, que monta canvas-selection, dueña de pegar y ordenar.

export const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))

/** Atajos de Stitch: ⌘+ / ⌘- / ⇧0 (100 %) / ⇧1 (encajar) / ⇧2 (a la selección), V seleccionar, H mano, E editar. */
export function useCanvasKeys(view: CanvasView, history: History, images: CanvasNodes) {
  const { zoom, zoomAt, fit, selected, setTool } = view
  const { undo, redo } = history
  const { selected: picked, removeSelected } = images
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target)) return
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); (e.shiftKey ? redo : undo)?.() }
      // deleteKeyCode de Stitch (DesignPage l.57925): Backspace o Delete borran las imágenes elegidas.
      else if (!mod && DELETE_KEYS.includes(e.key) && picked.size) { e.preventDefault(); removeSelected() }
      else if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomAt(zoom * 1.25) }
      else if (mod && e.key === '-') { e.preventDefault(); zoomAt(zoom / 1.25) }
      else if (e.shiftKey && e.code === 'Digit0') zoomAt(1)
      else if (e.shiftKey && e.code === 'Digit1') fit()
      else if (e.shiftKey && e.code === 'Digit2') fit(selected ?? undefined)
      else if (!mod && !e.shiftKey && e.key.toLowerCase() === 'v') setTool('select')
      else if (!mod && !e.shiftKey && e.key.toLowerCase() === 'h') setTool('hand')
      else if (!mod && !e.shiftKey && e.key.toLowerCase() === 'e') setTool('edit')
      else if (!mod && !e.shiftKey && e.key.toLowerCase() === 'm') setTool('mark')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoom, zoomAt, fit, selected, setTool, undo, redo, picked, removeSelected])
}

type KeyLike = Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'key' | 'target'>

/** ⇧⌘F de Stitch: Ordenar. No mientras se escribe en un campo. */
export const isFormatKey = (e: KeyLike): boolean => !typing(e.target) && (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f'

/** ⌘V llega como evento paste del navegador, que trae los archivos sin pedir permiso de portapapeles (a diferencia de
 * clipboard.read del menú). null mientras se escribe en un campo: ese pegado es del campo. */
export function pastedFiles(e: { target: EventTarget | null; clipboardData: { files: ArrayLike<File> } | null }): File[] | null {
  if (typing(e.target)) return null
  return Array.from(e.clipboardData?.files ?? [])
}

export interface SelectionKeys {
  /** ⌘V con archivos: los coloca en el último punto del puntero. */
  paste: (files: File[]) => void
  /** ⌘V sin archivos: el toast lo dice, como Pegar del menú. */
  empty: () => void
  format: () => void
}

export function useSelectionKeys(keys: SelectionKeys) {
  const live = useRef(keys)
  useEffect(() => { live.current = keys })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (isFormatKey(e)) { e.preventDefault(); live.current.format() } }
    const onPaste = (e: ClipboardEvent) => {
      const files = pastedFiles(e)
      if (files === null) return
      e.preventDefault()
      if (files.length) live.current.paste(files)
      else live.current.empty()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('paste', onPaste)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('paste', onPaste) }
  }, [])
}
