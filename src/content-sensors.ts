// Sensores de contenido (specs/observabilidad.md S1-S4 y S11, ADR 0011): lo que lee una persona y los sensores de
// contrato no ven. Deciden sobre la medida del navegador (page-sensors.browser.js), la misma en nuestro dist y en el
// preview de v0, y sobre el texto final del mensaje. No leen page.json: con el ADR 0011 el agente escribe archivos.
// Calibración: R2 de brechas/qa.md (v0 j049, Lumbre y atomchat, n=3).

import { CLASS_WORDS, disclosed, type InventedClass } from './facts-disclosure';
import { detectLang, type Lang } from './foreign-text';
import type { MeasuredSection, Owner, PageMeasure } from './page-sensors';
import { fold, roleOfKey } from './plan-sensors';
import { normalize } from './render-gate';
import { roleOfSlug } from './section-slug';

export type { InventedClass } from './facts-disclosure';

export type ContentField = 'content.repeat' | 'cta.budget' | 'content.demo' | 'section.lang.fragment' | 'facts.disclosed';

export interface ContentDefect {
  field: ContentField;
  owner: Owner;
  section: string;
  expected: string;
  actual: string;
  message: string;
}

const defect = (field: ContentField, owner: Owner, section: string, expected: string, actual: string, message: string): ContentDefect =>
  ({ field, owner, section, expected, actual, message });

const nameOf = (s: MeasuredSection): string => fold(roleOfSlug(s.key));
const isFrame = (s: MeasuredSection): boolean => s.frame || roleOfKey(s.key) === 'frame';
const content = (m: PageMeasure): MeasuredSection[] => m.sections.filter((s) => !isFrame(s));
// innerText por fragmento junta los dígitos de un contador ("3 8 %" en el texto plano es "38%" aquí).
const textsOf = (s: MeasuredSection): string[] => (s.fragments?.length ? s.fragments : [s.text]);

// Cifra con unidad o moneda: "4,000+", "38%", "2.4x", "8 seg", "US$99". Un número suelto o un año no es un hecho.
const FIGURE = /(?:US\$|[$€£])\s?\d[\d.,]*|\d{1,3}(?:[,.]\d{3})+\+?|\d[\d.,]*\s?(?:%|\+|x\b|k\b|M\+|hrs?\b|h\b|seg\b|segundos\b|días\b|days\b|min\b)/gi;
// "24/7" es una propiedad del servicio, no una cifra que se cita: v0 la repite en atomchat y Lumbre.
const NOT_FIGURE = new Set(['24/7']);
// Nombre y apellido: así se reconocen personas y empresas inventadas sin un pool (v0 no expone uno).
const NAME = /\b\p{Lu}\p{Ll}+ \p{Lu}\p{Ll}+\b/gu;
const HAS_NAME = new RegExp(NAME.source, 'u');
const FIGURES_MAX = 2;

const figuresOf = (t: string): string[] => [...t.matchAll(FIGURE)].map((x) => x[0].replace(/\s+/g, '').toLowerCase()).filter((f) => !NOT_FIGURE.has(f));

/** S1. Una persona o empresa aparece en una sola sección de contenido; las cifras repetidas no pasan del rango de v0
 * (j049 repite 2: 4,000+ y 80+). Los nombres que también son texto de un enlace (botones en Title Case) no cuentan. */
export function contentRepeat(m: PageMeasure): ContentDefect[] {
  const linkTexts = m.sections.flatMap((s) => (s.links ?? []).map((l) => l.text)).join(' | ');
  const where = (pick: (t: string) => string[]): Map<string, Set<string>> => {
    const at = new Map<string, Set<string>>();
    for (const s of content(m)) for (const v of textsOf(s).flatMap(pick)) at.set(v, new Set([...(at.get(v) ?? []), s.key]));
    return new Map([...at].filter(([, keys]) => keys.size > 1));
  };
  const names = where((t) => [...t.matchAll(NAME)].map((x) => x[0]).filter((n) => !linkTexts.includes(n) && !m.title.includes(n)));
  const figures = where(figuresOf);
  const out = [...names].map(([n, keys]) => defect('content.repeat', 'A', [...keys].join(','), 'en una sola sección', `${keys.size} secciones`, `"${n}" aparece en ${[...keys].join(', ')}: la misma persona o empresa vuelve en otra sección`));
  if (figures.size > FIGURES_MAX) {
    const list = [...figures].map(([f, keys]) => `${f} (${keys.size})`).join(', ');
    out.push(defect('content.repeat', 'A', '-', `≤${FIGURES_MAX} cifras repetidas`, String(figures.size), `${figures.size} cifras se repiten entre secciones: ${list}`));
  }
  return out;
}

