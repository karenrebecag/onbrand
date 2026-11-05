import { useEffect, useState } from 'react'
import { CopyIcon, GitCompareIcon } from 'lucide-react'
import { Button } from '@/components/arc/button/button'
import SegmentedControl from '@/components/arc/segmented-control/segmented-control'
import { ChatPanel } from '@/components/builder/chat-panel'
import { VersionsMenu } from '@/components/builder/versions-menu'
import { VariantsPanel } from '@/components/builder/variants-panel'
import { CodePane, DiffPane, PlanPane } from '@/components/builder/workspace-panes'
import { ArtboardCanvas, frameViewport, useCanvasView } from '@/components/builder/artboard-canvas'
import { useCanvasKeys } from '@/lib/use-canvas-keys'
import { screenTitle } from '@/lib/frame-label'
import { TopBarLeft, TopBarRight, ToolRail, ZoomBar } from '@/components/builder/canvas-chrome'
import { redoTarget, undoTarget } from '@/lib/undo'
import { dsStatus } from '@/lib/run-client'
import { useCanvasNodes } from '@/lib/use-canvas-nodes'
import { useFavorites } from '@/lib/use-favorites'
import { useCanvasWriter } from '@/lib/canvas-writer'
import styles from '@/components/builder/builder.module.css'
import '@/components/builder/stitch-theme.css'
import { useBuilder, variantTurn, type ComposerChoice } from '@/lib/use-builder'
import { isPageFile } from '@/lib/plus-menu'
import { addElement, type PickedElement } from '@/lib/element-context'
import type { ThemePreview } from '@/lib/theme-draft'
import { pageTitleFromFiles, pendingImagesFromFiles, planFromFiles, sectionSuggestionsFromFiles } from '@/lib/provenance'

type Pane = 'preview' | 'code' | 'diff' | 'plan'

