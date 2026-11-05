import { useEffect, useState } from 'react'
import * as Menu from '@radix-ui/react-dropdown-menu'
import { Check, ImageIcon, ListChecks, ListTodo, PlugIcon, PlusIcon, ShieldCheck, Trash2Icon } from 'lucide-react'
import { Button } from '@/components/arc/button/button'
import { Dialog, DialogContent } from '@/components/arc/dialog/dialog'
import SegmentedControl from '@/components/arc/segmented-control/segmented-control'
import { Textarea } from '@/components/arc/textarea/textarea'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
import composerStyles from '@/components/arc/blocks/ai-composer/ai-composer.module.css'
import type { ImageModel, PermissionMode } from '@/lib/run-client'
import { cleanRules, MAX_RULE_CHARS, MAX_RULES } from '@/lib/plus-menu'
import { MemoryEditor, type BrandMemory } from './memory-editor'
import styles from './builder.module.css'


interface PlusExtrasProps {
  rules: number
  imageModels: ImageModel[]
  imageModelId: string | null
  onInstructions: () => void
  onImageModel: (id: string | null) => void
  connected: number
  /** false cuando el transport no reenvía conectores (la demo sin Pipedream): la opción se ve pero no se activa. */
  connectorsReady: boolean
  onConnectors: () => void
  permissionMode: PermissionMode
  onPermissionMode: (mode: PermissionMode) => void
  plan: boolean
  onPlan: (on: boolean) => void
}

// Como el modo de permisos del menú + de v0, sin Full: una escritura en un conector siempre pregunta.
const PERMISSION_MODES: { id: PermissionMode; name: string; hint: string }[] = [
  { id: 'ask', name: 'Pedir permiso', hint: 'Antes de cada herramienta de un conector' },
  { id: 'auto', name: 'Automático', hint: 'Las lecturas pasan; las escrituras preguntan' },
]

