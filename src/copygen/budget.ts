// Presupuesto de longitud por slot, calcado de `jQ` del editor de Relume (relume-llm-infer/paginas/
// page-content.js:208, bundle main.5dbbe00c, 2026-10-12). Relume NO tiene una tabla de longitudes por
// nombre de slot: deriva el presupuesto del LARGO DEL TEXTO DEFAULT del componente ("1 word",
// "7 words", "2 sentences", "3 paragraphs") y se lo pasa al LLM como "max length". Aquí la misma regla
// es una función pura, más el text-fit determinista que la hace cumplir sin LLM (el `text-fit-1` de
// Relume es un loop LLM de hasta 3 reescrituras; su sustituto local recorta en frontera de idea).

export type BudgetUnit = 'words' | 'sentences' | 'paragraphs';

export interface Budget {
  unit: BudgetUnit;
  n: number;
}

/** Réplica literal de jQ: cuenta palabras por espacio simple, frases por punto y párrafos por salto.
 * Se mantiene el detalle de +2 palabras en textos de 6..15 palabras (holgura que Relume da al LLM) y
 * la rama `floor(t/15)` para textos largos con pocos puntos. */
export function jq(text: string): Budget {
  const t = text.split(' ').length;
  const dots = text.split('.').length - 1;
  const lines = text.split('\n').length;
  if (lines > 1 && dots > 2 && t > 10) return { unit: 'paragraphs', n: lines };
  if (t === 1) return { unit: 'words', n: 1 };
  if (t <= 5) return { unit: 'words', n: t };
  if (t <= 15) return { unit: 'words', n: t + 2 };
  if (dots === 1) return { unit: 'sentences', n: 1 };
  if (15 * dots > t) return { unit: 'sentences', n: Math.floor(t / 15) };
  // Quirk heredado: un texto >15 palabras sin ningún punto cae aquí con n=0 ("0 sentences").
  return { unit: 'sentences', n: dots };
}

/** El string que Relume manda al LLM como "max length". */
export function describeBudget(b: Budget): string {
  if (b.unit === 'words') return b.n === 1 ? '1 word' : `${b.n} words`;
  if (b.unit === 'sentences') return b.n === 1 ? '1 sentence' : `${b.n} sentences`;
  return `${b.n} paragraphs`;
}

