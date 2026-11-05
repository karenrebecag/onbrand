import { useMemo, useState } from 'react'
import { BracesIcon, ClipboardIcon, Code2Icon, FileTextIcon, GlobeIcon, PaletteIcon, ServerIcon, SquareArrowOutUpRightIcon } from 'lucide-react'
import { CopyButton } from '@/components/arc/copy-button/copy-button'
import { DropdownMenu, type DropdownItem } from '@/components/arc/dropdown-menu/dropdown-menu'
import { useCopyFeedback } from '@/components/arc/lib/use-copy-feedback'
import { chatBase } from '@/lib/chat-routes'
import { EXPORT_FORMATS, exportUrl, fetchExportFormats, fetchPageHtml, publishVersion, type ExportFormat, type PublishOutcome } from '@/lib/run-client'
import { createExportDownload, publishBlockedBy, saveBlob, type DownloadState } from '@/lib/export-download'
import { apiFetch } from '@/lib/session-provider'
import { mcpPointer } from '@/lib/mcp-pointer'
import styles from './builder.module.css'

const LABELS: Record<Exclude<ExportFormat, 'page'>, { label: string; icon: typeof Code2Icon }> = {
  source: { label: 'Código fuente (.zip)', icon: Code2Icon },
  site: { label: 'Sitio (.zip)', icon: GlobeIcon },
  'design-md': { label: 'DESIGN.md', icon: PaletteIcon },
  brief: { label: 'Brief', icon: FileTextIcon },
}

type Formats = { state: 'loading' } | { state: 'ready'; commit: string; formats: Partial<Record<ExportFormat, boolean>> } | { state: 'error' }
type Publish = PublishOutcome | { state: 'publishing' } | null


/** Lo que se ve junto al botón tras publicar: el menú ya se cerró. El provider local exporta a una carpeta del
 * servidor (file://), no a internet, y el texto lo dice para no venderlo como enlace para compartir. */
function publishNote(pub: Publish): { text: string; error: boolean; url?: string } | null {
  if (!pub) return null
  // La primera publicación de una versión arma el sitio con vite (#694): tarda unos segundos, y el texto lo avisa.
  if (pub.state === 'publishing') return { text: 'Publicando… la primera vez arma el sitio y tarda unos segundos.', error: false }
  if (pub.state === 'published') {
    const local = pub.url.startsWith('file:')
    return { text: local ? 'Exportada en una carpeta de este servidor, no es un enlace público.' : 'Publicada.', error: false, url: pub.url }
  }
  if (pub.state === 'blocked') return { text: `No se puede publicar: ${pub.errors.map((e) => e.path ? `${e.code} (${e.path})` : e.code).join(', ')}`, error: true }
  if (pub.state === 'disabled') return { text: 'Publicar no está habilitado en este servidor.', error: true }
  if (pub.state === 'no-build') return { text: 'Sin build para esta versión.', error: true }
  return { text: `No se pudo publicar: ${pub.message}`, error: true }
}

