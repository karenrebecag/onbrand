// Recuperación en dos pasos (DISENO-two-step-retrieval, opción A): el modelo ve el schema SOLO de los
// componentes que va a usar, y el prompt no crece con el catálogo. Mandar el índice entero sin props
// hacía que el modelo adivinara props (card.title y primos) y no escala a 10x componentes.
// Funciones puras: quien orquesta hace las dos llamadas (select, compose) y pasa a check_layout lo que
// devuelve injectContext, para que componer y verificar usen una sola fuente.

import type { AllowEntry } from '../ds-skill';
import type { SchemaStore } from './verify';
import { importLine } from '../catalog/import-line';

/** Los átomos no tienen rol y `provides` está vacío en 132/144: la llave es la categoría del registry. */
export const ROLE_CATEGORIES: Record<string, readonly string[]> = {
  hero: ['actions', 'special', 'text', 'data'],
  logos: ['special', 'data'],
  features: ['data', 'special'],
  steps: ['data', 'disclosure', 'text'],
  testimonials: ['data', 'text'],
  pricing: ['actions', 'data'],
  faq: ['disclosure'],
  cta: ['actions', 'text'],
  stats: ['data'],
  // Roles del vocabulario del plan (ADR 0010) sin block propio todavía: componen árbol con estos átomos.
  cases: ['data', 'text'],
  integrations: ['special', 'data'],
  contact: ['actions', 'text', 'data'],
  footer: ['actions', 'text', 'special'],
  navbar: ['actions', 'special'],
};

// El brief llega en el idioma del negocio y los whenToUse están en inglés: sin estas pistas el ranking
// cruzaría idiomas y quedaría en el desempate alfabético.
const ROLE_HINTS: Record<string, string> = {
  hero: 'headline clear action primary introduce reveal title',
  logos: 'logo brand customers trusted marquee',
  features: 'contained group related content label icon highlight',
  steps: 'step order sequence follow happened progress group related content',
  testimonials: 'quote person team contributors contained group related content',
  pricing: 'plan price contained group related content clear action label status',
  faq: 'question answer expand collapse',
  cta: 'clear action call start title',
  stats: 'number totals value context trend compact range',
  cases: 'case study customer result metric quote number totals value',
  integrations: 'logo integration connect tools brand marquee',
  contact: 'contact form address map whatsapp clear action label',
  footer: 'links navigation contact clear action',
  navbar: 'navigation menu links clear action',
};

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'una', 'uno', 'para', 'que', 'los', 'las', 'del', 'con', 'por', 'como', 'sus', 'nuestro', 'nuestra']);

export interface ShortlistOptions {
  maxAtoms?: number;
  /** `special` son piezas de efecto (37): sin tope propio llenan el cupo y desplazan a lo funcional. */
  maxSpecial?: number;
}

export interface Shortlist {
  blocks: string[];
  atoms: string[];
}

function tokens(text: string): Set<string> {
  const words = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  return new Set(words.filter((w) => !STOP.has(w)));
}

function textOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(textOf).join(' ');
  if (v && typeof v === 'object') return Object.values(v).map(textOf).join(' ');
  return '';
}

const usable = (e: AllowEntry): boolean => !e.propless;

/** Paso 0 (código, sin LLM): blocks del rol + átomos de las categorías del rol, rankeados contra el brief
 * y las pistas del rol. Se toman en ronda por categoría para que el ranking no deje la sección con una
 * sola categoría (QA: si los átomos por sección caen, two-step mata la composición). */
