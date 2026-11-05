import { useRef, useState } from 'react'
import * as Menu from '@radix-ui/react-dropdown-menu'
import { CheckIcon, CircleHelpIcon, HandIcon, ImageIcon, MenuIcon, MousePointer2Icon, PaletteIcon, PencilIcon, PlayIcon, LoaderCircleIcon, Redo2Icon, SquareArrowOutUpRightIcon, SquareDashedIcon, StarIcon, Undo2Icon } from 'lucide-react'
import { Button } from '@/components/arc/button/button'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
import composerStyles from '@/components/arc/blocks/ai-composer/ai-composer.module.css'
import type { CanvasView, History } from './artboard-canvas'
import type { CanvasNodes } from '@/lib/use-canvas-nodes'
import type { Favorites } from '@/lib/use-favorites'
import type { Theme } from '@/lib/use-builder'
import type { BrandSummary } from '@/lib/run-client'
import { IMAGE_TYPES, UPLOAD_MESSAGES } from '@/lib/canvas-upload'
import { ExportMenu } from './export-menu'
import { SessionMenuButton } from './session-menu'
import { sessionMenuOf, sessionProvider } from '@/lib/session-provider'
import { ThemePanel, type ThemePanelProps } from './theme-panel'
import { urlFor } from '@/lib/preview-access'
import { Off } from './off'
import styles from './builder.module.css'

const SOON = 'todavía no existe en el builder'

export function TopBarLeft({ title }: { title: string }) {
  // El provider se fija antes de montar (setSessionProvider en el entry de la distro): leerlo una vez basta.
  const [session] = useState(() => sessionMenuOf(sessionProvider()))
  return (
    <div className={styles.topLeft}>
      {session ? <SessionMenuButton menu={session} /> : (
        <Off note={`Menú: ${SOON}`} side="bottom">
          <Button variant="ghost" size="sm" className={`${styles.roundIcon} ${styles.menuIcon}`} aria-label="Menú" disabled><MenuIcon size={18} /></Button>
        </Off>
      )}
      <span className={styles.title}>{title}</span>
    </div>
  )
}

/** `exportOf`: transport y versión vigente; sin ellos Exportar queda apagado. */
/** `previewToken`: el token del latido del chat; una pestaña nueva no tiene la cookie del iframe (Partitioned), así que lo lleva en la url. */
export function TopBarRight({ previewUrl, previewToken, exportOf }: { previewUrl: string | null; previewToken?: () => string | undefined; exportOf?: { api: string; messageId: string; chatId: string } }) {
  return (
    <div className={styles.topRight}>
      <Tooltip content="Abrir el preview en otra pestaña" side="bottom">
        <Button variant="ghost" size="sm" className={styles.roundIcon} aria-label="Abrir el preview" disabled={!previewUrl} onClick={() => previewUrl && window.open(urlFor(previewUrl, previewToken?.()), '_blank', 'noopener')}><PlayIcon size={16} /></Button>
      </Tooltip>
      {exportOf ? <ExportMenu api={exportOf.api} messageId={exportOf.messageId} chatId={exportOf.chatId} /> : (
        <Off note="Exportar: todavía no hay una versión" side="bottom">
          <Button variant="ghost" size="sm" className={styles.pillButton} aria-label="Exportar" disabled><SquareArrowOutUpRightIcon size={16} aria-hidden="true" /><span className={styles.pillLabel}>Exportar</span></Button>
        </Off>
      )}
    </div>
  )
}

const AUTO = '__auto'

/** Acento, fondo y texto de la marca. Un acento por preset del contrato no trae hex: la muestra queda vacía con su nombre. */
function Swatches({ brand }: { brand: BrandSummary }) {
  const colors = [brand.accent, brand.background, brand.foreground]
  return (
    <span className={styles.themeSwatches} aria-hidden="true">
      {colors.map((c, i) => <span key={i} className={styles.themeSwatch} data-empty={!c || undefined} style={c ? { background: c } : undefined} />)}
    </span>
  )
}

function brandNote(b: BrandSummary): string {
  if (b.error) return b.error
  const fonts = [b.fonts?.display, b.fonts?.body].filter((f, i, all) => f && all.indexOf(f) === i).join(' / ')
  return [b.preset ? `acento ${b.preset}` : '', fonts].filter(Boolean).join(' · ') || b.id
}

/** Tema de Stitch: las marcas publicadas con sus colores. Antes del primer pedido se elige la del T1; con chat queda la
 * vigente marcada, porque cambiarla sobre una versión es applyBrand (H7a) y todavía no tiene ruta. */
