import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useReducedMotion } from 'motion/react'
import { AgentRun } from '@/components/arc/blocks/agent-run/agent-run'
import { ClaudeMark } from '@/components/arc/blocks/agent-run/agent-run-marks'
import { Composer, type ComposerHandle } from '@/components/arc/blocks/ai-composer/composer'
import type { ComposerModel, Effort } from '@/components/arc/blocks/ai-composer/composer-data'
import { canRestart, composerChoice, instructionsToSend, resumeActionOf, type Builder, type ComposerChoice, type Turn } from '@/lib/use-builder'
import { enhancePrompt, fetchApproval, fetchBrandInstructions, fetchBrandMemory, saveBrandMemory, fetchPlan, isDirectEdit, NotConnectedError, saveBrandInstructions, type ConnectorAccount, type ImageModel, type PermissionMode, type RunElement, type Upload, type Viewport } from '@/lib/run-client'
import { ConnectorsDialog } from './connectors-dialog'
import { openConnectTab } from '@/lib/connect-tab'
import { shownEffort, shownModel } from '@/lib/thread'
import { useSpend } from '@/lib/spend'
import { createRecorder } from '@/lib/recorder'
import { InstructionsDialog, PlanChip, PlusMenuExtras, RulesChip, type BrandRules, type Scope } from './composer-extras'
import { ContextMeter, InventedChip, MemoryNotes } from './turn-context'
import { contrastDefectsOf, contrastFixPrompt, contrastIssuesOf, followUpsOf, lateSuggestionsOf, PLAN_ONLY_TEXT, planOnlyOf, replaceFactPrompt, turnFooterOf, ownStats, questionOf, previewIssueMessages, previewIssueSummary, toRunState, type FileStat } from '@/lib/run-state'
import { newRuntimeErrors, useRuntimeErrors, type ContrastDefect } from '@/lib/runtime-errors'
import { Button } from '@/components/arc/button/button'
import { BellIcon, FileIcon, LoaderCircleIcon, MousePointerClickIcon, Wrench, XIcon } from 'lucide-react'
import { applyTasksPrompt, sectionsOf, sourceLabel, sourceShort, tasksOf, withElementContext, type PickedElement } from '@/lib/element-context'
import { StagedChanges } from './staged-changes'
import { pageTitleFromFiles, suggestionsFromFiles } from '@/lib/provenance'
import { useDoneNotification } from '@/lib/use-done-notification'
import { hostCap, UPLOAD_MAX_BYTES } from '@/lib/upload-limit'
import { chatBase } from '@/lib/chat-routes'
import { NextSteps } from './next-steps'
import { AgentLog, AgentPanelBody, Markdown } from './agent-panel'
import { ContrastNotice } from './contrast-notice'
import styles from './builder.module.css'

// Lo que acepta POST /uploads; el composer corta antes para no subir 30 MB y recibir un 413.
const MAX_UPLOAD = hostCap(UPLOAD_MAX_BYTES)

// Local (sesión de Claude Code): el transport no anuncia modelos y vale esta lista. En el deploy los ids y nombres
// llegan del catálogo de AI Gateway por GET /models; la nota y el esfuerzo por familia son del builder.
const LOCAL_MODELS: ComposerModel[] = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', short: 'Opus 5.5', note: 'Más calidad en páginas largas', mark: 'claude', defaultEffort: 'medium' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', short: 'Sonnet 5.5', note: 'Más rápido para ediciones', mark: 'claude', defaultEffort: 'high' },
]
/** Sin modelo forzado: el cliente manda 'auto' y el server usa su default (modo auto de Lovable). Va al final: el primero sigue siendo el default de la persona. */
const AUTO_MODEL: ComposerModel = { id: 'auto', name: 'Auto', short: 'Auto', note: 'El servidor elige el modelo', mark: 'claude', defaultEffort: 'medium' }
const familyOf = (id: string) => LOCAL_MODELS.find((m) => id.includes(m.short.split(' ')[0].toLowerCase()))

