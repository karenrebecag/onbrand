// Lista cerrada de fuentes de marca y el <link> de Google Fonts para las que el scaffold no trae instaladas. Hoja: la
// usan brand-identity, brand-pack, brand.ts, identity-ephemeral e identity-design sin que ninguna dependencia vuelva
// aquí (docs/estandares.md A4). Antes vivía en identity-ephemeral.ts.

export type FontRole = 'display' | 'body' | 'both';
export interface FontChoice { family: string; category: 'sans' | 'serif'; role: FontRole; weights: string; installed?: boolean }

// Pesos 400 y 500: la regla de Arc es regular y medium. Cada familia verificada contra fonts.googleapis.com/css2
// con esos pesos (200) el 2026-10-25. Geist e Inter ya vienen con el scaffold (fontsource): sin link.
export const FONT_LIST: readonly FontChoice[] = [
  { family: 'Geist', category: 'sans', role: 'both', weights: '400;500', installed: true },
  { family: 'Inter', category: 'sans', role: 'body', weights: '400;500', installed: true },
  { family: 'Sora', category: 'sans', role: 'display', weights: '400;500' },
  { family: 'Space Grotesk', category: 'sans', role: 'display', weights: '400;500' },
  { family: 'Bricolage Grotesque', category: 'sans', role: 'display', weights: '400;500' },
  { family: 'Schibsted Grotesk', category: 'sans', role: 'display', weights: '400;500' },
  { family: 'Outfit', category: 'sans', role: 'display', weights: '400;500' },
  { family: 'Inter Tight', category: 'sans', role: 'display', weights: '400;500' },
  { family: 'Fraunces', category: 'serif', role: 'display', weights: '400;500' },
  { family: 'Playfair Display', category: 'serif', role: 'display', weights: '400;500' },
  { family: 'Instrument Serif', category: 'serif', role: 'display', weights: '400' },
  { family: 'Newsreader', category: 'serif', role: 'both', weights: '400;500' },
  { family: 'Manrope', category: 'sans', role: 'both', weights: '400;500' },
  { family: 'DM Sans', category: 'sans', role: 'both', weights: '400;500' },
  { family: 'Plus Jakarta Sans', category: 'sans', role: 'both', weights: '400;500' },
  { family: 'Figtree', category: 'sans', role: 'both', weights: '400;500' },
  { family: 'Hanken Grotesk', category: 'sans', role: 'both', weights: '400;500' },
  { family: 'Instrument Sans', category: 'sans', role: 'body', weights: '400;500' },
  { family: 'Work Sans', category: 'sans', role: 'body', weights: '400;500' },
  { family: 'IBM Plex Sans', category: 'sans', role: 'body', weights: '400;500' },
  { family: 'Onest', category: 'sans', role: 'body', weights: '400;500' },
  { family: 'Libre Franklin', category: 'sans', role: 'body', weights: '400;500' },
  { family: 'Source Serif 4', category: 'serif', role: 'body', weights: '400;500' },
];

export const byFamily = new Map(FONT_LIST.map((f) => [f.family.toLowerCase(), f]));

/** href del <link> de Google Fonts para las familias dadas (las instaladas no entran). null si no hace falta link. */
export function googleFontsHref(families: readonly string[]): string | null {
  const remote = [...new Set(families)].map((f) => byFamily.get(f.toLowerCase())).filter((f): f is FontChoice => !!f && !f.installed);
  if (!remote.length) return null;
  const params = remote.map((f) => `family=${f.family.replace(/ /g, '+')}${f.weights === '400' ? '' : `:wght@${f.weights}`}`);
  return `https://fonts.googleapis.com/css2?${params.join('&')}&display=swap`;
}

/** Primera familia de un font stack, sin comillas ni el sufijo " Variable" de fontsource. */
export function familyOf(stack: string): string {
  return (stack.split(',')[0] ?? '').trim().replace(/^['"]|['"]$/g, '').replace(/ Variable$/i, '');
}
