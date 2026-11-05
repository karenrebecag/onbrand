// Esquema y parser de un Brand Pack (brand.json v1 y v2): valida el dato externo en el límite de confianza y devuelve un
// BrandPack tipado. Depende de brand-util (helpers), brand-identity (resolveIdentity, para el gate de contraste de las
// variantes) y brand-fonts indirectamente; NO importa brand.ts (antes el ciclo A4). brand.ts re-exporta lo público.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { config } from './config';
import { fileURLToPath } from 'node:url';
import { RHYTHM_PROFILES, type RhythmProfile } from './types';
import { SEED_VARIANTS, seedTheme, type SeedParams, type SeedVariant } from './theme/seed';
import { migrateV1ToV2 } from './theme/migrate-v1';
import { contractFromCss } from './theme/presets-from-css';
import type { Correction } from './theme/derive';
import { parseComponents, variantContrastErrors, type BrandComponents, type ExtensionPoints } from './brand-components';
import { ACCENT_TOKENS, isObject, isStr, isStrArray, onlyKeys, withoutAccent } from './brand-util';
import type { BrandExpect } from './brand-sensors';
import { resolveIdentity } from './brand-identity';

// Raíz del repo (brand-pack.ts vive en src/): para leer el contrato del scaffold como fuente única del allowlist.
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
// El contrato del core es el del DS base (B9 paso 4); una distro con otro scaffold regenera sus tablas en su repo.
const CONTRACT_CSS = join(REPO_ROOT, 'templates', 'base-scaffold', 'src', 'theme', 'tokens.css');

export const PRESET_ACCENTS = ['neutral', 'violet', 'blue', 'green', 'amber', 'orange', 'coral', 'rose'] as const;
/** Claves que brand.json puede traer; las mismas que declara brands/brandpack.schema.json (un test las compara). Una clave
 * fuera de la lista falla: un typo como `tokensdark` se ignoraba y la marca salía sin su bloque oscuro. */
export const BRAND_PACK_KEYS = ['$schema', 'name', 'logo', 'logoDark', 'logoKind', 'accent', 'surface', 'fonts', 'composition', 'tokens', 'tokensDark', 'inherit', 'requires', 'components'] as const;
export const ACCENT_KEYS = ['base', 'strong', 'subtle', 'foreground'] as const;
export const SURFACE_KEYS = ['background', 'surface', 'foreground', 'textSecondary'] as const;
export const FONT_KEYS = ['display', 'body', 'import'] as const;
/** brand.json v2 (specs/brandpack-v2-v1-spec.md, "Forma del pack v2"): la marca declara solo lo que decide; lo demás es
 * el contrato. Las mismas claves que brands/brandpack-v2.schema.json (un test las compara). */
export const BRAND_PACK_V2_KEYS = ['$schema', 'name', 'logo', 'logoDark', 'logoKind', 'theme', 'overrides', 'overridesDark', 'composition', 'requires', 'components'] as const;
export const THEME_KEYS = ['preset', 'seed', 'colorMode', 'fonts', 'roundness', 'scale'] as const;
export const SEED_KEYS = ['accent', 'neutral', 'variant'] as const;
export const COLOR_MODES = ['light', 'dark'] as const;
export type ColorMode = (typeof COLOR_MODES)[number];

export type PresetAccent = (typeof PRESET_ACCENTS)[number];

export interface CustomAccent { base: string; strong: string; subtle: string; foreground?: string }
export interface BrandSurface { background?: string; surface?: string; foreground?: string; textSecondary?: string }
export interface BrandFonts { display?: string; body?: string; import?: string }

/** Sesgo de composición por rol: ajusta el deseo (no toca los tags de los bloques), igual que
 * INTENT_OVERRIDES. Determinista: entra al score, no reordena por validación. */
export interface RoleBias { desiredTags?: string[]; undesiredTags?: string[]; allowedCategories?: string[] }
export const DENSITIES = ['compact', 'default', 'spacious'] as const;
export type Density = (typeof DENSITIES)[number];
/** Bloque determinista de preferencia de composición de una marca. Todo opcional; vacío = sin sesgo. */
export interface BrandComposition { roles?: Record<string, RoleBias>; density?: Density; rhythm?: RhythmProfile; styleSet?: string }

