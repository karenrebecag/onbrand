// Inyector de copy GUIADO POR EL SCHEMA (paso 4.3b): llena los props de un bloque Arc leyendo el
// contrato de componente (el schema TS de paso 4.3a) y poniendo el copy agnóstico del rol en cada prop
// de CONTENIDO según su `format`. Reemplaza al `case` por slug: cualquier bloque con schema se llena sin
// una rama a mano. Es honesto: un prop cuyo contenido el rol no provee (los props de app de un bloque
// showcase: model, series, greeting) se deja fuera —el bloque usa su default para ese prop—, nunca se
// inventa. Fitea al presupuesto del bloque, como el inyector Relume.

import type { RoleCopy } from '../copy';
import type { SlotBudgets } from '../copygen/slot-model';
import { contentFor, fitProps, type RoleContent } from './inject-copy';
import type { JsonSchema } from './schema-gen';
import { classifyProp, type SemanticFormat } from './semantic-formats';
import type { CatalogEntry } from './schema';

type Item = Record<string, unknown>;

/** Formats que el copy del rol sabe llenar en un item (los que itemValue mapea). Un array cuyo item
 * REQUIERE algo fuera de esto (id, start/end, series, points, messages) NO es contenido: es un array de
 * app y no se llena con copy a medias —eso falsearía C8. */
const FILLABLE_ITEM_FORMATS = new Set<SemanticFormat>(['heading', 'description', 'quote', 'person', 'role', 'company', 'tagline', 'label', 'metric', 'price']);

/** ¿El array de objetos es de CONTENIDO (lista de features/testimonios/faq) y no uno estructural de app
 * (events con start/end, maps con regions, kpis con series)? Lo es solo si cada prop REQUERIDO del item
 * es un format que el copy sabe llenar. */
function itemIsContentFillable(items: JsonSchema): boolean {
  const req = items.required ?? [];
  if (req.length === 0) return false; // sin campos requeridos no hay forma de saber que es contenido
  const props = items.properties ?? {};
  return req.every((k) => {
    const f = props[k]?.format;
    return f !== undefined && FILLABLE_ITEM_FORMATS.has(f);
  });
}

/** El array de contenido del rol que llena el primer array-de-objetos del schema. string[] para logos. */
function roleArray(content: RoleContent): Item[] | string[] | undefined {
  // Las interfaces del copy no declaran índice; se leen por clave del schema, así que se ven como Item.
  return (content.features ?? content.stats ?? content.testimonials ?? content.steps ?? content.pricing ?? content.faq ?? content.logos) as Item[] | string[] | undefined;
}

/** Valor de un item de contenido para un `format` de prop (heading←title/name/question, etc.). undefined
 * si el item no tiene nada para ese format. */
function itemValue(format: string | undefined, it: Item): unknown {
  switch (format) {
    case 'heading': return it.title ?? it.name ?? it.question;
    case 'description': return it.description ?? it.answer ?? it.detail;
    case 'quote': return it.quote;
    case 'person': return it.name;
    case 'role': return it.role;
    case 'company': return it.company;
    case 'tagline': case 'label': return it.tagline ?? it.label;
    case 'metric': return typeof it.value === 'number' ? it.value : undefined;
    case 'price': return it.monthlyPrice ?? it.price;
    default: return undefined;
  }
}

/** Un item de props desde un item de contenido, por los formats de los props del item del schema. */
function fillItem(itemProps: Record<string, JsonSchema>, it: Item): Item {
  const out: Item = {};
  for (const [k, s] of Object.entries(itemProps)) {
    const v = itemValue(s.format, it);
    if (v !== undefined && v !== '') out[k] = v;
  }
  return out;
}

/** Valor de un prop escalar por su format, desde el contenido del rol. `next` entrega el siguiente botón
 * para los props cta. undefined = el rol no provee ese contenido (el prop queda sin poner). */
function scalarValue(node: JsonSchema, content: RoleContent, next: () => { title: string } | undefined): unknown {
  switch (node.format) {
    case 'heading': return content.heading || undefined;
    case 'description': return content.description || undefined;
    case 'tagline': case 'label': return content.tagline || undefined;
    case 'cta': { const b = next(); return b ? (node.type === 'object' ? { label: b.title } : b.title) : undefined; }
    default: return undefined;
  }
}

/**
 * Props de un bloque Arc desde su schema + el copy del rol. `undefined` si el rol no trae copy o si no se
 * pudo llenar ningún prop de contenido (no se fuerza un objeto vacío que tape el default del bloque).
 */
export function injectBySchema(entry: CatalogEntry, schema: JsonSchema, copy: RoleCopy, budgets?: SlotBudgets): Record<string, unknown> | undefined {
  const content = contentFor(entry, copy);
  if (!content) return undefined;
  const props: Record<string, unknown> = {};
  const src = roleArray(content);
  let arrayPlaced = false;
  let btn = 0;
  const nextButton = () => content.buttons[btn++];

  for (const [name, node] of Object.entries(schema.properties ?? {})) {
    if (node.type === 'array') {
      // Un array de estado/config (defaultEvents, un arreglo de variantes) no es contenido: fuera.
      if (arrayPlaced || !src || src.length === 0 || classifyProp(name, '') !== 'content') continue;
      const max = node.maxItems ?? src.length;
      if (node.items?.type === 'object' && typeof src[0] === 'object') {
        if (!itemIsContentFillable(node.items)) continue; // array estructural de app: no se llena a medias
        const req = node.items.required ?? [];
        const items = (src as Item[]).slice(0, max).map((it) => fillItem(node.items!.properties ?? {}, it));
        // Cada item debe cubrir sus props requeridas; si no, el bloque recibiría un item roto.
        if (items.every((it) => req.every((k) => k in it))) { props[name] = items; arrayPlaced = true; }
      } else if (typeof src[0] === 'string' && (node.items?.format || node.items?.type === 'string')) {
        props[name] = (src as string[]).slice(0, max);
        arrayPlaced = true;
      }
      continue;
    }
    const v = scalarValue(node, content, nextButton);
    if (v !== undefined) props[name] = v;
  }
  if (Object.keys(props).length === 0) return undefined;
  return fitProps(props, budgets);
}
