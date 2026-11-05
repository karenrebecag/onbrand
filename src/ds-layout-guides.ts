// Guías de layout por rol para el registry del DS: destilan las secciones Relume del vault en
// PATRONES de maquetación expresados en las primitivas del motor (stack/grid/cluster/split), sin
// publicar su código. Es el consumidor de los Relume que no se materializan (RE-relume-en-registry
// §5b): v0 no tiene referencias de layout y su agente maqueta con el grid del DS; nosotros sí
// acotamos la forma, y la forma de 1524 secciones cabe en una guía por rol. Regla determinista
// sobre el source (nunca a mano) y cada patrón cita los slugs de los que salió.

import { deriveRelumeTags, roleOfCategory, scanRelume, type RelumeScanItem } from './catalog/ingest-relume';
import { extractDefaultLeaves, listCounts } from './copygen/defaults';
import type { Role } from './types';

export type Media = 'none' | 'image' | 'video' | 'background';
export type Side = 'left' | 'right' | 'none';

/** Firma de FORMA de una sección: lo que decide su esqueleto, sin copy ni estilo. */
export interface FormSignature {
  role: Role;
  cols: 1 | 2 | 3 | 4 | 6;
  media: Media;
  /** Lado del visual en un split texto + media. */
  side: Side;
  align: 'center' | 'left';
  cards: boolean;
  /** Control compuesto que gobierna la sección (tabs, accordion, slider, form). */
  control: 'tabs' | 'accordion' | 'slider' | 'form' | 'none';
  /** Items de la lista principal de los Defaults (features, testimonials, questions...). */
  items: number;
  buttons: boolean;
  /** Las celdas llevan icono (fuente: tag Icons del source). */
  icons: boolean;
}

export interface SectionForm {
  slug: string;
  category: string;
  sig: FormSignature;
}

export interface Pattern {
  key: string;
  sig: Omit<FormSignature, 'items'> & { items: string };
  why: string;
  count: number;
  slugs: string[];
  tree: unknown;
}

export interface RoleGuide {
  role: Role;
  total: number;
  patterns: Pattern[];
  /** Firmas con una sola sección: se listan agregadas, no como patrón. */
  singles: string[];
  md: string;
}

const MAX_PATTERNS = 10;
const COVERAGE = 0.9;
const MAX_CITED = 12;

/** Columnas del grid principal: el mayor `md|lg:grid-cols-N` del source. Sin señal = 1. */
function colsOf(tsx: string): FormSignature['cols'] {
  const all = [...tsx.matchAll(/\b(?:md|lg):grid-cols-(\d)\b/g)].map((m) => Number(m[1]));
  const n = Math.max(1, ...all);
  return (n >= 6 ? 6 : n === 5 ? 4 : n) as FormSignature['cols'];
}

/** Lado del visual: en un source de dos columnas, si el primer `<img|video` aparece antes del
 * primer heading el visual va a la izquierda; `lg:order-first/last` invierte. */
function sideOf(tsx: string, cols: number, media: Media): Side {
  if (cols !== 2 || media === 'none' || media === 'background') return 'none';
  const img = tsx.search(/<(img|video|VideoIframe)\b/);
  const text = tsx.search(/<h[1-3]\b/);
  if (img < 0 || text < 0) return 'none';
  const left = img < text;
  return /lg:order-(first|last)/.test(tsx) ? (left ? 'right' : 'left') : left ? 'left' : 'right';
}

/** Bucket de items para agrupar: 0, 2, 3, 4, 5-6, 7+. */
const itemsBucket = (n: number): string => (n <= 1 ? '0' : n <= 4 ? String(n) : n <= 6 ? '5-6' : '7+');

