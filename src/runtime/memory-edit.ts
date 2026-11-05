// Memoria por marca (spec contexto-agente §1, H8): `<root>/brands/<id>/memory.md`, una línea por hecho con la forma
// `- <hecho> · <messageId> · <AAAA-MM-DD>`. Aquí viven el formato, los topes y el filtro de datos personales, para que
// el PUT de la persona y la tool `remember` del agente apliquen exactamente las mismas reglas. Pura: la fecha la pasa
// quien llama.

export const MEMORY_FILE = 'memory.md';
export const MAX_MEMORY_LINES = 40;
export const MAX_MEMORY_BYTES = 4 * 1024;
export const MAX_FACT_CHARS = 200;
export const MEMORY_FULL = 'memoria llena: usa `replaces`';

export interface MemoryLine { fact: string; messageId: string; date: string }

export type MemoryEditCode = 'invalid' | 'too_large' | 'too_many_lines' | 'bad_line' | 'fact_too_long' | 'pii' | 'duplicate';
export type MemoryEditResult = { ok: true; text: string; lines: MemoryLine[] } | { ok: false; code: MemoryEditCode; error: string };

export type AddFactCode = 'empty' | 'fact_too_long' | 'pii' | 'full' | 'not_found' | 'ambiguous';
export type AddFactResult =
  | { ok: true; text: string; added: boolean; fact: string; replaced?: string }
  | { ok: false; code: AddFactCode; error: string };

const SEP = ' · ';
const LINE_RE = /^-\s+(.+?)\s+·\s+([A-Za-z0-9_-]{1,128})\s+·\s+(\d{4}-\d{2}-\d{2})\s*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Los tres patrones que pide el spec: correo, teléfono y token. El teléfono exige 8+ dígitos para no tomar horarios
// ("9 a 18 h") ni precios; el token, un prefijo de credencial conocido o una cadena larga sin espacios con dígitos.
const PII: readonly { kind: string; re: RegExp }[] = [
  { kind: 'un correo', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { kind: 'un teléfono', re: /\+?\d[\d\s().-]{6,}\d/ },
  { kind: 'un token o clave', re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}|\b(?:ghp|gho|ghs|xox[abp])[-_][A-Za-z0-9-]{8,}|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/ },
];

// HACK: heurística por dígitos; una fecha ISO no cuenta, pero una cifra larga con puntos ("12.500.000") sí cae como
// teléfono. Validar con libphonenumber cuando una marca real registre cifras con puntos o reporte un hecho legítimo
// rechazado.
const isPhone = (m: string): boolean => !/^\d{4}-\d{2}-\d{2}$/.test(m.trim()) && m.replace(/\D/g, '').length >= 8;

/** Qué dato personal o secreto trae el texto, o undefined. Es el filtro del PUT y de `remember`. */
export function piiIn(text: string): string | undefined {
  for (const { kind, re } of PII) {
    const all = text.match(new RegExp(re.source, 'g')) ?? [];
    if (all.some((m) => kind !== 'un teléfono' || isPhone(m))) return kind;
  }
  return undefined;
}

const cleanFact = (fact: string): string => fact.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').replace(/\s·\s/g, ' - ').trim();

export const formatLine = (l: MemoryLine): string => `- ${l.fact}${SEP}${l.messageId}${SEP}${l.date}`;
export const serializeMemory = (lines: readonly MemoryLine[]): string => (lines.length ? `${lines.map(formatLine).join('\n')}\n` : '');

/** Las líneas válidas del archivo; lo demás se ignora. Para leer lo guardado, no para validar lo que manda la persona. */
export function parseMemory(text: string): MemoryLine[] {
  return text.split(/\r?\n/).flatMap((raw) => {
    const m = LINE_RE.exec(raw.trim());
    return m ? [{ fact: m[1]!, messageId: m[2]!, date: m[3]! }] : [];
  });
}

const sameFact = (a: string, b: string): boolean => a.trim() === b.trim();

/** PUT /brands/:id/memory {text}: el texto entero que dejó la persona. Cualquier fallo → 400 con `code`, y el archivo no
 * se toca. Devuelve el texto normalizado (una línea por hecho, salto final). */
