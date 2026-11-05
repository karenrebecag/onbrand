// Claves técnicas de los items de un bloque (`id`, `key`): el schema las deja opcionales (GENERATED_KEYS en
// schema-gen) porque las genera el mapeo, como hace el binding del porter con f0…f5. En el camino v0 nadie las
// generaba: el modelo las omite, el bloque las usa como `key` de React y para mapas internos (FeatureBento), y
// el preview avisa en consola (QA-FINAL). Aquí se rellenan en código, siguiendo el schema de cada componente.

import { GENERATED_KEYS } from '../catalog/schema-gen';
import type { LayoutSection } from './layout';
import type { JsonSchema, SchemaStore } from './verify';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Propiedades declaradas de un schema de objeto (o del `items` de un array), si las tiene. */
const propsOf = (schema: unknown): Record<string, unknown> | undefined => (isObj(schema) && isObj(schema.properties) ? (schema.properties as Record<string, unknown>) : undefined);

/** Rellena, en un valor y su schema, las claves técnicas que faltan en los items de arrays de objetos: `${prop}-${i}`. */
function fillValue(value: unknown, schema: unknown, prop: string): unknown {
  if (Array.isArray(value)) {
    const itemSchema = isObj(schema) ? schema.items : undefined;
    const itemProps = propsOf(itemSchema);
    const keys = itemProps ? Object.keys(itemProps).filter((k) => GENERATED_KEYS.has(k)) : [];
    return value.map((item, i) => {
      if (!isObj(item)) return item;
      const filled = Object.fromEntries(keys.filter((k) => item[k] === undefined || item[k] === '').map((k) => [k, `${prop}-${i}`]));
      return fillObject({ ...item, ...filled }, itemSchema);
    });
  }
  if (isObj(value) && !('$slot' in value)) return fillObject(value, schema);
  return value;
}

function fillObject(obj: Obj, schema: unknown): Obj {
  const props = propsOf(schema);
  if (!props) return obj;
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, k in props ? fillValue(v, props[k], k) : v]));
}

/** Recorre el árbol de la sección y, en cada componente con schema, rellena las claves técnicas de sus props.
 * Los nodos dentro de un `$slot` se tratan como árbol (pueden ser componentes con su propio schema). */
export function fillGeneratedKeys(section: LayoutSection, schemaOf: SchemaStore): LayoutSection {
  const walk = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.map(walk);
    if (!isObj(n)) return n;
    if (typeof n.component === 'string') {
      const schema: JsonSchema | null = schemaOf(n.component);
      const props = isObj(n.props) ? n.props : undefined;
      const filled = props && schema ? fillObject(props, schema) : props;
      // Los slots llevan nodos: se recorren aparte, sin schema del padre.
      const withSlots = filled ? Object.fromEntries(Object.entries(filled).map(([k, v]) => [k, isObj(v) && '$slot' in v ? { $slot: walk(v.$slot) } : v])) : undefined;
      return { ...n, ...(withSlots ? { props: withSlots } : {}) };
    }
    return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, k === 'children' ? walk(v) : v]));
  };
  return { ...section, children: walk(section.children) as LayoutSection['children'] };
}
