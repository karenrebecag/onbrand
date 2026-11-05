// Hechos del brief para el generador determinista: nombre, descriptor ("agente de IA"), beneficios
// (los verbos del summary), audiencia y objetivo. Es lo único que el fallback puede afirmar del
// producto; todo lo demás son muletillas neutras. Equivale al `company description` + `page
// additional instructions` que Relume le da al LLM; aquí se parsea en vez de "entenderse".

import type { Lang } from './generator';

export interface Facts {
  name: string;
  /** Qué es, sin el nombre: "agente de IA", "copiloto de IA para equipos de producto". */
  descriptor: string;
  /** Verbos en tercera persona: "responde el WhatsApp de un e-commerce", "recupera carritos". */
  benefits: string[];
  audience?: string;
  /** Acción del visitante en infinitivo/minúscula: "agendar una demo". */
  goal: string;
  /** Frases del summary que no son ni la propuesta ni la lista de secciones. */
  extras: string[];
}

const SECTION_LIST_RE = /\b(landing|secciones?|sections?|logos|features|testimoni|faq|pricing|planes|precios|m[ée]tricas|c[óo]mo funciona|how it works|stats)\b/gi;
const IMPERATIVE_RE = /^(s[úu]mate|agenda|[úu]nete|reg[íi]strate|prueba|empieza|solicita|join|sign up|book|get started|try|request)\b/i;

const splitSentences = (s: string): string[] => s.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
const dropFinalDot = (s: string): string => s.replace(/[.!?]+$/, '').trim();
export const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
export const lower = (s: string): string => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

function audienceOf(sentence: string, lang: Lang): string | undefined {
  const re = lang === 'es' ? /\bpara ((?:los |las |tu |tus |el |la )?[^,.;:]+?)(?=[,.;:]|$| que\b)/i : /\bfor ((?:the |your )?[^,.;:]+?)(?=[,.;:]|$| that\b)/i;
  const m = sentence.match(re);
  if (m) return m[1].trim();
  const of = sentence.match(lang === 'es' ? /\bde (?:un|una|tu) ([^,.;:]+?)(?=[,.;:]|$| que\b)/i : /\bof (?:a|an|your) ([^,.;:]+?)(?=[,.;:]|$| that\b)/i);
  return of ? of[1].trim() : undefined;
}

/** Separa "X que hace A, hace B y hace C" en descriptor + beneficios. Sin relativo, todo es descriptor. */
function splitProposition(sentence: string, lang: Lang): { descriptor: string; benefits: string[] } {
  const rel = lang === 'es' ? / que (?=\p{L})/u : / (?:that|which) (?=\p{L})/u;
  const idx = sentence.search(rel);
  if (idx < 0) return { descriptor: sentence, benefits: [] };
  const descriptor = sentence.slice(0, idx).trim();
  const tail = sentence.slice(idx).replace(rel, '').trim();
  const benefits = tail.split(lang === 'es' ? /,\s*|\s+y\s+|\s+e\s+(?=i)/ : /,\s*|\s+and\s+/).map((b) => b.trim()).filter(Boolean);
  return { descriptor, benefits };
}

const isSectionList = (s: string): boolean => (s.match(SECTION_LIST_RE) ?? []).length >= 2;

export function extractFacts(summary: string, goal: string | undefined, lang: Lang): Facts {
  const colon = summary.indexOf(':');
  const head = colon > 0 ? summary.slice(0, colon).trim() : '';
  const hasName = head.length > 0 && head.length <= 40 && !/[.!?]/.test(head);
  const rest = hasName ? summary.slice(colon + 1).trim() : summary.trim();
  const sentences = splitSentences(rest);
  const first = dropFinalDot(sentences[0] ?? rest);
  const name = hasName ? head : first.split(/\s+/).slice(0, 2).join(' ');
  const { descriptor, benefits } = splitProposition(first, lang);
  const extras = sentences.slice(1).map(dropFinalDot).filter((s) => !isSectionList(s) && !IMPERATIVE_RE.test(s));
  const fallbackGoal = lang === 'es' ? 'empezar' : 'get started';
  return {
    name,
    descriptor: lower(descriptor),
    benefits: benefits.map(lower),
    ...(audienceOf(first, lang) ? { audience: audienceOf(first, lang) } : {}),
    goal: lower(dropFinalDot(goal?.trim() || fallbackGoal)),
    extras,
  };
}

/** "a, b y c" / "a, b and c". */
export function joinList(items: string[], lang: Lang): string {
  if (items.length <= 1) return items[0] ?? '';
  const conj = lang === 'es' ? ' y ' : ' and ';
  return `${items.slice(0, -1).join(', ')}${conj}${items[items.length - 1]}`;
}

/** Primeras `n` palabras de una frase, sin conector colgando: título corto de un beneficio. */
export function shortPhrase(s: string, n = 4): string {
  const words = s.split(/\s+/).slice(0, n);
  while (words.length > 1 && /^(de|del|la|el|los|las|un|una|y|o|para|con|que|a|en|por|the|a|an|and|or|of|to|for|with|that|in)$/i.test(words[words.length - 1])) words.pop();
  return cap(words.join(' '));
}