export type LogoKind = 'wordmark' | 'mark';
export interface BrandPack { name: string; logo?: string; logoDark?: string; logoKind?: LogoKind; accent: PresetAccent | CustomAccent; surface?: BrandSurface; fonts?: BrandFonts; composition?: BrandComposition; tokens?: Record<string, string>; tokensDark?: Record<string, string>; inherit?: Record<string, string>; requires?: { ds: string }; components?: BrandComponents; colorMode?: ColorMode; schemaVersion?: 2; corrections?: Correction[] }

export interface ParseBrandOptions {
  /** Ranuras del pin activo (extension-points@<pin>.json). Un pack con components y sin ellas falla cerrado. */
  extensionPoints?: ExtensionPoints;
  pin?: string;
  /** Para quien no escribe identity.css ni publica (cobertura, composición, métricas): no valida ni devuelve components. */
  skipComponents?: boolean;
}

export const LOGO_EXTS = ['.svg', '.png', '.webp'] as const;

// El logo viaja dentro del pack: una ruta que sale del pack (absoluta o con ..) copiaría cualquier archivo del host.
function parseLogo(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (!isStr(raw)) throw new Error('brand pack: "logo" debe ser una ruta relativa (string no vacío)');
  const path = normalize(raw);
  if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error(`brand pack: logo "${raw}" tiene que estar dentro del pack`);
  if (!(LOGO_EXTS as readonly string[]).includes(extname(path).toLowerCase())) throw new Error(`brand pack: logo "${raw}" tiene que ser ${LOGO_EXTS.join('|')}`);
  return path;
}

// QA gen7: el logo de una marca ya era el wordmark y los bloques le sumaban el nombre al lado. Sin logoKind se asume 'mark'.
function parseLogoKind(raw: unknown): LogoKind | undefined {
  if (raw === undefined) return undefined;
  if (raw !== 'wordmark' && raw !== 'mark') throw new Error('brand pack: "logoKind" tiene que ser wordmark|mark');
  return raw;
}

/** true si el archivo de logo ya contiene el nombre: header y footer no lo repiten al lado. */
export function logoIncludesName(brand: BrandPack): boolean {
  return Boolean(brand.logo) && brand.logoKind === 'wordmark';
}

/** src del logo en la página emitida, o undefined si la marca no trae logo. */
export function logoSrc(brand: BrandPack): string | undefined {
  return brand.logo ? `/brand/logo${extname(brand.logo).toLowerCase()}` : undefined;
}

/** src del logo para zonas oscuras, o undefined si la marca no trae uno aparte. */
export function logoDarkSrc(brand: BrandPack): string | undefined {
  return brand.logoDark ? `/brand/logo-dark${extname(brand.logoDark).toLowerCase()}` : undefined;
}

/** src/brand.ts del workspace: lo que BrandMark pinta en header y footer. JSON.stringify escapa el nombre, que es input. */
export function brandModule(brand: BrandPack): string {
  const light = logoSrc(brand);
  const dark = logoDarkSrc(brand);
  const identity = { name: brand.name, ...(light ? { logoSrc: light } : {}), ...(dark ? { logoDarkSrc: dark } : {}), ...(logoIncludesName(brand) ? { logoIncludesName: true } : {}) };
  return [
    '// Generado por applyBrand desde el brand pack. No editar a mano: se reescribe con la marca de la página.',
    'export interface BrandIdentity {',
    '  name: string;',
    '  logoSrc?: string;',
    '  logoDarkSrc?: string;',
    '  logoIncludesName?: boolean;',
    '}',
    '',
    `export const brand: BrandIdentity = ${JSON.stringify(identity)};`,
    '',
  ].join('\n');
}

/** Lo que los sensores de marca leen de un brand.json, v1 o v2. El JSON crudo no sirve: un pack v2 no trae `accent`,
 * `surface` ni `tokens` (van en theme/overrides) y brandSensors leía `accent.base` de undefined. Pasa por el parser. */
export function brandExpectOf(raw: unknown): BrandExpect {
  const { name, accent, fonts, surface, tokens, logoKind } = parseBrandPack(raw, { skipComponents: true });
  // Sin logoKind el contrato del pack dice 'mark' (parseLogoKind): el sensor no puede decidir otra cosa por proporción.
  return { name, accent, ...(fonts ? { fonts } : {}), ...(surface ? { surface } : {}), ...(tokens ? { tokens } : {}), logoKind: logoKind ?? 'mark' };
}

/** Lo que el panel Tema puede cambiar de una marca: solo el color y la forma. Sin name, logo, components ni requires,
 * para que la UI no pueda pisar más que el tema (specs/panel-tema-params.md:60). */
