// Filler de slots por semántica (spec composicion-slots, RF7). Para cada `x-slot` del schema del bloque
// que el binding dejó sin valor, elige el primer componente del índice (orden estable por slug) cuya
// semántica cruza `accepts` Y cuyos props obligatorios salen de un dato REAL del copy; lo escribe como
// `{ $component, props, children? }` (slot-value) y renderApp lo vuelve JSX. Sin dato, el slot cae al
// vacío que la política fijó (`x-empty`); nunca una serie o cifra inventada (D4). Sin aleatoriedad.

import type { RoleCopy } from '../copy';
import type { Role } from '../types';
import type { CatalogEntry, SlotSemantic } from './schema';
import type { JsonSchema } from './schema-gen';
import type { SlotComponentValue } from './slot-value';

export type SlotCardinality = 'one' | 'map' | 'list';

/** Lo que el schema declara en `x-slot` (S2) más el vacío de la política (`x-empty`). */
export interface SlotSpec {
  /** Ruta con la forma de las reglas de política: `visuals`, `brand.mark`, `channels[].icon`. */
  path: string;
  accepts: SlotSemantic[];
  cardinality: SlotCardinality;
  /** Solo map: ruta de las claves (`features[].id`). Sin ella, un map no se llena. */
  keys?: string;
  /** Vacío de la política cuando no hay componente ni dato; undefined = se deja sin poner. */
  else?: unknown;
}

type SchemaWithSlot = JsonSchema & { 'x-slot'?: { accepts?: unknown; cardinality?: unknown; keys?: unknown }; 'x-empty'?: unknown };

const CARDINALITIES: readonly SlotCardinality[] = ['one', 'map', 'list'];

/** Recorre el schema y devuelve los slots declarados, anidados incluidos. */
export function slotSpecsOf(schema: JsonSchema, prefix = ''): SlotSpec[] {
  const out: SlotSpec[] = [];
  for (const [name, raw] of Object.entries(schema.properties ?? {})) {
    const node = raw as SchemaWithSlot;
    const path = prefix + name;
    const slot = node['x-slot'];
    if (slot && Array.isArray(slot.accepts) && CARDINALITIES.includes(slot.cardinality as SlotCardinality)) {
      out.push({
        path,
        accepts: slot.accepts as SlotSemantic[],
        cardinality: slot.cardinality as SlotCardinality,
        ...(typeof slot.keys === 'string' ? { keys: slot.keys } : {}),
        ...('x-empty' in node && node['x-empty'] !== 'omit' ? { else: node['x-empty'] } : {}),
      });
      continue;
    }
    if (node.properties) out.push(...slotSpecsOf(node, `${path}.`));
    if (node.items?.properties) out.push(...slotSpecsOf(node.items, `${path}[].`));
  }
  return out;
}

/** Un dato del copy con nombres de prop: el componente toma los que su schema declare. */
type DataRecord = Record<string, unknown>;

/** De dónde sale el dato real de cada semántica. `illustration` es decorativa: no necesita dato, pero
 * solo entra un componente sin props obligatorios. `media`, `series`, `icon` no tienen proveedor
 * (fillImages no es un componente; nadie trae series; los iconos son lucide): caen siempre a `else`. */
const PROVIDERS: Partial<Record<SlotSemantic, (copy: RoleCopy, role: Role | undefined) => DataRecord[]>> = {
  metric: (copy) => (copy.stats?.stats ?? []).map((s) => ({ ...s, ...(s.detail !== undefined ? { context: s.detail } : {}) })),
  avatar: (copy) => {
    const members = (copy.testimonials?.items ?? []).map((t) => ({ name: t.name }));
    return members.length ? [{ members }] : [];
  },
  logo: (copy) => {
    const logos = (copy.logos?.brands ?? []).map((name) => ({ name }));
    return logos.length ? [{ logos }] : [];
  },
  action: (copy, role) => {
    const cta = role && role in copy ? (copy[role as keyof RoleCopy] as { primaryCta?: string } | undefined)?.primaryCta : undefined;
    return cta ? [{ children: cta }] : [];
  },
  illustration: () => [{}],
};

export interface FillContext {
  schema: JsonSchema | null;
  /** Componentes del índice (kind component) con su schema; sin schema no son elegibles. */
  components: { entry: CatalogEntry; schema: JsonSchema | null }[];
  semanticsOf(slug: string): SlotSemantic[];
}

/** Props del componente desde un dato: solo los props que su schema declara (más `children`), y solo
 * si todos los obligatorios quedan cubiertos. undefined = este componente no sirve para este dato. */
