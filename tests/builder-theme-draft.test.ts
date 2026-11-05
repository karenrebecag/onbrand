import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parseBrandPack } from '../src/brand'
import { backgroundOf, brandJsonOf, contractModes, DEFAULT_DRAFT, presetAccent, themeParamsOf, themePreviewOf } from '../apps/builder/src/lib/theme-draft'

const CSS = readFileSync(new URL('../templates/base-scaffold/src/theme/tokens.css', import.meta.url), 'utf8')

// Lo que emite el panel tiene que cargar por el lector v2 tal cual; si no, "copiar brand.json" entrega un pack roto.
test('el brand.json del panel lo acepta parseBrandPack v2, con preset o con acento propio', () => {
  const preset = brandJsonOf('Demo', { ...DEFAULT_DRAFT, preset: 'violet', colorMode: 'dark', roundness: 1.5, scale: 0.9 })
  expect(preset).toEqual({ name: 'Demo', theme: { preset: 'violet', colorMode: 'dark', roundness: 1.5, scale: 0.9 } })
  expect(parseBrandPack(preset, { skipComponents: true }).accent).toBe('violet')

  const custom = brandJsonOf('Demo', { ...DEFAULT_DRAFT, preset: 'violet', custom: { light: { base: '#c2410c', strong: '#9a3412', subtle: 'rgb(194 65 12 / .1)' }, dark: presetAccent('orange', 'dark') } })
  expect(custom.theme).toBeUndefined()
  expect(custom.overridesDark?.['--accent']).toBe('#ffad5e')
  expect(parseBrandPack(custom, { skipComponents: true }).accent).toEqual({ base: '#c2410c', strong: '#9a3412', subtle: 'rgb(194 65 12 / .1)' })
})

// El transport mezcla los params con el tema de la marca: un "neutral" o un "1" omitido dejaría el valor viejo.
test('Aplicar manda los params explícitos y sin preset cuando el acento es propio', () => {
  expect(themeParamsOf(DEFAULT_DRAFT)).toEqual({ theme: { preset: 'neutral', colorMode: 'light', roundness: 1, scale: 1 } })
  const custom = themeParamsOf({ ...DEFAULT_DRAFT, preset: 'violet', custom: { light: presetAccent('blue', 'light'), dark: presetAccent('blue', 'dark') } })
  expect(custom.theme.preset).toBeUndefined()
  expect(custom.overrides).toEqual({ '--accent': '#0562ef', '--accent-strong': '#074db7', '--accent-subtle': 'rgb(5 98 239 / .12)' })
  // Sin overridesDark el acento claro se pinta sobre el fondo oscuro y no pasa AA (QA, apply-theme-run D2).
  expect(custom.overridesDark).toEqual({ '--accent': '#6ba3ff', '--accent-strong': '#a4c7ff', '--accent-subtle': 'rgb(5 98 239 / .22)' })
})

// El puente pinta lo mismo que quedará al aplicar: la capa de marca de deriveTheme en los dos modos.
test('la vista previa trae la marca resuelta en los dos modos y el modo elegido', () => {
  const t = themePreviewOf({ ...DEFAULT_DRAFT, preset: 'green', colorMode: 'dark', roundness: 2 })
  expect(t.colorMode).toBe('dark')
  expect(t.dark['--accent']).toBe('#53dca6')
  expect(t.dark['--accent-foreground']).toBe('#102016')
  expect(t.light['--radius-factor']).toBe('2')
})

// El builder lee el contrato del base (theme-panel.tsx:4, #852): el bloque claro entero hasta su último token, y el fondo
// resuelto de cada modo. Valores de tokens.css: --duration-spring :111, --neutral-0 :8 (claro) y --background oscuro :116.
test('el contrato se lee entero y da el fondo resuelto de cada modo', () => {
  const contract = contractModes(CSS)
  expect(contract.light['--foreground']).toBe('var(--neutral-11)')
  expect(contract.light['--duration-spring']).toBe('500ms')
  expect(backgroundOf('light', contract)).toBe('#ffffff')
  expect(backgroundOf('dark', contract)).toBe('#121212')
})

// Preset, semilla y acento propio se excluyen en derive.ts:75,89 y en el schema v2: Aplicar manda uno solo.
test('con semilla viaja theme.seed sin preset ni overrides, y el pack la acepta', () => {
  const d = { ...DEFAULT_DRAFT, preset: 'violet', seed: { accent: '#7747ff', variant: 'fidelity' as const } }
  const params = themeParamsOf(d)
  expect(params.theme.seed).toEqual({ accent: '#7747ff', variant: 'fidelity' })
  expect(params.theme.preset).toBeUndefined()
  expect(params.overrides).toBeUndefined()
  expect(parseBrandPack(brandJsonOf('Demo', d), { skipComponents: true }).name).toBe('Demo')
  expect(themePreviewOf(d).light['--accent']).toMatch(/^#[0-9a-f]{6}$/i)
})