export const THEME_PARAM_KEYS = ['theme', 'overrides', 'overridesDark'] as const;

/** El brand.json de la marca con el tema del panel encima. Fusiona: el panel no expone fuentes, superficies ni
 * overridesDark, y reemplazar borraría las de la marca sin que el gate AA lo note (cae al contrato, que pasa). Un
 * acento nuevo (preset o --accent propio) saca el acento viejo de overrides y overridesDark: si no, chocan
 * (parseBrandPackV2, "se contradicen") o el oscuro sigue pintando el acento anterior. Valida antes de devolver. */
export function withThemeParams(packRaw: Record<string, unknown>, params: unknown): Record<string, unknown> {
  if (!isObject(params)) throw new Error('applyTheme: se esperaba un objeto {theme, overrides?, overridesDark?}');
  onlyKeys(params, THEME_PARAM_KEYS, 'applyTheme: ');
  for (const k of THEME_PARAM_KEYS) if (params[k] !== undefined && !isObject(params[k])) throw new Error(`applyTheme: ${k} debe ser un objeto`);
  const base = migrateV1ToV2(packRaw);
  const theme = { ...(isObject(base.theme) ? base.theme : {}), ...(isObject(params.theme) ? params.theme : {}) };
  const own = isObject(params.overrides) ? params.overrides : {};
  const ownAccent = ACCENT_TOKENS.some((t) => t in own);
  const baseOver = isObject(base.overrides) ? base.overrides : {};
  const baseTheme = isObject(base.theme) ? base.theme : {};
  // El panel manda su estado completo: reenviar el mismo acento no es un acento nuevo, y tratarlo así le borraría a la
  // marca su acento oscuro (una marca puede fijarlo en overridesDark). Cuenta solo si cambia lo que la marca tenía. El acento sale
  // de uno de tres lugares (preset, seed u overrides propios); el que manda el panel desplaza a los otros dos.
  const sent = isObject(params.theme) ? params.theme : {};
  const source = ownAccent ? 'own' : 'seed' in sent ? 'seed' : 'preset' in sent ? 'preset' : undefined;
  const baseHasOwn = ACCENT_TOKENS.some((t) => t in baseOver);
  const newAccent =
    source === 'own' ? 'preset' in baseTheme || 'seed' in baseTheme || ACCENT_TOKENS.some((t) => t in own && own[t] !== baseOver[t])
    : source === 'seed' ? JSON.stringify(sent.seed) !== JSON.stringify(baseTheme.seed) || 'preset' in baseTheme || baseHasOwn
    : source === 'preset' ? sent.preset !== baseTheme.preset || 'seed' in baseTheme || baseHasOwn
    : false;
  if (source === 'own' || source === 'seed') delete theme.preset;
  if (source === 'own' || source === 'preset') delete theme.seed;
  const overrides = { ...(newAccent ? withoutAccent(base.overrides) : isObject(base.overrides) ? base.overrides : {}), ...own };
  const overridesDark = { ...(newAccent ? withoutAccent(base.overridesDark) : isObject(base.overridesDark) ? base.overridesDark : {}), ...(isObject(params.overridesDark) ? params.overridesDark : {}) };
  const { theme: _t, overrides: _o, overridesDark: _d, ...kept } = base;
  const next = { ...kept, ...(Object.keys(theme).length ? { theme } : {}), ...(Object.keys(overrides).length ? { overrides } : {}), ...(Object.keys(overridesDark).length ? { overridesDark } : {}) };
  parseBrandPack(next, { skipComponents: true });
  return next;
}

