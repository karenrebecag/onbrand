import { useEffect, useMemo, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { SlidersHorizontalIcon } from 'lucide-react'
import contractCss from '../../../../../templates/base-scaffold/src/theme/tokens.css?raw'
import { Button } from '@/components/arc/button/button'
import { Tooltip } from '@/components/arc/tooltip/tooltip'
import { Combobox } from '@/components/arc/combobox/combobox'
import { ColorPicker } from '@/components/arc/color-picker/color-picker'
import { Slider } from '@/components/arc/slider/slider'
import SegmentedControl from '@/components/arc/segmented-control/segmented-control'
import { CopyButton } from '@/components/arc/copy-button/copy-button'
import { backgroundOf, brandJsonOf, contractModes, correctionsOf, DEFAULT_DRAFT, presetAccent, SEED_VARIANT_NAMES, themeParamsOf, themePreviewOf, THEME_PRESETS, type SeedParams, type ThemeDraft, type ThemeParamsBody, type ThemePreview } from '@/lib/theme-draft'
import { Off } from './off'
import styles from './theme-panel.module.css'

// El contrato de las páginas generadas es el tokens.css del scaffold base, no la copia del builder: de ahí sale el fondo
// contra el que el color-picker mide el contraste.
const CONTRACT = contractModes(contractCss)
const CUSTOM = '__custom'
const SEED = '__seed'
const PRESET_NAMES: Record<string, string> = { neutral: 'Neutral', violet: 'Violeta', blue: 'Azul', green: 'Verde', amber: 'Ámbar', orange: 'Naranja', coral: 'Coral', rose: 'Rosa' }
const ACCENT_OPTIONS = [
  ...THEME_PRESETS.map((p) => ({ value: p, label: PRESET_NAMES[p] ?? p, keywords: [p] })),
  { value: SEED, label: 'Desde un color', keywords: ['semilla', 'seed', 'derivar'] },
  { value: CUSTOM, label: 'Color propio exacto', keywords: ['custom', 'hex', 'exacto'] },
]
const VARIANT_NAMES: Record<string, string> = { 'tonal-spot': 'Tonal', fidelity: 'Fiel al color', content: 'Contenido', vibrant: 'Vibrante', expressive: 'Expresiva', neutral: 'Neutra', monochrome: 'Monocromo', rainbow: 'Arcoíris', 'fruit-salad': 'Ensalada de fruta' }
const VARIANT_OPTIONS = SEED_VARIANT_NAMES.map((v) => ({ value: v, label: VARIANT_NAMES[v] ?? v, keywords: [v] }))
const MODE_NAMES = { light: 'claro', dark: 'oscuro' } as const
// theme.seed solo acepta #rrggbb (brandpack-v2.schema.json); el picker agrega alfa si el color no es opaco.
const opaque = (hex: string): string => hex.slice(0, 7)
const HEX6 = /^#[0-9a-f]{6}$/i
const MODES = [{ value: 'light', label: 'Claro' }, { value: 'dark', label: 'Oscuro' }]
const ACCENT_FIELDS = [['base', 'Acento'], ['strong', 'Acento fuerte'], ['subtle', 'Acento suave']] as const

export interface ThemePanelProps {
  brandName?: string
  initialPreset?: string
  /** Repinta la página mientras el panel está abierto; null al cerrar devuelve la página a su identidad. */
  onPreview?: (theme: ThemePreview | null) => void
  /** POST /runs {applyTheme}: versión nueva con estos params sobre la marca vigente. */
  onApply?: (params: ThemeParamsBody) => Promise<boolean>
  /** Hay versión sobre la cual aplicar y ninguna corrida tiene el workspace. */
  canApply: boolean
  /** C3: DS fijado del chat y, si el registry publica otro, el nuevo (dsStatus). null: sin registry, no se muestra. */
  ds?: { pin: string | null; update: string | null } | null
}

/** Panel Tema: las perillas de brand.json v2 (theme + acento propio en overrides). La página se repinta en vivo con el
 * mismo deriveTheme que usa el transport, y Aplicar deja una versión nueva. */
export function ThemePanel({ brandName, initialPreset, onPreview, onApply, canApply, ds }: ThemePanelProps) {
  const [open, setOpen] = useState(false)
  const [applying, setApplying] = useState(false)
  const [draft, setDraft] = useState<ThemeDraft>(() => ({ ...DEFAULT_DRAFT, preset: initialPreset && THEME_PRESETS.includes(initialPreset) ? initialPreset : 'neutral' }))
  const set = (patch: Partial<ThemeDraft>) => setDraft((d) => ({ ...d, ...patch }))
  const json = useMemo(() => `${JSON.stringify(brandJsonOf(brandName ?? 'Mi marca', draft), null, 2)}\n`, [brandName, draft])
  const background = backgroundOf(draft.colorMode, CONTRACT)
  const corrections = useMemo(() => (draft.seed ? correctionsOf(draft) : []), [draft])
  const setSeed = (patch: Partial<SeedParams>) => setDraft((d) => (d.seed ? { ...d, seed: { ...d.seed, ...patch } } : d))

  // La vista previa vive solo mientras el panel está abierto: cerrar sin aplicar no puede dejar la página cambiada.
  useEffect(() => { if (open) onPreview?.(themePreviewOf(draft)) }, [open, draft, onPreview])
  const changeOpen = (next: boolean) => {
    setOpen(next)
    if (!next) onPreview?.(null)
  }

  const chooseAccent = (value: string) => {
    if (!value) return
    // overrides es la capa clara y el oscuro la hereda (derive.ts): se siembra con el acento claro del preset.
    const seedFrom = presetAccent(draft.preset, 'light').base
    if (value === CUSTOM) set({ custom: draft.custom ?? { light: presetAccent(draft.preset, 'light'), dark: presetAccent(draft.preset, 'dark') }, seed: null })
    else if (value === SEED) set({ seed: draft.seed ?? { accent: HEX6.test(seedFrom) ? seedFrom : '#7747ff', variant: 'tonal-spot' }, custom: null })
    else set({ preset: value, custom: null, seed: null })
  }

  const apply = () => {
    if (!onApply) return
    setApplying(true)
    void onApply(themeParamsOf(draft)).then((ok) => { if (ok) changeOpen(false) }).finally(() => setApplying(false))
  }

  return (
    <Popover.Root open={open} onOpenChange={changeOpen}>
      <Tooltip content="Ajustar tema" side="left">
        <Popover.Trigger asChild>
          <Button variant="ghost" size="sm" className={styles.trigger} aria-label="Ajustar tema"><SlidersHorizontalIcon size={18} /></Button>
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        {/* Radix enfoca el primer control al abrir y el combobox despliega su lista con el foco: el panel abre quieto. */}
        <Popover.Content className={styles.panel} side="left" align="center" sideOffset={12} collisionPadding={12} onOpenAutoFocus={(e) => e.preventDefault()}>
          <div className={styles.body}>
          <h2 className={styles.title}>Tema</h2>
          {ds && (
            <p className={styles.dsLine}>
              {ds.pin && <span>DS {ds.pin}</span>}
              {ds.update && <span className={styles.dsUpdate}>Actualización disponible: {ds.update}</span>}
            </p>
          )}
          <Combobox label="Acento" options={ACCENT_OPTIONS} value={draft.seed ? SEED : draft.custom ? CUSTOM : draft.preset} onValueChange={chooseAccent} />
          {draft.seed && (
            <div className={styles.pickers}>
              <ColorPicker label="Color de marca" value={draft.seed.accent} background={background} onValueChange={(hex) => setSeed({ accent: opaque(hex) })} />
              {draft.seed.neutral ? (
                <div className={styles.inline}>
                  <ColorPicker label="Tinte de grises" value={draft.seed.neutral} background={background} onValueChange={(hex) => setSeed({ neutral: opaque(hex) })} />
                  <Button variant="ghost" size="sm" onClick={() => setDraft((d) => (d.seed ? { ...d, seed: { accent: d.seed.accent, ...(d.seed.variant ? { variant: d.seed.variant } : {}) } } : d))}>Quitar</Button>
                </div>
              ) : (
                <div className={styles.inline}>
                  <span className={styles.label}>Grises del contrato</span>
                  <Button variant="ghost" size="sm" onClick={() => setSeed({ neutral: draft.seed!.accent })}>Teñir grises</Button>
                </div>
              )}
              <Combobox label="Variante" options={VARIANT_OPTIONS} value={draft.seed.variant ?? 'tonal-spot'} onValueChange={(v) => v && setSeed({ variant: v as SeedParams['variant'] })} />
              {corrections.length > 0 && (
                <ul className={styles.corrections} aria-label="Ajustes de contraste">
                  {corrections.map((c) => <li key={`${c.mode}${c.token}`}>Ajustamos <code>{c.token}</code> en {MODE_NAMES[c.mode]}: {c.from} → {c.to} para que se lea.</li>)}
                </ul>
              )}
            </div>
          )}
          {draft.custom && (['light', 'dark'] as const).map((mode) => (
            // Un trío por modo: cada picker mide el contraste contra el fondo del modo donde se va a usar.
            <div key={mode} className={styles.pickers}>
              <span className={styles.label}>En {MODE_NAMES[mode]}</span>
              {ACCENT_FIELDS.map(([key, label]) => (
                <ColorPicker key={key} label={label} value={draft.custom![mode][key]} background={backgroundOf(mode, CONTRACT)}
                  onValueChange={(hex) => setDraft((d) => (d.custom ? { ...d, custom: { ...d.custom, [mode]: { ...d.custom[mode], [key]: hex } } } : d))} />
              ))}
            </div>
          ))}
          <div className={styles.field}>
            <span className={styles.label}>Apariencia</span>
            <SegmentedControl label="Apariencia" options={MODES} value={draft.colorMode} onValueChange={(v) => set({ colorMode: v === 'dark' ? 'dark' : 'light' })} />
          </div>
          <Slider label="Esquinas" min={0.25} max={2} step={0.25} value={draft.roundness} onValueChange={(v) => set({ roundness: v as number })} format={(v) => `${v}×`} showValue />
          <Slider label="Escala" min={0.85} max={1.15} step={0.05} value={draft.scale} onValueChange={(v) => set({ scale: Math.round((v as number) * 100) / 100 })} format={(v) => `${v}×`} showValue />
          </div>
          <div className={styles.actions}>
            <CopyButton value={json} label="Copiar brand.json" />
            {onApply && canApply ? (
              <Button size="sm" disabled={applying} onClick={apply}>{applying ? 'Aplicando…' : 'Aplicar'}</Button>
            ) : (
              <Off note={onApply ? 'Aplicar necesita una versión y que no haya otra corrida' : 'Aplicar necesita el transport'} side="top">
                <Button size="sm" disabled>Aplicar</Button>
              </Off>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
