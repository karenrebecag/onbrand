// Identidad efímera (decisión de Karen 2026-10-25): sin brand pack, el agente decide una marca y la escribe en
// src/identity.css (solo tokens del contrato) más un <link> de Google Fonts de una lista cerrada. Aquí vive la
// lista, el validador que pasa esa hoja por el mismo guard que un brand.json (parseBrandPack, #159) y lo que el
// sensor de marca afirma después contra lo declarado. Puro: lee strings, no el disco.

import { identityCss } from './brand-identity';
import { parseBrandPack, type BrandPack } from './brand-pack';
import { byFamily, familyOf, FONT_LIST, googleFontsHref } from './brand-fonts';
export { familyOf, FONT_LIST, googleFontsHref } from './brand-fonts';
export type { FontChoice, FontRole } from './brand-fonts';
import { contrast, MIN_CONTRAST, parseColor, readableTone } from './color-contrast';
import { checkDesignMd, DESIGN_COLOR_ROLES, DESIGN_FILE, designColorDrift } from './identity-design';
import { brandSensors, type BrandDefect, type BrandExpect } from './brand-sensors';
import type { PageMeasure } from './page-sensors';

/** Comentario que applyBrand deja al inicio de identity.css: la hoja viene de un pack y el agente no la toca. */
export const PACK_MARKER = /^\s*\/\*\s*brand-pack:/;

export const REQUIRED_TOKENS = ['--accent', '--accent-strong', '--accent-subtle', '--accent-foreground', '--font-display', '--font-body'] as const;
const LIGHT_SELECTOR = ':root,[data-theme]';
const DARK_SELECTOR = '[data-theme="dark"]';
const RULE = /([^{}]+)\{([^{}]*)\}/g;
const DECL = /^(--[a-z0-9-]+)\s*:\s*(.+)$/i;

export interface EphemeralIdentity { light: Record<string, string>; dark: Record<string, string>; fonts: { display: string; body: string }; pack: BrandPack }
export type IdentityCheck =
  | { status: 'pack' }
  | { status: 'ok'; identity: EphemeralIdentity }
  | { status: 'invalid'; errors: string[] };

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

function parseRules(css: string, errors: string[]): { light: Record<string, string>; dark: Record<string, string> } {
  const body = stripComments(css).replace(/@[a-z-]+[^;{}]*;/gi, (at) => {
    errors.push(`"${at.trim().slice(0, 60)}": nada de @import ni otras reglas @ (las fuentes van por <link> en index.html)`);
    return '';
  });
  const light: Record<string, string> = {};
  const dark: Record<string, string> = {};
  const rest = body.replace(RULE, (_, selector: string, decls: string) => {
    const sel = selector.replace(/\s+/g, '');
    const target = sel === LIGHT_SELECTOR ? light : sel === DARK_SELECTOR ? dark : null;
    if (!target && sel.startsWith('@')) errors.push(`"${selector.trim()}": nada de @font-face ni otras reglas @ (las fuentes van por <link> en index.html)`);
    else if (!target) errors.push(`selector "${selector.trim()}" no permitido: solo \`:root, [data-theme]\` y \`[data-theme="dark"]\``);
    for (const raw of decls.split(';').map((d) => d.trim()).filter(Boolean)) {
      const m = DECL.exec(raw);
      if (!m) errors.push(`"${raw.slice(0, 60)}" no es un token: identity.css solo declara \`--token: valor\``);
      else if (target) target[m[1]] = m[2].trim();
    }
    return '';
  });
  if (rest.trim()) errors.push(`fuera de las reglas de tokens hay "${rest.trim().slice(0, 60)}": identity.css solo tiene los dos bloques de tokens`);
  return { light, dark };
}

