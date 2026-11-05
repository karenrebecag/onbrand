// Agregar (duplicar), reordenar y eliminar una sección sin modelo (re-iteracion/bloques.md). Las cuatro herramientas
// del RE resuelven la estructura con un turno del agente, y el nuestro deja tres rastros que nadie limpia: el archivo
// huérfano (no tiene `rm`), el plan en el orden viejo, y los enlaces del menú a anclas que ya no
// existen o en otro orden. Aquí la operación es mecánica y completa: App.tsx, el archivo de la copia, slug, CSS module,
// plan y enlaces #ancla del navbar y del footer se reescriben juntos, para que el commit sea una sola versión coherente.
// Los módulos que ya existen no se renombran (ver `renamed`).

import { roleOfSlug } from '../section-slug';
import type { Suggestion } from './event-model';
import { LANDMARK_AFTER_MAIN, LANDMARK_BEFORE_MAIN } from './layout';

type Ts = typeof import('typescript');
type Node = import('typescript').Node;
type SourceFile = import('typescript').SourceFile;

export type SectionOp =
  | { op: 'move'; slug: string; to: 'up' | 'down' }
  | { op: 'remove'; slug: string }
  | { op: 'duplicate'; slug: string };

export type SectionOpResult =
  | { ok: true; writes: Record<string, string>; deletes: string[]; summary: string; notes: string[]; followUps: Suggestion[] }
  | { ok: false; reason: 'invalid' | 'unsafe' | 'not-found'; message: string };

export const APP_PATH = 'src/App.tsx';
export const PLAN_PATH = 'page-plan.md';
const SECTIONS_DIR = 'src/sections/';
export const SECTION_SLUG = /^\d{2}-[a-z0-9-]+$/;
// El boundary por sección del scaffold (templates/base-scaffold/src/wt-section.tsx); su `slug` sigue al archivo.
const WT_SECTION = 'WtSection';

interface Mounted { name: string; slug: string; inMain: boolean; line: string }
interface Slot { from: string; copy: boolean }
// El scaffold importa las secciones con una sola forma (`@/sections/` o `./sections/`, comilla simple o doble);
// la reescritura por texto de App.tsx la reproduce en vez de fijar una.
interface ImportStyle { prefix: string; quote: string }

const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const fail = (reason: 'invalid' | 'unsafe' | 'not-found', message: string): SectionOpResult => ({ ok: false, reason, message });
const roleOf = roleOfSlug;
const tsxOf = (slug: string): string => `${SECTIONS_DIR}${slug}.tsx`;
const cssOf = (slug: string): string => `${SECTIONS_DIR}${slug}.module.css`;
const parse = (ts: Ts, path: string, source: string): SourceFile => ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function walk(ts: Ts, n: Node, visit: (n: Node) => void): void {
  visit(n);
  ts.forEachChild(n, (c) => walk(ts, c, visit));
}