export interface CtaBudget {
  maxSections: number;
  maxLabel: number;
  /** Secciones (por rol o nombre) donde la acción principal no va. */
  forbidden: readonly string[];
}

// Propuesta de la spec según v0 (n=3): 3-4 secciones, etiqueta más repetida 2-3 veces, nunca en features, steps ni
// footer. HACK: umbral provisional hasta la decisión 1 de Karen (¿cuántas veces o qué etiqueta?); cambiar aquí.
export const CTA_BUDGET: CtaBudget = { maxSections: 4, maxLabel: 3, forbidden: ['features', 'steps', 'footer'] };

const CONVERSION = /wa\.me|api\.whatsapp\.com|^mailto:|^tel:|#(cta|pedido|pedidos|pricing|precios|precos|signup|demo|contact|contacto)\b/i;

/** S2. La acción principal: las etiquetas de los botones de conversión de las secciones de contenido, contadas en
 * toda la página (navbar y footer incluidos). Un enlace del menú a #precios no es la acción: su etiqueta no sale en
 * ningún botón de contenido. */
export function ctaBudget(m: PageMeasure, budget: CtaBudget = CTA_BUDGET): ContentDefect[] {
  const conv = (s: MeasuredSection) => (s.links ?? []).filter((l) => CONVERSION.test(l.href) && l.text);
  const labels = new Set(content(m).flatMap((s) => conv(s).map((l) => l.text)));
  const hits = m.sections.flatMap((s) => conv(s).filter((l) => labels.has(l.text)).map((l) => ({ s, label: l.text })));
  const sections = [...new Set(hits.map((h) => h.s))];
  const out: ContentDefect[] = [];
  if (sections.length > budget.maxSections) out.push(defect('cta.budget', 'A', '-', `≤${budget.maxSections} secciones`, String(sections.length), `la acción principal está en ${sections.length} secciones: ${sections.map((s) => s.key).join(', ')}`));
  const counts = new Map<string, number>();
  for (const h of hits) counts.set(h.label, (counts.get(h.label) ?? 0) + 1);
  for (const [label, n] of counts) if (n > budget.maxLabel) out.push(defect('cta.budget', 'A', '-', `≤${budget.maxLabel} veces`, String(n), `"${label}" se repite ${n} veces`));
  for (const s of sections) {
    const slot = isFrame(s) ? nameOf(s) : roleOfKey(s.key);
    if (budget.forbidden.includes(slot)) out.push(defect('cta.budget', 'A', s.key, `sin la acción en ${slot}`, 'presente', `${s.key} lleva la acción principal y ese rol no la pide`));
  }
  return out;
}

const DEMO_MIN_WORDS = 3;
const DEMO_GENERIC_WORDS = 5;

/** Un literal de demo que una página real también escribiría ("start free trial", "see how it works": v0 j049 los usa)
 * no prueba nada. Cuenta el que trae una marca propia de la demo (cifra, #canal, @) o una frase larga. */
const specific = (l: string): boolean => /\d|#|@/.test(l) || l.split(' ').length >= DEMO_GENERIC_WORDS;

/** S3. Ningún fragmento visible ES un literal de demo del DS (los *-data.ts del scaffold, el starter y las
 * referencias que lee el agente). Se compara el fragmento entero: "$10 per seat" dentro de "$10 per seat each month
 * when billed yearly" es copy del negocio que coincide, no la demo. Lo que el brief dice no cuenta. */
export function contentDemo(m: PageMeasure, corpus: ReadonlySet<string>, brief = ''): ContentDefect[] {
  const b = normalize(brief);
  const lits = new Set([...corpus].filter((l) => l.split(' ').length >= DEMO_MIN_WORDS && specific(l) && !b.includes(l)));
  return m.sections.flatMap((s) => [...new Set(textsOf(s).map(normalize))]
    .filter((f) => lits.has(f))
    .map((l) => defect('content.demo', 'B', s.key, 'contenido del negocio', `"${l.slice(0, 60)}"`, `${s.key} pinta la demo del DS: "${l.slice(0, 60)}"`)));
}

// Con menos palabras detectLang no tiene señal (un nombre, una cifra, un botón de dos palabras).
const FRAGMENT_MIN_WORDS = 4;

/** S4. Cada fragmento con señal de idioma está en el de la página. Decide por fragmento y no por sección: una
 * tarjeta en inglés dentro de una sección en español no cambia la mayoría. */
export function fragmentLang(m: PageMeasure, lang: Lang | undefined): ContentDefect[] {
  if (!lang) return [];
  return m.sections.flatMap((s) => (s.fragments ?? [])
    .filter((f) => f.split(/[^\p{L}]+/u).filter(Boolean).length >= FRAGMENT_MIN_WORDS)
    .map((f) => ({ f, got: detectLang(f) }))
    .filter(({ got }) => got && got !== lang)
    .map(({ f, got }) => defect('section.lang.fragment', 'B', s.key, lang, got!, `${s.key}: "${f.slice(0, 60)}" está en ${got} en una página en ${lang}`)));
}


