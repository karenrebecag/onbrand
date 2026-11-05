// Eje semántico del ranking (brief <-> organismo). El scorer base solo mira overlap de tags de la
// ontología Relume ("3 Columns", "Icons"), así que un organismo de producto Arc —cuya señal vive en
// el manifiesto (keywords/whenToUse), no en tags estructurales— nunca puntúa. Este módulo traduce el
// brief a una consulta por rol y la cruza contra esas señales, para que "agente de IA que responde
// WhatsApp" alcance a `ai-chat`/`support-conversation`, no solo a un feature-grid genérico.
//
// Es el stand-in DETERMINISTA del paso que Relume resuelve con LLM (brief-to-homepage ->
// section-component): overlap de tokens normalizados, explicable y sin red. Cuando el transport LLM
// de descripción por sección aterrice, reemplaza a este matcher (ver HACK del léxico).

import type { Brief, Candidate, Role } from './types';

/** Stopwords es+en de alta frecuencia: no aportan señal de dominio y sacarlas evita falsos positivos
 * ("de"/"the"/"para"/"with"). Lista corta a propósito; no es un stemmer. */
const STOPWORDS = new Set([
  'de', 'la', 'el', 'los', 'las', 'un', 'una', 'y', 'o', 'que', 'en', 'con', 'por', 'para', 'del',
  'al', 'su', 'sus', 'lo', 'se', 'es', 'un', 'tu', 'tus', 'como', 'mas', 'muy', 'ya', 'cada',
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'your', 'you', 'is', 'it',
  'that', 'this', 'as', 'at', 'by', 'from', 'ui', 'react',
]);

/** Puentes es->en de términos de producto que el overlap de tokens no cruza por sí solo (la señal de
 * Arc está en inglés, el brief suele venir en español). General, no específico de un brief.
 * HACK: léxico fijo. Reemplazar por el matcher del transport LLM de descripción-por-sección cuando
 * ese paso aterrice (es su stand-in determinista), no ampliar este mapa término a término. */
const LEXICON: Record<string, string> = {
  ia: 'ai', inteligencia: 'ai', agente: 'agent', agentes: 'agent',
  correo: 'email', correos: 'email', mensaje: 'message', mensajes: 'message', chats: 'chat',
  carrito: 'cart', carritos: 'cart', tienda: 'ecommerce', comercio: 'ecommerce',
  precio: 'pricing', precios: 'pricing', plan: 'pricing', planes: 'pricing',
  metrica: 'metric', metricas: 'metric', cifras: 'metric', numeros: 'metric',
  panel: 'dashboard', tablero: 'dashboard', grafica: 'chart', graficas: 'chart',
  pregunta: 'faq', preguntas: 'faq', testimonio: 'testimonial', testimonios: 'testimonial',
  pasos: 'steps', proceso: 'steps',
};

const stripAccents = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Normaliza un término a su token canónico: sin acentos, minúsculas, singular simple, puente del
 * léxico. Devuelve '' para stopwords o tokens de 1 letra. Términos de dominio cortos como `ai`/`ia`
 * sobreviven (el ruido de 2 letras lo filtra STOPWORDS, no la longitud). */
function canonToken(raw: string): string {
  const t0 = stripAccents(raw.toLowerCase());
  if (LEXICON[t0]) return LEXICON[t0];
  let t = t0;
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) {
    const sing = t.slice(0, -1);
    if (LEXICON[sing]) return LEXICON[sing];
    t = sing;
  }
  if (t.length < 2 || STOPWORDS.has(t)) return '';
  return t;
}

/** Texto libre -> conjunto de tokens de dominio normalizados. */
export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/[^a-zA-Z0-9áéíóúñÁÉÍÓÚÑ]+/)) {
    const t = canonToken(raw);
    if (t) out.add(t);
  }
  return out;
}

/** Contexto mínimo por rol que ancla la consulta al tipo de sección (el "section description" que
 * Relume genera por LLM; aquí fijo y corto). Se suma a los tokens del brief. */
const ROLE_CONTEXT: Partial<Record<Role, string>> = {
  hero: 'hero headline product value',
  features: 'features product showcase capability benefit',
  steps: 'steps how it works process onboarding',
  stats: 'stats metrics numbers results dashboard',
  testimonials: 'testimonials customers social proof',
  pricing: 'pricing plans tiers subscription',
  faq: 'faq questions answers',
  logos: 'logos brands trusted',
  cta: 'cta call to action closing',
};

/** Consulta semántica de un rol: tokens del brief (dominio del producto) + contexto del rol. */
export function roleQuery(brief: Brief, role: Role): Set<string> {
  const q = tokenize(`${brief.summary} ${brief.goal ?? ''}`);
  for (const t of tokenize(ROLE_CONTEXT[role] ?? '')) q.add(t);
  return q;
}

/** Tokens de un candidato desde las señales de su manifiesto (keywords + whenToUse). Vacío si el
 * adaptador no las llevó (p.ej. un layout Relume sin manifiesto): entonces el eje no aporta y el
 * candidato se ordena solo por el scorer base. */
export function candidateTokens(c: Candidate): Set<string> {
  if (!c.keywords?.length && !c.whenToUse?.length) return new Set();
  return tokenize([...(c.keywords ?? []), ...(c.whenToUse ?? [])].join(' '));
}

export interface SemanticMatch {
  score: number;
  overlap: string[];
}

/** Cuántos tokens de dominio comparte el candidato con la consulta del rol. No se normaliza por
 * tamaño: más overlap = más señal (un organismo con 4 keywords de dominio debe ganar a uno con 1).
 * Devuelve el overlap para la traza. */
export function semanticMatch(query: ReadonlySet<string>, c: Candidate): SemanticMatch {
  const doc = candidateTokens(c);
  const overlap = [...query].filter((t) => doc.has(t));
  return { score: overlap.length, overlap };
}