const toComposerModels = (models: ImageModel[]): ComposerModel[] => [...(models.length ? models.map((m) => {
  const name = m.name ?? m.id
  const family = familyOf(m.id)
  return { id: m.id, name, short: name.replace(/^Claude /, ''), note: family?.note ?? '', mark: 'claude' as const, defaultEffort: family?.defaultEffort ?? 'medium' }
}) : LOCAL_MODELS), AUTO_MODEL]

const renderPlan = (markdown: string) => <Markdown text={markdown} />

// Como los tips de Stitch durante la generación, pero solo de cosas que el builder hace hoy.
const TIPS = [
  'Con ⌘ y la rueda acercas el lienzo; ⇧1 lo encaja todo.',
  'H mueve el lienzo y V vuelve a seleccionar.',
  'Versiones guarda cada turno: puedes volver a cualquiera.',
  'El botón de play abre la página en otra pestaña para probarla.',
  'Instrucciones, en el menú +, valen para todos los mensajes del chat.',
]
// Ux/Vx de Stitch (DesignPage deob l.19244-19284): cada 12 s un tip al azar distinto del que se ve.
const TIP_MS = 12_000

/** Vx: con un solo tip lo repite; si no, sortea entre los que no son el actual. */
// El mismo tope que withElementContext y que parseElements del transport.
const RUN_ELEMENTS_MAX = 20

/** Los elementos para la vía de parche del transport (H5). Solo si todos traen su origen con línea (wt-source.ts, en
 * dev): sin él no hay a dónde apuntar una op y el pedido va entero al agente, que lee la descripción del texto. */
export function runElements(elements: readonly PickedElement[]): RunElement[] | undefined {
  const list = elements.slice(0, RUN_ELEMENTS_MAX)
  // Sin línea (solo el archivo de la sección) la op no tiene dónde apuntar: el pedido va al agente.
  if (!list.length || list.some((e) => e.source?.line === undefined)) return undefined
  return list.map((e) => ({ source: { file: e.source!.file, line: e.source!.line!, col: e.source!.col ?? 0 }, kind: e.kind, tagName: e.tagName, text: e.text, ...(e.src ? { src: e.src } : {}), ...(e.section ? { section: e.section.slug } : {}) }))
}

export function nextTip(tips: readonly string[], current: string | undefined, random: () => number = Math.random): string {
  if (tips.length <= 1) return tips[0] ?? ''
  const pool = current ? tips.filter((t) => t !== current) : tips
  return pool[Math.floor(random() * pool.length)]
}

function RotatingTip() {
  const [tip, setTip] = useState(() => nextTip(TIPS, undefined))
  useEffect(() => {
    const t = window.setInterval(() => setTip((cur) => nextTip(TIPS, cur)), TIP_MS)
    return () => window.clearInterval(t)
  }, [])
  return <p className={styles.tip} aria-live="off" data-wt-loading="10">Tip: {tip}</p>
}

interface ChatPanelProps {
  builder: Builder
  resultAction: ReactNode
  /** Lo que el próximo mensaje va a editar, como el chip de pantalla del prompt de Stitch. */
  context: string
  /** Elementos elegidos con el lápiz: chips con × y, al enviar, el bloque "Modifica este elemento" delante del pedido. */
  elements: PickedElement[]
  onElements: (next: PickedElement[]) => void
  /** Un chip de sección del lienzo: se envía una vez, con el modelo y las opciones del chat, dirigido a ese elemento. */
  directed: { message: string; element: PickedElement } | null
  onDirectedSent: () => void
  /** El turno de la variante cuyo marco está seleccionado: su chat es otro y no se mezcla con el del hilo. */
  focus?: Turn
  /** Avisa lo que el composer tiene elegido, para que las variantes corran con eso. */
  onComposer?: (choice: ComposerChoice) => void
  /** Tamaño del marco que la persona mira; viaja con el follow-up. */
  viewport?: Viewport
}