const PLACEHOLDER_WA = /wa\.me\/52?1?5500000000/;
const PRICE = /(?:US\$|[$€£])\s?\d/;
// Credenciales que un generador inventa y presenta como verificadas (Stitch, RE 2026-10-26): auditoría,
// certificaciones, SLA con cifra, programas de partner y ratings de plataformas de reseñas. No cuentan "API oficial"
// (producto), "SLA y soporte prioritario" en un plan (oferta, v0) ni "verified", que es una ligadura de Material Symbols.
const CREDENTIAL = /\b(?:auditad[oa]s?|audited|certificad[oa]s?|certified|ISO\s?\d{4,5}|SOC\s?2|GDPR|HIPAA|PCI[- ]DSS|SLA\s?\d|\d+(?:[.,]\d+)?\s?%\s?SLA|partner|G2|Capterra|Trustpilot|\d[.,]\d\s?\/\s?5)(?![\p{L}\d])/giu;

/** Clases de dato inventado que la página muestra. Personas: nombre y apellido en una sección de testimonios o
 * casos, o junto a una cita. Enlaces: `#` o el número placeholder de WhatsApp. Credenciales: las que el brief
 * no trae; una certificación que el negocio declara no es inventada. */
export function inventedClasses(m: PageMeasure, brief = ''): Set<InventedClass> {
  const out = new Set<InventedClass>();
  const b = brief.toLowerCase();
  for (const s of m.sections) {
    const texts = textsOf(s);
    // Un fragmento queda cubierto si el brief nombra alguna de sus credenciales ("Certificados ISO 27001" con "ISO 27001").
    if (texts.some((t) => { const cs = [...t.matchAll(CREDENTIAL)].map((c) => c[0].toLowerCase()); return cs.length > 0 && !cs.some((c) => b.includes(c)); })) out.add('credentials');
    if (!isFrame(s) && texts.some((t) => figuresOf(t).length)) out.add('figures');
    if (texts.some((t) => PRICE.test(t))) out.add('prices');
    const role = roleOfKey(s.key);
    if ((role === 'testimonials' || role === 'cases' || texts.some((t) => /[“"«]/.test(t))) && texts.some((t) => HAS_NAME.test(t))) out.add('people');
    if ((s.links ?? []).some((l) => l.href === '#' || PLACEHOLDER_WA.test(l.href))) out.add('links');
  }
  return out;
}

/** S11. El resumen final del mensaje declara lo inventado, como el "Placeholder content" de v0 (j049): cada clase
 * que la página muestra está nombrada en un texto que dice que es inventado. */
export function factsDisclosed(m: PageMeasure, message: string, before?: PageMeasure, brief = ''): ContentDefect[] {
  // Un follow-up responde por lo que agrega: lo inventado del mensaje base ya se declaró en el suyo.
  const prior = before ? inventedClasses(before, brief) : new Set<InventedClass>();
  const present = new Set([...inventedClasses(m, brief)].filter((c) => !prior.has(c)));
  if (!present.size) return [];
  const sentences = disclosed(message);
  const said = sentences.join(' ');
  const missing = [...present].filter((c) => !CLASS_WORDS[c].test(said));
  if (!sentences.length) return [defect('facts.disclosed', 'A', '-', 'resumen que declara lo inventado', 'sin declaración', `la página muestra ${[...present].join(', ')} inventados y el mensaje no lo declara`)];
  return missing.map((c) => defect('facts.disclosed', 'A', '-', `declarar ${c}`, 'no nombrado', `la página muestra ${c} inventados y el resumen no los nombra`));
}

export interface ContentExpect {
  lang?: Lang;
  corpus?: ReadonlySet<string>;
  brief?: string;
  /** Texto final del mensaje; sin él no se afirma S11. */
  message?: string;
  cta?: CtaBudget;
  /** La versión sobre la que editó un follow-up: S11 solo exige declarar las clases nuevas. */
  before?: PageMeasure;
}

export function contentSensors(m: PageMeasure, e: ContentExpect = {}): ContentDefect[] {
  return [
    ...contentRepeat(m),
    ...ctaBudget(m, e.cta),
    ...(e.corpus ? contentDemo(m, e.corpus, e.brief) : []),
    ...fragmentLang(m, e.lang ?? detectLang(content(m).map((s) => s.text).join(' '))),
    ...(e.message !== undefined ? factsDisclosed(m, e.message, e.before, e.brief) : []),
  ];
}
