// Lectura de los textos default de un bloque Relume (`export const XDefaults: Props = {...}`) sin
// ejecutar su código: un escáner de literales que recorre el objeto y devuelve cada string con su ruta
// de claves. Es la fuente de verdad del presupuesto por slot (jq sobre el default, como hace Relume
// con `e.original`) y del conteo de items por lista (3 testimonios, 4 preguntas...). JSX dentro del
// objeto (iconos sociales) se ignora: no es texto.

export interface DefaultLeaf {
  /** Claves hasta la hoja, sin índices: `testimonials.quote`, `features`, `buttons.title`. */
  path: string[];
  text: string;
}

const DEFAULTS_RE = /export\s+const\s+\w+Defaults\s*(?::\s*[\w<>[\]|\s]+)?=\s*\{/;

interface Frame {
  key: string | undefined;
  kind: 'obj' | 'arr';
}

/** Lee un string literal desde `i` (en una comilla) y devuelve su valor y la posición siguiente. */
function readString(src: string, i: number): { value: string; next: number } {
  const quote = src[i];
  let out = '';
  let j = i + 1;
  while (j < src.length && src[j] !== quote) {
    if (src[j] === '\\' && j + 1 < src.length) {
      const esc = src[j + 1];
      out += esc === 'n' ? '\n' : esc;
      j += 2;
      continue;
    }
    out += src[j];
    j++;
  }
  return { value: out, next: j + 1 };
}

/** Extrae las hojas de texto del primer objeto `*Defaults` del source. Vacío si no hay Defaults. */
export function extractDefaultLeaves(source: string): DefaultLeaf[] {
  const m = DEFAULTS_RE.exec(source);
  if (!m) return [];
  const start = m.index + m[0].length;
  const leaves: DefaultLeaf[] = [];
  const stack: Frame[] = [{ key: undefined, kind: 'obj' }];
  let pendingKey: string | undefined;
  let i = start;
  while (i < source.length && stack.length > 0) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') { i = source.indexOf('\n', i); if (i < 0) break; continue; }
    if (ch === '/' && source[i + 1] === '*') { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; continue; }
    if (ch === '"' || ch === "'" || ch === '`') {
      const { value, next } = readString(source, i);
      const top = stack[stack.length - 1];
      const keys = stack.map((f) => f.key).filter((k): k is string => k !== undefined);
      if (top.kind === 'arr') leaves.push({ path: keys, text: value });
      else if (pendingKey !== undefined) leaves.push({ path: [...keys, pendingKey], text: value });
      pendingKey = undefined;
      i = next;
      continue;
    }
    if (ch === '{') { stack.push({ key: pendingKey, kind: 'obj' }); pendingKey = undefined; i++; continue; }
    if (ch === '[') { stack.push({ key: pendingKey, kind: 'arr' }); pendingKey = undefined; i++; continue; }
    if (ch === '}' || ch === ']') { stack.pop(); pendingKey = undefined; i++; continue; }
    if (ch === ',') { pendingKey = undefined; i++; continue; }
    // JSX (<Icon />): se salta hasta el cierre de la etiqueta.
    if (ch === '<') { const end = source.indexOf('>', i); i = end < 0 ? source.length : end + 1; continue; }
    const id = /^[A-Za-z_$][\w$]*/.exec(source.slice(i, i + 64));
    if (id && stack[stack.length - 1].kind === 'obj') {
      const after = source.slice(i + id[0].length).match(/^\s*:/);
      if (after) { pendingKey = id[0]; i += id[0].length + after[0].length; continue; }
      i += id[0].length;
      continue;
    }
    i++;
  }
  return leaves;
}

/** Cuántos items trae cada lista del Defaults (clave de la lista -> n). Se cuenta la primera hoja de
 * cada item; una lista de strings cuenta sus strings. */
export function listCounts(leaves: DefaultLeaf[]): Record<string, number> {
  const firstLeafOf = new Map<string, string>();
  const counts: Record<string, number> = {};
  for (const leaf of leaves) {
    if (leaf.path.length < 1) continue;
    const list = leaf.path.length === 1 ? leaf.path[0] : leaf.path[leaf.path.length - 2];
    const leafKey = leaf.path[leaf.path.length - 1];
    const seen = firstLeafOf.get(list);
    if (seen === undefined) firstLeafOf.set(list, leafKey);
    if ((seen ?? leafKey) === leafKey) counts[list] = (counts[list] ?? 0) + 1;
  }
  // Un escalar suelto (heading) cuenta 1 pero no es lista: solo interesan las claves con 2+ o arrays.
  return Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 1));
}

/** Tipo de placeholder que Relume manda al LLM por campo (page-content.js:155): un Lorem entre
 * comillas es una cita, un Lorem/Morbi es relleno y cualquier otro texto viaja tal cual. */
export function placeholderText(original: string): string {
  const lower = original.toLowerCase();
  if (lower.startsWith('"lorem ipsum')) return 'quote';
  if (lower.startsWith('lorem ipsum') || lower.startsWith('morbi sed')) return 'placeholder';
  return original;
}
