// Derivación de semilla: 1-2 colores -> los tokens de identidad del contrato, claro y oscuro. Pura (sin IO ni node:*)
// para que la importen igual el builder (vista previa vía @engine, apps/builder/vite.config.ts:19) y derive.ts.
// Algoritmo: el de Stitch, Material Color Utilities DynamicScheme spec 2025 con contraste 0
// (re-sistema/BRAND-THEME-CROSS-REFERENTE.md:48-52, prompts-B1n7qKLF/deobfuscated.js:28701-28719).
// Spec: ~/Desktop/web-transformer-sesiones/specs/derivacion-semilla.md.
import { argbFromHex, blueFromArgb, DynamicScheme, greenFromArgb, Hct, hexFromArgb, redFromArgb, TonalPalette, Variant } from '@material/material-color-utilities';
import { AA_PAIRS, chainOf, CONTRACT_DEBT, pairRatios } from '../brand-aa';
import { contrast, parseColor } from '../color-contrast';
import type { Correction } from './derive';
import type { ThemeMode, TokenMap } from './presets-from-css';
import neutralTones from './neutral-tones.json';

/** Las 9 variantes de Stitch (enum :26496-26506), con el nombre en kebab que usa el brand.json. */
export const SEED_VARIANTS = {
  'tonal-spot': Variant.TONAL_SPOT,
  fidelity: Variant.FIDELITY,
  content: Variant.CONTENT,
  vibrant: Variant.VIBRANT,
  expressive: Variant.EXPRESSIVE,
  neutral: Variant.NEUTRAL,
  monochrome: Variant.MONOCHROME,
  rainbow: Variant.RAINBOW,
  'fruit-salad': Variant.FRUIT_SALAD,
} as const;
export type SeedVariant = keyof typeof SEED_VARIANTS;

export interface SeedParams {
  /** El color de la marca: fija el acento (los 7 tokens que hoy fija un preset). */
  accent: string;
  /** Opcional: tiñe la rampa neutra (fondos, texto, bordes). Sin él, los grises del contrato quedan. */
  neutral?: string;
  /** Default tonal-spot, el default de Material. Stitch mapea UNSPECIFIED a fidelity (:28621-28631). */
  variant?: SeedVariant;
}

// Tono HCT (L*) de cada gris del contrato: con estos tonos una semilla neutra acromática reproduce el contrato; con una
// semilla teñida, la rampa conserva sus escalones. Los genera scripts/gen-theme-presets.ts desde tokens.css
// (neutral-tones.ts); en oscuro son los roles, porque el contrato los escribe directos y no por la rampa.
export const NEUTRAL_TONES_LIGHT: Readonly<Record<string, number>> = neutralTones.light;
export const NEUTRAL_TONES_DARK: Readonly<Record<string, number>> = neutralTones.dark;

const HEX = /^#[0-9a-f]{6}$/i;
// Paso de --accent-strong sobre el tono de --accent: más oscuro en claro y más claro en oscuro, la dirección de los
// presets (foundation.css:164-167 vs :172-175).
const STRONG_STEP = 10;
// Alpha de --accent-subtle: el de los presets, .12-.16 en claro (foundation.css:164-167) y .2-.22 en oscuro (:172-177).
const SUBTLE_ALPHA: Record<ThemeMode, number> = { light: 0.13, dark: 0.22 };

function hexArgb(label: string, value: string): number {
  // Solo hex: es la entrada de Hct.fromInt; convertir oklch o rgb en silencio cambiaría la semilla sin avisar.
  if (!HEX.test(value)) throw new Error(`theme.seed: ${label} "${value}" debe ser un hex de 6 dígitos (#rrggbb)`);
  return argbFromHex(value);
}

const rgbAlpha = (argb: number, alpha: number): string => `rgb(${redFromArgb(argb)} ${greenFromArgb(argb)} ${blueFromArgb(argb)} / ${alpha})`;

function scheme(seed: SeedParams, isDark: boolean): DynamicScheme {
  const variant = SEED_VARIANTS[seed.variant ?? 'tonal-spot'];
  if (variant === undefined) throw new Error(`theme.seed: variant "${String(seed.variant)}" no existe; usa una de ${Object.keys(SEED_VARIANTS).join(', ')}`);
  return new DynamicScheme({
    sourceColorHct: Hct.fromInt(hexArgb('accent', seed.accent)),
    variant,
    isDark,
    contrastLevel: 0,
    // El default de la librería es 2021 (dynamic_scheme DEFAULT_SPEC_VERSION); Stitch pide 2025 explícito.
    specVersion: '2025',
    ...(seed.neutral ? { neutralPalette: TonalPalette.fromInt(hexArgb('neutral', seed.neutral)) } : {}),
  });
}