export function validateMemoryEdit(text: unknown): MemoryEditResult {
  if (typeof text !== 'string') return { ok: false, code: 'invalid', error: 'text tiene que ser un string' };
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_MEMORY_BYTES) return { ok: false, code: 'too_large', error: `la memoria ocupa ${bytes} bytes; el máximo es ${MAX_MEMORY_BYTES}` };
  const raw = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (raw.length > MAX_MEMORY_LINES) return { ok: false, code: 'too_many_lines', error: `la memoria tiene ${raw.length} líneas; el máximo es ${MAX_MEMORY_LINES}` };
  const lines: MemoryLine[] = [];
  for (const [i, l] of raw.entries()) {
    const m = LINE_RE.exec(l);
    if (!m) return { ok: false, code: 'bad_line', error: `línea ${i + 1}: tiene que ser "- hecho · messageId · AAAA-MM-DD"` };
    const line = { fact: m[1]!, messageId: m[2]!, date: m[3]! };
    if (line.fact.length > MAX_FACT_CHARS) return { ok: false, code: 'fact_too_long', error: `línea ${i + 1}: el hecho pasa de ${MAX_FACT_CHARS} caracteres` };
    const pii = piiIn(line.fact);
    if (pii) return { ok: false, code: 'pii', error: `línea ${i + 1}: la memoria no guarda ${pii}` };
    if (lines.some((x) => sameFact(x.fact, line.fact))) return { ok: false, code: 'duplicate', error: `línea ${i + 1}: el hecho ya está en otra línea` };
    lines.push(line);
  }
  return { ok: true, text: serializeMemory(lines), lines };
}

/** La escritura de `remember`: agrega un hecho o, con `replaces`, sustituye la única línea cuyo hecho lo contiene. Un
 * duplicado exacto no suma línea (added:false). Lleno sin `replaces` falla con MEMORY_FULL. `fact` es el hecho tal como
 * quedó guardado (sin saltos ni separador): es el que va en memory.write. */
export function addFact(current: string, input: { fact: string; messageId: string; date: string; replaces?: string }): AddFactResult {
  if (!DATE_RE.test(input.date)) throw new Error(`addFact: fecha "${input.date}" no es AAAA-MM-DD`);
  const fact = cleanFact(input.fact);
  if (!fact) return { ok: false, code: 'empty', error: 'el hecho está vacío' };
  if (fact.length > MAX_FACT_CHARS) return { ok: false, code: 'fact_too_long', error: `el hecho pasa de ${MAX_FACT_CHARS} caracteres` };
  const pii = piiIn(fact);
  if (pii) return { ok: false, code: 'pii', error: `la memoria no guarda ${pii}` };
  const lines = parseMemory(current);
  const line = { fact, messageId: input.messageId, date: input.date };
  const replaces = input.replaces?.trim();
  if (replaces) {
    const hits = lines.flatMap((l, i) => (l.fact.includes(replaces) ? [i] : []));
    if (!hits.length) return { ok: false, code: 'not_found', error: `ninguna línea de la memoria contiene "${replaces}"` };
    if (hits.length > 1) return { ok: false, code: 'ambiguous', error: `"${replaces}" está en ${hits.length} líneas: usa un texto que esté en una sola` };
    const at = hits[0]!;
    const next = lines.map((l, i) => (i === at ? line : l)).filter((l, i) => i === at || !sameFact(l.fact, fact));
    const text = serializeMemory(next);
    if (Buffer.byteLength(text, 'utf8') > MAX_MEMORY_BYTES) return { ok: false, code: 'full', error: MEMORY_FULL };
    return { ok: true, text, added: true, fact, replaced: formatLine(lines[at]!) };
  }
  if (lines.some((l) => sameFact(l.fact, fact))) return { ok: true, text: serializeMemory(lines), added: false, fact };
  const text = serializeMemory([...lines, line]);
  if (lines.length >= MAX_MEMORY_LINES || Buffer.byteLength(text, 'utf8') > MAX_MEMORY_BYTES) return { ok: false, code: 'full', error: MEMORY_FULL };
  return { ok: true, text, added: true, fact };
}

/** El bloque MEMORIA DE LA MARCA del prompt: solo los hechos, sin messageId ni fecha, que no le sirven al agente. */
export const memoryFacts = (text: string): string[] => parseMemory(text).map((l) => l.fact);