/** Valida datos externos (brand.json) en el límite de confianza y devuelve un BrandPack tipado. */
export function parseBrandPack(raw: unknown, opts: ParseBrandOptions = {}): BrandPack {
  if (!isObject(raw)) throw new Error('brand pack: se esperaba un objeto');
  // Lector dual permanente, no de transición: una corrida pineada a un pack v1 del Blob corre con el código de hoy
  // (el Blob guarda datos, no código; verificación de Secondary), así que v1 se sigue leyendo. v1 exige `accent`; v2 no lo tiene.
  if (!('accent' in raw)) return parseBrandPackV2(raw, opts);
  const v2Keys = (['theme', 'overrides', 'overridesDark'] as const).filter((k) => k in raw);
  if (v2Keys.length) throw new Error(`brand pack: mezcla v1 ("accent") y v2 (${v2Keys.map((k) => `"${k}"`).join(', ')}); usa una sola forma`);
  onlyKeys(raw, BRAND_PACK_KEYS, '');
  if (!isStr(raw.name)) throw new Error('brand pack: "name" (string no vacío) es obligatorio');

  const accent = raw.accent;
  let parsedAccent: BrandPack['accent'];
  if (typeof accent === 'string') {
    if (!(PRESET_ACCENTS as readonly string[]).includes(accent)) {
      throw new Error(`brand pack: accent "${accent}" no es un preset (${PRESET_ACCENTS.join(', ')})`);
    }
    parsedAccent = accent as PresetAccent;
  } else if (isObject(accent)) {
    onlyKeys(accent, ACCENT_KEYS, 'accent: ');
    if (!isStr(accent.base) || !isStr(accent.strong) || !isStr(accent.subtle)) {
      throw new Error('brand pack: accent personalizado requiere base, strong y subtle');
    }
    parsedAccent = {
      base: cssValue('accent.base', accent.base),
      strong: cssValue('accent.strong', accent.strong),
      subtle: cssValue('accent.subtle', accent.subtle),
      ...(isStr(accent.foreground) ? { foreground: cssValue('accent.foreground', accent.foreground) } : {}),
    };
  } else {
    throw new Error('brand pack: "accent" es obligatorio (preset o colores propios)');
  }

  if (isObject(raw.surface)) onlyKeys(raw.surface, SURFACE_KEYS, 'surface: ');
  if (isObject(raw.fonts)) onlyKeys(raw.fonts, FONT_KEYS, 'fonts: ');
  const surface = isObject(raw.surface) ? cssValues('surface', pickStrings(raw.surface, SURFACE_KEYS)) : undefined;
  const fonts = isObject(raw.fonts) ? parseFonts(pickStrings(raw.fonts, FONT_KEYS)) : undefined;
  const composition = parseComposition(raw.composition);
  const tokens = parseTokens(raw.tokens);
  const tokensDark = parseTokens(raw.tokensDark);
  const inherit = parseInherit(raw.inherit);
  const logo = parseLogo(raw.logo);
  const logoDark = raw.logoDark === undefined ? undefined : parseLogo(raw.logoDark);
  const logoKind = parseLogoKind(raw.logoKind);

  const pack: BrandPack = {
    name: raw.name,
    ...(logo ? { logo } : {}),
    ...(logoDark ? { logoDark } : {}),
    ...(logoKind ? { logoKind } : {}),
    accent: parsedAccent,
    ...(surface && Object.keys(surface).length ? { surface } : {}),
    ...(fonts && Object.keys(fonts).length ? { fonts } : {}),
    ...(composition ? { composition } : {}),
    ...(tokens ? { tokens } : {}),
    ...(tokensDark ? { tokensDark } : {}),
    ...(inherit ? { inherit } : {}),
  };
  return opts.skipComponents ? pack : withComponents(pack, raw, opts);
}

const ACCENT_OVERRIDES = { base: '--accent', strong: '--accent-strong', subtle: '--accent-subtle', foreground: '--accent-foreground' } as const;
const SURFACE_OVERRIDES = { background: '--background', surface: '--surface', foreground: '--foreground', textSecondary: '--text-secondary' } as const;

function positiveLever(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`brand pack: theme.${name} debe ser un número mayor que 0`);
  return String(value);
}

// La forma de theme.seed; los valores (hex, variante) los valida seedTokens con el mismo mensaje que el panel.
function parseSeed(raw: unknown): SeedParams | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new Error('brand pack: theme.seed debe ser un objeto {accent, neutral?, variant?}');
  onlyKeys(raw, SEED_KEYS, 'theme.seed: ');
  if (!isStr(raw.accent)) throw new Error('brand pack: theme.seed.accent (hex) es obligatorio');
  if (raw.neutral !== undefined && !isStr(raw.neutral)) throw new Error('brand pack: theme.seed.neutral debe ser un hex');
  if (raw.variant !== undefined && !(typeof raw.variant === 'string' && raw.variant in SEED_VARIANTS)) throw new Error(`brand pack: theme.seed.variant debe ser una de ${Object.keys(SEED_VARIANTS).join(', ')}`);
  return { accent: raw.accent, ...(isStr(raw.neutral) ? { neutral: raw.neutral } : {}), ...(raw.variant ? { variant: raw.variant as SeedVariant } : {}) };
}