export function signatureOf(item: Pick<RelumeScanItem, 'tsx' | 'category'>, role: Role): FormSignature {
  const tags = new Set(deriveRelumeTags(item.tsx, item.category));
  const cols = colsOf(item.tsx);
  const media: Media = tags.has('Background Image') || tags.has('Background Video') ? 'background' : tags.has('Video') ? 'video' : tags.has('Image') ? 'image' : 'none';
  const control: FormSignature['control'] = tags.has('Tabs') ? 'tabs' : tags.has('Accordion') ? 'accordion' : tags.has('Slider') ? 'slider' : tags.has('Form') ? 'form' : 'none';
  const counts = listCounts(extractDefaultLeaves(item.tsx));
  const items = Math.max(0, ...Object.entries(counts).filter(([k]) => !/button|link/i.test(k)).map(([, n]) => n));
  return {
    role,
    cols,
    media,
    side: sideOf(item.tsx, cols, media),
    align: tags.has('Text Align Center') ? 'center' : 'left',
    cards: tags.has('Cards'),
    control,
    items,
    buttons: tags.has('Buttons'),
    icons: tags.has('Icons'),
  };
}

/** Clave de agrupación: solo los ejes de FORMA (columnas, media, lado, alineación). Medido sobre el
 * vault: con cards/control/items en la clave el rol features se parte en 64 firmas y 10 patrones
 * cubren 45%; con estos cuatro ejes, 31 firmas y cobertura 63-100% por rol. Lo demás se agrega como
 * atributo mayoritario del patrón. */
const patternKey = (s: FormSignature): string => [s.cols, s.media, s.side, s.align].join('|');