export function ChatPanel({ builder, resultAction, context, elements, onElements, directed, onDirectedSent, focus, onComposer, viewport }: ChatPanelProps) {
  const MODELS = useMemo(() => toComposerModels(builder.models), [builder.models])
  // Sin elección, el primero que anuncia el transport: llega después del primer render.
  const [chosenModel, setModelId] = useState<string>()
  const [chosenEffort, setEffort] = useState<Effort>()
  // Los chips dicen con qué corre Continuar: modelo y esfuerzo del turno cortado, que el transport hereda (#748, #754).
  const tail = builder.turns.at(-1)
  const spend = useSpend(builder.api, tail?.settled ? tail.messageId : undefined)
  const resumed = tail && resumeActionOf(tail, builder.turns, builder.busy) === 'continue' ? tail.request : undefined
  const modelId = shownModel(chosenModel, resumed?.model, MODELS)
  const effort = shownEffort(chosenEffort, resumed?.thinking, (MODELS.find((m) => m.id === modelId) ?? MODELS[0]).defaultEffort)
  const [notice, setNotice] = useState('')
  // Como Stitch: el panel muestra solo el último turno y el registro completo se abre desde la barra de abajo.
  const [logOpen, setLogOpen] = useState(false)
  // Elegir un pedido del registro lo abre arriba; un turno nuevo vuelve a mostrar el último.
  const [selectedId, setSelectedId] = useState<string>()
  const [rules, setRules] = useState<string[]>([])
  const [rulesOpen, setRulesOpen] = useState(false)
  const [rulesScope, setRulesScope] = useState<Scope>('chat')
  const openRules = (scope: Scope) => { setRulesScope(scope); setRulesOpen(true) }
  const composerRef = useRef<ComposerHandle>(null)
  // Al recargar, las del chat llegan con el hilo; si la persona ya las editó en esta vista, mandan las suyas.
  const rulesTouched = useRef(false)
  // El alcance de marca solo existe cuando la página ya tiene una: antes del primer pedido la marca todavía se elige.
  const brandId = builder.theme?.locked ? builder.theme.current : undefined
  const brandName = builder.theme?.brands?.find((b) => b.id === brandId)?.name ?? brandId
  const api = builder.api
  const owner = builder.ownerBase
  const brandRules = useMemo<BrandRules | undefined>(() => (owner && brandId && brandName ? {
    name: brandName,
    load: () => owner((b) => fetchBrandInstructions(b, brandId)),
    save: (next) => owner((b) => saveBrandInstructions(b, brandId, next)),
    memory: { load: () => owner((b) => fetchBrandMemory(b, brandId)), save: (text) => owner((b) => saveBrandMemory(b, brandId, text)) },
  } : undefined), [owner, brandId, brandName])
  useEffect(() => {
    if (builder.instructions && !rulesTouched.current) setRules(builder.instructions)
  }, [builder.instructions])
  // Imágenes encendidas por defecto, como v0: sin elección del usuario (undefined) va el primer modelo que
  // anuncia el transport; null es "Off" elegido a mano.
  const [chosenImageModel, setImageModelId] = useState<string | null | undefined>(undefined)
  const imageModelId = chosenImageModel === undefined ? (builder.imageModels[0]?.id ?? null) : chosenImageModel
  const [webSearch, setWebSearch] = useState(false)
  useEffect(() => {
    onComposer?.(composerChoice(modelId, imageModelId, effort))
  }, [onComposer, modelId, imageModelId, effort])
  const [connectorsOpen, setConnectorsOpen] = useState(false)
  const [accounts, setAccounts] = useState<ConnectorAccount[]>([])
  const [connectorsReady, setConnectorsReady] = useState(true)
  // Por chat, como en v0: el transport lo guarda con el hilo; por defecto se pide permiso.
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask')
  // Por mensaje, no por chat: aprobado el plan, el siguiente pedido ya construye.
  const [plan, setPlan] = useState(false)
  const enhance = useMemo(() => (owner ? (text: string, onText: (t: string) => void, signal: AbortSignal) => owner((b) => enhancePrompt(b, text, onText, signal)) : undefined), [owner])
  const connected = accounts.filter((a) => a.state === 'connected').map((a) => a.app)
  const connectors = builder.connectors
  useEffect(() => {
    connectors.accounts().then(setAccounts).catch((e: unknown) => {
      // Un servidor sin conectores (501 connectors-unavailable) no es un error al abrir: la opción del menú + queda apagada y lo explica.
      if (e instanceof NotConnectedError) setConnectorsReady(false)
      else setNotice(e instanceof Error ? e.message : String(e))
    })
  }, [connectors])
  // Drive y GitHub del menú +: las apps conectadas viajan en `connectors` de cada corrida, pero el composer todavía no
  // le da tools al agente para leerlas. Hasta que existan, el aviso dice solo "conectado" y no promete lectura.
  const linkApp = (app: string, name: string) => {
    if (!connectorsReady) { setNotice(`${name} necesita conectores y este servidor no los tiene configurados.`); return }
    if (connected.includes(app)) { setNotice(`${name} conectado.`); return }
    const recheck = () => connectors.accounts().then((list) => {
      setAccounts(list)
      if (list.some((a) => a.app === app && a.state === 'connected')) setNotice(`${name} conectado.`)
    })
    openConnectTab(() => connectors.connect(app))
      .then(() => { setNotice(`Conecta ${name} en la pestaña que se abrió.`); recheck(); window.addEventListener('focus', recheck, { once: true }) })
      .catch((e: unknown) => setNotice(e instanceof Error ? e.message : String(e)))
  }
  const recorder = useMemo(createRecorder, [])
  // Si el panel se desmonta grabando, el micrófono no debe quedar abierto.
  useEffect(() => () => recorder.cancel(), [recorder])
  const transcribe = builder.transcribe
  const dictate = useMemo(() => (transcribe ? {
    start: recorder.start,
    finish: () => recorder.stop().then(transcribe),
    cancel: recorder.cancel,
    level: recorder.level,
  } : transcribe === null ? false as const : undefined), [recorder, transcribe])
  const reduced = useReducedMotion() ?? false
  const model = MODELS.find((m) => m.id === modelId) ?? MODELS[0]
  const last = builder.turns.at(-1)
  useEffect(() => setSelectedId(undefined), [last?.messageId])
  const shown = focus ?? builder.turns.find((t) => t.messageId === selectedId) ?? last
  const resume = shown && !focus ? resumeActionOf(shown, builder.turns, builder.busy) : null
  // Restore y patch no pasan por el modelo (sin nombre, AgentRun pondría su modelo de demo); un turno con modelo
  // nombra el suyo, no el que está elegido ahora.
  const turnModel = (turn: Turn) => isDirectEdit(turn.request) ? { name: 'Direct edit' }
    : turn.request.restoreFrom ? { name: 'Restore' }
    : turn.request.updateDs ? { name: 'DS update' }
    : turn.request.applyTheme ? { name: 'Theme' }
    : { name: (MODELS.find((m) => m.id === turn.request.model) ?? model).name, mark: <ClaudeMark aria-hidden="true" /> }
  // El diff del transport es del último mensaje con versión; los turnos anteriores no traen diffstat propio.
  const stats: FileStat[] = builder.diff.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions }))
  // El commit del turno anterior con versión: un plan aplicado sin cambios cierra con ese mismo commit o sin ninguno.
  const parentCommit = shown ? builder.turns.slice(0, builder.turns.indexOf(shown)).findLast((t) => t.state.snapshot?.commit)?.state.snapshot?.commit : undefined
  const planOnly = shown ? planOnlyOf(shown.state, parentCommit) : false
  const shownStats = shown ? ownStats(shown.state, stats, parentCommit) : []
  // Los siguientes pasos son del último turno terminado: mientras corre otro no hay que ofrecerlos.
  // Con un mensaje en vuelo no se ofrecen (pendingInterjectionHidesChips de Lovable): busy cubre corrida e interjección.
  const followUps = followUpsOf(last?.state)
  const question = questionOf(last?.state)
  const fromTurn = lateSuggestionsOf(last?.state) ?? suggestionsFromFiles(builder.files)
  const suggestions = builder.busy ? [] : question ?? [...followUps, ...fromTurn.filter((s) => !followUps.some((f) => f.message === s.message))]
  // Como Fix with v0: solo sobre la versión actual y con el turno cerrado; con otro corriendo, el preview cambia.
  const serverIssues = last && !builder.busy ? previewIssueMessages(last.state) : []
  const live = newRuntimeErrors(useRuntimeErrors(builder.previewUrl, last?.messageId), serverIssues)
  const issues = builder.busy ? 0 : serverIssues.length + live.length
  const issueSummary = last && issues > 0 ? previewIssueSummary(last.state, live.length) : ''
  // Mismas reglas que "Arreglar": solo la versión actual y con el turno cerrado.
  const contrast = last && !builder.busy ? contrastIssuesOf(last.state) : []
  // Como figma-make: el arreglo arranca solo y aquí solo se ve el estado. El botón queda de respaldo cuando no hubo
  // auto-repair (tope de uno por versión, apagado en el server) o el que corrió dejó errores.
  const fixing = (last?.auto && last.state.status === 'streaming') || builder.autoPending
  const fixingLabel = last?.auto && last.state.status === 'streaming' ? last.prompt : 'Arreglando errores de runtime'
  // El medidor es del hilo: el ratio del último turno con agente, aunque el último sea una edición directa sin modelo.
  const footer = shown ? turnFooterOf(shown.state, shown === last, builder.turns.map((t) => t.state)) : null
  const replaceFact = (fact: Parameters<typeof replaceFactPrompt>[0]) => { composerRef.current?.fill(replaceFactPrompt(fact)); composerRef.current?.focus() }
  const notify = useDoneNotification(builder.busy, Boolean(last?.state.snapshot), builder.turns.length === 1, pageTitleFromFiles(builder.files))
  const sendText = (text: string, selectedSections?: string[], elements?: PickedElement[], contrastDefects?: ContrastDefect[]) => builder.send(text, modelId, { instructions: instructionsToSend(rules, rulesTouched.current, builder.instructions != null), attachments: [], imageModelId, thinking: effort, webSearch, connectors: connected, permissionMode, selectedSections, elements: elements && runElements(elements), viewport, contrastDefects })
  useEffect(() => {
    if (!directed) return
    onDirectedSent()
    if (!builder.busy) sendText(withElementContext(directed.message, [directed.element]), sectionsOf([directed.element]), [directed.element])
    // Solo al llegar un chip nuevo: sendText cambia en cada render y reenviaría el mismo pedido.
  }, [directed])

  return (
    <div className={styles.chat}>
      {shown && (
        <div className={styles.agentPanel} id="agent-panel" data-expanded={logOpen || undefined} data-busy={builder.busy || undefined}>
          <AgentPanelBody
            key={shown.messageId}
            turn={shown}
            first={shown === builder.turns[0]}
            spend={spend}
            needsDecision={shown.state.approvals?.some((a) => !a.decision) ?? false}
            steps={(
              <AgentRun
                task={shown.prompt.length > 60 ? `${shown.prompt.slice(0, 60)}…` : shown.prompt}
                model={turnModel(shown)}
                run={toRunState(shown.state, shown.elapsedMs, shown === last ? shownStats : [], builder.shotUrl && ((file) => builder.shotUrl!(shown.messageId, file)))}
                onRestart={focus || !canRestart(shown) ? undefined : () => builder.retry(shown, modelId)}
                resultAction={null}
                onDecideTool={builder.decide}
                onRevokeTool={builder.revoke}
                onLoadPlan={api && builder.chatId ? () => fetchPlan(chatBase(api, builder.chatId!), shown.messageId) : undefined}
                onLoadApproval={api && builder.chatId ? (callId) => fetchApproval(chatBase(api, builder.chatId!), callId) : undefined}
                renderMarkdown={renderPlan}
              />
            )}
            footer={shown === last ? (
              <>
                <InventedChip facts={footer?.invented ?? []} onReplace={replaceFact} />
                <MemoryNotes writes={footer?.memoryWrites ?? []} onOpen={brandRules?.memory ? () => openRules('memory') : undefined} />
                {planOnly && <p className={styles.changed}>{PLAN_ONLY_TEXT}</p>}
                {shownStats.length > 0 && <p className={styles.changed}>{shownStats.length === 1 ? '1 archivo cambiado' : `${shownStats.length} archivos cambiados`}</p>}
                {resultAction}
                {resume && (
                  <div className={styles.resumeRow}>
                    <Button size="sm" variant="secondary" onClick={() => void (resume === 'continue' ? builder.continueTurn?.(shown, chosenModel, chosenEffort) : builder.retry(shown, modelId))}>
                      {resume === 'continue' ? 'Continuar' : 'Reenviar'}
                    </Button>
                  </div>
                )}
                <NextSteps suggestions={suggestions} onPick={sendText} />
                {footer?.context && <ContextMeter usage={footer.context} />}
              </>
            ) : (
              // Un turno viejo abierto desde el registro va plegado (M2 §2): pedido, resumen y sus chips; los pasos detrás de "Ver pasos".
              <>
                {planOnly && <p className={styles.changed}>{PLAN_ONLY_TEXT}</p>}
                <InventedChip facts={footer?.invented ?? []} onReplace={replaceFact} />
                <MemoryNotes writes={footer?.memoryWrites ?? []} onOpen={brandRules?.memory ? () => openRules('memory') : undefined} />
              </>
            )}
          />
        </div>
      )}
      {builder.turns.length > 0 && (
        <AgentLog turns={builder.turns} selected={shown?.messageId} open={logOpen} onToggle={() => setLogOpen((v) => !v)} onSelect={setSelectedId} />
      )}
      <div className={styles.composerDock}>
        {fixing ? (
          <div className={styles.repairRow} role="status" data-wt-autofix="">
            <LoaderCircleIcon size={14} className={styles.railSpin} aria-hidden="true" />
            <span className={styles.repairNote}>{fixingLabel}…</span>
          </div>
        ) : issues > 0 && (
          // El arnés (A5) separa los errores runtime del preview de los avisos del servidor (contraste, validación).
          <div className={styles.repairRow} data-wt-runtime-errors={live.length}>
            <span className={styles.repairNote}>{last?.auto ? `No se pudo arreglar solo: ${issueSummary}` : issueSummary}</span>
            <Button size="sm" variant="secondary" onClick={() => builder.repair(issues, modelId, live)}><Wrench size={14} aria-hidden="true" /> Arreglar</Button>
          </div>
        )}
        {!fixing && <ContrastNotice issues={contrast} onFix={() => sendText(contrastFixPrompt(contrast), undefined, undefined, contrastDefectsOf(contrast))} />}
        <StagedChanges tasks={tasksOf(elements)} busy={builder.busy}
          onRemove={(t) => onElements(elements.filter((e) => e !== t))}
          onDiscard={() => onElements(elements.filter((e) => !e.note))}
          onApply={() => {
            // Como "Applied N changes" de Make: un solo mensaje con todas las tareas y los chips sin nota que haya.
            sendText(withElementContext(applyTasksPrompt(tasksOf(elements).length), elements), sectionsOf(elements), elements)
            onElements([])
          }} />
        {(builder.error || notice) && <p className={styles.notice} role="status">{builder.error ?? notice}</p>}
        {builder.busy && !builder.error && !notice && <RotatingTip />}
        {/* El pedido de permiso sale de un gesto de la persona (MDN Notification.requestPermission): se ofrece mientras
            corre, que es cuando sirve, y desaparece una vez decidido. */}
        {builder.busy && notify.supported && notify.permission === 'default' && (
          <Button size="sm" variant="ghost" className={styles.notifyButton} data-wt-loading="25" onClick={() => void notify.request()}><BellIcon size={14} aria-hidden="true" /> Avisarme al terminar</Button>
        )}
        <Composer
          ref={composerRef}
          models={MODELS}
          model={model}
          effort={effort}
          webSearch={webSearch}
          onModel={setModelId}
          onEffort={setEffort}
          // Sin chip de thinking: v0 no lo tiene y el CLI solo entiende --effort, que ya viaja con el nivel elegido.
          onTool={(tool) => { if (tool === 'search') setWebSearch((v) => !v) }}
          // El Stop ocupa el lugar del enviar mientras corre, como en Stitch; con texto escrito vuelve el enviar y el mensaje
          // entra a la corrida en curso, como en Lovable.
          busy={builder.busy}
          steerable={Boolean(builder.steer)}
          progress={null}
          progressSeconds={0}
          run={builder.turns.length}
          placeholder={builder.turns.length ? 'Pide un cambio a la página…' : 'Describe la página…'}
          maxLength={4000}
          reduced={reduced}
          upload={builder.upload}
          dictate={dictate}
          maxUpload={MAX_UPLOAD}
          onDrive={() => linkApp('google_drive', 'Google Drive')}
          onGithub={() => linkApp('github', 'GitHub')}
          slots={{
            menu: <PlusMenuExtras rules={rules.length} imageModels={builder.imageModels} imageModelId={imageModelId} onInstructions={() => openRules('chat')} onImageModel={setImageModelId} connected={connected.length} connectorsReady={connectorsReady} onConnectors={() => setConnectorsOpen(true)} permissionMode={permissionMode} onPermissionMode={setPermissionMode} plan={plan} onPlan={setPlan} />,
            chips: <><PlanChip on={plan} onToggle={() => setPlan(false)} /><RulesChip count={rules.length} onOpen={() => openRules('chat')} /></>,
            // Sin × a propósito: cada mensaje edita esta página, así que quitar el contexto no tendría efecto.
            context: (
            <span className={styles.contextRow}>
              <span className={styles.contextChip}><FileIcon size={14} aria-hidden="true" /><span className={styles.contextChipText}>{context}</span></span>
              {elements.filter((el) => !el.note).map((el) => (
                <span key={el.selector} className={styles.contextChip} data-element="">
                  <MousePointerClickIcon size={14} aria-hidden="true" />
                  <span className={styles.contextChipText} title={el.source ? sourceLabel(el.source) : undefined}>{el.label}{el.text ? `: ${el.text}` : ''}</span>
                  {el.source && <span className={styles.contextChipSource}>{sourceShort(el.source)}</span>}
                  <button type="button" className={styles.contextChipRemove} aria-label={`Quitar ${el.label.toLowerCase()}`} onClick={() => onElements(elements.filter((e) => e !== el))}><XIcon size={12} /></button>
                </span>
              ))}
            </span>
            ),
          }}
          enhance={enhance}
          onSubmit={(draft) => {
            const text = draft.text.trim()
            // El motor necesita un pedido escrito; un adjunto solo no dice qué hacer con él.
            if (!text) { setNotice('Escribe qué hacer con el adjunto.'); return false }
            // El aviso de recargar ya está a la vista; false conserva el borrador para no perder lo escrito.
            if (builder.threadLost) return false
            const attachments: Upload[] = draft.attachments.flatMap((a) =>
              a.url ? [{ url: a.url, name: a.name, contentType: a.file?.type || 'application/octet-stream', size: a.size }] : [])
            // Captura y pegado siguen simulados por Arc: no tienen URL y no viajan.
            const dropped = draft.attachments.length - attachments.length
            if (dropped) setNotice(`${dropped} adjunto(s) simulados no se enviaron.`)
            if (builder.busy && builder.steer) {
              if (attachments.length) { setNotice('Los adjuntos van en el próximo mensaje, cuando termine la corrida.'); return false }
              builder.steer(withElementContext(text, elements), modelId, { instructions: instructionsToSend(rules, rulesTouched.current, builder.instructions != null), attachments: [], imageModelId, thinking: effort, webSearch, connectors: connected, permissionMode, selectedSections: sectionsOf(elements) })
              onElements([])
              return true
            }
            builder.send(withElementContext(text, elements), modelId, { instructions: instructionsToSend(rules, rulesTouched.current, builder.instructions != null), attachments, imageModelId, thinking: effort, webSearch, connectors: connected, permissionMode, selectedSections: sectionsOf(elements), elements: runElements(elements), viewport, plan })
            onElements([])
            setPlan(false)
            return true
          }}
          onStop={() => (builder.stop ? builder.stop() : setNotice('Sin transport no hay corrida que detener.'))}
          announce={setNotice}
        />
      </div>
      <ConnectorsDialog open={connectorsOpen} connectors={builder.connectors} onOpenChange={setConnectorsOpen} onAccounts={setAccounts} />
      <InstructionsDialog open={rulesOpen} rules={rules} brand={brandRules} initialScope={rulesScope} onOpenChange={setRulesOpen} onSave={(next) => { rulesTouched.current = true; setRules(next); setRulesOpen(false) }} />
    </div>
  )
}
