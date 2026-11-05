// Generador del contrato de componente (paso 4.1): de los props documentados de un bloque Arc
// (manifest.props, ya parseados del doc.md) saca un JSON Schema draft-07 con additionalProperties:false,
// `format` semántico en los props de contenido y enum+default en los de config. Es la fuente única de
// props que hoy no existe: reemplaza al `case` por slug por un contrato legible por máquina. NO cambia
// la salida; solo describe cada bloque. Incluye un validador mínimo (sin deps) para C12.

import type { CatalogEntry, ManifestProp, SlotSemantic } from './schema';

export type SlotCardinality = 'one' | 'map' | 'list';

const MAP_SLOT = /^(Partial<)?Record<string,\s*ReactNode>>?$/;

/** Cardinalidad de un prop que es slot (ReactNode o mapa de ReactNode), o null si no lo es. Una
 * render-prop (`(n) => ReactNode`) no es slot: el filler no escribe funciones (ADR 0005). */
export function slotCardinality(path: string, type: string): SlotCardinality | null {
  if (MAP_SLOT.test(type.trim())) return 'map';
  if (type.trim() !== 'ReactNode') return null;
  return path.includes('[]') ? 'list' : 'one';
}
import { FORMATS_VERSION, inferFormat, isContentProp, type SemanticFormat } from './semantic-formats';

export interface JsonSchema {
  $schema?: string;
  $id?: string;
  title?: string;
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  additionalProperties?: boolean;
  enum?: string[];
  default?: string;
  format?: SemanticFormat;
  minItems?: number;
  maxItems?: number;
  description?: string;
  examples?: unknown[];
  'x-format-confidence'?: 'low';
  'x-formats-version'?: number;
  /** El prop existe en el interface TS pero doc.md no lo documenta (sin description). Paso 4.3a. */
  'x-undocumented'?: true;
  /** El prop admite `null` además de su tipo (`contact: {...} | null`: null lo oculta). */
  'x-nullable'?: true;
  /** Qué hace el pipeline cuando el binding no trae este prop (spec politica-slots-visibles). Copia
   * documental del overlay catalog/slot-policy.json: el runtime lee el overlay, no esto. */
  'x-empty'?: null | [] | '' | 'media' | 'omit';
  /** Slot que llena un componente (spec composicion-slots, RF4). Copia del overlay: `accepts` = `fill`,
   * `keys` = ruta que indexa un map. El nodo no lleva `type`: un ReactNode no es JSON. */
  'x-slot'?: { accepts: SlotSemantic[]; cardinality: SlotCardinality; keys?: string };
  /** Variantes de un componente (raíz del schema): los valores de su prop `variant`. */
  'x-variants'?: string[];
}

/** Prop de entrada al generador: un ManifestProp con `required`/`undocumented` explícitos cuando la
 * fuente es el interface TS (no el doc.md, donde `required` viene en el nombre). */
export interface SchemaProp extends ManifestProp {
  required?: boolean;
  undocumented?: boolean;
}

interface CleanProp {
  segments: { key: string; array: boolean }[];
  type: string;
  description: string;
  required: boolean;
  undocumented: boolean;
  default?: string;
}

/** Limpia el nombre crudo del prop (ruido del doc.md: backticks, "(required)") y lo parte en segmentos
 * de ruta; cada segmento que termina en `[]` marca un array. `required`/`undocumented` explícitos
 * (fuente TS) ganan sobre la heurística del nombre. */