/** Firma agregada de un grupo: ejes de la clave + mayoría de cards/control/buttons + media de items. */
function aggregate(members: SectionForm[]): FormSignature {
  const first = members[0].sig;
  const majority = <K extends 'cards' | 'buttons' | 'icons'>(k: K): boolean => members.filter((m) => m.sig[k]).length * 2 > members.length;
  const controls = new Map<FormSignature['control'], number>();
  for (const m of members) controls.set(m.sig.control, (controls.get(m.sig.control) ?? 0) + 1);
  const control = [...controls.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const withItems = members.filter((m) => m.sig.items > 0);
  const items = withItems.length * 2 > members.length ? Math.round(withItems.reduce((n, m) => n + m.sig.items, 0) / withItems.length) : 0;
  return { ...first, cards: majority('cards'), buttons: majority('buttons'), icons: majority('icons'), control, items };
}

/** Una línea de por qué: lo que el patrón resuelve, derivado de su forma (misma regla para todos). */
const MEDIA_NOTE = ' Fondo con media en la fuente: el contrato de layout no lo admite hoy (solo base/muted/raised), así que el árbol emite `muted` y lo marca en `x-source-surface` para medir el hueco.';

function rationale(s: FormSignature): string {
  return `${rationaleOf(s)}${s.media === 'background' ? MEDIA_NOTE : ''}`;
}

function rationaleOf(s: FormSignature): string {
  if (s.cols === 2 && s.side !== 'none') return `El titular abre la lectura y el ${s.media === 'video' ? 'video' : 'visual'} a la ${s.side === 'left' ? 'izquierda' : 'derecha'} sostiene el claim; en mobile se apila texto primero.`;
  if (s.cols >= 3) return `Cabecera compartida y ${s.cols} celdas iguales: cada item pesa lo mismo, el ojo compara en fila.`;
  if (s.cols === 2 && s.items >= 2) return 'Cabecera y dos celdas por fila: pocos items con más espacio para describir cada uno.';
  if (s.media === 'background') return 'Una sola columna sobre media de fondo: el texto manda y la imagen ambienta sin competir.';
  if (s.media !== 'none') return 'Una columna con el visual debajo del titular: primero el mensaje, luego la prueba.';
  return 'Una sola columna de texto: sección breve que no necesita media ni rejilla.';
}

const text = (kind: 'display' | 'title' | 'subtitle' | 'body' | 'caption', value: string, align: 'center' | 'left') =>
  ({ text: kind, value, ...(align === 'center' ? { align: 'center' } : {}) });

/** Cabecera de sección: titular + bajada (+ botones), alineada según el patrón. El tagline de Relume
 * se DESCARTA al destilar: es un eyebrow y el DS lo decide (Arc lo prohíbe, SKILL.md "Sin eyebrow
 * labels"); una guía no puede enseñar a violar el DS activo. */
function header(s: FormSignature, display: boolean) {
  const align = s.align;
  const children: unknown[] = [text(display ? 'display' : 'title', '{heading}', align), text('body', '{description}', align)];
  if (s.buttons) children.push({ layout: 'cluster', gap: 'sm', justify: align === 'center' ? 'center' : 'start', children: [{ component: '@atom:actions' }, { component: '@atom:actions' }] });
  return { layout: 'stack', gap: 'md', align: align === 'center' ? 'center' : 'start', children };
}

const itemCell = (s: FormSignature) => ({
  layout: 'stack',
  gap: 'sm',
  align: s.align === 'center' ? 'center' : 'start',
  // Icono real de Relume -> `@icon` (icon:<set>/<Nombre> ya existe); card -> átomo de data; si no, solo texto.
  children: [...(s.icons ? [{ component: '@icon' }] : s.cards ? [{ component: '@atom:data' }] : []), text('subtitle', '{item.title}', s.align), text('body', '{item.description}', s.align)],
});

/** Fondo con media: el contrato de layout no lo admite (surface base/muted/raised) y el agente copia
 * los ejemplos literalmente, así que el árbol lleva un valor EMITIBLE (`muted`) y el hueco queda
 * explícito en `x-source-surface` para medirlo; cuando #64 admita `media`, se invierte aquí. */
const bg = (s: FormSignature, otherwise: 'base' | 'muted') =>
  s.media === 'background' ? { surface: 'muted', 'x-source-surface': 'media' } : { surface: otherwise };

/** Árbol en las primitivas del motor (src/runtime/layout.ts) con placeholders de copy `{x}` y de átomo
 * `@atom:<categoría>`. Es un patrón, no una sección: el compositor lo rellena con slugs reales. */
export function treeOf(s: FormSignature): unknown {
  const display = s.role === 'hero';
  const visual = { component: s.media === 'video' ? '@atom:special' : '@atom:media' };
  const n = Math.max(2, Math.min(s.items || 3, 6));
  const grid = (cols: number) => ({ layout: 'grid', cols: { base: 1, md: Math.min(cols, 2), lg: cols }, gap: 'lg', children: Array.from({ length: n }, () => itemCell(s)) });
  if (s.cols === 2 && s.media !== 'none' && s.side !== 'none') {
    const pair = [header(s, display), visual];
    return { role: s.role, ...bg(s, 'base'), children: [{ layout: 'split', ratio: '1:1', gap: 'xl', align: 'center', children: s.side === 'left' ? pair.reverse() : pair }] };
  }
  if (s.cols >= 3 || (s.cols === 2 && s.items >= 2)) {
    return { role: s.role, ...bg(s, s.cards ? 'muted' : 'base'), children: [header(s, display), grid(s.cols)] };
  }
  const children: unknown[] = [header(s, display)];
  if (s.media === 'image' || s.media === 'video') children.push(visual);
  if (s.control !== 'none') children.push({ component: `@atom:${s.control === 'form' ? 'inputs' : 'disclosure'}` });
  return { role: s.role, ...bg(s, 'base'), children: [{ layout: 'stack', gap: 'xl', align: s.align === 'center' ? 'center' : 'start', children }] };
}

function describe(s: Pattern['sig']): string {
  const parts = [
    s.cols === 2 && s.side !== 'none' ? `split texto + ${s.media} ${s.side === 'left' ? 'izquierda' : 'derecha'}` : s.cols >= 2 ? `grid ${s.cols} col` : 'una columna',
    s.media === 'background' ? 'fondo media' : s.cols !== 2 && s.media !== 'none' ? s.media : '',
    s.cards ? 'cards' : '',
    s.control !== 'none' ? s.control : '',
    s.items !== '0' ? `${s.items} items` : '',
    `texto ${s.align === 'center' ? 'centrado' : 'izquierda'}`,
    s.buttons ? 'botones' : 'sin botones',
  ];
  return parts.filter(Boolean).join(' · ');
}

/** Agrupa por firma y se queda con los patrones frecuentes hasta cubrir COVERAGE o MAX_PATTERNS. */
export function patternsOf(forms: SectionForm[]): { patterns: Pattern[]; singles: string[] } {
  const groups = new Map<string, SectionForm[]>();
  for (const f of forms) {
    const k = patternKey(f.sig);
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const patterns: Pattern[] = [];
  const singles: string[] = [];
  let covered = 0;
  for (const [key, members] of sorted) {
    if (members.length < 2 || patterns.length >= MAX_PATTERNS || covered / forms.length >= COVERAGE) {
      singles.push(...members.map((m) => m.slug));
      continue;
    }
    covered += members.length;
    const agg = aggregate(members);
    patterns.push({ key, sig: { ...agg, items: itemsBucket(agg.items) }, why: rationale(agg), count: members.length, slugs: members.map((m) => m.slug).sort(), tree: treeOf(agg) });
  }
  return { patterns, singles: singles.sort() };
}

export function renderGuide(role: Role, total: number, patterns: Pattern[], singles: string[]): string {
  const lines = [
    `# layout-${role}`,
    '',
    `Patrones de maquetación del rol \`${role}\`, destilados de ${total} secciones Relume (regla determinista sobre el source; nada escrito a mano). Cada patrón es un árbol en las primitivas del motor con placeholders: \`{x}\` = copy del rol, \`@atom:<categoría>\` = un componente del DS de esa categoría (actions, data, media, special, inputs, disclosure). \`@icon\` = un icono verificable (icon:<set>/<Nombre>). El tagline/eyebrow de Relume se descartó al destilar: lo decide el DS activo. Elige UN patrón por sección y sustituye los placeholders por slugs y copy reales; no mezcles dos.`,
    '',
  ];
  patterns.forEach((p, i) => {
    const cited = p.slugs.slice(0, MAX_CITED).join(', ') + (p.slugs.length > MAX_CITED ? ` (+${p.slugs.length - MAX_CITED})` : '');
    lines.push(`## P${i + 1} · ${describe(p.sig)} · n=${p.count} (${Math.round((p.count / total) * 100)}%)`, '', p.why, '', '```json', JSON.stringify(p.tree), '```', '', `Fuentes: ${cited}`, '');
  });
  if (singles.length) lines.push(`Otras ${singles.length} secciones con forma única (sin patrón): ${singles.slice(0, MAX_CITED).join(', ')}${singles.length > MAX_CITED ? ` (+${singles.length - MAX_CITED})` : ''}`, '');
  return lines.join('\n');
}

export interface RolePatterns {
  total: number;
  patterns: Pattern[];
  singles: string[];
}

/** Patrones por rol desde el vault entero, sin renderizar: lo que consume la selección de un solo
 * patrón por brief (experimento 2) y la guía completa (layoutGuides). */
export function rolePatterns(vaultRoot: string, scan: (root: string) => RelumeScanItem[] = scanRelume): { byRole: Record<string, RolePatterns>; excluded: Record<string, number> } {
  const items = scan(vaultRoot);
  const forms = new Map<Role, SectionForm[]>();
  const excluded: Record<string, number> = {};
  for (const it of items) {
    const role = roleOfCategory(it.category);
    if (!role) {
      excluded[it.category] = (excluded[it.category] ?? 0) + 1;
      continue;
    }
    forms.set(role, [...(forms.get(role) ?? []), { slug: it.slug, category: it.category, sig: signatureOf(it, role) }]);
  }
  const byRole: Record<string, RolePatterns> = {};
  for (const [role, list] of [...forms.entries()].sort(([x], [y]) => x.localeCompare(y))) byRole[role] = { total: list.length, ...patternsOf(list) };
  return { byRole, excluded };
}

export interface LayoutGuidesReport {
  guides: Record<string, string>;
  roles: Record<string, { total: number; patterns: number; covered: number; singles: number }>;
  /** Categorías del vault sin rol en el core (blog, forms, team...), con su conteo: fuera a propósito. */
  excluded: Record<string, number>;
}

/** Guías `layout-<rol>` desde el vault entero. Las categorías sin rol se reportan, no se inventan. */
export function layoutGuides(vaultRoot: string, scan: (root: string) => RelumeScanItem[] = scanRelume): LayoutGuidesReport {
  const { byRole, excluded } = rolePatterns(vaultRoot, scan);
  const guides: Record<string, string> = {};
  const roles: LayoutGuidesReport['roles'] = {};
  for (const [role, r] of Object.entries(byRole)) {
    guides[`layout-${role}`] = renderGuide(role as Role, r.total, r.patterns, r.singles);
    roles[role] = { total: r.total, patterns: r.patterns.length, covered: r.patterns.reduce((n, p) => n + p.count, 0), singles: r.singles.length };
  }
  return { guides, roles, excluded };
}