/** Ítems que el menú + de v0 tiene y Arc no: Instructions y Generate images. */
export function PlusMenuExtras({ rules, imageModels, imageModelId, onInstructions, onImageModel, connected, connectorsReady, onConnectors, permissionMode, onPermissionMode, plan, onPlan }: PlusExtrasProps) {
  return (
    <>
      {/* Add context → Plan de Make: se enciende desde el menú y queda como chip junto a los toggles. */}
      <Menu.CheckboxItem className={`${composerStyles.menuItem} ${styles.menuItemTall}`} checked={plan} onCheckedChange={onPlan}>
        <span className={composerStyles.menuIcon} aria-hidden="true"><ListTodo /></span>
        <span className={styles.menuItemText}>Plan<span className={styles.menuItemHint}>Revisa el plan antes de construir</span></span>
        <Menu.ItemIndicator className={styles.menuMeta}><Check size={14} aria-hidden="true" /></Menu.ItemIndicator>
      </Menu.CheckboxItem>
      <Menu.Item className={composerStyles.menuItem} onSelect={onInstructions}>
        <span className={composerStyles.menuIcon} aria-hidden="true"><ListChecks /></span>
        Instrucciones
        {rules > 0 && <span className={styles.menuMeta}>{rules}</span>}
      </Menu.Item>
      {connectorsReady ? (
        <Menu.Item className={composerStyles.menuItem} onSelect={onConnectors}>
          <span className={composerStyles.menuIcon} aria-hidden="true"><PlugIcon /></span>
          Conectores
          {connected > 0 && <span className={styles.menuMeta}>{connected}</span>}
        </Menu.Item>
      ) : (
        <Tooltip content="Este servidor no tiene conectores configurados" side="right">
          <Menu.Item className={`${composerStyles.menuItem} ${styles.menuItemOff}`} disabled>
            <span className={composerStyles.menuIcon} aria-hidden="true"><PlugIcon /></span>
            Conectores
            <span className={styles.menuMeta}>No disponible</span>
          </Menu.Item>
        </Tooltip>
      )}
      {connectorsReady ? (
        <Menu.Sub>
          <Menu.SubTrigger className={composerStyles.menuItem}>
            <span className={composerStyles.menuIcon} aria-hidden="true"><ShieldCheck /></span>
            Permisos
            <span className={styles.menuMeta}>{PERMISSION_MODES.find((m) => m.id === permissionMode)?.name}</span>
          </Menu.SubTrigger>
          <Menu.Portal>
            <Menu.SubContent className={composerStyles.menu} sideOffset={6} collisionPadding={12}>
              <Menu.RadioGroup value={permissionMode} onValueChange={(v) => onPermissionMode(v as PermissionMode)}>
                {PERMISSION_MODES.map((m) => (
                  <Menu.RadioItem key={m.id} value={m.id} className={`${composerStyles.menuItem} ${styles.menuItemTall}`}>
                    <span className={styles.menuItemText}>{m.name}<span className={styles.menuItemHint}>{m.hint}</span></span>
                    <Menu.ItemIndicator className={styles.menuMeta}><Check size={14} aria-hidden="true" /></Menu.ItemIndicator>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.SubContent>
          </Menu.Portal>
        </Menu.Sub>
      ) : (
        <Tooltip content="Sin conectores no hay herramientas que aprobar" side="right">
          <Menu.Item className={`${composerStyles.menuItem} ${styles.menuItemOff}`} disabled>
            <span className={composerStyles.menuIcon} aria-hidden="true"><ShieldCheck /></span>
            Permisos
            <span className={styles.menuMeta}>No disponible</span>
          </Menu.Item>
        </Tooltip>
      )}
      {imageModels.length === 0 ? (
        // Sin modelo de imagen en el motor el ítem existe pero no se puede activar, para que la ausencia se vea.
        <Menu.Item className={`${composerStyles.menuItem} ${styles.menuItemOff}`} disabled>
          <span className={composerStyles.menuIcon} aria-hidden="true"><ImageIcon /></span>
          Generar imágenes
          <span className={styles.menuMeta}>No disponible</span>
        </Menu.Item>
      ) : (
        <Menu.Sub>
          <Menu.SubTrigger className={composerStyles.menuItem}>
            <span className={composerStyles.menuIcon} aria-hidden="true"><ImageIcon /></span>
            Generar imágenes
            <span className={styles.menuMeta}>{imageModels.find((m) => m.id === imageModelId)?.name ?? (imageModelId ? imageModelId : 'No')}</span>
          </Menu.SubTrigger>
          <Menu.Portal>
            <Menu.SubContent className={composerStyles.menu} sideOffset={6} collisionPadding={12}>
              <Menu.RadioGroup value={imageModelId ?? ''} onValueChange={(v) => onImageModel(v || null)}>
                {[{ id: '', name: 'No' }, ...imageModels].map((m) => (
                  <Menu.RadioItem key={m.id} value={m.id} className={composerStyles.menuItem}>
                    {m.name ?? m.id}
                    <Menu.ItemIndicator className={styles.menuMeta}><Check size={14} aria-hidden="true" /></Menu.ItemIndicator>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.SubContent>
          </Menu.Portal>
        </Menu.Sub>
      )}
    </>
  )
}

/** Chip junto a los toggles del composer: deja ver que hay reglas activas sin abrir el menú. */
export function RulesChip({ count, onOpen }: { count: number; onOpen: () => void }) {
  if (!count) return null
  const label = count === 1 ? '1 rule' : `${count} rules`
  return (
    <Tooltip content="Edit instructions">
      <button type="button" className={composerStyles.toolChip} aria-label={`Instructions, ${label}`} onClick={onOpen}>
        <ListChecks className={composerStyles.toolIcon} aria-hidden="true" />
        <span className={composerStyles.toolLabel}>{label}</span>
      </button>
    </Tooltip>
  )
}

/** Plan encendido: el chip lo apaga, como el chip de contexto de Make. */
export function PlanChip({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  if (!on) return null
  return (
    <Tooltip content="El próximo mensaje propone un plan antes de construir">
      <button type="button" className={composerStyles.toolChip} aria-pressed="true" aria-label="Plan, encendido" onClick={onToggle}>
        <ListTodo className={composerStyles.toolIcon} aria-hidden="true" />
        <span className={composerStyles.toolLabel}>Plan</span>
      </button>
    </Tooltip>
  )
}

/** Alcance de marca (#444): solo cuando la página tiene marca. */
export interface BrandRules {
  name: string
  load: () => Promise<string[]>
  save: (rules: string[]) => Promise<string[]>
  /** Memoria de la marca (M2 §1): la escribe el agente; aquí se corrige o se borra por línea. */
  memory?: BrandMemory
}

interface InstructionsDialogProps {
  open: boolean
  rules: string[]
  onOpenChange: (open: boolean) => void
  onSave: (rules: string[]) => void
  brand?: BrandRules
  /** "Ver memoria" del turno abre el diálogo directo en la memoria. */
  initialScope?: Scope
}

export function InstructionsDialog({ open, rules, onOpenChange, onSave, brand, initialScope }: InstructionsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Montado solo abierto, así el borrador arranca de las reglas vigentes cada vez. */}
      {open && <InstructionsForm rules={rules} brand={brand} initialScope={initialScope} onCancel={() => onOpenChange(false)} onSave={onSave} />}
    </Dialog>
  )
}

export type Scope = 'chat' | 'brand' | 'memory'

function InstructionsForm({ rules, brand, initialScope, onCancel, onSave }: { rules: string[]; brand?: BrandRules; initialScope?: Scope; onCancel: () => void; onSave: (rules: string[]) => void }) {
  const [scope, setScope] = useState<Scope>(initialScope === 'memory' && !brand?.memory ? 'chat' : initialScope ?? 'chat')
  // null mientras carga: las de la marca viven en el transport, no en el hilo.
  const [brandRules, setBrandRules] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (scope !== 'brand' || !brand || brandRules) return
    let live = true
    brand.load()
      .then((r) => { if (live) setBrandRules(r) })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)) })
    return () => { live = false }
  }, [scope, brand, brandRules])

  const saveBrand = async (next: string[]) => {
    if (!brand) return
    setSaving(true)
    setError(null)
    try {
      setBrandRules(await brand.save(next))
      onCancel()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const description = scope === 'memory' && brand
    ? `What the agent remembered about ${brand.name}. It informs, it does not oblige: if it conflicts with a rule, the rule wins.`
    : scope === 'brand' && brand
    ? `Rules the agent follows on every page of ${brand.name}. If they conflict with this chat's, the chat's win.`
    : 'Rules the agent follows on every message of this page. Follow-ups keep them until you change them.'
  return (
    <DialogContent title="Instructions" description={description}>
      {brand && (
        <div className={styles.rulesScope}>
          <SegmentedControl label="Scope" options={[{ value: 'chat', label: 'This chat' }, { value: 'brand', label: `Brand ${brand.name}` }, ...(brand.memory ? [{ value: 'memory', label: 'Memory' }] : [])]} value={scope} onValueChange={(v) => { setError(null); setScope(v as Scope) }} />
        </div>
      )}
      {scope === 'memory' && brand?.memory
        ? <MemoryEditor memory={brand.memory} onCancel={onCancel} />
        : scope === 'chat' || !brand
        ? <RulesEditor key="chat" initial={rules} onCancel={onCancel} onSubmit={onSave} />
        : brandRules
          ? <RulesEditor key="brand" initial={brandRules} saving={saving} onCancel={onCancel} onSubmit={(next) => void saveBrand(next)} />
          : !error && <p className={styles.rulesNote}>Loading the brand's rules…</p>}
      {error && <p className={styles.rulesError} role="alert">{error}</p>}
    </DialogContent>
  )
}

function RulesEditor({ initial, saving, onCancel, onSubmit }: { initial: string[]; saving?: boolean; onCancel: () => void; onSubmit: (rules: string[]) => void }) {
  const [draft, setDraft] = useState<string[]>(initial.length ? initial : [''])
  const over = draft.some((r) => r.length > MAX_RULE_CHARS)
  const update = (i: number, value: string) => setDraft((list) => list.map((r, j) => (j === i ? value : r)))
  const remove = (i: number) => setDraft((list) => (list.length === 1 ? [''] : list.filter((_, j) => j !== i)))

  return (
    <form
      className={styles.rulesForm}
      onSubmit={(e) => { e.preventDefault(); if (!over && !saving) onSubmit(cleanRules(draft)) }}
    >
      <ol className={styles.rulesList}>
        {draft.map((rule, i) => (
          <li key={i} className={styles.ruleRow}>
            <Textarea
              label={`Rule ${i + 1}`}
              value={rule}
              rows={2}
              className={styles.ruleInput}
              placeholder="Keep copy under 12 words per line"
              error={rule.length > MAX_RULE_CHARS ? `${rule.length - MAX_RULE_CHARS} characters over the ${MAX_RULE_CHARS} limit` : undefined}
              onChange={(e) => update(i, e.target.value)}
            />
            <Tooltip content="Remove rule">
              <Button type="button" variant="ghost" size="sm" aria-label={`Remove rule ${i + 1}`} onClick={() => remove(i)}><Trash2Icon size={14} /></Button>
            </Tooltip>
          </li>
        ))}
      </ol>
      <div className={styles.rulesActions}>
        <Button type="button" variant="ghost" size="sm" disabled={draft.length >= MAX_RULES} onClick={() => setDraft((list) => [...list, ''])}>
          <PlusIcon size={14} /> Add rule
        </Button>
        <span className={styles.spacer} />
        <Button type="button" variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" disabled={over || saving}>{saving ? 'Saving…' : 'Save'}</Button>
      </div>
    </form>
  )
}