/** Export de la versión vigente. Los formatos se piden al abrir: dependen de la versión (sin build no hay sitio). */
export function ExportMenu({ api, messageId, chatId }: { api: string; messageId: string; chatId: string }) {
  const base = useMemo(() => chatBase(api, chatId), [api, chatId])
  const [formats, setFormats] = useState<Formats>({ state: 'loading' })
  const [pub, setPub] = useState<Publish>(null)
  const onOpenChange = (open: boolean) => {
    if (!open) return
    setFormats({ state: 'loading' })
    fetchExportFormats(base, messageId)
      .then((f) => setFormats({ state: 'ready', commit: f.commit, formats: f.formats }))
      // Un transport sin /export (404) o una versión sin commit (409): el menú dice que no hay, sin enlazar a nada.
      .catch(() => setFormats({ state: 'error' }))
  }
  const [dl, setDl] = useState<DownloadState<ExportFormat>>({ kind: 'idle' })
  const downloader = useMemo(() => createExportDownload<ExportFormat>({ fetch: (url) => apiFetch(url), urlOf: (f) => exportUrl(base, messageId, f), save: saveBlob, set: setDl }), [base, messageId])
  const { state: copyState, activeKey, copy } = useCopyFeedback()
  // Un transport sin `page` en la lista (versión vieja) la deja apagada.
  const pageAvailable = formats.state === 'ready' && formats.formats.page === true
  const [pageFailed, setPageFailed] = useState(false)
  const copyPage = () => {
    setPageFailed(false)
    return fetchPageHtml(base, messageId).then((html) => copy(html, 'page', html)).catch(() => setPageFailed(true))
  }
  const items: DropdownItem[] = EXPORT_FORMATS.map((f) => {
    const { label, icon: Icon } = LABELS[f]
    const available = formats.state === 'ready' && formats.formats[f]
    const preparing = dl.kind === 'preparing' && dl.format === f
    const meta = formats.state === 'loading' ? 'Cargando…' : formats.state === 'error' ? 'No disponible' : !available ? 'No hay en esta versión' : preparing ? 'Preparando…' : undefined
    return { label, icon: <Icon size={15} />, disabled: !available || preparing, meta, onSelect: () => void downloader.start(f) }
  })
  items.push({
    label: activeKey === 'page' && copyState === 'copied' ? 'Página copiada' : (activeKey === 'page' && copyState === 'error') || pageFailed ? 'No se pudo copiar' : 'Copiar página',
    icon: <ClipboardIcon size={15} />,
    disabled: !pageAvailable,
    meta: formats.state === 'loading' ? 'Cargando…' : formats.state === 'error' ? 'No disponible' : pageAvailable ? undefined : 'No hay en esta versión',
    onSelect: () => void copyPage(),
  })
  // Misma disponibilidad que GET /export: con commit hay versión que leer, aunque no haya build.
  const pointer = formats.state === 'ready' ? mcpPointer({ chatId, messageId, commit: formats.commit, api, origin: window.location.origin }) : null
  items.push({
    label: activeKey === 'mcp' && copyState === 'copied' ? 'Copiado' : activeKey === 'mcp' && copyState === 'error' ? 'No se pudo copiar' : 'Copiar para MCP',
    icon: <BracesIcon size={15} />,
    disabled: !pointer,
    meta: formats.state === 'loading' ? 'Cargando…' : pointer ? undefined : 'No disponible',
    onSelect: () => { if (pointer) void copy(pointer, 'mcp') },
  })
  // Publicar local (H1) vive aquí y no en un menú propio: un solo punto de entrada para sacar la versión del builder.
  const publishing = pub?.state === 'publishing'
  const blockedBy = publishBlockedBy(formats)
  items.push({
    label: 'Publicar en este servidor',
    icon: <ServerIcon size={15} />,
    separatorBefore: true,
    disabled: blockedBy !== null || publishing,
    meta: publishing ? 'Publicando…' : blockedBy ?? undefined,
    onSelect: () => {
      setPub({ state: 'publishing' })
      publishVersion(base, messageId).then(setPub).catch((e: unknown) => setPub({ state: 'error', message: e instanceof Error ? e.message : String(e) }))
    },
  })
  // El menú se cierra al elegir: el estado de la descarga y del publish se ve junto al botón, no dentro del menú.
  const published = publishNote(pub)
  const note = dl.kind === 'preparing' ? { text: 'Preparando descarga…', error: false } : dl.kind === 'error' ? { text: dl.message, error: true } : published
  return (
    <>
      {note && (
        <span className={styles.exportNote} role="status" data-error={note.error || undefined}>
          {note.text}
          {'url' in note && note.url && <CopyButton value={note.url} label="Copiar ruta" />}
        </span>
      )}
      <DropdownMenu label="Exportar" icon={<SquareArrowOutUpRightIcon size={16} />} items={items} triggerClassName={`${styles.pillButton} ${styles.exportTrigger}`} onOpenChange={(open) => {
        if (open && dl.kind === 'error') setDl({ kind: 'idle' })
        if (open && pub && pub.state !== 'publishing') setPub(null)
        onOpenChange(open)
      }} />
    </>
  )
}
