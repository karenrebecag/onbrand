// Contrato de bloque (ADR 0009). Un port conserva su maquetación, pero cuatro cosas que en v0 decide la
// página dejan de ser constantes del bloque: columnas de una colección (salen de sus datos), alineación de
// la cabecera (data-wt-align), alcance del tema oscuro (cualquier ancestro, no solo :root) y, más
// adelante, el reveal. Es un pase sobre tsx+css ya portados: se aplica a los ports revisados a mano sin
// re-portarlos, y el porter lo corre al final para los nuevos. Idempotente.

export interface BlockContractResult {
  tsx: string;
  css: string;
  /** Contenedores de colección convertidos: grupo del .module.css y expresión del array que itera. */
  collections: { group: string; items: string; nested: boolean }[];
  /** Grupos cuya alineación pasa a venir del contrato de página. */
  headerGroups: string[];
}

export interface BlockContractOptions {
  /** Ruta del helper de columnas desde el .tsx del port (relume/<categoria>/<slug>/). */
  collectionImport?: string;
}

// Relume abre columnas desde sm (480px) en algunos layouts; todo lo que no es escritorio es tier md.
const MD_MIN = 480;
const LG_MEDIA = '(min-width: 992px)';

const COLLECTION_RE = /<([A-Za-z][\w.]*) className=\{styles\.(\w+)\}>(\s*)\{([\w.]+)\.map\(/g;

/** Una fila de botones o una lista vertical también iteran; colección es solo la que el original
 * reparte en columnas fijas a partir de tablet. */
const isGridCollection = (css: string, group: string): boolean =>
  cssBlocks(css).some((b) => b.selector === `.${group}` && (minWidth(b.media) ?? 0) >= MD_MIN && (FIXED_REPEAT.test(b.body) || /var\(--cols-/.test(b.body)));

/** Una colección dentro de una columna de un layout partido (cabecera a un lado, items al otro) no
 * tiene el ancho de la sección: en escritorio conserva el tope del original. */
const isNested = (tsx: string, at: number, css: string): boolean =>
  openGroups(tsx, at).some((g) => g !== undefined && cssBlocks(css).some((b) => b.selector === `.${g}` && (minWidth(b.media) ?? 0) >= MD_MIN && hasSeveralTracks(b.body)));

/** `repeat(2, …)`, `repeat(var(--cols-…))` o pistas sueltas como `0.5fr 1fr`. */
function hasSeveralTracks(body: string): boolean {
  const value = /grid-template-columns:\s*([^;]+);/.exec(body)?.[1].trim();
  if (!value) return false;
  if (value.startsWith('repeat(')) return !/^repeat\(1,/.test(value);
  return value.split(/\s+(?![^(]*\))/).length >= 2;
}

function convertCollectionsTsx(tsx: string, css: string, importPath: string): { tsx: string; collections: BlockContractResult['collections'] } {
  const collections: BlockContractResult['collections'] = [];
  let out = tsx.replace(COLLECTION_RE, (whole, tag: string, group: string, ws: string, items: string, offset: number) => {
    if (!isGridCollection(css, group)) return whole;
    collections.push({ group, items, nested: isNested(tsx, offset, css) });
    return `<${tag} className={styles.${group}} style={collectionStyle(${items}.length)}>${ws}{${items}.map(`;
  });
  for (const m of tsx.matchAll(/className=\{styles\.(\w+)\} style=\{collectionStyle\(([\w.]+)\.length(?:, "compact")?\)\}/g)) collections.push({ group: m[1], items: m[2], nested: isNested(tsx, m.index ?? 0, css) });
  // Una colección de logos es de items chicos y lleva el tope compacto (COMPACT_MAX en collection.ts).
  out = out.replace(/collectionStyle\(([\w.]*logos)\.length\)/gi, 'collectionStyle($1.length, "compact")');
  if (collections.length && !out.includes('collectionStyle } from')) {
    out = out.replace(/^(import styles from [^\n]+\n)/m, `$1import { collectionStyle } from "${importPath}";\n`);
  }
  return { tsx: out, collections };
}

interface CssBlock { start: number; end: number; media?: string; selector: string; body: string }

/** Bloques de primer nivel y los de dentro de @media, con sus posiciones. Los .module.css del porter no
 * anidan más que @media > regla, así que basta con contar llaves. */
function cssBlocks(css: string): CssBlock[] {
  const blocks: CssBlock[] = [];
  const re = /(@media[^{]+|[^{}@]+)\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const head = m[1].trim();
    if (head.startsWith('@media')) {
      const media = head.slice('@media'.length).trim();
      let depth = 1;
      let i = re.lastIndex;
      while (depth && i < css.length) depth += css[i] === '{' ? 1 : css[i] === '}' ? -1 : 0, i += 1;
      const inner = css.slice(re.lastIndex, i - 1);
      for (const b of cssBlocks(inner)) blocks.push({ ...b, start: b.start + re.lastIndex, end: b.end + re.lastIndex, media });
      re.lastIndex = i;
      continue;
    }
    const close = css.indexOf('}', re.lastIndex);
    blocks.push({ start: m.index, end: close + 1, selector: head.replace(/^[\s\S]*\*\/\s*/, ''), body: css.slice(re.lastIndex, close) });
    re.lastIndex = close + 1;
  }
  return blocks;
}

const minWidth = (media?: string): number | undefined => {
  const m = /min-width:\s*(\d+)px/.exec(media ?? '');
  return m ? Number(m[1]) : undefined;
};

const FIXED_REPEAT = /grid-template-columns:\s*repeat\((\d+),\s*minmax\(0,\s*1fr\)\);/;

function convertCollectionsCss(css: string, collections: BlockContractResult['collections']): string {
  let out = css;
  for (const { group, nested } of collections) {
    const own = cssBlocks(out).filter((b) => b.selector === `.${group}`);
    let lastFixed: number | undefined;
    let hasLg = own.some((b) => (minWidth(b.media) ?? 0) >= 992 && /var\(--cols-lg/.test(b.body));
    // De atrás hacia adelante para no mover posiciones aún sin reescribir.
    for (const b of [...own].reverse()) {
      const w = minWidth(b.media);
      const fixed = FIXED_REPEAT.exec(b.body);
      if (!w || w < MD_MIN || !fixed) continue;
      const tier = w >= 992 ? 'lg' : 'md';
      if (tier === 'lg') hasLg = true;
      lastFixed ??= Number(fixed[1]);
      const body = b.body.replace(FIXED_REPEAT, `grid-template-columns: repeat(var(--cols-${tier}, ${fixed[1]}), minmax(0, 1fr));`);
      out = out.slice(0, b.start) + out.slice(b.start, b.end).replace(b.body, body) + out.slice(b.end);
    }
    if (!nested && !hasLg && lastFixed !== undefined) {
      const md = cssBlocks(out).filter((b) => b.selector === `.${group}` && b.media).at(-1);
      const mediaEnd = md ? out.indexOf('}', md.end) + 1 : out.length;
      const lg = `\n\n@media ${LG_MEDIA} {\n  .${group} {\n    grid-template-columns: repeat(var(--cols-lg, ${lastFixed}), minmax(0, 1fr));\n  }\n}`;
      out = out.slice(0, mediaEnd) + lg + out.slice(mediaEnd);
    }
  }
  return out;
}

const TAG_RE = /<(\/?)([A-Za-z][\w.]*)([^<>]*?)(\/?)>/g;

/** El contenedor que envuelve el primer h1/h2 y fija su alineación es la cabecera de sección. Se recorre
 * el JSX con una pila de elementos abiertos hasta el titular. */
/** Grupos de los elementos abiertos en `at`, de fuera hacia dentro. Se cuenta desde el return: antes hay
 * genéricos de TS (`Partial<Props>`) que parecen etiquetas. */
function openGroups(tsx: string, at: number): (string | undefined)[] {
  const from = tsx.lastIndexOf('return (', at);
  const stack: (string | undefined)[] = [];
  for (const m of tsx.slice(Math.max(from, 0), at).matchAll(TAG_RE)) {
    if (m[4] === '/') continue;
    if (m[1] === '/') {
      stack.pop();
      continue;
    }
    stack.push(/className=\{styles\.(\w+)\}/.exec(m[3])?.[1]);
  }
  return stack;
}

function headerGroupsOf(tsx: string, alignedGroups: Set<string>): string[] {
  // Solo un titular JSX: los comentarios del port citan "<h1>".
  const heading = /<h[12]\s[^<>]*className=/.exec(tsx);
  if (!heading) return [];
  // El propio titular primero: logo-3 centra el h2 sin envoltorio y la cabecera quedaba fuera del contrato.
  const own = /className=\{styles\.(\w+)\}/.exec(tsx.slice(heading.index, tsx.indexOf('>', heading.index)))?.[1];
  const found = [own, ...openGroups(tsx, heading.index).reverse()].find((g) => g && alignedGroups.has(g));
  return found ? [found] : [];
}

const BASE_ALIGN = /text-align:\s*(center|left|start|right|end);/;
const LEGACY_VAR = /text-align:\s*var\(--section-align,\s*(\w+)\);/;

/** Una cabecera centrada lo está por el texto Y por la caja (`margin: auto` + `max-width`): un solo valor CSS
 * no mueve las dos cosas. El wrapper de sección lleva `data-wt-align` (política del DS, ADR 0009) y la
 * cabecera gana una regla para `start` que alinea texto y caja; sin atributo queda el original. */
const startRule = (group: string): string =>
  `:global([data-wt-align="start"]) .${group} {\n  margin-left: 0;\n  margin-right: auto;\n  text-align: start;\n}`;

function convertHeaderAlign(css: string, tsx: string): { css: string; headerGroups: string[] } {
  // Migra la primera versión del pase (var --section-align) al original, para que sea idempotente.
  let out = css.replace(new RegExp(LEGACY_VAR.source, 'g'), 'text-align: $1;');
  const blocks = cssBlocks(out);
  const aligned = new Set(blocks.filter((b) => !b.media && /^\.\w+$/.test(b.selector) && BASE_ALIGN.test(b.body)).map((b) => b.selector.slice(1)));
  const headerGroups = headerGroupsOf(tsx, aligned);
  for (const group of headerGroups) {
    const b = cssBlocks(out).find((x) => !x.media && x.selector === `.${group}`);
    if (!b || BASE_ALIGN.exec(b.body)?.[1] !== 'center' || out.includes(`[data-wt-align="start"]) .${group} {`)) continue;
    out = `${out.slice(0, b.end)}\n\n${startRule(group)}${out.slice(b.end)}`;
  }
  return { css: out, headerGroups };
}

/** `:root[data-theme="dark"] .x` solo reacciona al documento; con el ancestro una sección inversa del
 * plan puede poner data-theme="dark" en su wrapper y el bloque la sigue. */
const ancestorTheme = (css: string): string =>
  css.replace(/:global\(:root\[data-theme="dark"\]\)/g, ':global([data-theme="dark"])').replace(/:root\[data-theme="dark"\](?=\s)/g, ':global([data-theme="dark"])');

const RELUME_DEMO_SRC = /(\bsrc:\s*)"https:\/\/d22po4pjz3o32e\.cloudfront\.net\/[^"]*"/g;
const IMG_WITH_SRC = /<img\b[^>]*?\bsrc=\{([\w.[\]]+)\.src\}[^>]*\/>/g;

/** Media de demo fuera (ADR 0006), como v0: el placeholder del CDN de Relume en los Defaults pasa a vacío y cada
 * <img> con `x.src` se pinta solo si hay dato. Sin esto, una foto que el composer no llena sale como imagen rota
 * (header-145, cta-1 en el lote de variedad); los ports curados ya lo hacían a mano (layout-253, testimonial-3). */
export function noDemoMedia(tsx: string): string {
  return tsx.replace(RELUME_DEMO_SRC, '$1""').replace(IMG_WITH_SRC, (img: string, obj: string, at: number, all: string) => {
    const before = all.slice(0, at).trimEnd();
    if (before.endsWith('&&') || before.endsWith('?') || before.endsWith(':')) return img; // ya condicionado
    // Hijo JSX (tras `>` o `}`) va entre llaves; en posición de expresión (retorno de un map, `(`, `,`) sin llaves.
    return /[>}]$/.test(before) ? `{${obj}.src && ${img}}` : `(${obj}.src ? ${img} : null)`;
  });
}

const BORDER_BOX_MARK = '/* contrato: border-box */';

/** Relume se escribe sobre el preflight de Tailwind (`* { box-sizing: border-box }`), que el scaffold no carga: un
 * `width: 100%` con padding desborda (stats-2 a 375 px: 13 px). Se declara solo sobre las clases del propio port, así
 * los componentes Arc que un shell aloja conservan su propio box model. Idempotente por la marca. */
export function borderBox(css: string): string {
  if (css.includes(BORDER_BOX_MARK)) return css;
  const classes = [...new Set([...css.matchAll(/^\.([A-Za-z_][\w-]*)/gm)].map((m) => m[1]))];
  if (!classes.length) return css;
  const selector = classes.flatMap((c) => [`.${c}`, `.${c}::before`, `.${c}::after`]).join(', ');
  return `${BORDER_BOX_MARK}\n${selector} { box-sizing: border-box; }\n\n${css}`;
}

const MEDIA_FIT_MARK = '/* contrato: media-fit */';

/** El mismo preflight pone `img, svg, video { max-width: 100%; height: auto }`: sin eso un logo no encoge en su
 * celda y la fila desborda (logo-2 con 3 columnas a 375 px: 6 px). Va antes del CSS del port para que una
 * medida propia del port gane por orden. Solo clases de medios del propio port. Idempotente por la marca. */
export function mediaFit(css: string, tsx: string): string {
  if (css.includes(MEDIA_FIT_MARK)) return css;
  const classes = [...new Set([...tsx.matchAll(/<(?:img|video|svg)\b[^>]*?className=\{styles\.(\w+)\}/g)].map((m) => m[1]))];
  if (!classes.length) return css;
  return `${MEDIA_FIT_MARK}\n${classes.map((c) => `.${c}`).join(', ')} { max-width: 100%; height: auto; }\n\n${css}`;
}

const ARC_BUTTON_IMPORT = /^import \{([^}]*)\} from "\.\.\/\.\.\/\.\.\/arc\/button\/button";$/m;

/** Un CTA con destino es un enlace: todo <Button> del port pasa a <Action>, que pinta <a> cuando trae href (el
 * Button de Arc es un <button> y perdía el #cta/wa.me del composer; QA cta.link). El tipo de botón de datos gana
 * `href?` para que el schema lo publique. Idempotente: un port ya convertido no importa Button. */
export function linkActions(tsx: string, actionImport = "../../action"): string {
  const imp = ARC_BUTTON_IMPORT.exec(tsx);
  if (!imp || !/\bButton\b(?!Props)/.test(imp[1])) return tsx;
  const names = imp[1].split(",").map((n) => n.trim()).filter((n) => n && n !== "Button");
  const keep = names.length ? `import { ${names.join(", ")} } from "../../../arc/button/button";\n` : "";
  return tsx
    .replace(imp[0], `${keep}import { Action } from "${actionImport}";`.replace(/\n$/, ""))
    .replace(/<Button\b([^>]*?)\bvariant=\{([\w.[\]]+)\.variant\}/g, (_m, pre: string, obj: string) => `<Action${pre}href={${obj}.href} variant={${obj}.variant}`)
    .replace(/<Button\b/g, "<Action")
    .replace(/<\/Button>/g, "</Action>")
    .replace(/(Pick<ButtonProps,[^>]*>\s*&\s*\{)(?!\s*href\?)/g, "$1 href?: string;")
    .replace(/\bButtonProps\[\]/g, "(ButtonProps & { href?: string })[]");
}

/** Relume tipa sus botones con `variant/size: "link"`, que Arc no tiene: el port no pasaba tsc y el agente (ADR 0011)
 * revisa tipos sobre todo el scaffold. `ghost` es el botón de Arc sin caja, lo más cercano al enlace de Relume. */
export function arcButtonVariants(tsx: string): string {
  const out = tsx.replace(/\bvariant(:\s*|=)"link"/g, 'variant$1"ghost"').replace(/\bsize(:\s*|=)"link"/g, 'size$1"sm"');
  // El icono de cola lo pinta Action; el tipo de datos del botón tiene que publicarlo para que la demo compile.
  return /\biconRight:/.test(out) ? out.replace(/\(ButtonProps & \{ href\?: string \}\)/g, '(ButtonProps & { href?: string; iconRight?: React.ReactNode })') : out;
}

const ICON_LINK_RE = /<a key=\{(\w+)\} href=\{(\w+)\.url\}>\s*\{\2\.icon\}\s*<\/a>/g;

/** Un enlace de solo icono pasa por SocialLink, que le da nombre accesible e icono desde la url. */
export function nameIconLinks(tsx: string, socialImport = "../../social"): string {
  if (!ICON_LINK_RE.test(tsx)) return tsx;
  ICON_LINK_RE.lastIndex = 0;
  const lastImport = [...tsx.matchAll(/^import .*;$/gm)].pop();
  const imp = `import { SocialLink } from "${socialImport}";`;
  const withImport = lastImport ? tsx.replace(lastImport[0], `${lastImport[0]}\n${imp}`) : `${imp}\n${tsx}`;
  return withImport
    .replace(ICON_LINK_RE, (_m, key: string, obj: string) => `<SocialLink key={${key}} {...${obj}} />`)
    .replace(/(\{\s*url: string;\s*)icon: React\.ReactNode;/g, "$1icon?: React.ReactNode;\n  label?: string;");
}

export function applyBlockContract(tsx: string, css: string, opts: BlockContractOptions = {}): BlockContractResult {
  const { tsx: tsxOut, collections } = convertCollectionsTsx(tsx, css, opts.collectionImport ?? '../../collection');
  const cssCols = convertCollectionsCss(css, collections.filter((c, i) => collections.findIndex((x) => x.group === c.group) === i));
  const { css: cssAligned, headerGroups } = convertHeaderAlign(cssCols, tsxOut);
  return { tsx: arcButtonVariants(nameIconLinks(linkActions(noDemoMedia(tsxOut)))), css: mediaFit(borderBox(ancestorTheme(cssAligned)), tsxOut), collections, headerGroups };
}