export function shortlist(role: string, brief: unknown, allow: Record<string, AllowEntry>, opts: ShortlistOptions = {}): Shortlist {
  const maxAtoms = opts.maxAtoms ?? 8;
  const maxSpecial = opts.maxSpecial ?? 2;
  const entries = Object.entries(allow).sort(([a], [b]) => a.localeCompare(b));
  const blocks = entries.filter(([, e]) => e.kind === 'block' && e.role === role && usable(e)).map(([s]) => s);

  const cats = ROLE_CATEGORIES[role] ?? [...new Set(entries.map(([, e]) => e.category).filter((c): c is string => !!c))];
  const query = tokens(`${role} ${ROLE_HINTS[role] ?? ''} ${textOf(brief)}`);
  const score = (slug: string, e: AllowEntry): number => {
    const own = tokens(`${slug.replace(/-/g, ' ')} ${e.summary ?? ''} ${(e.whenToUse ?? []).join(' ')}`);
    let n = 0;
    for (const t of own) if (query.has(t)) n += 1;
    return n;
  };
  const queues = cats.map((c) =>
    entries
      .filter(([, e]) => e.kind === 'component' && e.category === c && usable(e))
      .map(([s, e]) => ({ slug: s, score: score(s, e) }))
      .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug)),
  );

  const atoms: string[] = [];
  let special = 0;
  const take = (matched: boolean): void => {
    const qs = queues.map((q) => q.filter((x) => (x.score > 0) === matched && !atoms.includes(x.slug)));
    for (let i = 0; atoms.length < maxAtoms && qs.some((q) => i < q.length); i += 1) {
      qs.forEach((q, ci) => {
        const item = q[i];
        if (!item || atoms.length >= maxAtoms) return;
        if (cats[ci] === 'special') {
          if (special >= maxSpecial) return;
          special += 1;
        }
        atoms.push(item.slug);
      });
    }
  };
  // Primero lo que coincide con el brief o el rol; el resto solo rellena cupo.
  take(true);
  take(false);
  return { blocks, atoms };
}

/** Paso 1: índice corto del shortlist. `kind` y rol del block van explícitos para que el modelo no meta
 * un block dentro de un layout. */
export function shortIndex(slugs: string[], allow: Record<string, AllowEntry>): string {
  return slugs
    .filter((s) => allow[s])
    .map((s) => {
      const e = allow[s];
      const kind = e.kind === 'block' ? `block${e.role ? ` (rol ${e.role}, va solo en la sección)` : ''}` : 'component';
      const nest = e.accepts.length ? `anida: ${e.accepts.map((a) => a.prop).join(',')}` : 'hoja';
      return `- \`${s}\` · ${e.export} · ${kind} · [${nest}] · ${e.summary ?? ''}`.trimEnd();
    })
    .join('\n');
}

/** Valida la respuesta del paso 1 (salida del modelo): solo pasan slugs del shortlist, sin repetir. */
export function pickSelection(raw: unknown, candidates: string[]): { slugs: string[]; rejected: string[] } {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { slugs?: unknown }).slugs) ? (raw as { slugs: unknown[] }).slugs : [];
  const allowed = new Set(candidates);
  const slugs: string[] = [];
  const rejected: string[] = [];
  for (const v of list) {
    const s = typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { slug?: unknown }).slug === 'string' ? (v as { slug: string }).slug : null;
    if (s === null) continue;
    if (!allowed.has(s)) rejected.push(s);
    else if (!slugs.includes(s)) slugs.push(s);
  }
  return { slugs, rejected };
}

export interface InjectedContext {
  prompt: string;
  /** Resuelve solo los slugs inyectados. */
  schemas: SchemaStore;
  /** La allowlist recortada a lo inyectado: con ella check_layout marca como desconocido lo que el
   * modelo use sin haberlo visto, en vez de aceptarlo sin schema. */
  allow: Record<string, AllowEntry>;
}

/** Paso 2: schema (fuente de máquina) + whenToUse de los elegidos. Si se solapan, manda el schema. */
export function injectContext(slugs: string[], allow: Record<string, AllowEntry>, schemas: SchemaStore): InjectedContext {
  const picked = [...new Set(slugs)].filter((s) => allow[s]);
  const sub = Object.fromEntries(picked.map((s) => [s, allow[s]]));
  const blocks = picked.map((s) => {
    const e = allow[s];
    const schema = schemas(s);
    const lines = [`### \`${s}\` (${e.export})`, `- import: \`${importLine(e, '"')}\``];
    lines.push(e.accepts.length ? `- acepta componentes en: ${e.accepts.map((a) => `\`${a.prop}\`${a.required ? ' (obligatorio)' : ''}`).join(', ')}` : '- hoja: solo datos por props');
    if (e.form) lines.push(`- forma: ${e.form}`);
    if (e.whenToUse?.length) lines.push(`- cuándo usarlo:\n${e.whenToUse.map((w) => `  - ${w}`).join('\n')}`);
    lines.push(schema ? `- schema de props (manda sobre cualquier otra fuente):\n\`\`\`json\n${JSON.stringify(schema)}\n\`\`\`` : '- sin schema: no le pases props de datos');
    return lines.join('\n');
  });
  const set = new Set(picked);
  return {
    prompt: blocks.join('\n\n'),
    schemas: (slug) => (set.has(slug) ? schemas(slug) : null),
    allow: sub,
  };
}