/** Familias que pide cada <link> a fonts.googleapis.com en index.html; errores si un link trae otra cosa. */
function linkedFamilies(html: string, errors: string[]): Set<string> {
  const out = new Set<string>();
  for (const [, href] of html.matchAll(/<link\b[^>]*\bhref="(https:\/\/fonts\.googleapis\.com\/[^"]*)"/gi)) {
    let url: URL;
    try { url = new URL(href.replace(/&amp;/g, '&')); } catch { errors.push(`link de fuentes inválido: ${href}`); continue; }
    if (url.pathname !== '/css2') { errors.push(`link de fuentes "${href}": solo fonts.googleapis.com/css2`); continue; }
    for (const fam of url.searchParams.getAll('family')) {
      const name = fam.split(':')[0].replace(/\+/g, ' ');
      if (!byFamily.has(name.toLowerCase())) errors.push(`la fuente "${name}" no está en la lista cerrada del skill`);
      else out.add(name.toLowerCase());
    }
  }
  return out;
}

// Pares que un usuario lee: el CTA (texto sobre el acento) y el texto de la página. Se miden en cada bloque porque el
// oscuro es el que pinta un cierre inverse, y ahí es donde un acento claro con texto blanco se vuelve ilegible.
const CONTRAST_PAIRS: [fg: string, bg: string, what: string][] = [
  ['--accent-foreground', '--accent', 'texto de un CTA sobre --accent'],
  ['--foreground', '--background', 'texto sobre --background'],
];

function contrastErrors(block: Record<string, string>, name: string): string[] {
  const out: string[] = [];
  for (const [fgToken, bgToken, what] of CONTRAST_PAIRS) {
    if (!(fgToken in block) && !(bgToken in block)) continue;
    // Si el bloque declara solo uno, el otro queda en el default del contrato (oklch): no se podría medir el par.
    if (!(fgToken in block) || !(bgToken in block)) { out.push(`bloque ${name}: declara ${fgToken} y ${bgToken} juntos para que se pueda medir el contraste (${what})`); continue; }
    // Un color translúcido se ve compuesto sobre el fondo de la zona; el texto, sobre el color ya compuesto.
    const page = parseColor(block['--background']);
    const bg = parseColor(block[bgToken], page ?? undefined);
    const fg = parseColor(block[fgToken], bg ?? undefined);
    if (!fg || !bg) { out.push(`bloque ${name}: ${!fg ? fgToken : bgToken} tiene que ser hex, rgb() u oklch() (si es translúcido, con --background opaco) para medir el contraste (${what})`); continue; }
    const ratio = contrast(fg, bg);
    if (ratio >= MIN_CONTRAST) continue;
    // El acento se corrige derivándolo de la semilla hacia un tono legible, como la primaria de Stitch; el fondo no.
    const fix = bgToken === '--accent' ? readableTone(bg, fg) : null;
    out.push(`bloque ${name}: ${what} tiene contraste ${ratio.toFixed(2)}:1, mínimo ${MIN_CONTRAST}:1${fix ? ` (con ese ${fgToken}, usa --accent: ${fix})` : ''}`);
  }
  return out;
}

/**
 * Valida la identidad de la página. `changed` = el agente tocó identity.css en este turno.
 * - Hoja de pack sin tocar: nada que validar. Tocada: error (la marca del pack no se reescribe).
 * - Sin pack: la hoja tiene que declarar la identidad completa (REQUIRED_TOKENS, cada token claro también en oscuro),
 *   pasar el guard de brand.json, describirse en DESIGN.md con los mismos valores (si se pasa `design`), llegar a 4.5:1 en CTA y texto de ambos bloques, usar fuentes de FONT_LIST enlazadas en index.html y no dejar data-accent en <html>.
 */
/** El DESIGN.md de un pack contra su propio brand.json: los bloques salen de identityCss(brand), no de lo que escriba
 * el agente, así la prosa que acompaña a la marca no puede contradecir sus tokens. El @import de fuentes del pack es
 * legítimo aquí; sus avisos se descartan. */