/** Las secciones que monta App.tsx, en el orden de la página. Solo las de `<main>` se mueven: navbar y footer van fuera. */
function mounted(ts: Ts, app: string): { list: Mounted[]; imports: Map<string, string>; style: ImportStyle } | string {
  const sf = parse(ts, APP_PATH, app);
  const imports = new Map<string, string>();
  let style: ImportStyle | undefined;
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const m = /^(\.\/|@\/)sections\/(.+)$/.exec(st.moduleSpecifier.text);
    const name = st.importClause?.name?.text;
    if (!m || !name || !SECTION_SLUG.test(m[2]!)) continue;
    // El agente escribe `@/sections/` con comillas dobles o `./sections/` con simples; se captura la forma para reusarla.
    const here: ImportStyle = { prefix: m[1]!, quote: st.moduleSpecifier.getText(sf)[0]! };
    if (style && (style.prefix !== here.prefix || style.quote !== here.quote)) return 'App.tsx mezcla formas de import de sección: usa Editar con IA';
    style = here;
    imports.set(name, m[2]!);
  }
  const list: Mounted[] = [];
  let mainOk = true;
  const isSection = (c: Node): boolean => ts.isJsxSelfClosingElement(c) && imports.has(c.tagName.getText(sf));
  // `<WtSection slug="…"><Hero /></WtSection>` en una sola línea es la sección con su boundary: la línea se mueve entera.
  const wrapped = (c: Node): boolean => {
    if (!ts.isJsxElement(c) || c.openingElement.tagName.getText(sf) !== WT_SECTION) return false;
    const inner = c.children.filter((k) => !(ts.isJsxText(k) && k.text.trim() === ''));
    const oneLine = !app.slice(c.getStart(sf), c.getEnd()).includes('\n');
    return oneLine && inner.length === 1 && isSection(inner[0]!);
  };
  const isMain = (p: Node | undefined): boolean => !!p && ts.isJsxElement(p) && p.openingElement.tagName.getText(sf) === 'main';
  walk(ts, sf, (n) => {
    // <main> se reescribe con solo las líneas de sección: cualquier otro hijo (un divisor, un comentario) se perdería.
    if (isMain(n)) {
      const other = (n as import('typescript').JsxElement).children.some((c) => ts.isJsxText(c) ? c.text.trim() !== '' : !(isSection(c) || wrapped(c)));
      if (other) mainOk = false;
    }
    if (!ts.isJsxSelfClosingElement(n)) return;
    const slug = imports.get(n.tagName.getText(sf));
    if (!slug) return;
    let p: Node | undefined = n.parent;
    let inMain = false;
    while (p) {
      if (isMain(p)) { inMain = true; break; }
      p = p.parent;
    }
    const holder = wrapped(n.parent) ? n.parent : n;
    // Una sección dentro de un condicional o de otro elemento no tiene una línea propia que mover.
    if (inMain && !isMain(holder.parent)) mainOk = false;
    const start = app.lastIndexOf('\n', holder.getStart(sf) - 1) + 1;
    const nl = app.indexOf('\n', holder.getEnd());
    list.push({ name: n.tagName.getText(sf), slug, inMain, line: app.slice(start, nl === -1 ? app.length : nl) });
  });
  if (!mainOk) return 'App.tsx tiene en <main> algo que no es una sección propia: usa Editar con IA';
  if (new Set(list.map((m) => m.slug)).size !== list.length) return 'App.tsx monta la misma sección dos veces: usa Editar con IA';
  return { list, imports, style: style ?? { prefix: './', quote: "'" } };
}

/** Los `id="..."` literales de un archivo de sección: las anclas a las que puede apuntar un `#` del menú. */
function anchorsOf(ts: Ts, path: string, source: string): string[] {
  const sf = parse(ts, path, source);
  const out: string[] = [];
  walk(ts, sf, (n) => {
    if (!ts.isJsxAttribute(n) || n.name.getText(sf) !== 'id' || !n.initializer) return;
    if (ts.isStringLiteral(n.initializer)) out.push(n.initializer.text);
  });
  return out;
}

/** Cambia el `id` raíz de una sección duplicada: dos anclas iguales harían que el menú salte siempre a la primera. */
function renameAnchor(ts: Ts, path: string, source: string, from: string, to: string): string {
  const sf = parse(ts, path, source);
  let at = -1;
  walk(ts, sf, (n) => {
    if (at < 0 && ts.isJsxAttribute(n) && n.name.getText(sf) === 'id' && n.initializer && ts.isStringLiteral(n.initializer) && n.initializer.text === from) at = n.initializer.getStart(sf);
  });
  return at < 0 ? source : `${source.slice(0, at)}"${to}"${source.slice(at + from.length + 2)}`;
}

/** Elementos de arrays de enlaces `{ ..., href: '#x' }`: así declaran el menú el navbar y el footer del DS. */
function linkItems(ts: Ts, sf: SourceFile): { array: import('typescript').ArrayLiteralExpression; items: { el: Node; anchor: string | null }[] }[] {
  const out: { array: import('typescript').ArrayLiteralExpression; items: { el: Node; anchor: string | null }[] }[] = [];
  walk(ts, sf, (n) => {
    if (!ts.isArrayLiteralExpression(n) || !n.elements.length) return;
    const items = n.elements.map((el) => {
      if (!ts.isObjectLiteralExpression(el)) return null;
      const href = el.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === 'href');
      if (!href || !ts.isPropertyAssignment(href)) return null;
      const v = href.initializer;
      const text = ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v) ? v.text : null;
      return { el: el as Node, anchor: text !== null && text.startsWith('#') ? text.slice(1) : null };
    });
    if (items.every((i) => i !== null)) out.push({ array: n, items: items as { el: Node; anchor: string | null }[] });
  });
  return out;
}

