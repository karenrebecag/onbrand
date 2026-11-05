import { useRef, useState } from 'react'
import * as Menu from '@radix-ui/react-dropdown-menu'
import { ChevronRightIcon } from 'lucide-react'
import composerStyles from '@/components/arc/blocks/ai-composer/ai-composer.module.css'
import { IMAGE_TYPES } from '@/lib/canvas-upload'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
import styles from './builder.module.css'

interface CanvasMenuProps {
  /** Punto del clic derecho en px de pantalla; null = cerrado. */
  at: { x: number; y: number } | null
  onClose: () => void
  undo: (() => void) | null
  redo: (() => void) | null
  /** Pega imágenes del portapapeles en el punto; null si el navegador no deja leerlo o no hay chat. */
  onPaste: (() => void) | null
  /** Format de Stitch: recoloca las imágenes y encuadra. */
  onFormat: () => void
  /** Sube archivos y los coloca en el punto del clic; null si todavía no hay dónde guardar. */
  onUpload: ((files: File[]) => void) | null
}


/** Menú del lienzo `Yj` de Stitch (DesignPage l.48775, static-rail-tools.md §3d), en su orden: Undo/Redo, Paste,
 * Format, Add ▸ Upload file. Add Text no está: Stitch lo oculta sin el flag `textNode` (l.58854, l.48839) y el builder
 * no tiene nodos de texto. Debug tampoco: es del modo debug interno de Stitch. Se ancla en el punto del
 * clic derecho con un disparador invisible, porque el builder no trae el ContextMenu de Radix. */
export function CanvasMenu({ at, onClose, undo, redo, onPaste, onFormat, onUpload }: CanvasMenuProps) {
  const fileRef = useRef<HTMLInputElement>(null)
  // El ancla se queda en el último punto mientras el menú se cierra (si volviera a 0,0 el menú saltaría al cerrar).
  const [point, setPoint] = useState(at)
  if (at && at !== point) setPoint(at)
  const item = (label: string, keys: string | null, run: (() => void) | null, off = '') => run
    ? <Menu.Item className={composerStyles.menuItem} onSelect={run}>{label}{keys && <span className={styles.menuMeta}>{keys}</span>}</Menu.Item>
    : <Tooltip content={`${label}: ${off}`} side="right"><Menu.Item className={`${composerStyles.menuItem} ${styles.menuItemOff}`} disabled>{label}{keys && <span className={styles.menuMeta}>{keys}</span>}</Menu.Item></Tooltip>

  return (
    <>
      <Menu.Root open={!!at} onOpenChange={(open) => { if (!open) onClose() }} modal={false}>
        <Menu.Trigger asChild>
          <span className={styles.menuAnchor} style={{ left: point?.x ?? 0, top: point?.y ?? 0 }} aria-hidden="true" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content className={composerStyles.menu} side="bottom" align="start" sideOffset={2} collisionPadding={12} loop aria-label="Lienzo">
            {item('Deshacer', '⌘Z', undo, 'no hay nada que deshacer')}
            {item('Rehacer', '⇧⌘Z', redo, 'no hay nada que rehacer')}
            <Menu.Separator className={composerStyles.menuSeparator} />
            {item('Pegar', '⌘V', onPaste, 'el navegador no deja leer el portapapeles o todavía no hay chat')}
            {item('Ordenar', '⇧⌘F', onFormat)}
            <Menu.Separator className={composerStyles.menuSeparator} />
            <Menu.Sub>
              <Menu.SubTrigger className={composerStyles.menuItem}>Agregar<ChevronRightIcon size={14} className={styles.menuMeta} /></Menu.SubTrigger>
              <Menu.Portal>
                <Menu.SubContent className={composerStyles.menu} sideOffset={2} collisionPadding={12}>
                  {item('Subir archivo', null, onUpload ? () => fileRef.current?.click() : null, 'primero pide una página')}
                </Menu.SubContent>
              </Menu.Portal>
            </Menu.Sub>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
      <input ref={fileRef} type="file" accept={Object.keys(IMAGE_TYPES).join(',')} multiple hidden
        onChange={(e) => { const files = [...(e.currentTarget.files ?? [])]; e.currentTarget.value = ''; if (files.length) onUpload?.(files) }} />
    </>
  )
}