function ThemeMenu({ theme }: { theme: Theme }) {
  const value = theme.current ?? AUTO
  return (
    <Menu.Root modal={false} onOpenChange={(open) => { if (open) theme.load() }}>
      <Tooltip content="Tema" side="left">
        <Menu.Trigger asChild>
          <Button variant="ghost" size="sm" className={styles.railTool} aria-label="Tema"><PaletteIcon size={18} /></Button>
        </Menu.Trigger>
      </Tooltip>
      <Menu.Portal>
        <Menu.Content className={`${composerStyles.menu} ${composerStyles.modelMenu}`} side="left" align="center" sideOffset={8} collisionPadding={12} loop>
          <Menu.Label className={styles.themeHead}>Marca</Menu.Label>
          {theme.brands === null ? <p className={styles.themeEmpty}>Cargando marcas…</p> : (
            <Menu.RadioGroup value={value} onValueChange={(v) => theme.choose(v === AUTO ? undefined : v)}>
              {!theme.locked && (
                <Menu.RadioItem value={AUTO} className={`${composerStyles.menuItem} ${composerStyles.modelItem}`}>
                  <span className={composerStyles.modelItemText}>
                    <span className={composerStyles.modelItemName}>Automática</span>
                    <span className={composerStyles.modelItemNote}>La detecta del pedido</span>
                  </span>
                  <Menu.ItemIndicator><CheckIcon size={16} /></Menu.ItemIndicator>
                </Menu.RadioItem>
              )}
              {theme.brands.map((b) => (
                <Menu.RadioItem key={b.id} value={b.id} disabled={theme.busy || !!b.error} className={`${composerStyles.menuItem} ${composerStyles.modelItem} ${styles.themeItem}`}>
                  <Swatches brand={b} />
                  <span className={composerStyles.modelItemText}>
                    <span className={composerStyles.modelItemName}>{b.name}</span>
                    <span className={composerStyles.modelItemNote}>{brandNote(b)}</span>
                  </span>
                  <Menu.ItemIndicator><CheckIcon size={16} /></Menu.ItemIndicator>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          )}
          {theme.brands?.length === 0 && <p className={styles.themeEmpty}>No hay marcas publicadas.</p>}
          {theme.locked && (
            <>
              <Menu.Separator className={composerStyles.menuSeparator} />
              <p className={styles.themeEmpty}>{theme.busy ? 'Espera a que termine la corrida para cambiar de marca.' : 'Elegir otra marca la aplica a la versión vigente, sin modelo.'}</p>
            </>
          )}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}

/** Rail derecho de Stitch: Seleccionar (V), Marco (M), Editar (E) y Mano (H) funcionan; el resto queda apagado con nota. */
export function ToolRail({ view, images, theme, themePanel, favorites }: { view: CanvasView; images: CanvasNodes; theme?: Theme; themePanel: Pick<ThemePanelProps, 'onPreview' | 'onApply' | 'canApply' | 'ds'>; favorites?: Favorites }) {
  const fileRef = useRef<HTMLInputElement>(null)
  // El diálogo no da punto de colocación y en Stitch la posición la decide su server (index-BNt8DXHu l.5252, fuera de
  // los extracts): aquí la fila empieza en el centro de la vista, donde la persona está mirando.
  const uploadAtCenter = (files: File[]) => {
    const el = view.viewport.current
    if (!el) return
    const r = el.getBoundingClientRect()
    void images.upload(files, view.toWorld({ x: r.left + r.width / 2, y: r.top + r.height / 2 }))
  }
  const tool = (id: 'select' | 'hand' | 'edit' | 'mark', label: string, Icon: typeof HandIcon, key: string) => (
    <Tooltip content={`${label} (${key})`} side="left">
      <Button variant="ghost" size="sm" className={styles.railTool} aria-label={label} aria-pressed={view.tool === id} data-active={view.tool === id || undefined} onClick={() => view.setTool(id)}><Icon size={18} /></Button>
    </Tooltip>
  )
  return (
    <nav className={styles.rail} aria-label="Herramientas">
      {tool('select', 'Seleccionar', MousePointer2Icon, 'V')}
      {tool('mark', 'Marcar una región', SquareDashedIcon, 'M')}
      {tool('edit', 'Editar', PencilIcon, 'E')}
      {tool('hand', 'Mover el lienzo', HandIcon, 'H')}
      {/* "Upload files to canvas" de Stitch (DesignPage l.42260): abre el diálogo y gira mientras sube (l.41212). */}
      {images.ready ? (
        <Tooltip content={UPLOAD_MESSAGES.button} side="left">
          <Button variant="ghost" size="sm" className={styles.railTool} aria-label={UPLOAD_MESSAGES.button} disabled={images.uploading} onClick={() => fileRef.current?.click()}>
            {images.uploading ? <LoaderCircleIcon size={18} className={styles.railSpin} /> : <ImageIcon size={18} />}
          </Button>
        </Tooltip>
      ) : (
        // El lienzo se guarda por chat: antes del primer mensaje no hay dónde.
        <Off note={`${UPLOAD_MESSAGES.button}: primero pide una página`} side="left">
          <Button variant="ghost" size="sm" className={styles.railTool} aria-label={UPLOAD_MESSAGES.button} disabled><ImageIcon size={18} /></Button>
        </Off>
      )}
      <input ref={fileRef} type="file" accept={Object.keys(IMAGE_TYPES).join(',')} multiple hidden
        onChange={(e) => { const files = [...(e.currentTarget.files ?? [])]; e.currentTarget.value = ''; if (files.length) uploadAtCenter(files) }} />
      <span className={styles.railRule} />
      {theme ? <ThemeMenu theme={theme} /> : (
        <Off note="Tema: sin transport no hay marcas" side="left">
          <Button variant="ghost" size="sm" className={styles.railTool} aria-label="Tema" disabled><PaletteIcon size={18} /></Button>
        </Off>
      )}
      <ThemePanel {...themePanel} brandName={theme?.brands?.find((b) => b.id === theme.current)?.name} initialPreset={theme?.brands?.find((b) => b.id === theme.current)?.preset} />
      {/* Panel Favourites de Stitch como filtro: deja a la vista la página y las variantes con estrella. */}
      {favorites?.ids.length ? (
        <Tooltip content={favorites.only ? 'Mostrar todas las variantes' : `Solo favoritas (${favorites.ids.length})`} side="left">
          <Button variant="ghost" size="sm" className={styles.railTool} aria-label="Solo favoritas" aria-pressed={favorites.only} data-active={favorites.only || undefined} onClick={() => favorites.setOnly(!favorites.only)}><StarIcon size={18} fill={favorites.only ? 'currentColor' : 'none'} /></Button>
        </Tooltip>
      ) : (
        <Off note="Favoritas: marca una variante con su estrella" side="left">
          <Button variant="ghost" size="sm" className={styles.railTool} aria-label="Solo favoritas" disabled><StarIcon size={18} /></Button>
        </Off>
      )}
    </nav>
  )
}

/** Abajo a la derecha: deshacer y rehacer entre versiones, y el zoom del lienzo con el menú de Stitch. */
export function ZoomBar({ view, history }: { view: CanvasView; history: History }) {
  const items: { label: string; keys: string; run: () => void; disabled?: boolean }[] = [
    { label: 'Acercar', keys: '⌘+', run: () => view.zoomAt(view.zoom * 1.25) },
    { label: 'Alejar', keys: '⌘-', run: () => view.zoomAt(view.zoom / 1.25) },
    { label: 'Zoom al 100 %', keys: '⇧0', run: () => view.zoomAt(1) },
    { label: 'Encajar todo', keys: '⇧1', run: () => view.fit() },
    { label: 'Zoom a la selección', keys: '⇧2', run: () => view.fit(view.selected ?? undefined), disabled: !view.selected },
  ]
  return (
    <div className={styles.zoomBar}>
      <div className={styles.zoomGroup}>
        <Button variant="ghost" size="sm" className={styles.railTool} aria-label="Deshacer" title="Deshacer (⌘Z)" disabled={!history.undo} onClick={() => history.undo?.()}><Undo2Icon size={16} /></Button>
        <Button variant="ghost" size="sm" className={styles.railTool} aria-label="Rehacer" title="Rehacer (⇧⌘Z)" disabled={!history.redo} onClick={() => history.redo?.()}><Redo2Icon size={16} /></Button>
      </div>
      <Menu.Root modal={false}>
        <Menu.Trigger asChild>
          <button type="button" className={styles.zoomValue} aria-label={`Zoom, ${Math.round(view.zoom * 100)} %`}>{Math.round(view.zoom * 100)}%</button>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content className={composerStyles.menu} side="top" align="end" sideOffset={6} collisionPadding={12} loop>
            {items.map((it) => (
              <Menu.Item key={it.label} className={composerStyles.menuItem} disabled={it.disabled} onSelect={it.run}>
                {it.label}
                <span className={styles.menuMeta}>{it.keys}</span>
              </Menu.Item>
            ))}
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
      <Off note={`Ayuda: ${SOON}`}>
        <Button variant="ghost" size="sm" className={styles.railTool} aria-label="Ayuda" disabled><CircleHelpIcon size={16} /></Button>
      </Off>
    </div>
  )
}