function modeTokens(seed: SeedParams, mode: ThemeMode): TokenMap {
  const s = scheme(seed, mode === 'dark');
  const accent = s.primary;
  const tone = Hct.fromInt(accent).tone;
  const toward = tone + (mode === 'dark' ? STRONG_STEP : -STRONG_STEP);
  // monochrome en oscuro da el acento en tono 100: no hay más claro, así que el fuerte va al otro lado y no se
  // confunde con el acento (un hover que no cambia).
  const strongTone = toward > 100 || toward < 0 ? tone - (mode === 'dark' ? STRONG_STEP : -STRONG_STEP) : toward;
  const out: TokenMap = {
    '--accent': hexFromArgb(accent),
    '--accent-strong': hexFromArgb(s.primaryPalette.tone(strongTone)),
    '--accent-subtle': rgbAlpha(accent, SUBTLE_ALPHA[mode]),
    '--accent-foreground': hexFromArgb(s.onPrimary),
    // Un control elegido se pinta con el acento y su marca con el texto sobre el acento, como los presets de color
    // (presets.json: --control-on = --accent, --control-thumb-on/--control-glyph claros sobre él).
    '--control-on': hexFromArgb(accent),
    '--control-thumb-on': hexFromArgb(s.onPrimary),
    '--control-glyph': hexFromArgb(s.onPrimary),
  };
  // El neutro oscuro del contrato rellena el slider en gris (foundation.css:139); con acento propio va el acento.
  if (mode === 'dark') out['--control-fill'] = hexFromArgb(accent);
  if (seed.neutral) {
    const tones = mode === 'light' ? NEUTRAL_TONES_LIGHT : NEUTRAL_TONES_DARK;
    for (const [token, tone] of Object.entries(tones)) out[token] = hexFromArgb(s.neutralPalette.tone(tone));
  }
  return out;
}

/** Los tokens de identidad que salen de la semilla, por modo. Determinista: la misma semilla da los mismos hex. */
export function seedTokens(seed: SeedParams): Record<ThemeMode, TokenMap> {
  return { light: modeTokens(seed, 'light'), dark: modeTokens(seed, 'dark') };
}

// Tokens que repiten el acento: si la corrección mueve --accent, se mueven con él para que el control elegido no quede
// en el tono viejo (modeTokens arriba los iguala).
const ACCENT_ECHOES: Record<ThemeMode, readonly string[]> = { light: ['--control-on'], dark: ['--control-on', '--control-fill'] };
// Hasta 3 vueltas: mover el foreground de un par puede romper otro par que lo usa de fondo; más vueltas no convergen.
const MAX_PASSES = 3;

function retone(hex: string, other: string, min: number): string | null {
  const argb = argbFromHex(hex);
  const back = parseColor(other);
  if (!back) return null;
  const hct = Hct.fromInt(argb);
  // Hacia el extremo que aleja del otro lado: más oscuro sobre fondo claro, más claro sobre oscuro. Hue y croma quedan.
  const step = contrast(back, [0, 0, 0]) > contrast(back, [255, 255, 255]) ? -1 : 1;
  for (let tone = hct.tone + step; tone >= 0 && tone <= 100; tone += step) {
    const next = hexFromArgb(Hct.from(hct.hue, hct.chroma, tone).toInt());
    const fg = parseColor(next);
    if (fg && contrast(fg, back) >= min) return next;
  }
  return null;
}


/** La semilla con los pares de AA_PAIRS (brand-aa.ts:8-20) corregidos donde un lado salió de la semilla. Exacto para
 * todo lo demás (decisión de Karen 2026-11-03): un override o el contrato nunca se mueven. Si los dos lados son de la
 * semilla se mueve el foreground; el acento es la identidad. Lo que no se pueda corregir queda y el gate de applyBrand
 * falla con el par. `own`/`ownDark` son los overrides del pack: cuentan para medir y nunca se corrigen. */
export function seedTheme(seed: SeedParams, contract: Record<ThemeMode, TokenMap>, own: TokenMap = {}, ownDark: TokenMap = {}): { light: TokenMap; dark: TokenMap; corrections: Correction[] } {
  const derived = seedTokens(seed);
  const out = { light: { ...derived.light }, dark: { ...derived.dark } };
  for (const t of Object.keys(own)) { delete out.light[t]; delete out.dark[t]; }
  for (const t of Object.keys(ownDark)) delete out.dark[t];
  const corrections: Correction[] = [];
  // La misma composición que brandAaTables (brand.ts): en una zona oscura rige lo claro y encima lo oscuro.
  const tables = (): Record<ThemeMode, TokenMap> => {
    const light = { ...contract.light, ...out.light, ...own };
    return { light, dark: { ...light, ...contract.dark, ...out.dark, ...own, ...ownDark } };
  };
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let moved = false;
    for (const mode of ['light', 'dark'] as const) {
      for (const { fg, bg, min } of AA_PAIRS) {
        if (CONTRACT_DEBT.has(fg)) continue;
        const table = tables()[mode];
        const ratio = pairRatios(table)[`${fg} / ${bg}`];
        if (ratio === null || ratio === undefined || ratio >= min) continue;
        const ownedBy = (token: string) => chainOf(table, token).find((t) => t in out[mode] && HEX.test(out[mode][t]));
        const target = ownedBy(fg) ?? ownedBy(bg);
        if (!target) continue;
        const otherSide = target === ownedBy(fg) ? bg : fg;
        const otherValue = chainOf(table, otherSide).map((t) => table[t]).at(-1) ?? '';
        const next = retone(out[mode][target], otherValue, min);
        if (!next) continue;
        corrections.push({ mode, token: target, from: out[mode][target], to: next, reason: `${fg} / ${bg} ${ratio.toFixed(2)} -> ${min}` });
        out[mode][target] = next;
        if (target === '--accent') for (const echo of ACCENT_ECHOES[mode]) if (echo in out[mode]) out[mode][echo] = next;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return { ...out, corrections };
}
