// Contraste de un pack sin navegador: los mismos pares que mide la red en chromium (scripts/brandpack-red.ts:58-71),
// sobre la tabla de tokens que el pack deja en cada modo. Lo usa applyBrand para no aplicar una marca ilegible.
import { contrast, mixOklab, parseColor, toHex, type Rgb } from './color-contrast';

export type ThemeTables = { light: Record<string, string>; dark: Record<string, string> };

/** Pares que una landing pinta con el contrato Arc. 4.5 = texto (WCAG 1.4.3), 3 = no-texto (1.4.11). */
export const AA_PAIRS: { fg: string; bg: string; min: 4.5 | 3 }[] = [
  { fg: '--foreground', bg: '--background', min: 4.5 },
  { fg: '--text-secondary', bg: '--background', min: 4.5 },
  { fg: '--text-muted', bg: '--background', min: 4.5 },
  { fg: '--foreground', bg: '--surface', min: 4.5 },
  { fg: '--text-secondary', bg: '--surface', min: 4.5 },
  { fg: '--foreground', bg: '--surface-muted', min: 4.5 },
  { fg: '--text-muted', bg: '--surface-muted', min: 4.5 },
  { fg: '--accent-foreground', bg: '--accent', min: 4.5 },
  { fg: '--accent', bg: '--background', min: 3 },
  { fg: '--foreground', bg: '--accent-subtle', min: 4.5 },
  { fg: '--border-strong', bg: '--background', min: 3 },
];

// El contrato mismo no llega a estos dos en sus defaults (tests/fixtures/brandpack-v2/aa-report.json: --text-muted
// 4.12 y 3.88, --border-strong 1.74 en el pack Base): es deuda del contrato, no de una marca. Si bloquearan, ningún
// pack se aplicaría. Se miden e informan; dejan de estar exentos cuando el contrato los lleve a su umbral.
export const CONTRACT_DEBT: ReadonlySet<string> = new Set(['--text-muted', '--border-strong']);

const VAR = /^var\(\s*(--[a-z0-9-]+)\s*(?:,[^)]*)?\)$/i;

const MIX = /^color-mix\(\s*in\s+oklab\s*,(.*)\)$/i;
const PCT = /^(.*?)\s+([\d.]+)%$/;

/** Argumentos de primer nivel de una función CSS: las comas dentro de var(..., fallback) no separan. */
function topLevelArgs(body: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const ch of body) {
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    cur += ch;
  }
  return [...out, cur.trim()];
}

/** El valor final de un token siguiendo sus var(); undefined si no está o hay un ciclo. Un color-mix en oklab de dos
 * colores opacos se resuelve a hex: así se declara --surface-band (tokens.css), el fondo de las bandas de sección. */
function resolveToken(table: Record<string, string>, token: string, depth = 0): string | undefined {
  const v = table[token]?.trim();
  if (v === undefined || depth > 8) return undefined;
  const ref = VAR.exec(v);
  if (ref) return resolveToken(table, ref[1], depth + 1);
  const mix = MIX.exec(v);
  return mix ? resolveMix(table, mix[1], depth + 1) : v;
}

function resolveMix(table: Record<string, string>, body: string, depth: number): string | undefined {
  const args = topLevelArgs(body);
  if (args.length !== 2) return undefined;
  const parts = args.map((a) => { const m = PCT.exec(a); return { color: (m ? m[1] : a).trim(), pct: m ? Number(m[2]) / 100 : undefined }; });
  const colors = parts.map(({ color }) => { const ref = VAR.exec(color); return parseColor(ref ? resolveToken(table, ref[1], depth) : color); });
  if (!colors[0] || !colors[1]) return undefined;
  // CSS Color 5 §2.1: sin porcentajes es 50/50; con uno solo, el otro es su complemento.
  const p2 = parts[1].pct ?? (parts[0].pct !== undefined ? 1 - parts[0].pct : 0.5);
  return toHex(mixOklab(colors[0], colors[1], p2));
}

/** Los tokens que recorre un token hasta su valor: él y cada var() que sigue. */
export function chainOf(table: Record<string, string>, token: string): string[] {
  const chain: string[] = [];
  for (let t: string | undefined = token; t && chain.length <= 8 && !chain.includes(t); t = VAR.exec(table[t]?.trim() ?? '')?.[1]) chain.push(t);
  return chain;
}

const OPAQUE_WHITE: Rgb = [255, 255, 255];

/** Ratio de cada par en un modo; null si un lado no se puede leer fuera del navegador (color-mix, nombre). */
export function pairRatios(table: Record<string, string>): Record<string, number | null> {
  const page = parseColor(resolveToken(table, '--background')) ?? OPAQUE_WHITE;
  const out: Record<string, number | null> = {};
  for (const { fg, bg } of AA_PAIRS) {
    const back = parseColor(resolveToken(table, bg), page);
    const front = back ? parseColor(resolveToken(table, fg), back) : null;
    out[`${fg} / ${bg}`] = back && front ? Math.round(contrast(front, back) * 100) / 100 : null;
  }
  return out;
}

