// Modelo de slot por campo: el "input text fields" de Relume (page-content.js:154) para un bloque
// elegido. Cada campo lleva su rol semántico (lo que Relume saca de la css class del nodo), su
// presupuesto jq derivado del texto default del componente y el tipo de placeholder. Los Defaults se
// leen del source Relume (vendorizado en el repo o en el vault, read-only); Arc no trae Defaults y cae
// al canon por semántica.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CatalogEntry } from '../catalog/schema';
import { REPO_ROOT, VAULT_ROOT } from '../catalog/load';
import { type Budget, canonBudget, describeBudget, jq } from './budget';
import { type DefaultLeaf, extractDefaultLeaves, listCounts, placeholderText } from './defaults';

/** Rol semántico de un slot de texto. Es el vocabulario común entre el copy agnóstico (RoleCopy),
 * los props de los bloques y el presupuesto. */
export type Semantic =
  | 'heading' | 'tagline' | 'description' | 'cta' | 'quote' | 'name' | 'position' | 'company'
  | 'question' | 'answer' | 'label' | 'link' | 'brand' | 'price' | 'note' | 'placeholder';

export interface SlotField {
  id: number;
  path: string;
  semantic: Semantic;
  budget: Budget;
  /** Texto default del componente para este slot, si lo hay. */
  original?: string;
}

/** Campo de texto tal como viaja en el inputJson de Relume. `css classes` lleva la semántica y, tras
 * un espacio, la ruta del campo (Relume solo lee el primer token: page-content.js:33). */
export interface InputTextField {
  id: number;
  'css classes': string;
  'max length': string;
  'placeholder text': string;
}

export type SlotBudgets = Partial<Record<Semantic, Budget>>;

const KEY_SEMANTIC: ReadonlyArray<[RegExp, Semantic]> = [
  [/^(quote|testimonial)$/i, 'quote'],
  [/^(companyname|company)$/i, 'company'],
  [/^(position|jobtitle|role)$/i, 'position'],
  [/^(name|author)$/i, 'name'],
  [/^(question)$/i, 'question'],
  [/^(answer)$/i, 'answer'],
  [/^(tagline|eyebrow|kicker|badge)$/i, 'tagline'],
  [/^(heading|title|headline|planname|newsletterheading|footerheading)$/i, 'heading'],
  [/^(description|text|paragraph|subheading|subtitle|newsletterdescription|footerdescription|content)$/i, 'description'],
  [/^(label|percentage|value|periodlabel)$/i, 'label'],
  [/^(url|href)$/i, 'link'],
  [/^(monthlyprice|yearlyprice|price)$/i, 'price'],
  [/^(footertext|termsandconditions|note|yearlynote|footnote)$/i, 'note'],
  [/^(inputplaceholder|placeholder)$/i, 'placeholder'],
];

/** Semántica de una hoja por su ruta: el padre desambigua (`buttons.title` es un CTA, `links.title`
 * un link, `questions.title` una pregunta). */
export function semanticOf(path: string[]): Semantic | undefined {
  const leaf = path[path.length - 1] ?? '';
  const parent = (path[path.length - 2] ?? '').toLowerCase();
  if (/alt|src|icon/i.test(leaf)) return undefined;
  if (/button/.test(parent) && /^(title|label|text)$/i.test(leaf)) return 'cta';
  if (/link|navlink|footerlink|columnlink/.test(parent) && /^(title|label|text)$/i.test(leaf)) return 'link';
  if (/question|faq/.test(parent) && /^(title|heading)$/i.test(leaf)) return 'question';
  if (/logo/.test(parent) && /^(name|title)$/i.test(leaf)) return 'brand';
  if (/stat/.test(parent) && /^(heading|title)$/i.test(leaf)) return 'label';
  for (const [re, s] of KEY_SEMANTIC) if (re.test(leaf)) return s;
  return undefined;
}

