// Delete de Stitch sobre el código de la página (re-iteracion/stitch-ui/static-editor.md §2.5): Stitch busca el elemento
// por su selector, lo quita del DOM (`remove_element`) y guarda el HTML entero. Aquí la página es TSX, así que el
// elemento se ubica en el árbol de TypeScript por lo que el DOM sí comparte con el código: el texto de un elemento hoja
// o el src de una imagen. Igual que en Edit Text, solo con una coincidencia única en todos los archivos.

type Ts = typeof import('typescript');
type Node = import('typescript').Node;
type SourceFile = import('typescript').SourceFile;

export type DeleteTarget = { kind: 'text'; text: string } | { kind: 'image'; src: string };

export type DeleteResult =
  | { ok: true; path: string; source: string; tag: string }
  | { ok: false; reason: 'invalid' | 'unsafe' | 'not-found' | 'ambiguous'; message: string };

const MAX_TARGET_CHARS = 2000;
const plain = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** El src del DOM es absoluto (currentSrc); en el código suele ser la ruta de public/. */
export function sameSrc(code: string, dom: string): boolean {
  if (code === dom) return true;
  try {
    const url = new URL(dom);
    return code.startsWith('/') && decodeURIComponent(url.pathname) === decodeURIComponent(code);
  } catch {
    return false;
  }
}

export function stringValue(ts: Ts, init: Node | undefined): string | null {
  if (!init) return null;
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init) && init.expression && (ts.isStringLiteral(init.expression) || ts.isNoSubstitutionTemplateLiteral(init.expression))) return init.expression.text;
  return null;
}

function tagNameOf(ts: Ts, el: Node): string {
  const open = ts.isJsxElement(el) ? el.openingElement : (el as import('typescript').JsxSelfClosingElement);
  return open.tagName.getText();
}

/** Los elementos JSX de un archivo que el DOM describe. Texto: un elemento cuyo único contenido es ese texto. */
function matches(ts: Ts, sf: SourceFile, target: DeleteTarget): Node[] {
  const out: Node[] = [];
  const visit = (n: Node): void => {
    if (target.kind === 'text' && ts.isJsxText(n) && plain(n.text) === plain(target.text)) {
      const el = n.parent;
      const onlyText = ts.isJsxElement(el) && el.children.every((c) => c === n || (ts.isJsxText(c) && !c.text.trim()));
      if (onlyText) out.push(el);
    }
    if (target.kind === 'image' && (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n))) {
      const src = n.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === 'src');
      const value = src && ts.isJsxAttribute(src) ? stringValue(ts, src.initializer) : null;
      if (value !== null && sameSrc(value, target.src)) out.push(ts.isJsxOpeningElement(n) ? n.parent : n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Quita [start, end) y, si la línea queda vacía, la línea entera: que el archivo no quede con huecos. */
function cut(source: string, start: number, end: number): string {
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  const nl = source.indexOf('\n', end);
  const lineEnd = nl === -1 ? source.length : nl;
  const blankBefore = !source.slice(lineStart, start).trim();
  const blankAfter = !source.slice(end, lineEnd).trim();
  if (blankBefore && blankAfter) return source.slice(0, lineStart) + source.slice(nl === -1 ? lineEnd : lineEnd + 1);
  return source.slice(0, start) + source.slice(end);
}

/** Con noUnusedLocals el scaffold no compila si queda un import sin uso: si el componente borrado era el último uso,
 * su import se va con él. */
function dropUnusedImport(ts: Ts, path: string, source: string, name: string): string {
  if (!/^[A-Z]/.test(name)) return source;
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let used = false;
  let spec: import('typescript').ImportSpecifier | undefined;
  let clause: import('typescript').ImportDeclaration | undefined;
  const visit = (n: Node): void => {
    if (ts.isImportSpecifier(n) && n.name.text === name) spec = n;
    // Un @import de JSDoc también tiene ImportClause; solo un import real se puede quitar.
    else if (ts.isImportClause(n) && n.name?.text === name && ts.isImportDeclaration(n.parent)) clause = n.parent;
    else if (ts.isIdentifier(n) && n.text === name && !ts.isImportSpecifier(n.parent) && !ts.isImportClause(n.parent)) used = true;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (used) return source;
  if (clause && !clause.importClause?.namedBindings) return cut(source, clause.getStart(sf), clause.getEnd());
  if (!spec) return source;
  const named = spec.parent;
  if (named.elements.length === 1) {
    const decl = named.parent.parent;
    return decl.importClause?.name ? source : cut(source, decl.getStart(sf), decl.getEnd());
  }
  const i = named.elements.indexOf(spec);
  const end = i < named.elements.length - 1 ? named.elements[i + 1]!.getStart(sf) : spec.getEnd();
  const start = i < named.elements.length - 1 ? spec.getStart(sf) : named.elements[i - 1]!.getEnd();
  return source.slice(0, start) + source.slice(end);
}

export function deleteElement(ts: Ts, files: Readonly<Record<string, string>>, target: DeleteTarget): DeleteResult {
  const key = target.kind === 'text' ? target.text : target.src;
  if (!plain(key) || key.length > MAX_TARGET_CHARS) return { ok: false, reason: 'invalid', message: `el elemento se identifica con 1 a ${MAX_TARGET_CHARS} caracteres` };
  const found = Object.entries(files).flatMap(([path, source]) => {
    const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    return matches(ts, sf, target).map((el) => ({ path, source, sf, el }));
  });
  if (found.length === 0) return { ok: false, reason: 'not-found', message: 'el elemento no está escrito tal cual en el código (puede salir de datos o de un componente): usa Editar con IA' };
  if (found.length > 1) return { ok: false, reason: 'ambiguous', message: `hay ${found.length} elementos iguales en la página: usa Editar con IA para decir cuál` };
  const { path, source, sf, el } = found[0]!;
  // Fuera de un padre JSX (la raíz de un return, un `cond && <x/>`) quitarlo deja una expresión vacía.
  if (!ts.isJsxElement(el.parent) && !ts.isJsxFragment(el.parent)) return { ok: false, reason: 'unsafe', message: 'el elemento es la raíz de su bloque: quitarlo rompe el componente; usa Editar con IA' };
  const tag = tagNameOf(ts, el);
  const removed = cut(source, el.getStart(sf), el.getEnd());
  return { ok: true, path, source: dropUnusedImport(ts, path, removed, tag.split('.')[0]!), tag };
}