/** Bandas de sección (tokens.css, [data-wt-surface]): remapean --background a una superficie propia y --text-muted a
 * --text-secondary en claro. Los bloques pintan texto y controles sobre var(--background), así que la banda es otro fondo de página
 * que el gate tiene que medir (QA: caption muted a 4.31:1 en la banda clara de Stats). */
export const BANDS: Record<'light' | 'dark', Record<'muted' | 'raised', string>> = {
  light: { muted: '--surface-band', raised: '--surface-band' },
  dark: { muted: '--surface-band', raised: '--surface-raised' },
};
/** Solo en claro: en oscuro el muted del tema ya pasa sobre las bandas y se conserva el del pack. */
export const BAND_REMAP: Record<'light' | 'dark', Readonly<Record<string, string>>> = { light: { '--text-muted': 'var(--text-secondary)' }, dark: {} };

/** Lo que se pinta sobre una banda: el texto a 4.5 (WCAG 1.4.3) y el borde de los controles a 3 (1.4.11). */
export const BAND_PAIRS: { fg: string; min: 4.5 | 3 }[] = [
  { fg: '--foreground', min: 4.5 },
  { fg: '--text-secondary', min: 4.5 },
  { fg: '--text-muted', min: 4.5 },
  { fg: '--border-strong', min: 3 },
];

/** La tabla dentro de una banda: el fondo es la superficie ya resuelta (se calcula en el elemento raíz, como el navegador
 * hereda el valor computado) y los remapeos de la banda encima. */
export function bandTable(table: Record<string, string>, surface: string, mode: 'light' | 'dark'): Record<string, string> | null {
  const bg = resolveToken(table, surface);
  return bg === undefined ? null : { ...table, ...BAND_REMAP[mode], '--background': bg };
}

/** Ratio de cada par de banda en un modo; clave `<fg> / band:<muted|raised>`. */
export function bandRatios(table: Record<string, string>, mode: 'light' | 'dark'): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [band, surface] of Object.entries(BANDS[mode])) {
    const t = bandTable(table, surface, mode);
    const back = t ? parseColor(t['--background']) : null;
    for (const { fg } of BAND_PAIRS) {
      const front = t && back ? parseColor(resolveToken(t, fg), back) : null;
      out[`${fg} / band:${band}`] = back && front ? Math.round(contrast(front, back) * 100) / 100 : null;
    }
  }
  return out;
}

/** Pares bajo su umbral que la marca tocó (fija al menos uno de los dos tokens). Lo que queda en el default del contrato
 * es responsabilidad del contrato, no del pack. */
export function packAaErrors(tables: ThemeTables, touched: ReadonlySet<string>): string[] {
  const errors: string[] = [];
  for (const [mode, table] of Object.entries(tables) as ['light' | 'dark', Record<string, string>][]) {
    const ratios = pairRatios(table);
    for (const { fg, bg, min } of AA_PAIRS) {
      // Por cadena y no por nombre: --background es var(--neutral-0) en claro, y un pack que fija la rampa cambia el rol.
      if (CONTRACT_DEBT.has(fg) || ![...chainOf(table, fg), ...chainOf(table, bg)].some((t) => touched.has(t))) continue;
      const r = ratios[`${fg} / ${bg}`];
      if (r !== null && r !== undefined && r < min) errors.push(`${fg} sobre ${bg} tiene ${r.toFixed(2)}:1 en ${mode === 'light' ? 'claro' : 'oscuro'}, mínimo ${min}:1`);
    }
    const bands = bandRatios(table, mode);
    for (const [band, surface] of Object.entries(BANDS[mode])) {
      // La banda mezcla --background y --foreground: un pack que fija cualquiera de los dos la mueve.
      const back = [...chainOf(table, surface), ...chainOf(table, '--background'), ...chainOf(table, '--foreground')];
      for (const { fg, min } of BAND_PAIRS) {
        const front = chainOf({ ...table, ...BAND_REMAP[mode] }, fg);
        if (CONTRACT_DEBT.has(fg) || ![...front, ...back].some((t) => touched.has(t))) continue;
        const r = bands[`${fg} / band:${band}`];
        if (r !== null && r !== undefined && r < min) errors.push(`${fg} sobre ${surface} (banda ${band}) tiene ${r.toFixed(2)}:1 en ${mode === 'light' ? 'claro' : 'oscuro'}, mínimo ${min}:1`);
      }
    }
  }
  return errors;
}
