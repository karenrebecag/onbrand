import { expect, test } from 'bun:test'
import { formatCompact, formatDuration, tokensTooltip, totalTokens } from '../apps/builder/src/lib/run-cost'

// D9e de Lovable con alwaysShowSeconds, como lo llama el header Details ("1m 42s" de la corrida del 2026-10-27).
test('la duración sale como en Lovable: segundos, minutos y horas cortos, nunca menos de 1s', () => {
  expect(formatDuration(0.2, true)).toBe('1s')
  expect(formatDuration(42, true)).toBe('42s')
  expect(formatDuration(101.676, true)).toBe('1m 42s')
  expect(formatDuration(120, true)).toBe('2m 0s')
  expect(formatDuration(120)).toBe('2m')
  expect(formatDuration(3725, true)).toBe('1h 2m 5s')
})

// _E de Lovable para el contador; sin tokens o en cero no se muestra nada, como Ad con el costo.
test('los tokens van compactos como el contador de Lovable y se esconden si no hay', () => {
  expect(formatCompact(950)).toBe('950')
  expect(formatCompact(12345)).toBe('12.3k')
  expect(formatCompact(2000)).toBe('2k')
  expect(formatCompact(1_250_000)).toBe('1.3m')
  expect(totalTokens(undefined)).toBeUndefined()
  expect(totalTokens({ inputTokens: 0, outputTokens: 0 })).toBeUndefined()
  expect(totalTokens({ inputTokens: 12000, outputTokens: 345 })).toBe(12345)
  expect(tokensTooltip({ inputTokens: 12000, outputTokens: 345 })).toBe('12.000 tokens de entrada · 345 de salida')
})