export default function App() {
  const builder = useBuilder()
  const [pane, setPane] = useState<Pane>('preview')
  const view = useCanvasView()
  const [composer, setComposer] = useState<ComposerChoice>()
  const focusRun = builder.variants?.flatMap((g) => g.runs).find((r) => r.messageId === view.selected)
  const canvasWriter = useCanvasWriter(builder.api, builder.chatId)
  const images = useCanvasNodes(builder.api, builder.chatId, builder.canvas, builder.setCanvas, canvasWriter, builder.media)
  const favorites = useFavorites(builder.chatId, builder.canvas, builder.setCanvas, canvasWriter)
  // Elementos que el lápiz mandó al chat con "Editar con IA"; viajan delante del próximo pedido y después se limpian.
  const [elements, setElements] = useState<PickedElement[]>([])
  // Un chip de sección se manda ya, dirigido a esa sección (Stitch selectedNodeIds): el chat lo envía con su modelo.
  const [directed, setDirected] = useState<{ message: string; element: PickedElement } | null>(null)
  const [variantsOpen, setVariantsOpen] = useState(false)
  const [themePreview, setThemePreview] = useState<ThemePreview | null>()
  const head = builder.versions.find((v) => v.head)
  const ds = dsStatus(builder.ds)
  const exportOf = builder.api && head && builder.chatId ? { api: builder.api, messageId: head.messageId, chatId: builder.chatId } : undefined
  const undoTo = builder.busy ? null : undoTarget(builder.versions)
  const redoTo = builder.busy ? null : redoTarget(builder.versions)
  const history = { undo: undoTo ? () => builder.restore(undoTo) : null, redo: redoTo ? () => builder.restore(redoTo) : null }
  useCanvasKeys(view, history, images)
  // Los menús y tooltips de Arc se montan en un portal fuera de la app: la piel tiene que vivir en <html> para alcanzarlos.
  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = 'dark'
    root.dataset.skin = 'stitch'
    return () => { delete root.dataset.theme; delete root.dataset.skin }
  }, [])
  const last = builder.turns.at(-1)
  // Solo un turno que dejó versión tiene cambios que ver: uno detenido antes de escribir o fallido no.
  const done = Boolean(last?.state.snapshot) && !builder.busy
  const pageFiles = builder.files.filter((f) => isPageFile(f.path))
  const plan = planFromFiles(builder.files)
  const sectionSuggestions = sectionSuggestionsFromFiles(builder.files)
  const pendingImages = pendingImagesFromFiles(builder.files)
  const showPlan = Boolean(plan) || pendingImages.length > 0
  // Un turno nuevo puede no traer plan: la pestaña desaparece y se vuelve al preview en vez de dejar un panel vacío.
  const active: Pane = pane === 'plan' && !showPlan ? 'preview' : pane
  const title = screenTitle(pageTitleFromFiles(builder.files), builder.turns[0]?.prompt)

  return (
    <div className={styles.app}>
      <main className={styles.stage}>
        <ArtboardCanvas themePreview={themePreview} history={history} title={title} view={view} url={builder.previewUrl} version={builder.previewVersion} restores={builder.restores} imagesReady={builder.imagesReady} busy={builder.busy} saved={Boolean(last?.state.snapshot)} settled={Boolean(last?.settled)}
          onEditWithAI={(el) => setElements((list) => addElement(list, el))}
          onEditText={builder.editText}
          onDeleteElement={builder.deleteElement}
          onReplaceImage={builder.replaceImage}
          onSectionOp={builder.sectionOp}
          sectionSuggestions={sectionSuggestions}
          onSuggest={(element, message) => setDirected({ message, element })}
          images={images}
          variants={builder.variants}
          onCancelVariant={builder.cancelVariant}
          favorites={favorites}
          chatId={builder.chatId}
          previewUrls={builder.previewUrls}
          remounts={builder.previewRemounts}
          previewSrc={builder.previewSrc}
          onFrameSilent={builder.pokePreview} />
        {/* Código, cambios y plan se abren encima del lienzo, como View Code en Stitch; el lienzo sigue debajo. */}
        {active !== 'preview' && (
          <div className={styles.screen}>
            {active === 'code' && <CodePane key={pageFiles.map((f) => f.path).join('|')} files={pageFiles} />}
            {active === 'diff' && <DiffPane files={builder.diff} />}
            {active === 'plan' && <PlanPane plan={plan} pendingImages={pendingImages} />}
          </div>
        )}
      </main>

      <header className={styles.topBar}>
        <TopBarLeft title={title} />
        <div className={styles.actionPill}>
          <SegmentedControl
            label="Panel"
            value={active}
            onValueChange={(v) => setPane(v as Pane)}
            options={[{ value: 'preview', label: 'Vista previa' }, { value: 'code', label: 'Código' }, { value: 'diff', label: 'Cambios' }, ...(showPlan ? [{ value: 'plan', label: 'Plan' }] : [])]}
          />
          <VersionsMenu versions={builder.versions} busy={builder.busy} onRestore={builder.restore} onUpdateDs={ds?.blocked ? undefined : builder.updateDs} dsUpdate={ds?.update ?? null} />
          {builder.generateVariants && (
            <Button variant="ghost" size="sm" disabled={builder.busy || !builder.versions.length} onClick={() => setVariantsOpen(true)}><CopyIcon size={14} aria-hidden="true" /> Variantes</Button>
          )}
        </div>
        <TopBarRight previewUrl={builder.previewUrl} previewToken={() => (builder.chatId ? builder.previewToken?.(builder.chatId) : undefined)} exportOf={exportOf} />
      </header>

      {builder.generateVariants && (
        <VariantsPanel open={variantsOpen} onOpenChange={setVariantsOpen} onCreate={(options) => builder.generateVariants!(options, composer)} />
      )}

      <ChatPanel
        builder={builder}
        context={title}
        elements={elements}
        onElements={setElements}
        directed={directed}
        onDirectedSent={() => setDirected(null)}
        focus={focusRun && variantTurn(focusRun)}
        onComposer={setComposer}
        viewport={frameViewport(view.selected, view.frames)}
        resultAction={done && last?.state.snapshot?.files.length ? <Button size="sm" variant="secondary" onClick={() => setPane('diff')}><GitCompareIcon size={14} /> Ver cambios</Button> : null}
      />
      <ToolRail view={view} images={images} theme={builder.theme} themePanel={{ onPreview: setThemePreview, onApply: builder.applyTheme, canApply: !builder.busy && builder.versions.length > 0, ds }} favorites={favorites} />
      <ZoomBar view={view} history={history} />
    </div>
  )
}