function componentValue(slug: string, schema: JsonSchema, record: DataRecord): SlotComponentValue | undefined {
  const props: Record<string, unknown> = {};
  for (const name of Object.keys(schema.properties ?? {})) if (record[name] !== undefined) props[name] = record[name];
  if ((schema.required ?? []).some((r) => props[r] === undefined)) return undefined;
  const children = typeof record.children === 'string' ? record.children : undefined;
  return { $component: slug, ...(Object.keys(props).length ? { props } : {}), ...(children !== undefined ? { children } : {}) };
}

/** Primer componente (por slug) que acepta la semántica y cubre sus obligatorios con el dato. */
function pick(ctx: FillContext, accepts: SlotSemantic[], record: DataRecord): SlotComponentValue | undefined {
  const candidates = ctx.components
    .filter((c) => c.schema && ctx.semanticsOf(c.entry.slug).some((s) => accepts.includes(s)))
    .sort((a, b) => a.entry.slug.localeCompare(b.entry.slug));
  for (const c of candidates) {
    const v = componentValue(c.entry.slug, c.schema!, record);
    if (v) return v;
  }
  return undefined;
}

const records = (copy: RoleCopy, role: Role | undefined, accepts: SlotSemantic[]): DataRecord[] =>
  accepts.flatMap((s) => PROVIDERS[s]?.(copy, role) ?? []);

/** Valor del slot (uno, map o lista) o undefined si nada se pudo llenar. */
function slotValue(spec: SlotSpec, ctx: FillContext, copy: RoleCopy, role: Role | undefined, props: Record<string, unknown>): unknown {
  const data = records(copy, role, spec.accepts);
  if (spec.cardinality === 'one') return data.length ? pick(ctx, spec.accepts, data[0]) : undefined;
  if (spec.cardinality === 'list') {
    const items = data.map((r) => pick(ctx, spec.accepts, r)).filter((v): v is SlotComponentValue => v !== undefined);
    return items.length ? items : undefined;
  }
  if (!spec.keys) return undefined;
  const keys = readAll(props, spec.keys).filter((k): k is string => typeof k === 'string');
  const entries = keys.flatMap((k, i) => {
    const v = data[i] ? pick(ctx, spec.accepts, data[i]) : undefined;
    return v ? [[k, v] as const] : [];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** Todos los valores de una ruta (`features[].id` → un id por feature). */
export function readAll(obj: unknown, path: string): unknown[] {
  let cur: unknown[] = [obj];
  for (const seg of path.split('.')) {
    const isList = seg.endsWith('[]');
    const key = isList ? seg.slice(0, -2) : seg;
    cur = cur.flatMap((o) => {
      if (typeof o !== 'object' || o === null) return [];
      const v = (o as Record<string, unknown>)[key];
      return isList ? (Array.isArray(v) ? v : []) : [v];
    });
  }
  return cur.filter((v) => v !== undefined);
}

/** Escribe `value` en `path` SOLO donde esté sin poner. Inmutable: copia el camino tocado. En un
 * segmento `x[]` escribe en cada elemento (índice i → value(i)). */
function writeUnset(obj: unknown, segs: string[], value: (i: number) => unknown, i = 0): unknown {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return obj;
  const [head, ...rest] = segs;
  const isList = head.endsWith('[]');
  const key = isList ? head.slice(0, -2) : head;
  const rec = obj as Record<string, unknown>;
  const current = rec[key];
  if (isList) {
    if (!Array.isArray(current)) return obj;
    const items = current.map((it, j) => (rest.length ? writeUnset(it, rest, value, j) : it));
    return items.some((it, j) => it !== current[j]) ? { ...rec, [key]: items } : obj;
  }
  if (rest.length === 0) {
    if (current !== undefined) return obj;
    const v = value(i);
    return v === undefined ? obj : { ...rec, [key]: v };
  }
  if (current === undefined) return obj;
  const next = writeUnset(current, rest, value, i);
  return next === current ? obj : { ...rec, [key]: next };
}

/** Rellena los slots del bloque que el binding no puso. Puro y determinista. Corre DESPUÉS de
 * applySlotPolicy: la política decide el vacío, el filler intenta el componente, y lo que no se llena
 * recibe `else` (si el schema lo trae) para que el bloque no muestre su default demo. */
export function fillSlots(entry: Pick<CatalogEntry, 'slug' | 'role'>, props: Record<string, unknown>, copy: RoleCopy, ctx: FillContext): Record<string, unknown> {
  if (!ctx.schema) return props;
  let out: unknown = props;
  for (const spec of slotSpecsOf(ctx.schema)) {
    const segs = spec.path.split('.');
    const value = slotValue(spec, ctx, copy, entry.role, props);
    out = writeUnset(out, segs, () => value);
    if ('else' in spec) out = writeUnset(out, segs, () => spec.else);
  }
  return out as Record<string, unknown>;
}
