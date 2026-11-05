import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { PRESET_ACCENTS } from '../src/brand'
import { contractFromCss, presetsFromCss, serializePresets } from '../src/theme/presets-from-css'
import { deriveTheme, THEME_PRESETS } from '../src/theme/derive'

// El contrato del core (B9 paso 4): de él salen presets.json y contract.json.
const FOUNDATION = new URL('../templates/base-scaffold/src/theme/tokens.css', import.meta.url)
const PRESETS_JSON = new URL('../src/theme/presets.json', import.meta.url)

// presets.json se committea para que derive.ts no lea foundation.css (sin IO); si alguien toca un preset del contrato
// y no regenera, la derivación mentiría. bun scripts/gen-theme-presets.ts lo arregla.
test('presets.json es byte a byte lo que sale de foundation.css', () => {
  expect(readFileSync(PRESETS_JSON, 'utf8')).toBe(serializePresets(presetsFromCss(readFileSync(FOUNDATION, 'utf8'))))
})

// Igual para el contrato que lee la derivación de semilla para medir AA sin IO (seed.ts seedTheme).
test('contract.json es lo que sale de foundation.css', () => {
  const json = readFileSync(new URL('../src/theme/contract.json', import.meta.url), 'utf8')
  expect(json).toBe(`${JSON.stringify(contractFromCss(readFileSync(FOUNDATION, 'utf8')), null, 2)}\n`)
})

// El schema del pack (brand.ts:26) y la derivación tienen que ofrecer los mismos 8 presets.
test('los presets derivables son los del brandpack', () => {
  expect([...THEME_PRESETS]).toEqual([...PRESET_ACCENTS])
})

// Cascada real de foundation.css: la regla clara del preset alcanza las zonas oscuras y la oscura solo pisa lo suyo.
test('el modo oscuro del preset hereda lo que su regla oscura no redeclara', () => {
  const t = deriveTheme({ preset: 'green' })
  expect(t.light['--accent-foreground']).toBe('#102016')
  expect(t.dark['--accent-foreground']).toBe('#102016')
  expect(t.dark['--accent']).toBe('#53dca6')
  expect(t.dark['--control-fill']).toBe('#1fae78')
})

// Orden contrato < preset < theme < overrides < overridesDark; exacto: nada se corrige en v1.
test('overrides exactos ganan en los dos modos y overridesDark solo en oscuro', () => {
  const t = deriveTheme(
    { preset: 'violet', fonts: { display: 'Source Serif', body: 'Inter' }, roundness: 1.25, scale: 1 },
    { '--accent': '#ff6600' },
    { '--accent': '#ff8a3d' },
  )
  expect(t.light['--accent']).toBe('#ff6600')
  expect(t.dark['--accent']).toBe('#ff8a3d')
  expect(t.light['--accent-strong']).toBe('#5528ce')
  expect(t.light['--font-geist']).toBe("'Source Serif'")
  expect(t.dark['--font-inter']).toBe('Inter')
  expect(t.light['--radius-factor']).toBe('1.25')
  expect(t.colorMode).toBe('light')
  expect(t.corrections).toEqual([])
})

test('sin preset la base es neutral; un preset, palanca o valor inválido falla fuerte', () => {
  expect(deriveTheme().light['--accent']).toBe('oklch(33% 0 0)')
  expect(() => deriveTheme({ preset: 'teal' })).toThrow(/no existe/)
  expect(() => deriveTheme({ roundness: 0 })).toThrow(/mayor que 0/)
  expect(() => deriveTheme({}, { '--accent': 'red; } body { x: 1' })).toThrow(/valor inválido/)
  expect(() => deriveTheme({}, { accent: '#fff' })).toThrow(/nombre de token/)
  expect(() => deriveTheme({ fonts: { display: "x'; }" } })).toThrow(/familia/)
})
