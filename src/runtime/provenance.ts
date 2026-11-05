// La provenance que emite el modelo no sirve tal cual al builder: marca de más (features.description,
// copy largo) y PARAFRASEA el claim ("3,800 personas ya están en la lista…" para un count de 3800), así
// que el dato no aparece textual en el valor y no se puede resaltar. PROVENANCE_RULE pide lo correcto,
// pero el prompt no alcanza; esto lo hace cumplir en código tras componer (QA, corrida real :5300).
//
// Para no perder recall (si el modelo casi siempre parafrasea, exigir claim literal tiraría los hechos
// que SÍ inventó: nombres, cargos, empresas, cifras), cuando el claim no es subcadena literal del valor
// se DERIVA el hecho del propio valor:
//   - cifras/%/moneda/fechas dentro del valor → claims = esas subcadenas (resaltables);
//   - valor corto (≤6 palabras, sin verbo de marketing: nombre/cargo/empresa/marca) → claims [] (el
//     valor entero es el hecho);
//   - número → claims [];  placeholder `#` → claims [];
//   - copy largo sin cifras → se descarta.

import type { LayoutSection } from './layout';

const normWS = (s: string): string => s.replace(/\s+/g, ' ').trim();

// Verbos de marketing (es/pt/en): si un valor corto trae uno, es copy, no un hecho. Lista corta y
// frecuente; no pretende ser exhaustiva, solo separar "Lucía Herrera" de "Convierte más clientes".
const MARKETING_VERBS = new Set([
  'convierte', 'impulsa', 'transforma', 'descubre', 'aumenta', 'optimiza', 'lanza', 'crea', 'potencia',
  'mejora', 'ahorra', 'gana', 'unete', 'únete', 'empieza', 'prueba', 'agenda', 'reserva', 'consigue',
  'acelera', 'simplifica', 'automatiza', 'conecta', 'escala', 'multiplica', 'maximiza', 'haz', 'logra',
  'convert', 'boost', 'transform', 'discover', 'grow', 'launch', 'create', 'join', 'start', 'try', 'get',
  'save', 'unlock', 'build', 'scale', 'accelerate', 'simplify', 'automate', 'connect', 'turn', 'make',
  'converta', 'descubra', 'comece', 'experimente', 'aumente', 'transforme', 'crie', 'junte',
]);

// Cifras, porcentajes, moneda y fechas: subcadenas literales del valor que el builder puede resaltar.
const FIGURE_RE = /(?:[$€£]\s?)?\d[\d.,]*\s?(?:%|\+|k\b|K\b|M\b|mil|millones|USD|MXN|EUR)?/g;
const DATE_RE = /\b(?:\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|(?:19|20)\d{2}|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|january|february|march|april|june|july|august|september|october|november|december)\b/gi;

function extractFigures(value: string): string[] {
  const out: string[] = [];
  for (const re of [FIGURE_RE, DATE_RE]) {
    for (const m of value.matchAll(re)) {
      const s = m[0].trim();
      if (s.length > 1 && !out.includes(s)) out.push(s);
    }
  }
  return out;
}

const hasMarketingVerb = (words: string[]): boolean =>
  words.some((w) => MARKETING_VERBS.has(w.toLowerCase().replace(/[^\p{L}]/gu, '')));

/** Decide si una entrada de provenance se conserva y con qué claims, mirando el valor. */
function claimsFromValue(value: unknown, modelClaims: string[]): { keep: boolean; claims: string[] } {
  if (typeof value === 'number') return { keep: true, claims: [] };
  if (typeof value !== 'string') return { keep: false, claims: [] };
  const v = value.trim();
  if (v === '#') return { keep: true, claims: [] };
  // 1) Si el modelo dio un claim que aparece textual, es el mejor: se queda.
  const literal = modelClaims.filter((c) => normWS(v).includes(normWS(String(c))));
  if (literal.length) return { keep: true, claims: literal };
  // 2) Si no, se deriva del valor: cifras/fechas resaltables.
  const figures = extractFigures(v);
  if (figures.length) return { keep: true, claims: figures };
  // 3) Valor corto sin verbo de marketing = nombre/cargo/empresa/marca: el valor entero es el hecho.
  const words = v.split(/\s+/).filter(Boolean);
  if (words.length <= 6 && !hasMarketingVerb(words)) return { keep: true, claims: [] };
  // 4) Copy largo sin cifras: no es un hecho a confirmar.
  return { keep: false, claims: [] };
}

/** Resuelve el valor de una ruta de provenance (`children[0].props.items[1].name`) contra el árbol de la
 * sección. Devuelve undefined si la ruta no resuelve (el builder ya ignora esas). */
export function valueAtPath(section: LayoutSection, path: string): unknown {
  const tokens = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur: unknown = section;
  for (const t of tokens) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[t];
  }
  return cur;
}

/** Deja la provenance en hechos resaltables: claim literal del modelo, cifras/fechas del valor, o el
 * valor entero cuando es nombre/cargo/empresa corto; descarta copy largo y rutas que no resuelven.
 * Inmutable: devuelve una sección nueva. */
export function normalizeProvenance(section: LayoutSection): LayoutSection {
  if (!section.provenance) return section;
  const out: Record<string, { claims?: string[] }> = {};
  for (const [path, entry] of Object.entries(section.provenance)) {
    const value = valueAtPath(section, path);
    const modelClaims = Array.isArray(entry?.claims) ? entry.claims.map(String) : [];
    const { keep, claims } = claimsFromValue(value, modelClaims);
    if (keep) out[path] = { claims };
  }
  return { ...section, provenance: out };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Saca la `provenance` que el modelo dejó dentro de un nodo a la sección, con la ruta del nodo como prefijo. */
function liftNode(node: unknown, path: string, out: Record<string, { claims?: string[] }>): unknown {
  if (Array.isArray(node)) return node.map((c, i) => liftNode(c, `${path}[${i}]`, out));
  if (!isObj(node)) return node;
  const { provenance, ...rest } = node;
  if (isObj(provenance)) {
    for (const [p, entry] of Object.entries(provenance)) out[`${path}.${p.replace(/^\.+/, '')}`] = isObj(entry) ? (entry as { claims?: string[] }) : {};
  }
  return Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, k === 'children' || k === 'props' || k === '$slot' || (isObj(v) && '$slot' in v) || Array.isArray(v) ? liftNode(v, `${path}.${k}`, out) : v]));
}

/** El modelo a veces escribe `provenance` dentro del nodo componente (cta-section en Nimbus 91253120) y el
 * runner rechaza la página entera ("trae provenance fuera de props"). La información es la correcta en el
 * lugar equivocado: se sube a la sección con la ruta del nodo (`children[0].props.title`). Inmutable. */
export function liftNodeProvenance(section: LayoutSection): LayoutSection {
  if (!Array.isArray(section.children)) return section;
  const lifted: Record<string, { claims?: string[] }> = {};
  const children = liftNode(section.children, 'children', lifted) as LayoutSection['children'];
  if (!Object.keys(lifted).length) return section;
  return { ...section, children, provenance: { ...lifted, ...(section.provenance ?? {}) } };
}
