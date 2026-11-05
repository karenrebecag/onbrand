// Derivación de la identidad de marca, pura: sin IO ni node:*, para que la usen igual el builder (vista previa vía
// @engine, apps/builder/vite.config.ts:19) y el transport (aplicar). Una sola implementación evita que la vista previa
// y la versión aplicada diverjan (specs/panel-tema-params.md §5, refinamiento 2).
import presetTable from './presets.json';
import contractTable from './contract.json';
import { seedTheme, type SeedParams } from './seed';
import type { ThemeMode, TokenMap } from './presets-from-css';

export type { ThemeMode, TokenMap } from './presets-from-css';

/** Lo que el panel Tema expone (specs/brandpack-v2-v1-spec.md, "derive.ts"). Un acento propio llega como override
 * exacto o como semilla (specs/derivacion-semilla.md), que deriva el acento y, con neutral, la rampa. */
export interface ThemeParams {
  preset?: string;
  seed?: SeedParams;
  colorMode?: ThemeMode;
  fonts?: { display?: string; body?: string };
  roundness?: number;
  scale?: number;
}

/** Un valor que la derivación cambió para cumplir AA. Solo de la semilla: presets y overrides son exactos (decisión
 * de Karen 2026-11-03, specs/derivacion-semilla.md "Corrección AA"). */
export interface Correction { mode: ThemeMode; token: string; from: string; to: string; reason: string }

/** Tokens que la marca fija encima del contrato (foundation.css), por modo. El contrato no se repite aquí: lo pone
 * foundation.css y esto se declara después, igual que identity.css hoy (brand.ts:467). */
export interface DerivedTheme { light: TokenMap; dark: TokenMap; colorMode: ThemeMode; corrections: Correction[] }

const PRESETS = presetTable as Record<string, Record<ThemeMode, TokenMap>>;
export const THEME_PRESETS: readonly string[] = Object.keys(PRESETS);

// Mismo guard que la frontera de brand.json (brand.ts:292): el valor termina dentro de `:root { --x: VALUE; }`, así
// que no puede cerrar la regla ni colar @import/url(). Copiado y no importado porque brand.ts trae node:fs.
const UNSAFE_TOKEN_VALUE = /[;{}@]|\/\*|\*\/|url\(|expression\(/i;
const TOKEN_NAME = /^--[a-z0-9-]+$/;
const UNSAFE_FONT = /[;{}@'"\\\n\r]/;

// brand.ts:443 cita la familia con espacios para que `--font-geist: Fraunces` y `'Source Serif'` resuelvan igual.
const quoteFont = (name: string): string => (/\s/.test(name) ? `'${name}'` : name);

function lever(name: string, value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`theme: ${name} debe ser un número mayor que 0 (llegó ${value})`);
  return String(value);
}

function checkedOverrides(raw: TokenMap | undefined, label: string): TokenMap {
  const out: TokenMap = {};
  for (const [token, value] of Object.entries(raw ?? {})) {
    if (!TOKEN_NAME.test(token)) throw new Error(`theme: ${label} "${token}" no es un nombre de token`);
    if (typeof value !== 'string' || !value.trim() || UNSAFE_TOKEN_VALUE.test(value)) throw new Error(`theme: ${label} "${token}" tiene un valor inválido`);
    out[token] = value.trim();
  }
  return out;
}

function fontPairs(fonts: ThemeParams['fonts']): TokenMap {
  const out: TokenMap = {};
  // El contrato resuelve --font-display/--font-body vía --font-geist/--font-inter (foundation.css:99-100); escribir
  // esos dos es lo que hace resolveIdentity (brand.ts:422-423) y deja el resto de la cadena intacta.
  for (const [role, token] of [['display', '--font-geist'], ['body', '--font-inter']] as const) {
    const family = fonts?.[role]?.trim();
    if (!family) continue;
    if (UNSAFE_FONT.test(family)) throw new Error(`theme: fonts.${role} "${family}" no es un nombre de familia`);
    out[token] = quoteFont(family);
  }
  return out;
}

/** Resuelve la identidad: contrato < preset < theme (palancas y fuentes) < overrides / overridesDark. Emite siempre
 * los dos modos porque una página clara puede tener zonas oscuras (foundation.css:1-4, alcance por data-theme). */
export function deriveTheme(theme: ThemeParams = {}, overrides?: TokenMap, overridesDark?: TokenMap): DerivedTheme {
  // Semilla y preset dicen los dos de dónde sale el acento: juntos no hay cuál gana.
  if (theme.seed && theme.preset !== undefined) throw new Error('theme: preset y seed se contradicen; usa uno');
  const name = theme.preset ?? 'neutral';
  const preset = PRESETS[name];
  if (!preset) throw new Error(`theme: preset "${name}" no existe; usa uno de ${THEME_PRESETS.join(', ')}`);
  if (theme.colorMode !== undefined && theme.colorMode !== 'light' && theme.colorMode !== 'dark') throw new Error(`theme: colorMode "${String(theme.colorMode)}" no es light ni dark`);

  const levers: TokenMap = {};
  const radius = lever('roundness', theme.roundness);
  const scaling = lever('scale', theme.scale);
  if (scaling) levers['--scaling'] = scaling;
  if (radius) levers['--radius-factor'] = radius;
  const fonts = fontPairs(theme.fonts);
  const own = checkedOverrides(overrides, 'overrides');
  const ownDark = checkedOverrides(overridesDark, 'overridesDark');
  if (theme.seed && '--accent' in own) throw new Error('theme: seed y un --accent en overrides se contradicen; usa uno');

  // En foundation.css la regla clara del preset ([data-accent=x] [data-theme]) también alcanza las zonas oscuras y
  // la oscura solo pisa lo que declara: green no redeclara --accent-foreground en oscuro (:147 vs :155), así que en
  // una zona oscura sigue el #102016 claro. El modo oscuro resuelto es claro + oscuro, no solo el bloque oscuro.
  // La semilla ocupa el lugar del preset (contrato < semilla < palancas < overrides) y se corrige a AA contra el
  // contrato y los overrides, que cuentan para medir pero no se mueven (seed.ts seedTheme).
  const seeded = theme.seed ? seedTheme(theme.seed, contractTable as Record<ThemeMode, TokenMap>, own, ownDark) : undefined;
  const base = seeded ?? { ...preset, corrections: [] };
  const light: TokenMap = { ...base.light, ...levers, ...fonts, ...own };
  // Los overrides valen en los dos modos y overridesDark gana al final, como tokens/tokensDark (brand.ts:436-437):
  // si no, foundation.css redeclara el acento neutro en cada zona oscura y la marca se vuelve gris.
  const dark: TokenMap = { ...base.light, ...base.dark, ...levers, ...fonts, ...own, ...ownDark };

  return { light, dark, colorMode: theme.colorMode ?? 'light', corrections: base.corrections };
}