/** Los "input text fields" de un bloque desde su source: una entrada por hoja de texto del Defaults
 * con semántica reconocida, numerada desde 1 como Relume. */
export function blockSlotFields(source: string): SlotField[] {
  return leavesToFields(extractDefaultLeaves(source));
}

function leavesToFields(leaves: DefaultLeaf[]): SlotField[] {
  const out: SlotField[] = [];
  for (const leaf of leaves) {
    const semantic = semanticOf(leaf.path);
    if (!semantic) continue;
    out.push({ id: out.length + 1, path: leaf.path.join('.'), semantic, budget: jq(leaf.text), original: leaf.text });
  }
  return out;
}

export const toInputTextField = (f: SlotField): InputTextField => ({
  id: f.id,
  'css classes': `${f.semantic} ${f.path}`,
  'max length': describeBudget(f.budget),
  'placeholder text': placeholderText(f.original ?? ''),
});

/** Presupuesto por semántica de un bloque: el del PRIMER slot de cada semántica (el default más
 * representativo), para que `fitProps` y el generador compartan la misma medida. */
export function budgetsOf(fields: SlotField[]): SlotBudgets {
  const out: SlotBudgets = {};
  for (const f of fields) if (!(f.semantic in out)) out[f.semantic] = f.budget;
  return out;
}

// Piso de palabras por semántica: el text-fit de Relume es blando (±1 línea, 3 intentos), el nuestro es
// un tope duro, así que un default de una palabra ("Button") no puede amputar un CTA de tres.
const MIN_WORDS: Partial<Record<Semantic, number>> = { cta: 4, heading: 5, brand: 3, name: 3, label: 4, link: 3, tagline: 2, price: 2, company: 3, position: 4, placeholder: 3, note: 4, question: 5 };

export function budgetFor(semantic: Semantic, budgets: SlotBudgets | undefined): Budget {
  const b = budgets?.[semantic] ?? canonBudget(semantic);
  const floor = MIN_WORDS[semantic];
  return b.unit === 'words' && floor !== undefined && b.n < floor ? { unit: 'words', n: floor } : b;
}

/** Lo que el generador necesita saber de un bloque elegido: presupuestos y tamaños de lista. */
export interface BlockSlotModel {
  slug: string;
  fields: SlotField[];
  budgets: SlotBudgets;
  counts: Record<string, number>;
}

const EMPTY_MODEL = (slug: string): BlockSlotModel => ({ slug, fields: [], budgets: {}, counts: {} });

/** Source de un bloque para leer sus Defaults: el vendorizado en el repo, o el original del vault
 * (read-only). Arc no tiene Defaults de texto: devuelve undefined y el modelo cae al canon. */
export function sourceTextOf(entry: CatalogEntry): string | undefined {
  if (entry.library !== 'relume') return undefined;
  const candidates = [entry.source ? join(REPO_ROOT, entry.source) : undefined, join(VAULT_ROOT, entry.origin.path)];
  for (const p of candidates) {
    if (!p) continue;
    try {
      return readFileSync(p, 'utf8');
    } catch {
      continue;
    }
  }
  return undefined;
}

const MODEL_CACHE = new Map<string, BlockSlotModel>();

/** Modelo de slot de un bloque del catálogo (memoizado por slug: el source no cambia en una corrida). */
export function blockSlotModel(entry: CatalogEntry): BlockSlotModel {
  const cached = MODEL_CACHE.get(entry.slug);
  if (cached) return cached;
  const src = sourceTextOf(entry);
  const model = src ? modelFromSource(entry.slug, src) : EMPTY_MODEL(entry.slug);
  MODEL_CACHE.set(entry.slug, model);
  return model;
}

export function modelFromSource(slug: string, source: string): BlockSlotModel {
  const leaves = extractDefaultLeaves(source);
  const fields = leavesToFields(leaves);
  return { slug, fields, budgets: budgetsOf(fields), counts: listCounts(leaves) };
}