function parseBrandPackV2(raw: Record<string, unknown>, opts: ParseBrandOptions): BrandPack {
  onlyKeys(raw, BRAND_PACK_V2_KEYS, '');
  if (!isStr(raw.name)) throw new Error('brand pack: "name" (string no vacío) es obligatorio');
  const theme = raw.theme === undefined ? {} : raw.theme;
  if (!isObject(theme)) throw new Error('brand pack: "theme" debe ser un objeto');
  onlyKeys(theme, THEME_KEYS, 'theme: ');
  const preset = theme.preset ?? 'neutral';
  if (typeof preset !== 'string' || !(PRESET_ACCENTS as readonly string[]).includes(preset)) throw new Error(`brand pack: theme.preset "${String(preset)}" no es un preset (${PRESET_ACCENTS.join(', ')})`);
  const colorMode = theme.colorMode;
  if (colorMode !== undefined && !(COLOR_MODES as readonly unknown[]).includes(colorMode)) throw new Error(`brand pack: theme.colorMode debe ser ${COLOR_MODES.join(' o ')}`);
  if (theme.fonts !== undefined && !isObject(theme.fonts)) throw new Error('brand pack: theme.fonts debe ser un objeto');
  if (isObject(theme.fonts)) onlyKeys(theme.fonts, FONT_KEYS, 'theme.fonts: ');
  const fonts = isObject(theme.fonts) ? parseFonts(pickStrings(theme.fonts, FONT_KEYS)) : undefined;
  const scaling = positiveLever('scale', theme.scale);
  const radius = positiveLever('roundness', theme.roundness);
  // Las palancas del contrato (foundation.css:93): un override explícito del mismo token gana, por eso van antes.
  const levers = { ...(scaling ? { '--scaling': scaling } : {}), ...(radius ? { '--radius-factor': radius } : {}) };

  const own = { ...(parseTokens(raw.overrides, 'overrides') ?? {}) };
  const ownDark = parseTokens(raw.overridesDark, 'overridesDark');
  const seed = parseSeed(theme.seed);
  if (seed && theme.preset !== undefined) throw new Error('brand pack: theme.preset y theme.seed se contradicen; usa uno');
  if (seed && (ACCENT_OVERRIDES.base in own || ACCENT_OVERRIDES.strong in own || ACCENT_OVERRIDES.subtle in own)) throw new Error('brand pack: theme.seed y un --accent en overrides se contradicen; usa uno');
  // La semilla se compila a lo mismo que un pack con acento propio (accent + tokens + tokensDark), así identityCss y el
  // gate AA no cambian. Se corrige contra el contrato y los overrides, que son exactos (specs/derivacion-semilla.md).
  const seeded = seed ? seedTheme(seed, contractThemes(), own, ownDark ?? {}) : undefined;
  let accent: BrandPack['accent'] = preset as PresetAccent;
  const seedLight: Record<string, string> = {};
  if (seeded) {
    const { '--accent': base, '--accent-strong': strong, '--accent-subtle': subtle, '--accent-foreground': foreground, ...rest } = seeded.light;
    accent = { base, strong, subtle, foreground } as CustomAccent;
    Object.assign(seedLight, rest);
  }
  if (ACCENT_OVERRIDES.base in own || ACCENT_OVERRIDES.strong in own || ACCENT_OVERRIDES.subtle in own) {
    // El mismo requisito que el accent propio de v1: sin strong y subtle el resto del acento quedaría en el preset.
    if (!(ACCENT_OVERRIDES.base in own && ACCENT_OVERRIDES.strong in own && ACCENT_OVERRIDES.subtle in own)) throw new Error('brand pack: un acento propio en overrides requiere --accent, --accent-strong y --accent-subtle');
    if (theme.preset !== undefined) throw new Error('brand pack: theme.preset y un --accent en overrides se contradicen; usa uno');
    accent = Object.fromEntries(Object.entries(ACCENT_OVERRIDES).filter(([, t]) => t in own).map(([k, t]) => [k, cssValue(`overrides.${t}`, own[t])])) as unknown as CustomAccent;
    for (const t of Object.values(ACCENT_OVERRIDES)) delete own[t];
  }
  const surface = Object.fromEntries(Object.entries(SURFACE_OVERRIDES).filter(([, t]) => t in own).map(([k, t]) => [k, cssValue(`overrides.${t}`, own[t])])) as BrandSurface;
  for (const t of Object.values(SURFACE_OVERRIDES)) delete own[t];
  const tokens = { ...seedLight, ...levers, ...own };
  const tokensDark = seeded || ownDark ? { ...(seeded?.dark ?? {}), ...(ownDark ?? {}) } : undefined;
  const logo = parseLogo(raw.logo);
  const logoDark = raw.logoDark === undefined ? undefined : parseLogo(raw.logoDark);
  const logoKind = parseLogoKind(raw.logoKind);
  const composition = parseComposition(raw.composition);

  const pack: BrandPack = {
    name: raw.name,
    schemaVersion: 2,
    ...(logo ? { logo } : {}),
    ...(logoDark ? { logoDark } : {}),
    ...(logoKind ? { logoKind } : {}),
    accent,
    ...(Object.keys(surface).length ? { surface } : {}),
    ...(fonts && Object.keys(fonts).length ? { fonts } : {}),
    ...(composition ? { composition } : {}),
    ...(Object.keys(tokens).length ? { tokens } : {}),
    ...(tokensDark && Object.keys(tokensDark).length ? { tokensDark } : {}),
    ...(colorMode ? { colorMode: colorMode as ColorMode } : {}),
    ...(seeded?.corrections.length ? { corrections: seeded.corrections } : {}),
  };
  return opts.skipComponents ? pack : withComponents(pack, raw, opts);
}