export function checkPackDesign(brand: BrandPack, md: string): string[] {
  const { light, dark } = packTokens(brand);
  return checkDesignMd(md, light, dark);
}

/** Los bloques claro y oscuro de un pack tal como se aplican: de ellos sale y contra ellos se valida su DESIGN.md. */
function packTokens(brand: BrandPack): { light: Record<string, string>; dark: Record<string, string> } {
  const { light, dark } = parseRules(identityCss(brand), []);
  // Un pack escribe sus familias en los slots de fuente (--font-geist, --font-inter), no en --font-display/--font-body.
  const fonts = { ...(brand.fonts?.display ? { '--font-display': brand.fonts.display } : {}), ...(brand.fonts?.body ? { '--font-body': brand.fonts.body } : {}) };
  return { light: { ...light, ...fonts }, dark };
}

/** El frontmatter de DESIGN.md que checkPackDesign acepta para `brand`: copiar los valores a mano es el paso que más falla
 * al armar un pack. Solo los roles cuyo token el pack declara; la prosa sigue siendo de quien escribe la marca. */
export function packDesignFrontmatter(brand: BrandPack): string {
  const { light, dark } = packTokens(brand);
  const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
  const colors = Object.entries(DESIGN_COLOR_ROLES).flatMap(([role, { token, block }]) => {
    const v = (block === 'dark' ? dark : light)[token];
    return v ? [`  ${role}: ${q(v)}`] : [];
  });
  const type = (role: string, token: string, weight: string) => [`  ${role}:`, `    fontFamily: ${q(familyOf(light[token] ?? ''))}`, `    fontWeight: ${weight}`];
  return ['---', `name: ${q(brand.name)}`, ...(colors.length ? ['colors:', ...colors] : ['colors: {}']), 'typography:', ...type('display', '--font-display', '500'), ...type('body', '--font-body', '400'), '---', ''].join('\n');
}

/** Turno en el que el pedido es un cambio global de identidad: el transport lo marca y el sensor deja editar el pack. */
export const IDENTITY_EDIT_FILE = '.wt/identity-edit';

/** `packEditable`: el pedido del turno cambia la identidad de toda la página. Como v0 (F3: `globals.css` +9/-7,
 * re-iteracion/v0.md:26, RE dinámica), Lovable (`:root` de `src/styles.css`) y Make (`src/index.css`; planes/secondary.md
 * §tokens), ese cambio se hace en el archivo de tokens, también sobre una marca montada. */
