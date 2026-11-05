// Estado del panel Tema y su salida: el brand.json v2 que parseBrandPackV2 acepta (brands/brandpack-v2.schema.json) y las
// variables con las que se pinta la muestra. Puro: la vista previa de la página resuelve con el mismo deriveTheme que usa el
// transport al aplicar, así lo que se ve y lo que queda no divergen (specs/panel-tema-params.md §5, refinamiento 2).
import { deriveTheme, THEME_PRESETS, type Correction, type ThemeMode, type TokenMap } from '@engine/theme/derive'
import { SEED_VARIANTS, type SeedParams } from '@engine/theme/seed'

export { THEME_PRESETS }
export type { Correction, SeedParams }
export const SEED_VARIANT_NAMES = Object.keys(SEED_VARIANTS) as NonNullable<SeedParams['variant']>[]

/** Acento propio: los tres valores exactos que pide el schema v2 (src/brand.ts:233-236 exige los tres juntos). La
 * derivación desde una semilla está diferida, así que el panel no inventa strong ni subtle. */
export interface CustomAccent { base: string; strong: string; subtle: string }

export interface ThemeDraft {
  preset: string
  /** Exacto en los dos modos: con solo el claro, el oscuro lo reemite sobre el fondo oscuro y casi todo color propio
   * falla AA en uno de los dos (QA, vivo/casos/apply-theme-run, D2). */
  custom: { light: CustomAccent; dark: CustomAccent } | null
  /** Acento derivado de un color (theme.seed, src/theme/seed.ts). Excluye preset y acento propio; lo que no llegue a AA
   * lo corrige la derivación y queda en corrections. */
  seed: SeedParams | null
  colorMode: ThemeMode
  roundness: number
  scale: number
}

export const DEFAULT_DRAFT: ThemeDraft = { preset: 'neutral', custom: null, seed: null, colorMode: 'light', roundness: 1, scale: 1 }

export interface BrandJsonV2 {
  name: string
  theme?: { preset?: string; seed?: SeedParams; colorMode?: ThemeMode; roundness?: number; scale?: number }
  overrides?: TokenMap
  overridesDark?: TokenMap
}

const accentTokens = (a: CustomAccent): TokenMap => ({ '--accent': a.base, '--accent-strong': a.strong, '--accent-subtle': a.subtle })
const accentOverrides = (d: ThemeDraft): { overrides?: TokenMap; overridesDark?: TokenMap } =>
  d.custom ? { overrides: accentTokens(d.custom.light), overridesDark: accentTokens(d.custom.dark) } : {}

/** Lo que se escribe en brand.json: solo lo que se aleja del contrato. Un acento propio y un preset se contradicen en v2
 * (src/brand.ts:237), así que con acento propio el preset no viaja. */
export function brandJsonOf(name: string, d: ThemeDraft): BrandJsonV2 {
  const theme = {
    ...(!d.custom && !d.seed && d.preset !== 'neutral' ? { preset: d.preset } : {}),
    ...(d.seed ? { seed: d.seed } : {}),
    ...(d.colorMode !== 'light' ? { colorMode: d.colorMode } : {}),
    ...(d.roundness !== 1 ? { roundness: d.roundness } : {}),
    ...(d.scale !== 1 ? { scale: d.scale } : {}),
  }
  return { name, ...(Object.keys(theme).length ? { theme } : {}), ...accentOverrides(d) }
}

/** Valores del preset en ese modo, para sembrar el acento propio con algo coherente en vez de un color al azar. */
export function presetAccent(preset: string, mode: ThemeMode): CustomAccent {
  const t = deriveTheme({ preset })[mode]
  return { base: t['--accent'], strong: t['--accent-strong'], subtle: t['--accent-subtle'] }
}

export interface ContractModes { light: TokenMap; dark: TokenMap }

const BLOCK = (selector: RegExp) => new RegExp(`${selector.source}\\s*\\{([^}]*)\\}`)
const LIGHT = BLOCK(/:root,\s*\[data-theme\]/)
const DARK = BLOCK(/\n\[data-theme="dark"\]/)

function declarations(body: string): TokenMap {
  const out: TokenMap = {}
  for (const decl of body.split(';')) {
    const m = /^\s*(--[a-z0-9-]+)\s*:\s*([\s\S]+?)\s*$/.exec(decl)
    if (m) out[m[1]] = m[2]
  }
  return out
}

/** Los dos bloques base del contrato (foundation.css:5-113 y :115-161 del scaffold): el fondo de cada modo para la
 * lectura de contraste del color-picker. El builder pinta con su propia copia del DS, no con la del scaffold. */
export function contractModes(css: string): ContractModes {
  // Sin comentarios antes de cortar bloques: uno de foundation.css:35 cita `:root{...}` y cerraba el bloque claro ahí.
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const light = LIGHT.exec(clean)
  const dark = DARK.exec(clean)
  if (!light || !dark) throw new Error('foundation.css: no encontré los bloques :root,[data-theme] y [data-theme="dark"]')
  return { light: declarations(light[1]), dark: declarations(dark[1]) }
}

/** Lo que viaja en POST /runs {applyTheme}. Explícito aunque coincida con el contrato: el transport mezcla con el tema
 * de la marca, así que omitir "neutral" o "1" dejaría el valor viejo de la marca en vez del elegido. */
export interface ThemeParamsBody { theme: { preset?: string; seed?: SeedParams; colorMode: ThemeMode; roundness: number; scale: number }; overrides?: TokenMap; overridesDark?: TokenMap }

export function themeParamsOf(d: ThemeDraft): ThemeParamsBody {
  // Preset, semilla y acento propio se excluyen entre sí (derive.ts:75,89): viaja uno solo.
  const accent = d.seed ? { seed: d.seed } : d.custom ? {} : { preset: d.preset }
  const theme = { ...accent, colorMode: d.colorMode, roundness: d.roundness, scale: d.scale }
  return { theme, ...accentOverrides(d) }
}

/** Lo que el puente del scaffold pinta (wt-theme-bridge.ts, mensaje wt:theme): la capa de marca resuelta en los dos modos,
 * con el mismo deriveTheme que usa el transport al aplicar. */
export interface ThemePreview { light: TokenMap; dark: TokenMap; colorMode: ThemeMode }

export function themePreviewOf(d: ThemeDraft): ThemePreview {
  const { light, dark, colorMode } = derivedOf(d)
  return { light, dark, colorMode }
}

/** Lo que la derivación de semilla movió para llegar a AA: el panel lo dice ("ajustamos X") en vez de pintar un color
 * distinto al elegido sin explicar por qué (specs/panel-tema-params.md §5, refinamiento 3). */
export const correctionsOf = (d: ThemeDraft): Correction[] => derivedOf(d).corrections

function derivedOf(d: ThemeDraft) {
  const { theme, overrides, overridesDark } = themeParamsOf(d)
  return deriveTheme(theme, overrides, overridesDark)
}

/** Fondo del modo, contra el que el color-picker lee el contraste: el del contrato, ya resuelto (el claro es var()). */
export function backgroundOf(mode: ThemeMode, contract: ContractModes): string {
  const bg = mode === 'dark' ? contract.dark['--background'] : contract.light['--background']
  const ref = /^var\((--[a-z0-9-]+)\)$/.exec(bg ?? '')
  return (ref ? contract.light[ref[1]] : bg) ?? '#ffffff'
}