function withComponents(pack: BrandPack, raw: Record<string, unknown>, opts: ParseBrandOptions): BrandPack {
  if (raw.requires !== undefined && (!isObject(raw.requires) || !isStr(raw.requires.ds))) throw new Error('brand pack: "requires.ds" debe ser el pin con el que se validó el pack');
  const ds = isObject(raw.requires) && isStr(raw.requires.ds) ? cssValue('requires.ds', raw.requires.ds) : undefined;
  const components = parseComponents(raw.components, ds, { points: opts.extensionPoints, pin: opts.pin, isContractToken: (t) => packTokens().has(t), cssValue });
  const next = { ...pack, ...(ds ? { requires: { ds } } : {}), ...(components ? { components } : {}) };
  if (components) {
    const errors = variantContrastErrors(components, brandThemes(next));
    if (errors.length) throw new Error(errors.join('\n'));
  }
  return next;
}

/** Valor de cada token en claro y en oscuro con esta marca: el default del contrato y encima la identidad del pack. */
function brandThemes(brand: BrandPack): { light: Record<string, string>; dark: Record<string, string> } {
  const contract = contractThemes();
  const id = resolveIdentity(brand);
  const decls = (list: string[]): Record<string, string> => Object.fromEntries(list.map((d) => /^(--[a-z0-9-]+):\s*(.*);$/i.exec(d)).filter((m): m is RegExpExecArray => !!m).map((m) => [m[1], m[2]]));
  const light = { ...contract.light, ...decls(id.rootDeclarations) };
  return { light, dark: { ...light, ...contract.dark, ...decls(id.darkDeclarations) } };
}

/** Bloque `inherit`: tokens del contrato que la marca NO redefine a propósito y deja en el default del
 * contrato, cada uno con su motivo (no un valor). Cerrar el contrato (C1) exige que cada token esté
 * definido por un canal o declarado aquí; un token en ninguno de los dos es una fuga silenciosa. */
function parseInherit(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new Error('brand pack: "inherit" debe ser un objeto {token: motivo}');
  const allow = packTokens();
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!allow.has(key)) throw new Error(`brand pack: inherit "${key}" no es un token del contrato`);
    if (!isStr(value)) throw new Error(`brand pack: inherit "${key}" necesita un motivo (string no vacío)`);
    out[key] = value;
  }
  return out;
}

/** Nombres de token que un pack puede fijar: los `--x` de las hojas que existan. Si no existe ninguna, el set queda
 * vacío y parseTokens falla cerrado (rechaza toda clave en vez de aceptar a ciegas). */
export function tokenNames(sheets: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const sheet of sheets.filter((f) => existsSync(f))) {
    for (const m of readFileSync(sheet, 'utf8').matchAll(/(--[a-z0-9-]+)\s*:/gi)) names.add(m[1]);
  }
  return names;
}

// Cacheado: el contrato se envía con el scaffold y no cambia en runtime. Es lo que mide la cobertura de marca.
let contractTokenCache: Set<string> | undefined;
export function contractTokens(): Set<string> {
  contractTokenCache ??= tokenNames([CONTRACT_CSS]);
  return contractTokenCache;
}

