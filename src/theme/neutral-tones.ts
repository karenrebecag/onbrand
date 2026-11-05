// Tono HCT (L*) de cada gris del contrato: la tabla con que theme.seed.neutral reconstruye la rampa (seed.ts). Es una tabla
// derivada del contrato como presets.json y contract.json: scripts/gen-theme-presets.ts la escribe en neutral-tones.json
// desde tokens.css del core, y una distro la regenera desde su DS en su repo (Arq, B9 paso 5).
import { argbFromRgb, Hct } from '@material/material-color-utilities';
import { parseColor } from '../color-contrast';
import type { ThemeMode, TokenMap } from './presets-from-css';

// En claro la rampa (--neutral-0..11) fija los roles por var(); en oscuro el contrato escribe los roles directos.
export const NEUTRAL_RAMP_LIGHT = ['--neutral-0', '--neutral-1', '--neutral-2', '--neutral-3', '--neutral-4', '--neutral-5', '--neutral-6', '--neutral-7', '--neutral-8', '--neutral-9', '--neutral-10', '--neutral-11'] as const;
export const NEUTRAL_ROLES_DARK = ['--background', '--surface', '--surface-raised', '--surface-muted', '--foreground', '--text-secondary', '--text-muted', '--border', '--border-subtle', '--border-strong'] as const;

export type NeutralTones = Record<ThemeMode, Record<string, number>>;

/** Tono con un decimal del color de un token; el contrato tiene que darlo literal (hex, rgb u oklch), no por var(). */
function toneOf(token: string, value: string | undefined): number {
  const rgb = value === undefined ? null : parseColor(value);
  if (!rgb) throw new Error(`neutral-tones: ${token} no es un color literal en el contrato (${value ?? 'falta'})`);
  const [r, g, b] = rgb.map(Math.round) as [number, number, number];
  return Math.round(Hct.fromInt(argbFromRgb(r, g, b)).tone * 10) / 10;
}

export function neutralTonesFrom(contract: Record<ThemeMode, TokenMap>): NeutralTones {
  return {
    light: Object.fromEntries(NEUTRAL_RAMP_LIGHT.map((t) => [t, toneOf(t, contract.light[t])])),
    dark: Object.fromEntries(NEUTRAL_ROLES_DARK.map((t) => [t, toneOf(t, contract.dark[t])])),
  };
}
