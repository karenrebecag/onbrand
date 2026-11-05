// Edit Text de Stitch sin modelo (webcrack de DesignPage-s8oa9o80, re-iteracion/stitch-ui/deob-2026-11-02: estrategias
// :4633-4687, de `exact` y `quote-normalized` a `br-tolerant` :4668 y `tag-stripped` :4687): buscar el texto
// visible en el código y reemplazarlo con las mismas estrategias, en el mismo orden. Dos diferencias a propósito:
// Stitch edita un solo HTML y toma la primera coincidencia; aquí la página son varios TSX y un texto repetido
// cambiaría el lugar equivocado, así que solo se aplica con una coincidencia única en todos los archivos. Y el
// reemplazo va por función, porque Stitch pasa un string a replace() y un "$&" escrito por la persona se expande.
// Y solo cuenta lo que se ve: texto JSX y literales de texto, no className, href, id ni imports, que un texto corto
// podría encontrar y cambiar sin avisar.

type Ts = typeof import('typescript');
type Node = import('typescript').Node;

export type TextEditStrategy =
  | 'exact'
  | 'quote-normalized'
  | 'html-entity'
  | 'case-insensitive'
  | 'case-insensitive-entity'
  | 'br-tolerant'
  | 'br-tolerant-entity'
  | 'tag-stripped';

export type TextEditResult =
  // typeSafe: el reemplazo cayó en texto JSX (o <br/>) o en un atributo de texto, no en un literal de datos que pueda
  // estar tipado como unión: se guarda sin tsc.
  | { ok: true; path: string; source: string; strategy: TextEditStrategy; typeSafe: boolean }
  | { ok: false; reason: 'invalid' | 'unsafe' | 'not-found' | 'ambiguous'; message: string };