export function cleanProp(p: SchemaProp): CleanProp {
  const raw = p.name.replace(/`/g, '').trim();
  const required = p.required ?? /\(required\)/i.test(raw);
  const name = raw.replace(/\s*\(required\)\s*/i, '').trim();
  const segments = name.split('.').filter(Boolean).map((seg) => ({
    key: seg.replace(/\[\]$/, ''),
    array: seg.endsWith('[]'),
  }));
  return { segments, type: p.type.trim(), description: p.description, required, undocumented: p.undocumented ?? false, ...(p.default !== undefined ? { default: p.default } : {}) };
}

/** Alias de tipo que son union de literales (`type ButtonVariant = "primary" | "ghost"`), por nombre.
 * Solo los del mismo archivo: tsPropsOf devuelve el nombre del alias y sin esto el prop queda opaco. */
export function literalAliasesOf(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/^(?:export\s+)?type\s+(\w+)\s*=\s*([^;]+);/gm)) {
    const body = m[2].replace(/\s+/g, ' ').trim().replace(/^\|\s*/, '');
    if (enumValues(body)) out.set(m[1], body);
  }
  return out;
}

/** Claves técnicas que el mapeo genera (`id`, `key`): no son contenido, no se le exigen al autor. */
export const GENERATED_KEYS: ReadonlySet<string> = new Set(['id', 'key']);

// Texto de pantalla en un literal: algún string con mayúscula inicial o con espacio ("Arc", "Before",
// "Q3 launch plan"). Un token de configuración ("short", "USD", "contribution") no lo es.
const hasDisplayText = (code: string): boolean =>
  [...code.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)].some((m) => /^[A-Z][a-z]|\S\s+\S/.test(m[1] ?? m[2] ?? m[3]));

/** Inicializador de `const <name> = [...]` / `{...}` del archivo, cortado donde cierra su corchete. */
function constInit(src: string, name: string): string | null {
  const m = new RegExp(`^(?:export\\s+)?const\\s+${name}\\s*(?::[^=\\n]+)?=\\s*(?=[[{])`, 'm').exec(src);
  if (!m) return null;
  const start = m.index + m[0].length;
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '[' || c === '{') depth++;
    else if ((c === ']' || c === '}') && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

/** Nombre exportado por el módulo `*-data` del que viene el identificador local `expr`
 * (`import { kpis as sampleKpis }` → `kpis`), o null si no se importa de ahí. */
export function dataImportOf(expr: string, src: string): string | null {
  for (const m of src.matchAll(/^import\s*\{([^}]*)\}\s*from\s*["'][^"']*-data["']/gm)) {
    const hit = m[1].split(',').map((n) => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)).find((parts) => parts[parts.length - 1] === expr);
    if (hit) return hit[0];
  }
  return null;
}

/** ¿El default de un prop es un dato de demo? Omitir ese prop pinta la demo en vez del contenido, así
 * que para componer cuenta como obligatorio (política de slots: llenar u omitir, nunca demo).
 * - identificador importado de un módulo `*-data` y que ahí no es una función;
 * - constante de datos del archivo (array/objeto con texto de pantalla: `DEFAULT_REACTIONS` de emojis no);
 * - literal array/objeto inline con texto de pantalla (`brand = { name: "Arc" }`).
 * Un default de configuración (`= []`, `= 300`, `= { month: "short" }`) no. */
export function isDemoDefault(expr: string, src: string, dataSrc = ''): boolean {
  if (/^[[{]/.test(expr)) return hasDisplayText(expr);
  if (!/^[A-Za-z_$][\w$]*$/.test(expr)) return false;
  const name = dataImportOf(expr, src);
  if (name) {
    return !new RegExp(`export\\s+(?:async\\s+)?function\\s*\\*?\\s*${name}\\b|export\\s+const\\s+${name}\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>`).test(dataSrc);
  }
  const init = constInit(src, expr);
  return init !== null && hasDisplayText(init);
}

// Un asset de la demo (`/block-logos/stripe.svg`, una URL de foto) delata la copia igual que su texto.
const ASSET = /^(\/|https?:\/\/)\S+\.(svg|png|jpe?g|webp|gif|avif)$/i;

/** Strings de la demo de un componente: los textos de pantalla y assets de cada default de demo
 * (literal inline, constante del archivo o export del `*-data`). Si el agente devuelve uno tal cual,
 * copió la demo en vez de componer con el contenido del negocio. */
export function demoStringsOf(defaults: Map<string, string>, src: string, dataSrc = ''): string[] {
  const out = new Set<string>();
  for (const expr of defaults.values()) {
    if (!isDemoDefault(expr, src, dataSrc)) continue;
    const name = dataImportOf(expr, src);
    const text = /^[[{]/.test(expr) ? expr : name ? constInit(dataSrc, name) : constInit(src, expr);
    for (const v of demoPhrasesOf(text ?? '')) out.add(v);
  }
  return [...out].sort();
}

/** Frases y assets de los strings de un trozo de código. Una palabra suelta ("Stripe") puede ser
 * contenido legítimo del negocio; una frase o un asset no. */
export function demoPhrasesOf(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`$]*)`/g)) {
    const v = m[1] ?? m[2] ?? m[3];
    if (ASSET.test(v) || /\S\s+\S/.test(v)) out.push(v);
  }
  return out;
}

/** Union de literales `"a" | "b"` → lista de valores; null si no es un enum de strings. */
export function enumValues(type: string): string[] | null {
  if (!/\|/.test(type)) return null;
  const parts = type.split('|').map((s) => s.trim());
  const lits = parts.filter((s) => /^["'].*["']$/.test(s)).map((s) => s.slice(1, -1));
  return lits.length && lits.length === parts.length ? lits : null;
}

const isDateLike = (type: string): boolean => {
  const parts = type.split('|').map((s) => s.trim());
  return parts.includes('Date') && parts.includes('string') && parts.every((p) => /^(string|number|Date|null|undefined)$/.test(p));
};

/** Schema de una HOJA (no tiene hijos anidados): tipo JSON + enum/format/default. */
function leafSchema(raw: string, name: string, description: string, undocumented = false): JsonSchema {
  const out: JsonSchema = {};
  // `T | null`: null es un valor válido (ocultar), el resto se clasifica por T.
  const type = raw.replace(/\s*\|\s*null\s*$/, '');
  if (type !== raw) out['x-nullable'] = true;
  if (description) out.description = description;
  if (undocumented) out['x-undocumented'] = true;
  if (slotCardinality(name, type)) return out;
  const en = enumValues(type);
  if (en) { out.type = 'string'; out.enum = en; return out; }
  if (/^number(\[\])?$/.test(type)) out.type = type.endsWith('[]') ? 'array' : 'number';
  else if (/^boolean$/.test(type)) out.type = 'boolean';
  else if (/^string\[\]$/.test(type)) { out.type = 'array'; out.items = { type: 'string' }; }
  else if (/^string/.test(type)) out.type = 'string';
  // `Date | string | number` acepta el string ISO que llega por JSON; un `Date` solo sigue opaco, porque
  // el componente le llamaría métodos de Date.
  else if (isDateLike(type)) out.type = 'string';
  else out.type = 'object'; // media ({src,alt}), ReactNode, Record: opaco salvo props anidados

  if (out.type === 'array' && out.items) { /* items ya puesto */ }
  if (out.type === 'array' && !out.items) out.items = { type: 'number' };

  // format solo en props de contenido (no en config/estado: variant, locale, defaultX, el valor
  // controlado de un input; esos quedan como string/enum sin format y fuera de C12b).
  if (isContentProp(name, type)) {
    const guess = inferFormat(name, type);
    const target = out.type === 'array' ? out.items! : out;
    if (guess.format) target.format = guess.format;
    else if (guess.confidence === 'low') target['x-format-confidence'] = 'low';
  }
  return out;
}

/** ¿El tipo es un array de OBJETOS (`Stat[]`, `BentoFeature[]`), no de escalares (`string[]`)? */
const isObjectArrayType = (type: string): boolean => /\[\]$/.test(type) && !/^(string|number)\[\]$/.test(type);

/** Marca un nodo como array de objetos sin pisar lo que ya exista (los props `X[].Y` y el prop `X: T[]`
 * convergen al mismo nodo, en cualquier orden). */
function ensureObjectArray(node: JsonSchema, description?: string, undocumented?: boolean): JsonSchema {
  node.type = 'array';
  node.minItems = node.minItems ?? 1;
  node.items ??= {};
  node.items.type = node.items.type ?? 'object';
  if (description && !node.description) node.description = description;
  if (undocumented && !node.description) node['x-undocumented'] = true;
  return node.items;
}

/** Inserta una hoja en el árbol de schema siguiendo sus segmentos de ruta (crea objects/arrays).
 * Idempotente: un prop `X: T[]` y los `X[].Y` construyen el mismo array sin pisarse. */
function insert(root: JsonSchema, cp: CleanProp): void {
  let node = root;
  for (let i = 0; i < cp.segments.length; i++) {
    const seg = cp.segments[i];
    const last = i === cp.segments.length - 1;
    node.type = 'object';
    node.properties ??= {};
    node.additionalProperties = false;
    let child = node.properties[seg.key];
    if (!child) { child = {}; node.properties[seg.key] = child; }
    // El required va al objeto que contiene la hoja: un `X[].Y` requerido obliga a Y dentro de cada item,
    // no a X en la raíz. Si X debe venir lo dice su propio prop (TS sin `?` o default de demo).
    if (cp.required && last && !GENERATED_KEYS.has(seg.key) && !(node.required ??= []).includes(seg.key)) node.required.push(seg.key);

    // Segmento array por notación (`X[].Y`) o por tipo en la hoja (`X: T[]` de objetos).
    const arrayHere = seg.array || (last && isObjectArrayType(cp.type));
    if (arrayHere) {
      const items = ensureObjectArray(child, last ? cp.description : undefined, last ? cp.undocumented : undefined);
      if (last && !seg.array) { /* hoja `X: T[]`: el array queda, los items los llenan los `X[].Y` */ }
      node = items;
    } else if (last) {
      // No pisar un array ya construido por props anidados con una hoja opaca.
      if (child.type !== 'array') Object.assign(child, leafSchema(cp.type, seg.key, cp.description, cp.undocumented));
    } else {
      node = child;
    }
  }
}

/** `messages` / `defaultMessages`: controlado y no controlado son alternativas. Un `X[].Y` requerido
 * marca X como requerido en la raíz, y así salían los dos obligatorios a la vez. Aquí se sueltan los
 * dos salvo que el interface declare uno sin `?`. */
function releaseControlledPairs(root: JsonSchema, props: SchemaProp[]): void {
  if (!root.required?.length) return;
  const top = props.map(cleanProp).filter((c) => c.segments.length === 1);
  const declared = new Set(top.filter((c) => c.required).map((c) => c.segments[0].key));
  const typeOf = new Map(top.map((c) => [c.segments[0].key, c.type] as const));
  // Mismo tipo o no es un par: `defaultSeries: string` es la serie elegida, no la lista sin controlar.
  const paired = new Set([...typeOf.keys()].flatMap((k) => {
    const base = /^default([A-Z]\w*)$/.exec(k);
    if (!base) return [];
    const controlled = base[1].charAt(0).toLowerCase() + base[1].slice(1);
    return typeOf.get(controlled) === typeOf.get(k) ? [k, controlled] : [];
  }));
  root.required = root.required.filter((k) => !paired.has(k) || declared.has(k));
  if (!root.required.length) delete root.required;
}

/** JSON Schema draft-07 de un bloque, desde sus props documentados. `example` (si se pasa) va a
 * `examples` y fija maxItems de los arrays a su longitud. */
export function buildSchema(entry: CatalogEntry, example?: Record<string, unknown>, props?: SchemaProp[]): JsonSchema {
  const root: JsonSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: `arc/${entry.slug}.schema.json`,
    title: entry.name,
    type: 'object',
    additionalProperties: false,
    properties: {},
    'x-formats-version': FORMATS_VERSION,
  };
  // Fuente de verdad: los props TS (paso 4.3a) cuando se pasan; si no, los del manifest (doc.md).
  for (const p of props ?? entry.manifest?.props ?? []) {
    // className y props de passthrough técnico no entran al contrato de contenido.
    const container = p.type.trim().startsWith('{');
    if (/^class(name)?$/i.test(p.name) || (/ReactNode|Record</.test(p.type) && !/\[\]/.test(p.type) && !container && !slotCardinality(p.name, p.type))) continue;
    insert(root, cleanProp(p));
  }
  releaseControlledPairs(root, props ?? entry.manifest?.props ?? []);
  if (example) {
    root.examples = [example];
    for (const [key, val] of Object.entries(example)) {
      const prop = root.properties?.[key];
      if (prop?.type === 'array' && Array.isArray(val)) prop.maxItems = Math.max(val.length, prop.minItems ?? 1);
    }
  }
  return root;
}

// --- validador mínimo draft-07 (sin ajv): cubre type, required, enum, additionalProperties, items,
// minItems/maxItems. Suficiente para C12 (validar que los `examples` cumplen su propio schema). ---

const jsonType = (v: unknown): string => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

export function validate(schema: JsonSchema, value: unknown, path = '$'): string[] {
  const errors: string[] = [];
  if (schema.enum) { if (!schema.enum.includes(value as string)) errors.push(`${path}: "${String(value)}" no está en enum`); return errors; }
  if (value === null && schema['x-nullable']) return errors;
  if (schema.type) {
    const t = jsonType(value);
    const ok = schema.type === 'number' ? t === 'number' : schema.type === t;
    if (!ok) { errors.push(`${path}: se esperaba ${schema.type}, llegó ${t}`); return errors; }
  }
  if (schema.type === 'array' && Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: < minItems ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: > maxItems ${schema.maxItems}`);
    if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items!, v, `${path}[${i}]`)));
  }
  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) if (!(req in obj)) errors.push(`${path}.${req}: requerido y ausente`);
    for (const [key, v] of Object.entries(obj)) {
      const ps = schema.properties?.[key];
      if (!ps) { if (schema.additionalProperties === false) errors.push(`${path}.${key}: additionalProperties:false`); continue; }
      errors.push(...validate(ps, v, `${path}.${key}`));
    }
  }
  return errors;
}

/** ¿El schema está bien formado como contrato? (objeto raíz, additionalProperties:false, con props). */
export function schemaWellFormed(schema: JsonSchema): boolean {
  return schema.type === 'object' && schema.additionalProperties === false && !!schema.properties && Object.keys(schema.properties).length > 0;
}

/** Props de contenido con format y su confianza, recorriendo el schema (para la métrica C12). */
export function formatStats(schema: JsonSchema): { withFormat: number; lowConfidence: number } {
  let withFormat = 0, lowConfidence = 0;
  const walk = (s: JsonSchema): void => {
    if (s.format) withFormat++;
    if (s['x-format-confidence'] === 'low') lowConfidence++;
    if (s.items) walk(s.items);
    for (const c of Object.values(s.properties ?? {})) walk(c);
  };
  walk(schema);
  return { withFormat, lowConfidence };
}