/** Quita del texto un elemento de array con su coma, sin dejar una línea vacía. */
function removeElement(source: string, sf: SourceFile, array: import('typescript').ArrayLiteralExpression, el: Node): string {
  const els = array.elements;
  const i = els.indexOf(el as import('typescript').Expression);
  const last = i === els.length - 1;
  let start = last && i > 0 ? els[i - 1]!.getEnd() : el.getStart(sf);
  let end = last ? el.getEnd() : els[i + 1]!.getStart(sf);
  if (!last) {
    const lineStart = source.lastIndexOf('\n', start - 1) + 1;
    if (!source.slice(lineStart, start).trim()) start = lineStart;
    const nextLine = source.lastIndexOf('\n', end - 1) + 1;
    if (!source.slice(nextLine, end).trim()) end = nextLine;
  } else if (i === 0) {
    end = array.elements.hasTrailingComma ? source.indexOf(',', end) + 1 : end;
  }
  return source.slice(0, start) + source.slice(end);
}

/** Enlaces del menú: los que apuntan a un ancla borrada se van; los que apuntan a secciones se reordenan como la página
 * (los demás, p. ej. "Términos" → #pie, quedan en su lugar). */
function fixLinks(ts: Ts, path: string, source: string, removed: Set<string>, order: string[]): { source: string; removed: number; reordered: boolean } {
  let out = source;
  let removedCount = 0;
  for (;;) {
    const sf = parse(ts, path, out);
    const hit = linkItems(ts, sf).flatMap((g) => g.items.filter((it) => it.anchor && removed.has(it.anchor)).map((it) => ({ g, it })))[0];
    if (!hit) break;
    out = removeElement(out, sf, hit.g.array, hit.it.el);
    removedCount++;
  }
  const rank = new Map(order.map((a, i) => [a, i]));
  let reordered = false;
  const sf = parse(ts, path, out);
  const edits: { start: number; end: number; text: string }[] = [];
  for (const g of linkItems(ts, sf)) {
    const slots = g.items.map((it, i) => ({ it, i })).filter(({ it }) => it.anchor !== null && rank.has(it.anchor));
    if (slots.length < 2) continue;
    const sorted = [...slots].sort((a, z) => rank.get(a.it.anchor!)! - rank.get(z.it.anchor!)!);
    if (sorted.every((s, k) => s.i === slots[k]!.i)) continue;
    reordered = true;
    slots.forEach((s, k) => edits.push({ start: s.it.el.getStart(sf), end: s.it.el.getEnd(), text: sorted[k]!.it.el.getText(sf) }));
  }
  for (const e of edits.sort((a, z) => z.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return { source: out, removed: removedCount, reordered };
}

/** Bloques `## <slug> · #ancla` del plan: se reordenan, se copian y se borran con las secciones. */
function rewritePlan(plan: string, slots: Slot[], renamed: Map<Slot, string>, copyAnchor: { from: string; to: string } | null, dropped: string | null): { plan: string; missing: string[] } {
  const parts = plan.split(/^(?=## )/m);
  const head = parts[0]!.startsWith('## ') ? '' : parts.shift()!;
  const bySlug = new Map<string, string>();
  for (const b of parts) {
    const m = /^## (\S+)/.exec(b);
    if (m) bySlug.set(m[1]!, b);
  }
  const missing: string[] = [];
  const blocks: string[] = [];
  for (const s of slots) {
    let b = bySlug.get(s.from);
    if (!b) { missing.push(s.from); continue; }
    b = b.replace(/^## \S+/, `## ${renamed.get(s)}`);
    if (s.copy && copyAnchor) b = b.replace(new RegExp(`^(## \\S+ · )#${copyAnchor.from.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?![\\w-])`), `$1#${copyAnchor.to}`);
    blocks.push(b);
  }
  // Entradas del plan sin sección montada (deriva del agente): se dejan al final, no se pierden.
  const used = new Set(slots.map((s) => s.from));
  for (const [slug, b] of bySlug) if (!used.has(slug) && slug !== dropped) blocks.push(b);
  return { plan: `${head}${blocks.map((b) => `${b.trimEnd()}\n`).join('\n')}`, missing };
}

function uniqueName(base: string, taken: Set<string>): string {
  for (let i = 2; ; i++) if (!taken.has(`${base}${i}`)) return `${base}${i}`;
}

export function sectionOp(ts: Ts, files: Readonly<Record<string, string>>, op: SectionOp): SectionOpResult {
  if (!SECTION_SLUG.test(op.slug)) return fail('invalid', `slug inválido "${op.slug}"`);
  const app = files[APP_PATH];
  if (app === undefined) return fail('not-found', 'la página no tiene src/App.tsx');
  const parsed = mounted(ts, app);
  if (typeof parsed === 'string') return fail('unsafe', parsed);
  const { list, imports, style } = parsed;
  const target = list.find((m) => m.slug === op.slug);
  if (!target) return fail('not-found', `la sección ${op.slug} no está montada en App.tsx`);
  if (!target.inMain) return fail('unsafe', `${op.slug} va fuera de <main> (navbar o footer): usa Editar con IA`);
  if (files[tsxOf(op.slug)] === undefined) return fail('not-found', `no existe ${tsxOf(op.slug)}`);

  const main = list.filter((m) => m.inMain);
  const at = main.indexOf(target);
  if (op.op === 'move') {
    const to = op.to === 'up' ? at - 1 : at + 1;
    if (to < 0 || to >= main.length) return fail('invalid', `${op.slug} ya es la ${op.to === 'up' ? 'primera' : 'última'} sección`);
  }

  // Orden nuevo de toda la página (navbar y footer incluidos, para numerar todo de corrido).
  const slots: Slot[] = list.map((m) => ({ from: m.slug, copy: false }));
  const idx = list.indexOf(target);
  if (op.op === 'remove') slots.splice(idx, 1);
  if (op.op === 'duplicate') slots.splice(idx + 1, 0, { from: op.slug, copy: true });
  if (op.op === 'move') {
    const swapWith = list.indexOf(main[op.to === 'up' ? at - 1 : at + 1]!);
    [slots[idx], slots[swapWith]] = [slots[swapWith]!, slots[idx]!];
  }
  // Ninguna op renombra lo que ya existe: el slug es la identidad del módulo y el orden vive en App.tsx, el menú y el plan.
  // Puck reordena por índice sin tocar el id (core/reducer/actions/reorder.ts:7-23 -> move.ts:48-56) y v0 mueve el nodo
  // tal cual (v0-runtime webcrack l.22726, insertBefore). Renumerar al duplicar o quitar renombraba hasta 8 archivos: vite
  // recargaba la página entera y llegaban "[vite] Failed to reload /src/sections/0N-…" falsos al builder (QA unidad 3).
  // La copia toma `<slug>-N` libre: queda junto a su origen en el árbol sin mover a nadie.
  const base = op.slug.replace(/-\d+$/, '');
  let n = 2;
  while (files[tsxOf(`${base}-${n}`)] !== undefined) n++;
  const copySlug = `${base}-${n}`;
  const renamed = new Map<Slot, string>(slots.map((s) => [s, s.copy ? copySlug : s.from]));

  const writes: Record<string, string> = {};
  const deletes = new Set<string>();
  const notes: string[] = [];
  // El arreglo que la operación no pudo hacer sola, escrito como el pedido que la persona mandaría (chip de Lovable).
  const followUps: Suggestion[] = [];

  // Archivos de sección: renombrar (con su CSS module, slug e import del CSS) o copiar.
  const taken = new Set(imports.keys());
  const copyName = op.op === 'duplicate' ? uniqueName(target.name, taken) : null;
  const srcAnchors = anchorsOf(ts, tsxOf(op.slug), files[tsxOf(op.slug)]!);
  const copyAnchor = op.op === 'duplicate' && srcAnchors[0] ? { from: srcAnchors[0], to: `${srcAnchors[0].replace(/-\d+$/, '')}-${n}` } : null;
  for (const s of slots) {
    const next = renamed.get(s)!;
    if (!s.copy && next === s.from) continue;
    let tsx = files[tsxOf(s.from)];
    if (tsx === undefined) return fail('not-found', `no existe ${tsxOf(s.from)}`);
    tsx = tsx.split(`'./${s.from}.module.css'`).join(`'./${next}.module.css'`).split(`"./${s.from}.module.css"`).join(`"./${next}.module.css"`);
    tsx = tsx.replace(new RegExp(`(slug|data-wt-slug)=(["'])${s.from}\\2`, 'g'), `$1=$2${next}$2`);
    if (s.copy && copyAnchor) tsx = renameAnchor(ts, tsxOf(next), tsx, copyAnchor.from, copyAnchor.to);
    writes[tsxOf(next)] = tsx;
    const css = files[cssOf(s.from)];
    if (css !== undefined) writes[cssOf(next)] = css;
    if (!s.copy) {
      deletes.add(tsxOf(s.from));
      if (css !== undefined) deletes.add(cssOf(s.from));
    }
  }
  if (op.op === 'remove') {
    deletes.add(tsxOf(op.slug));
    if (files[cssOf(op.slug)] !== undefined) deletes.add(cssOf(op.slug));
  }

  // App.tsx: imports con la ruta nueva y las líneas de <main> en el orden nuevo, con la forma de import del scaffold.
  const { prefix, quote } = style;
  const path = (slug: string): string => `${quote}${prefix}sections/${slug}${quote}`;
  const tmp = (slug: string): string => `${quote}${prefix}sections/__${slug}${quote}`;
  let nextApp = app;
  for (const m of list) {
    const s = slots.find((x) => !x.copy && x.from === m.slug);
    const spec = path(m.slug);
    if (!s) {
      nextApp = nextApp.replace(new RegExp(`^import ${m.name} from ${escRe(spec)};?\\n`, 'm'), '');
      continue;
    }
    nextApp = nextApp.split(spec).join(tmp(renamed.get(s)!));
  }
  if (copyName) {
    const copy = slots.find((s) => s.copy)!;
    const srcLine = new RegExp(`^import ${target.name} from ${escRe(quote)}${escRe(prefix)}sections/__[^${escRe(quote)}]+${escRe(quote)};?\\n`, 'm');
    nextApp = nextApp.replace(srcLine, (l) => `${l}import ${copyName} from ${tmp(renamed.get(copy)!)};\n`);
  }
  nextApp = nextApp.split(`${quote}${prefix}sections/__`).join(`${quote}${prefix}sections/`);
  const mainLines = main.map((m) => m.line);
  const first = nextApp.indexOf(mainLines[0]!);
  const lastLine = mainLines[mainLines.length - 1]!;
  const last = nextApp.indexOf(lastLine, first) + lastLine.length;
  if (first < 0 || last < lastLine.length) return fail('unsafe', 'no pude ubicar las secciones de <main> en App.tsx: usa Editar con IA');
  const lineOf = new Map(main.map((m) => [m.slug, m.line]));
  // El slug del boundary nombra el archivo en el error de preview.runtime: renumerar el archivo y no el boundary
  // atribuiría el error a otra sección.
  const retag = (line: string, s: Slot): string => line.replace(new RegExp(`(<${WT_SECTION}\\s+slug=)(["'])${escRe(s.from)}\\2`), `$1$2${renamed.get(s)!}$2`);
  const newMain = slots
    .filter((s) => lineOf.has(s.from))
    .map((s) => retag(s.copy ? lineOf.get(s.from)!.replace(`<${target.name}`, `<${copyName}`) : lineOf.get(s.from)!, s));
  nextApp = nextApp.slice(0, first) + newMain.join('\n') + nextApp.slice(last);
  for (const m of list.filter((x) => !x.inMain)) {
    const s = slots.find((x) => !x.copy && x.from === m.slug);
    if (s) nextApp = nextApp.replace(m.line, retag(m.line, s));
  }
  writes[APP_PATH] = nextApp;

  // Menú: enlaces a anclas borradas fuera; enlaces a secciones en el orden de la página.
  const removedAnchors = new Set(op.op === 'remove' ? srcAnchors : []);
  const anchorOrder = slots.flatMap((s) => (s.copy ? [] : anchorsOf(ts, tsxOf(s.from), files[tsxOf(s.from)] ?? '')));
  for (const [path, source] of Object.entries({ ...files, ...writes })) {
    if (!path.startsWith(SECTIONS_DIR) || !path.endsWith('.tsx') || deletes.has(path) && !writes[path]) continue;
    const fixed = fixLinks(ts, path, writes[path] ?? source, removedAnchors, anchorOrder);
    if (fixed.source === (writes[path] ?? source)) continue;
    writes[path] = fixed.source;
    if (fixed.removed) notes.push(`${path}: quité ${fixed.removed} enlace(s) a #${[...removedAnchors].join(', #')}`);
    if (fixed.reordered) notes.push(`${path}: reordené el menú como la página`);
  }
  // Un `href="#x"` escrito en JSX no es un item de menú que se pueda quitar sin romper el marcado: se avisa.
  for (const [path, source] of Object.entries({ ...files, ...writes })) {
    if (!path.endsWith('.tsx') || (deletes.has(path) && !writes[path])) continue;
    for (const a of removedAnchors) if ((writes[path] ?? source).includes(`"#${a}"`) || (writes[path] ?? source).includes(`'#${a}'`)) {
      notes.push(`${path} todavía enlaza a #${a}: revísalo con Editar con IA`);
      followUps.push({ title: `Arreglar el enlace a #${a}`, message: `Quita o redirige el enlace a #${a} en ${path}: esa sección ya no existe` });
    }
  }

  const plan = files[PLAN_PATH];
  if (plan !== undefined) {
    const r = rewritePlan(plan, slots, renamed, copyAnchor, op.op === 'remove' ? op.slug : null);
    if (r.plan !== plan) writes[PLAN_PATH] = r.plan;
    if (r.missing.length) notes.push(`el plan no tenía entrada para ${r.missing.join(', ')}`);
  }

  for (const p of Object.keys(writes)) deletes.delete(p);
  const summary = op.op === 'move' ? `${op.slug} ${op.to === 'up' ? 'sube' : 'baja'} una posición`
    : op.op === 'remove' ? `${op.slug} eliminada`
      : `${op.slug} duplicada`;
  return { ok: true, writes, deletes: [...deletes].sort(), summary, notes, followUps };
}

export type ApplyStep = { op: 'write' | 'delete'; path: string };

/** Orden en disco de una operación: lo nuevo primero, App después y lo borrado al final. Un App que importa un archivo
 * que todavía no existe o que ya se borró queda en la lista de resolución fallida de vite (8.3.4
 * dist/node/chunks/node.js:26630-26631) y el siguiente archivo dispara un full-reload del preview (:25505,
 * :25604-25636). Una ruta que se borra y se reescribe (quitar 03-casos renumera 04-casos a 03-casos) no se borra. */
export function applyOrder(writes: Readonly<Record<string, string>>, deletes: readonly string[]): ApplyStep[] {
  const paths = Object.keys(writes);
  return [
    ...paths.filter((p) => p !== APP_PATH).map((path) => ({ op: 'write' as const, path })),
    ...paths.filter((p) => p === APP_PATH).map((path) => ({ op: 'write' as const, path })),
    ...deletes.filter((p) => !(p in writes)).map((path) => ({ op: 'delete' as const, path })),
  ];
}

const pascal = (role: string): string => role.split('-').filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join('') || 'Section';

/** El orden de la página según `page-plan.md`: los slugs de sus encabezados `## NN-<rol> · #<ancla>`. */
export function planOrder(plan: string | undefined): string[] {
  return [...(plan ?? '').matchAll(/^## (\d{2}-[a-z0-9-]+)\b/gm)].map((m) => m[1]!);
}

/** App.tsx del T1 que monta el sistema (P1, arnes/48de1230-arq.md): en dos T1 el agente no escribió App una línea por
 * sección y las secciones montaron juntas al final. Solo importa archivos que ya existen, así que nunca deja a vite en
 * resolución fallida (8.3.4 node.js:26630-26631) y cada sección entra por HMR. Orden: el del plan, que el agente escribe
 * antes que las secciones y que sectionOp mantiene; lo que no está en el plan va al final de <main> por nombre. navbar y
 * footer, fuera de <main>, como el App de la ruta JSON (runner.ts renderPage). */
export function appFor(slugs: readonly string[], plan?: string): string {
  const present = new Set(slugs.filter((s) => SECTION_SLUG.test(s)));
  const order = planOrder(plan).filter((s) => present.has(s));
  const ordered = [...new Set([...order, ...[...present].filter((s) => !order.includes(s)).sort()])];
  const taken = new Set<string>(['App', WT_SECTION]);
  const named = ordered.map((slug) => {
    let name = pascal(roleOf(slug));
    for (let i = 2; taken.has(name); i += 1) name = `${pascal(roleOf(slug))}${i}`;
    taken.add(name);
    return { slug, name };
  });
  const line = (n: { slug: string; name: string }, pad: string): string => `${pad}<${WT_SECTION} slug="${n.slug}"><${n.name} /></${WT_SECTION}>`;
  const before = named.filter((n) => LANDMARK_BEFORE_MAIN.has(roleOf(n.slug)));
  const after = named.filter((n) => LANDMARK_AFTER_MAIN.has(roleOf(n.slug)));
  const inside = named.filter((n) => !before.includes(n) && !after.includes(n));
  return [
    `import { ${WT_SECTION} } from '@/wt-section';`,
    ...named.map((n) => `import ${n.name} from './sections/${n.slug}';`),
    '',
    'export default function App() {',
    '  return (',
    '    <>',
    ...before.map((n) => line(n, '      ')),
    '      <main>',
    ...inside.map((n) => line(n, '        ')),
    '      </main>',
    ...after.map((n) => line(n, '      ')),
    '    </>',
    '  );',
    '}',
    '',
  ].join('\n');
}