/** Parser inverso ("7 words" -> Budget) para leer presupuestos serializados en el inputJson. */
export function parseBudget(s: string): Budget | undefined {
  const m = s.trim().toLowerCase().match(/^(\d+)\s+(word|words|sentence|sentences|paragraph|paragraphs)$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (m[2].startsWith('word')) return { unit: 'words', n };
  if (m[2].startsWith('sentence')) return { unit: 'sentences', n };
  return { unit: 'paragraphs', n };
}

// Relume asume ~15 palabras por frase (la constante de jQ); se reutiliza para medir frases y párrafos.
const WORDS_PER_SENTENCE = 15;
const SENTENCES_PER_PARAGRAPH = 3;

/** Tope de palabras equivalente a un presupuesto (para medir, no para cortar frases a ciegas). */
export function maxWords(b: Budget): number {
  if (b.unit === 'words') return b.n;
  const sentences = Math.max(1, b.n);
  return sentences * WORDS_PER_SENTENCE * (b.unit === 'paragraphs' ? SENTENCES_PER_PARAGRAPH : 1);
}

export const countWords = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

const splitSentences = (text: string): string[] => text.trim().split(/(?<=[.!?])\s+/).filter(Boolean);

// Palabras que no pueden cerrar un recorte sin dejar la idea colgando (artículos, preposiciones,
// conjunciones en es/en). El recorte retrocede hasta dejar una palabra plena.
const DANGLING = new Set([
  'de', 'del', 'la', 'el', 'lo', 'los', 'las', 'un', 'una', 'y', 'o', 'e', 'u', 'para', 'con', 'sin', 'que', 'a', 'en', 'por', 'al', 'su', 'sus', 'tu', 'tus', 'como', 'más', 'cada', 'todo', 'toda', 'nuestro', 'nuestra',
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'with', 'without', 'that', 'in', 'on', 'at', 'by', 'your', 'our', 'as', 'more', 'each', 'every', 'all',
]);

const stripTrailingPunct = (s: string): string => s.replace(/[\s,;:–-]+$/u, '');

/** Recorta a `limit` palabras sin partir la idea: primero intenta cerrar en fin de frase, luego en
 * una cláusula (`,` `;` `:`), y si no, en palabra plena (nunca en artículo/preposición). */
function cutWords(text: string, limit: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= limit) return text.trim();
  const endsSentence = /[.!?]$/.test(text.trim());
  const head = words.slice(0, limit);
  const minKeep = Math.max(1, Math.floor(limit * 0.5));
  for (let i = head.length - 1; i >= minKeep; i--) {
    if (/[.!?]["»”]?$/.test(head[i])) return head.slice(0, i + 1).join(' ');
  }
  const minClause = Math.max(1, Math.floor(limit * 0.6));
  for (let i = head.length - 1; i >= minClause; i--) {
    if (/[,;:]$/.test(head[i])) return `${stripTrailingPunct(head.slice(0, i + 1).join(' '))}${endsSentence ? '.' : ''}`;
  }
  let end = head.length;
  while (end > 1 && DANGLING.has(head[end - 1].toLowerCase().replace(/[^\p{L}]/gu, ''))) end--;
  return `${stripTrailingPunct(head.slice(0, end).join(' '))}${endsSentence ? '.' : ''}`;
}

/** Text-fit determinista: devuelve el texto si cabe; si no, lo acorta al presupuesto respetando
 * frases/párrafos. No alarga nunca (no inventa): el generador es quien escribe para caber; esto es
 * la red de seguridad, también para la salida de un LLM. Conserva las comillas envolventes. */
export function fitToBudget(text: string, b: Budget): string {
  const trimmed = text.trim();
  const quoted = trimmed.length > 1 && trimmed.startsWith('"') && trimmed.endsWith('"');
  const body = quoted ? trimmed.slice(1, -1) : trimmed;
  const fitted = fitBody(body, b);
  return quoted ? `"${fitted}"` : fitted;
}

function fitBody(body: string, b: Budget): string {
  if (b.unit === 'paragraphs') {
    const paras = body.split(/\n+/).filter((p) => p.trim());
    return paras.slice(0, Math.max(1, b.n)).join('\n');
  }
  if (b.unit === 'sentences' && b.n >= 1) {
    const kept = splitSentences(body).slice(0, b.n).join(' ');
    // Frases muy largas siguen sujetas al tope de palabras (~15 por frase, con 80% de holgura).
    const cap = Math.ceil(maxWords(b) * 1.8);
    return countWords(kept) > cap ? cutWords(kept, cap) : kept;
  }
  // words, o el quirk "0 sentences": tope de palabras.
  const limit = b.unit === 'words' ? b.n : WORDS_PER_SENTENCE;
  return countWords(body) <= limit ? body : cutWords(body, limit);
}

/** Textos default canónicos de los bloques Relume por semántica de slot: cuando un bloque no trae
 * Defaults (Arc) o no tiene ese slot, el presupuesto sale de aquí vía jq, no de una tabla ad hoc. */
export const CANON_DEFAULTS: Readonly<Record<string, string>> = {
  heading: 'Medium length section heading goes here',
  tagline: 'Tagline',
  description: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Suspendisse varius enim in eros elementum tristique.',
  quote: '"Lorem ipsum dolor sit amet, consectetur adipiscing elit. Suspendisse varius enim in eros elementum tristique. Duis cursus, mi quis viverra ornare."',
  cta: 'Button',
  name: 'Name Surname',
  position: 'Position',
  company: 'Company name',
  question: 'Question text goes here',
  answer: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Suspendisse varius enim in eros elementum tristique. Duis cursus, mi quis viverra ornare.',
  label: 'Short heading goes here',
  link: 'Link One',
  brand: 'Logo',
  price: '$19',
  note: 'Lorem ipsum dolor sit amet',
  placeholder: 'Enter your email',
};

export const canonBudget = (semantic: string): Budget => jq(CANON_DEFAULTS[semantic] ?? CANON_DEFAULTS.description);