/** Las hojas de tokens que monta un scaffold: los @import relativos de src/index.css, sin identity.css (es la salida
 * del pack). Fuera del scaffold no se lee nada: scaffoldDir viene del env. */
export function scaffoldTokenSheets(scaffoldDir: string): string[] {
  const index = join(resolve(scaffoldDir), 'src', 'index.css');
  if (!existsSync(index)) throw new Error(`scaffold ${scaffoldDir}: no hay src/index.css de donde leer sus tokens`);
  // realpath: un symlink dentro del scaffold que apunte fuera no pasa el chequeo de contención.
  const root = realpathSync(resolve(scaffoldDir));
  const sheets = [...readFileSync(index, 'utf8').matchAll(/@import\s+['"](\.{1,2}\/[^'"]+\.css)['"]/g)]
    .map((m) => resolve(root, 'src', m[1]!))
    .filter((f) => basename(f) !== 'identity.css')
    .map((f) => (existsSync(f) ? realpathSync(f) : f));
  const outside = sheets.find((f) => !f.startsWith(`${root}${sep}`));
  if (outside) throw new Error(`scaffold ${scaffoldDir}: src/index.css importa ${outside}, fuera del scaffold`);
  return sheets;
}

// Los packs de producción fijan tokens del DS que monta la distro (los de Arc: gradiente, WhatsApp), que no son contrato
// del core: el allowlist del pack es el core más el contrato del scaffold activo. Un scaffold sin tokens legibles es un
// error y no cae al core: ahí los packs de producción se rechazarían en runtime sin decir por qué.
const packTokenCache = new Map<string, Set<string>>();
export function packTokens(scaffoldDir: string = config().scaffoldDir): Set<string> {
  const hit = packTokenCache.get(scaffoldDir);
  if (hit) return hit;
  const own = tokenNames(scaffoldTokenSheets(scaffoldDir));
  if (own.size === 0) throw new Error(`scaffold ${scaffoldDir}: sus hojas de src/index.css no declaran tokens`);
  const names = new Set([...contractTokens(), ...own]);
  packTokenCache.set(scaffoldDir, names);
  return names;
}

// Los dos primeros bloques de foundation.css son el tema claro (`:root, [data-theme]`) y el oscuro (`[data-theme="dark"]`).
let contractThemeCache: { light: Record<string, string>; dark: Record<string, string> } | undefined;
export function contractThemes(): { light: Record<string, string>; dark: Record<string, string> } {
  if (contractThemeCache) return contractThemeCache;
  // Una sola lectura del contrato: la misma función genera contract.json para la derivación pura de semilla.
  contractThemeCache = contractFromCss(existsSync(CONTRACT_CSS) ? readFileSync(CONTRACT_CSS, 'utf8') : '');
  return contractThemeCache;
}

// brand.json es dato externo: un valor que se inyecta en `:root { --x: VALUE; }` podría romper la
// llave o colar @import/url. Se rechaza cualquier valor con separadores de regla o funciones de red.
const UNSAFE_TOKEN_VALUE = /[;{}@]|\/\*|\*\/|url\(|expression\(/i;

/** Valida el bloque tokens en la frontera de confianza: clave ∈ contrato Arc (allowlist) y valor que
 * pasa el guard de gramática CSS. undefined si no hay nada que anclar. */
function parseTokens(raw: unknown, label = 'tokens'): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new Error(`brand pack: "${label}" debe ser un objeto`);
  const allow = packTokens();
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!allow.has(key)) throw new Error(`brand pack: ${label}."${key}" no es un token del contrato`);
    if (!isStr(value)) throw new Error(`brand pack: ${label}."${key}" debe ser un string no vacío`);
    if (UNSAFE_TOKEN_VALUE.test(value)) throw new Error(`brand pack: ${label}."${key}" tiene un valor CSS no permitido`);
    out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

// accent, surface y fonts también terminan dentro de identity.css: el mismo guard que tokens, más comillas
// y barras invertidas, que dejarían una cadena abierta y se comerían el resto de la hoja.
const UNSAFE_FIELD_VALUE = /[\\\n\r]/;
const oddQuotes = (v: string): boolean => (v.split("'").length - 1) % 2 === 1 || (v.split('"').length - 1) % 2 === 1;

function cssValue(field: string, value: string): string {
  if (UNSAFE_TOKEN_VALUE.test(value) || UNSAFE_FIELD_VALUE.test(value) || oddQuotes(value)) throw new Error(`brand pack: ${field} tiene un valor CSS no permitido`);
  return value;
}

function cssValues<K extends string>(group: string, values: Partial<Record<K, string>>): Partial<Record<K, string>> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, cssValue(`${group}.${k}`, v as string)])) as Partial<Record<K, string>>;
}