export function checkIdentity(css: string, html: string, changed: boolean, design?: string | null, packEditable = false): IdentityCheck {
  if (PACK_MARKER.test(css)) {
    if (!changed) return { status: 'pack' };
    if (!packEditable) return { status: 'invalid', errors: ['src/identity.css es la marca del pack: no la edites; restaura el archivo'] };
    // El @import de fuentes del pack es legítimo: sus avisos se descartan y solo cuenta que la marca editada se lea.
    const { light, dark } = parseRules(css, []);
    const errors = [...contrastErrors(light, 'claro'), ...contrastErrors(dark, 'oscuro')];
    // El prompt pide reflejar el cambio en DESIGN.md; sin esto un DESIGN.md con los valores viejos llegaba al siguiente
    // turno y al export contradiciendo la página.
    if (design) errors.push(...designColorDrift(design, light, dark));
    return errors.length ? { status: 'invalid', errors } : { status: 'pack' };
  }
  const errors: string[] = [];
  if (!stripComments(css).trim()) return { status: 'invalid', errors: ['sin marca: declara la identidad de esta página en src/identity.css (ver references/foundations/identity.md, "Identidad sin marca")'] };
  const { light, dark } = parseRules(css, errors);
  for (const t of REQUIRED_TOKENS) if (!light[t]) errors.push(`falta ${t} en \`:root, [data-theme]\``);
  const noDark = Object.keys(light).filter((t) => !(t in dark));
  // El bloque claro también pinta las zonas oscuras (mismo alcance, va después de foundation.css): sin su par oscuro,
  // una sección data-theme="dark" heredaría el fondo y el texto claros.
  if (noDark.length) errors.push(`faltan en \`[data-theme="dark"]\` (cada token claro necesita su valor oscuro): ${noDark.join(', ')}`);
  if (/<html\b[^>]*\sdata-accent="/i.test(html)) errors.push('quita data-accent de <html> en index.html: el preset del scaffold le gana a tu --accent dentro de las zonas');

  errors.push(...contrastErrors(light, 'claro'), ...contrastErrors(dark, 'oscuro'));
  // undefined = quien llama no lee el workspace (sensor sobre la medida); null = el archivo no existe.
  if (design === null) errors.push(`falta ${DESIGN_FILE}: describe la identidad en el formato DESIGN.md (ver references/foundations/identity.md)`);
  else if (design !== undefined) errors.push(...checkDesignMd(design, light, dark));

  const linked = linkedFamilies(html, errors);
  const fonts = { display: familyOf(light['--font-display'] ?? ''), body: familyOf(light['--font-body'] ?? '') };
  for (const [role, fam] of Object.entries(fonts)) {
    if (!fam) continue;
    const choice = byFamily.get(fam.toLowerCase());
    if (!choice) errors.push(`--font-${role}: "${fam}" no está en la lista cerrada del skill`);
    else if (!choice.installed && !linked.has(fam.toLowerCase())) errors.push(`--font-${role}: "${fam}" no tiene <link> en index.html (${googleFontsHref([fam])})`);
  }

  let pack: BrandPack | undefined;
  try {
    const { ['--accent']: base, ['--accent-strong']: strong, ['--accent-subtle']: subtle, ['--accent-foreground']: foreground, ...tokens } = light;
    pack = parseBrandPack({ name: 'efímera', accent: { base, strong, subtle, foreground }, tokens, tokensDark: dark });
  } catch (e) {
    errors.push((e instanceof Error ? e.message : String(e)).replace(/^brand pack: /, ''));
  }
  return errors.length || !pack ? { status: 'invalid', errors } : { status: 'ok', identity: { light, dark, fonts, pack } };
}

/** Lo que el sensor de marca afirma de una identidad efímera: lo mismo que de un pack, contra lo que el agente declaró. */
export function ephemeralExpect(id: EphemeralIdentity): BrandExpect {
  return {
    name: 'identidad declarada',
    accent: { base: id.light['--accent'] },
    fonts: id.fonts,
    ...(id.light['--background'] ? { surface: { background: id.light['--background'] } } : {}),
  };
}

/** Sensor de una página sin pack: la identidad tiene que estar declarada y la página tiene que pintar lo declarado.
 * Con pack no afirma nada aquí (lo afirma brandSensors contra el brand.json). */
export function identitySensors(m: PageMeasure, css: string, html: string): BrandDefect[] {
  if (PACK_MARKER.test(css)) return [];
  const r = checkIdentity(css, html, true);
  if (r.status === 'pack') return [];
  if (r.status === 'invalid') return [{ field: 'brand.declared', owner: 'A', section: '-', expected: 'identidad declarada en src/identity.css', actual: r.errors[0], message: `sin pack y sin identidad válida: ${r.errors.join('; ')}` }];
  return brandSensors(m, ephemeralExpect(r.identity));
}

export function formatIdentityCheck(r: IdentityCheck): string {
  if (r.status === 'pack') return 'Identidad: marca del pack, sin cambios.';
  if (r.status === 'ok') return `Identidad: declarada (acento ${r.identity.light['--accent']}, display ${r.identity.fonts.display}, cuerpo ${r.identity.fonts.body}).`;
  return [`Identidad: ${r.errors.length} errores en src/identity.css o index.html:`, ...r.errors.map((e) => `- ${e}`)].join('\n');
}
