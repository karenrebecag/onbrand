// Reglas de contenido que comparten el SKILL.md del DS (build-ds-skill) y el prompt de composición
// (LAYOUT_RULE): una sola redacción para que el skill y el composer no le digan cosas distintas al modelo.

/** Sin dato real se inventa verosímil, nunca datos de terceros ni la copy demo del componente. */
export const FILL_RULE =
  'Rellena TODO con contenido específico y plausible de ESTE negocio; nunca lorem, placeholder ni la copy demo del componente. Si falta un dato real (cifras, testimonios, logos), INVÉNTALO verosímil para este negocio: cifras redondas creíbles (4,000+, 38%), testimonios con nombre, cargo y empresa, y marcas de logos FICTICIAS. NUNCA uses marcas, personas ni cifras REALES de terceros: todo inventado y creíble.';

/** Misma política que hrefViolations/hrefPlaceholders (src/runtime/href-check.ts): una ruta inventada es un
 * link roto en la página publicada; `#` queda visible como pendiente y sale en datos a confirmar. */
export const HREF_RULE =
  'Nunca inventes rutas. Un enlace va a: (a) un ancla a una sección de esta página (#<id>, de la lista de anclas válidas que recibes); (b) `#` si el brief no trae el destino, y esa ruta va en provenance con {"claims": []} para que salga en datos a confirmar; (c) mailto:/tel:/URL de red social, también en provenance como hecho.';

/** Solo los HECHOS inventados se listan, para confirmarlos después; la copy y lo visual no. */
export const PROVENANCE_RULE =
  'Marca cada valor que inventaste (no venido del brief) en un mapa "provenance" a nivel de sección: {"<ruta del prop>":{"claims":["<hecho>"]}}, misma ruta que el árbol (p. ej. children[0].props.items[1].name). claims[] = los hechos concretos que afirma ese texto (cifra, persona, empresa, precio, fecha, cliente); excluye props visuales (tamaño, variante, color, icono). No se renderiza; sirve para listar después qué confirmar.';