// fonts.import va a `@import url('…')`: solo las fuentes del propio pack o una URL https sin comillas, paréntesis ni barras (lo único que cierra el url('…')).
const FONT_IMPORT = /^(?:\.\/fonts\/(?!.*\.\.)[\w./-]+|https:\/\/[^\s'"()\\]+)$/;

function parseFonts(fonts: Partial<Record<'display' | 'body' | 'import', string>>): BrandFonts {
  if (fonts.import !== undefined && !FONT_IMPORT.test(fonts.import)) throw new Error(`brand pack: fonts.import "${fonts.import}" tiene que ser ./fonts/… o https://… sin comillas`);
  const { import: imp, ...families } = fonts;
  return { ...cssValues('fonts', families), ...(imp !== undefined ? { import: imp } : {}) };
}

/** Valida el bloque composition en el límite de confianza; undefined si no hay nada que sesgar. */
function parseComposition(raw: unknown): BrandComposition | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new Error('brand pack: "composition" debe ser un objeto');

  let roles: Record<string, RoleBias> | undefined;
  if (raw.roles !== undefined) {
    if (!isObject(raw.roles)) throw new Error('brand pack: "composition.roles" debe ser un objeto');
    roles = {};
    for (const [role, bias] of Object.entries(raw.roles)) {
      if (!isObject(bias)) throw new Error(`brand pack: composition.roles.${role} debe ser un objeto`);
      if (bias.desiredTags !== undefined && !isStrArray(bias.desiredTags)) throw new Error(`brand pack: composition.roles.${role}.desiredTags debe ser string[]`);
      if (bias.undesiredTags !== undefined && !isStrArray(bias.undesiredTags)) throw new Error(`brand pack: composition.roles.${role}.undesiredTags debe ser string[]`);
      if (bias.allowedCategories !== undefined && !isStrArray(bias.allowedCategories)) throw new Error(`brand pack: composition.roles.${role}.allowedCategories debe ser string[]`);
      roles[role] = {
        ...(isStrArray(bias.desiredTags) ? { desiredTags: bias.desiredTags } : {}),
        ...(isStrArray(bias.undesiredTags) ? { undesiredTags: bias.undesiredTags } : {}),
        ...(isStrArray(bias.allowedCategories) ? { allowedCategories: bias.allowedCategories } : {}),
      };
    }
  }

  let density: Density | undefined;
  if (raw.density !== undefined) {
    if (typeof raw.density !== 'string' || !(DENSITIES as readonly string[]).includes(raw.density)) {
      throw new Error(`brand pack: composition.density debe ser uno de ${DENSITIES.join(', ')}`);
    }
    density = raw.density as Density;
  }

  // rhythm es el eje de CONTRASTE que la marca pide a propósito (banded/quiet/neutral). Independiente
  // de density (espaciado): ninguna fuente los acopla. Ausente = lo trae la librería (adapter.rhythm).
  let rhythm: RhythmProfile | undefined;
  if (raw.rhythm !== undefined) {
    if (typeof raw.rhythm !== 'string' || !(RHYTHM_PROFILES as readonly string[]).includes(raw.rhythm)) {
      throw new Error(`brand pack: composition.rhythm debe ser uno de ${RHYTHM_PROFILES.join(', ')}`);
    }
    rhythm = raw.rhythm as RhythmProfile;
  }

  if (raw.styleSet !== undefined && !isStr(raw.styleSet)) throw new Error('brand pack: composition.styleSet debe ser string');

  const out: BrandComposition = {
    ...(roles && Object.keys(roles).length ? { roles } : {}),
    ...(density ? { density } : {}),
    ...(rhythm ? { rhythm } : {}),
    ...(isStr(raw.styleSet) ? { styleSet: raw.styleSet } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

function pickStrings<K extends string>(obj: Record<string, unknown>, keys: readonly K[]): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const k of keys) if (isStr(obj[k])) out[k] = obj[k] as string;
  return out;
}