export const MAX_EDIT_CHARS = 2000;
// En JSX estos caracteres abren una expresión o una etiqueta, y \ y ` rompen el literal que los contenga: el texto
// que los lleva necesita al agente, no un reemplazo.
const UNSAFE = /[{}<>\\`]/;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const toEntities = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const normalizeQuotes = (s: string): string => s.replace(/[‘’‚‹›]/g, "'").replace(/[“”„«»]/g, '"');
const stripTags = (s: string): string => s.replace(/<[^>]*>/g, '').trim();
const BR_OR_SPACE = '(?:\\s*<br\\s*/?>\\s*|\\s+)';

// Atributos y claves que llevan texto que se lee; cualquier otro string de un atributo o de una clave de objeto es
// código (clases, rutas, ids, variantes).
// HACK: un atributo de texto se asume `string` y se guarda sin tsc. Si un bloque tipa title o label como unión de
// literales, leer el tipo de la prop con el checker antes de saltarse el tsc.
const TEXT_ATTRS = new Set(['alt', 'title', 'placeholder', 'aria-label', 'aria-description', 'label']);
const CODE_KEYS = new Set(['className', 'class', 'href', 'src', 'id', 'key', 'to', 'slug', 'icon', 'variant', 'size', 'type', 'name', 'as', 'rel', 'target', 'tone', 'color', 'style']);

/** Un tramo del fuente donde vive texto visible; quote es la comilla del literal que lo contiene; textAttr, que es el
 * valor de un atributo JSX de TEXT_ATTRS. */
interface Span { start: number; end: number; quote: string | null; escapes: boolean; textAttr: boolean }

const keyName = (ts: Ts, n: Node): string | null =>
  ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : null;

function isVisibleString(ts: Ts, lit: Node): boolean {
  let parent = lit.parent;
  if (ts.isJsxExpression(parent)) parent = parent.parent;
  if (ts.isJsxAttribute(parent)) return TEXT_ATTRS.has(parent.name.getText());
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent) || ts.isLiteralTypeNode(parent)) return false;
  if (ts.isCallExpression(parent) && parent.expression.getText() === 'require') return false;
  if (ts.isPropertyAssignment(parent)) {
    if (parent.name === lit) return false;
    const key = keyName(ts, parent.name);
    return key === null || !CODE_KEYS.has(key);
  }
  if (ts.isElementAccessExpression(parent) || ts.isComputedPropertyName(parent)) return false;
  return true;
}

function visibleSpans(ts: Ts, path: string, source: string): Span[] {
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const spans: Span[] = [];
  const visit = (n: Node): void => {
    if (ts.isJsxText(n)) spans.push({ start: n.getStart(sf), end: n.getEnd(), quote: null, escapes: false, textAttr: false });
    else if (ts.isJsxSelfClosingElement(n) && n.tagName.getText(sf) === 'br') spans.push({ start: n.getStart(sf), end: n.getEnd(), quote: null, escapes: false, textAttr: false });
    else if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && isVisibleString(ts, n)) {
      const start = n.getStart(sf);
      // Un atributo JSX (title="...") no tiene escapes: ahí una comilla no se puede escapar, se rechaza.
      spans.push({ start: start + 1, end: n.getEnd() - 1, quote: source[start]!, escapes: !ts.isJsxAttribute(n.parent), textAttr: ts.isJsxAttribute(n.parent) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return spans.sort((a, z) => a.start - z.start);
}

/** El tramo que contiene la coincidencia entera; tramos JSX contiguos (texto y <br/>) cuentan como uno. */
function spanFor(spans: readonly Span[], from: number, to: number): Span | null {
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i]!;
    if (from < s.start || from >= s.end) continue;
    if (to <= s.end) return s;
    if (s.quote !== null) return null;
    let end = s.end;
    for (let j = i + 1; j < spans.length && spans[j]!.quote === null && spans[j]!.start <= end; j++) {
      end = Math.max(end, spans[j]!.end);
      if (to <= end) return s;
    }
    return null;
  }
  return null;
}

/** Dentro de un literal, la comilla y el salto de línea del texto nuevo no pueden cerrar el string. */
const forLiteral = (text: string, quote: string | null): string =>
  quote === null ? text : text.replace(/\r?\n/g, '\\n').split(quote).join(`\\${quote}`);

interface Candidate { strategy: TextEditStrategy; pattern: RegExp; replace: string }

/** Las estrategias de Mp como patrones, en su orden; las que Mp salta (sin cambio de forma) no se generan. */
function candidates(find: string, replace: string): Candidate[] {
  const out: Candidate[] = [{ strategy: 'exact', pattern: new RegExp(escapeRe(find), 'g'), replace }];
  const quoted = normalizeQuotes(find);
  if (quoted !== find) out.push({ strategy: 'quote-normalized', pattern: new RegExp(escapeRe(quoted), 'gi'), replace });
  const findEnt = toEntities(find);
  const replaceEnt = toEntities(replace);
  if (findEnt !== find) out.push({ strategy: 'html-entity', pattern: new RegExp(escapeRe(findEnt), 'g'), replace: replaceEnt });
  out.push({ strategy: 'case-insensitive', pattern: new RegExp(escapeRe(find), 'gi'), replace });
  if (findEnt !== find) out.push({ strategy: 'case-insensitive-entity', pattern: new RegExp(escapeRe(findEnt), 'gi'), replace: replaceEnt });
  const words = find.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    out.push({ strategy: 'br-tolerant', pattern: new RegExp(words.map(escapeRe).join(BR_OR_SPACE), 'gi'), replace });
    out.push({ strategy: 'br-tolerant-entity', pattern: new RegExp(words.map((w) => escapeRe(toEntities(w))).join(BR_OR_SPACE), 'gi'), replace: replaceEnt });
  }
  const stripped = stripTags(find);
  if (stripped && stripped !== find && stripped.length >= 3) out.push({ strategy: 'tag-stripped', pattern: new RegExp(escapeRe(stripped), 'gi'), replace: stripTags(replace) });
  return out;
}

interface Hit { path: string; source: string; index: number; length: number; span: Span }

function hitsIn(ts: Ts, files: Readonly<Record<string, string>>, pattern: RegExp): Hit[] {
  const out: Hit[] = [];
  for (const [path, source] of Object.entries(files)) {
    const matches = [...source.matchAll(pattern)];
    if (!matches.length) continue;
    const spans = visibleSpans(ts, path, source);
    for (const m of matches) {
      const span = spanFor(spans, m.index!, m.index! + m[0].length);
      // Pegado a una \ del fuente (la de \n) o con una dentro, el escape del texto nuevo se aparearía con ella y la
      // comilla cerraría el literal: 'Hola\nmundo' con nmundo -> '+alert(1)// compilaba.
      if (span && span.quote !== null && (source[m.index! - 1] === '\\' || m[0].includes('\\'))) continue;
      if (span) out.push({ path, source, index: m.index!, length: m[0].length, span });
    }
  }
  return out;
}

/** Reemplaza `find` por `replace` en el único archivo y lugar donde aparece. La primera estrategia que encuentra algo
 * decide: si encuentra más de una coincidencia no se baja a una más laxa, porque esa encontraría al menos las mismas. */
export function quickEditText(ts: Ts, files: Readonly<Record<string, string>>, find: string, replace: string): TextEditResult {
  if (!find.trim() || find.length > MAX_EDIT_CHARS || replace.length > MAX_EDIT_CHARS) return { ok: false, reason: 'invalid', message: `el texto va de 1 a ${MAX_EDIT_CHARS} caracteres` };
  if (!replace.trim()) return { ok: false, reason: 'invalid', message: 'el texto nuevo está vacío: para quitar el elemento usa Eliminar' };
  if (UNSAFE.test(replace)) return { ok: false, reason: 'unsafe', message: 'el texto nuevo lleva { } < > \\ o `, que en el código abren una expresión: usa Editar con IA' };
  for (const c of candidates(find, replace)) {
    const hits = hitsIn(ts, files, c.pattern);
    if (hits.length === 0) continue;
    if (hits.length > 1) return { ok: false, reason: 'ambiguous', message: `el texto aparece ${hits.length} veces en la página: usa Editar con IA para decir cuál` };
    const hit = hits[0]!;
    if (hit.span.quote !== null && !hit.span.escapes && (replace.includes(hit.span.quote) || /[\r\n]/.test(replace))) return { ok: false, reason: 'unsafe', message: 'el texto nuevo lleva la comilla del atributo o un salto de línea: usa Editar con IA' };
    return { ok: true, path: hit.path, source: hit.source.slice(0, hit.index) + forLiteral(c.replace, hit.span.quote) + hit.source.slice(hit.index + hit.length), strategy: c.strategy, typeSafe: hit.span.quote === null || hit.span.textAttr };
  }
  return { ok: false, reason: 'not-found', message: 'el texto no está escrito tal cual en el código (puede salir de datos o de un componente): usa Editar con IA' };
}
