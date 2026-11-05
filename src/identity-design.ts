// DESIGN.md de la identidad efímera, en el formato abierto de google-labs-code/design.md (el de Stitch): frontmatter YAML
// de tokens más prosa de intención. Es la descripción exportable de identity.css, no otra fuente: en S2 de Stitch la
// prosa decía "Primary #FF6600" con el token en #a33e00. Aquí cada valor tiene que ser copia del token que aplica la
// página, y la prosa solo puede nombrar colores del frontmatter. Puro sobre textos.

import { familyOf } from './brand-fonts';

// En la raíz del workspace, como el estándar (y fuera de Vite): se exporta tal cual a otra herramienta.
export const DESIGN_FILE = 'DESIGN.md';
/** Encabezados del estándar que aplican a una landing sobre Arc, en orden; Layout, Elevation, Shapes y Components los fija el DS. */
export const DESIGN_SECTIONS = ['Brand & Style', 'Colors', 'Typography'] as const;
/** Rol del frontmatter (nombres del estándar, Material 3) → token de identity.css y bloque. Los inverse llevan la zona
 * oscura: sin ellos una marca exportada pierde el cierre inverse y una importada no lo trae. */
export const DESIGN_COLOR_ROLES: Readonly<Record<string, { token: string; block: 'light' | 'dark' }>> = {
  primary: { token: '--accent', block: 'light' },
  'on-primary': { token: '--accent-foreground', block: 'light' },
  background: { token: '--background', block: 'light' },
  'on-background': { token: '--foreground', block: 'light' },
  surface: { token: '--surface', block: 'light' },
  // Material 3 llama tertiary al acento de contraste; aquí es el color de identidad que no pinta CTAs (#200).
  tertiary: { token: '--brand-highlight', block: 'light' },
  'inverse-surface': { token: '--background', block: 'dark' },
  'inverse-on-surface': { token: '--foreground', block: 'dark' },
};
/** Los pesos de la regla de Arc (regular y medium), los mismos que carga FONT_LIST. */
export const DESIGN_WEIGHTS = ['400', '500'] as const;
const TYPE_ROLES: Readonly<Record<string, string>> = { display: '--font-display', body: '--font-body' };

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;
const HEX = /#[\da-f]{3,8}\b/gi;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const norm = (v: unknown): string => String(v ?? '').trim().toLowerCase();

function parseYaml(text: string): unknown {
  return (globalThis as { Bun?: { YAML: { parse(s: string): unknown } } }).Bun?.YAML.parse(text);
}

/** Roles de color del DESIGN.md que contradicen un token que la hoja SÍ declara. Para la hoja de un pack editada en un
 * cambio global: solo declara lo que sobrescribe del contrato, así que lo que no declara no se juzga aquí (lo validó
 * checkPackDesign al publicar). [] = sin frontmatter legible o sin contradicciones. */
export function designColorDrift(md: string, light: Readonly<Record<string, string>>, dark: Readonly<Record<string, string>>): string[] {
  const fm = FRONTMATTER.exec(md);
  let data: unknown;
  try { data = fm ? parseYaml(fm[1]) : undefined; } catch { return [`${DESIGN_FILE}: frontmatter YAML inválido`]; }
  const colors = isObj(data) && isObj(data.colors) ? data.colors : {};
  return Object.entries(DESIGN_COLOR_ROLES).flatMap(([role, { token, block }]) => {
    const declared = (block === 'dark' ? dark : light)[token];
    if (!declared || !(role in colors) || norm(colors[role]) === norm(declared)) return [];
    return [`${DESIGN_FILE}: colors.${role} es ${String(colors[role])} y ${token}${block === 'dark' ? ' del bloque oscuro' : ''} en identity.css es ${declared}; actualiza DESIGN.md con el cambio`];
  });
}

/** Errores de un DESIGN.md frente a los bloques claro y oscuro de identity.css. [] = coincide. */
export function checkDesignMd(md: string, light: Readonly<Record<string, string>>, dark: Readonly<Record<string, string>>): string[] {
  const errors: string[] = [];
  const fm = FRONTMATTER.exec(md);
  if (!fm) return [`${DESIGN_FILE}: falta el frontmatter YAML (--- … ---) con colors y typography`];
  let data: unknown;
  try { data = parseYaml(fm[1]); } catch (e) { return [`${DESIGN_FILE}: frontmatter YAML inválido (${e instanceof Error ? e.message.split('\n')[0] : String(e)})`]; }
  if (!isObj(data)) return [`${DESIGN_FILE}: el frontmatter tiene que ser un objeto`];

  const colors = isObj(data.colors) ? data.colors : {};
  for (const [role, { token, block }] of Object.entries(DESIGN_COLOR_ROLES)) {
    const declared = (block === 'dark' ? dark : light)[token];
    const where = `${token}${block === 'dark' ? ' del bloque oscuro' : ''}`;
    if (!declared) { if (role in colors) errors.push(`${DESIGN_FILE}: colors.${role} sin ${where} en identity.css`); continue; }
    if (!(role in colors)) errors.push(`${DESIGN_FILE}: falta colors.${role} (= ${where}: ${declared})`);
    else if (norm(colors[role]) !== norm(declared)) errors.push(`${DESIGN_FILE}: colors.${role} es ${String(colors[role])} y ${where} en identity.css es ${declared}`);
  }
  const named = new Set(Object.values(colors).map(norm));
  const body = md.slice(fm[0].length);
  for (const hex of new Set(body.match(HEX) ?? [])) if (!named.has(hex.toLowerCase())) errors.push(`${DESIGN_FILE}: la prosa nombra ${hex}, que no está en el frontmatter`);

  const typography = isObj(data.typography) ? data.typography : {};
  for (const [role, token] of Object.entries(TYPE_ROLES)) {
    const entry = typography[role];
    const want = familyOf(light[token] ?? '');
    if (!isObj(entry)) { errors.push(`${DESIGN_FILE}: falta typography.${role}.fontFamily (= ${want})`); continue; }
    if (norm(entry.fontFamily) !== norm(want)) errors.push(`${DESIGN_FILE}: typography.${role}.fontFamily es ${String(entry.fontFamily)} y ${token} es ${want}`);
    if (entry.fontWeight !== undefined && !(DESIGN_WEIGHTS as readonly string[]).includes(String(entry.fontWeight))) errors.push(`${DESIGN_FILE}: typography.${role}.fontWeight ${String(entry.fontWeight)}; Arc usa ${DESIGN_WEIGHTS.join(' o ')}`);
  }

  for (const s of DESIGN_SECTIONS) if (!new RegExp(`^## ${s.replace(/[&]/g, '\\&')}\\s*$`, 'm').test(body)) errors.push(`${DESIGN_FILE}: falta la sección "## ${s}"`);
  return errors;
}
