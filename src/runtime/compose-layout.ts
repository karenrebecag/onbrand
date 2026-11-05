// Emit de layout del modo v0: el agente deja de emitir parts[] planas y emite el ÁRBOL acotado de
// layout (LayoutSection de layout.ts) — maqueta alrededor de los componentes del DS sin tocar su
// interior. Es la mitad que faltaba: sin esto "componer" era elegir bloques; con esto el agente
// escribe orden, grid, stack, espaciado, contenedor y fondo, todo por token. Un archivo por sección,
// como v0. El verify corre dentro del loop y su feedback vuelve al agente (el AutoFix de v0).

import type { AllowEntry } from '../ds-skill';
import type { JsonSchema } from './verify';
import type { LayoutChild, LayoutSection, PageAsset } from './layout';
import { shortlist } from './retrieve';
import { FILL_RULE, HREF_RULE, PROVENANCE_RULE } from './content-rules';
import { type DsLayoutPolicy } from './layout-check';

/** Verdict mínimo que el verify de layout (check_layout de M-TOOLS) devuelve. Si trae fix determinista
 * se aplica; si no, su feedback vuelve al prompt para el reintento. */
export interface LayoutVerdict {
  ok: boolean;
  feedback: string;
  fix?: { section: LayoutSection };
}
export type LayoutVerifyFn = (section: LayoutSection, allowlist: Record<string, AllowEntry>) => LayoutVerdict;

const LAYOUT_RULE = (role: string, policy?: DsLayoutPolicy) => `

Compón UNA SOLA sección, la de rol "${role}", para ESTE negocio, MAQUETÁNDOLA como un árbol de layout.

Salida: SOLO un objeto JSON con esta forma (sin texto alrededor):
{"role":"${role}","width":"prose|content|wide|full","surface":"base|muted|raised","padding":"none|sm|md|lg","children":[...],"provenance":{"<ruta del prop inventado>":{"claims":["<hecho>"]}}}

children[] es un árbol. Cada hijo es uno de:
- NODO DE LAYOUT (maqueta, no es contenido):
  - {"layout":"stack","gap":"<space>","align":"start|center|end|stretch","children":[...]}  columna vertical
  - {"layout":"grid","cols":2 | {"base":1,"md":2,"lg":3},"gap":"<space>","children":[...]}  rejilla de columnas iguales (cols ∈ 1,2,3,4,6)
  - {"layout":"cluster","gap":"<space>","justify":"start|center|end|between","children":[...]}  fila que se envuelve: botones, badges, logos
  - {"layout":"split","ratio":"1:1|1:2|2:1","gap":"<space>","children":[A,B]}  dos columnas (texto | visual), se apilan en mobile
- NODO DE TEXTO de página (titulares y bajadas; Arc no tiene componente de tipografía):
  - {"text":"display|title|subtitle|body|caption","value":"<texto del negocio>","align":"start|center"}
- COMPONENTE del índice, por su slug EXACTO: {"component":"<slug>","props":{...}}
  - Para meter nodos dentro de un prop que el índice marca como slot (accepts), envuélvelo: {"$slot": nodo} o {"$slot":[nodo,nodo]}. Nunca metas un nodo en un prop que no sea slot.

<space> ∈ none|xs|sm|md|lg|xl|2xl. Espaciado SIEMPRE por este enum, nunca px ni valores propios.

Reglas DURAS:
- Solo slugs del índice, solo props reales. Nunca inventes componentes, props ni clases CSS.
- Nunca reescribes el interior de un componente: lo nombras por slug y le pasas props/slots.
- Si un componente declara un prop de título o etiqueta, el texto va en ESE prop, nunca como nodo text hijo; los hijos/slot son solo el cuerpo. Un prop required sin valor rebota la sección.
- Un componente kind:"block" (lo dice el índice) trae su propio contenedor: va como ÚNICO hijo directo de la sección, nunca dentro de un layout ni de un slot. Dentro de un layout o slot solo van componentes kind:"component", texto o más layout.
- ${FILL_RULE}
- ${PROVENANCE_RULE}
- ${HREF_RULE}
- Maqueta de verdad: agrupa, alinea y espacia. Dos negocios distintos dan árboles distintos.${policy?.sectionHeaderAlign ? `\n- La alineación de la cabecera de sección (titular y bajada) la fija el DS: align "${policy.sectionHeaderAlign}" en esos nodos text y en su stack.` : ''}${policy?.icons?.length ? `\n- ICONOS: un icono es un nodo {"component":"icon:<set>/<Nombre>"}, en un layout o dentro de un slot. En una grilla de items (funciones, pasos, líneas de un plan) cada item lleva uno a la cabeza. Usa SOLO estos: ${policy.icons.join(', ')}. Nunca inventes el nombre.` : ''}`;

/** Loop por sección que emite el árbol de layout. Reusa el patrón de composeSectionBySection: una
 * llamada por rol, verify dentro del loop, feedback al reintento. */
/** Bloque de instrucciones del usuario (feature "Instructions" del menú +). Va después del SKILL.md y
 * antes de la tarea: mandan sobre estilo y copy, NUNCA sobre el DS (allowlist/schema), igual que el
 * "can't be verified → don't use" de v0. */
const INSTRUCTIONS_BLOCK = (rules: string[]): string =>
  rules.length
    ? `\n\nINSTRUCCIONES DEL USUARIO (mandan sobre estilo y copy; nunca sobre los componentes, props o tokens válidos del design system):\n${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}`
    : '';

/** Marcadores por idioma. Los únicos de un idioma (¿ ¡ ñ en español; ã õ você não en portugués)
 * desempatan; el resto son palabras función frecuentes. */
const LANG_MARKERS: Record<string, string[]> = {
  español: ['¿', '¡', 'ñ', ' el ', ' la ', ' los ', ' las ', ' una ', ' para ', ' con ', ' que ', ' tu ', ' su '],
  português: ['ã', 'õ', ' você ', ' não ', ' com ', ' para ', ' uma ', ' seu ', ' sua ', ' já '],
  English: [' the ', ' and ', ' for ', ' with ', ' your ', ' you ', ' to ', ' of ', ' is ', ' this '],
};
/** Detecta el idioma del brief UNA vez para fijarlo en todas las secciones. Empate -> español (contexto
 * de los briefs, mayormente es). Determinista: misma entrada, mismo idioma en toda la página. */
export function detectLanguage(text: string): string {
  const t = ` ${text.toLowerCase()} `;
  let best = 'español';
  let bestScore = -1;
  for (const [lang, marks] of Object.entries(LANG_MARKERS)) {
    const score = marks.reduce((n, m) => n + (t.split(m).length - 1), 0);
    if (score > bestScore) { bestScore = score; best = lang; }
  }
  return best;
}

/** Fija el idioma de TODO el contenido de la página. Va en el system de cada sección para que no se
 * mezclen idiomas entre secciones (el bug de hero en inglés con el resto en español). */
const LANG_BLOCK = (lang: string): string =>
  `\n\nIDIOMA: escribe TODO el texto (titulares, copy, botones, labels) en ${lang}. El MISMO idioma en todas las secciones; nunca mezcles idiomas.`;

/** La imagen de producto ya existe (paso de imagen del motor, antes de componer): la sección solo la
 * coloca, por id. src/alt/tamaño los pone el motor, así el modelo nunca escribe una URL. */
const IMAGE_BLOCK = (asset: PageAsset | undefined): string =>
  asset
    ? `\n\nIMAGEN DE PRODUCTO: ya está generada ("${asset.alt}"). Colócala como el visual de esta sección con el nodo {"image":"${asset.id}"}: dentro del slot de visual del componente (un prop cuyo schema acepta media, envuelto como {"$slot":{"image":"${asset.id}"}}) o en un split junto al texto. No escribas src ni URL. No inventes otras imágenes.`
    : '';

/** Prop slot de un block cuyo schema acepta media (`x-slot.accepts`): donde va el visual del hero. */
export function mediaSlotOf(schema: JsonSchema | null): string | undefined {
  const props = (schema as { properties?: Record<string, { 'x-slot'?: { accepts?: unknown } }> } | null)?.properties ?? {};
  return Object.entries(props).find(([, v]) => Array.isArray(v?.['x-slot']?.accepts) && (v['x-slot']!.accepts as unknown[]).includes('media'))?.[0];
}

const hasImage = (n: unknown): boolean =>
  Array.isArray(n) ? n.some(hasImage) : !!n && typeof n === 'object' && ('image' in n || Object.values(n).some(hasImage));

function resolveImages(n: unknown, asset: PageAsset): unknown {
  if (Array.isArray(n)) return n.map((x) => resolveImages(x, asset));
  if (!n || typeof n !== 'object') return n;
  const o = n as Record<string, unknown>;
  if (o.image === asset.id) return { image: asset.id, src: `/images/${asset.file}`, alt: asset.alt, width: asset.width, height: asset.height };
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, resolveImages(v, asset)]));
}

/** Deja la imagen lista para el runner. El hero SIEMPRE la lleva como visual principal (decisión de QA,
 * como v0): si el modelo no la puso, va al slot de media del componente único de la sección (fijado o
 * elegido por el modelo), o, en un árbol, a un split texto|imagen. Es determinista: el asset existe y el
 * lugar también. Luego rellena src/alt/tamaño. */
export function placeImage(section: LayoutSection, asset: PageAsset, schemaOf?: (slug: string) => JsonSchema | null): LayoutSection {
  let out = section;
  const [only] = section.children;
  const loneComponent = section.children.length === 1 && !!only && 'component' in only;
  const mediaProp = loneComponent && schemaOf ? mediaSlotOf(schemaOf(only.component)) : undefined;
  if (!hasImage(section.children)) {
    if (mediaProp && loneComponent) {
      out = { ...section, children: [{ ...only, props: { ...(only.props ?? {}), [mediaProp]: { $slot: { image: asset.id } } } }] };
    } else if (!loneComponent && section.children.length) {
      out = { ...section, children: [{ layout: 'split', ratio: '1:1', gap: 'xl', align: 'center', children: [{ layout: 'stack', gap: 'md', children: section.children as LayoutChild[] }, { image: asset.id }] }] };
    }
  }
  return resolveImages(out, asset) as LayoutSection;
}

/** La categoría de SECCIÓN de landing de cada rol en el registry (pin 89e34). El gate de categoría es
 * necesario (QA): `features` tiene 34 blocks pero solo 2 son `feature-sections` (secciones de landing);
 * los 32 `features-sections` son showcases de app (ai-chat, market-terminal, wallet-card...) que pasan
 * schema+capacidad y fijarían un trading terminal como sección de features. Un rol fuera de esta tabla
 * no tiene block de sección → 0 candidatos → árbol. */
const LANDING_CATEGORY: Record<string, string> = {
  hero: 'hero-header-sections',
  logos: 'logo-sections',
  features: 'feature-sections',
  steps: 'steps-sections',
  testimonials: 'testimonial-sections',
  pricing: 'pricing-sections',
  faq: 'faq-sections',
  cta: 'cta-sections',
  stats: 'stats-sections',
  // Roles del vocabulario del plan (ADR 0010): sus categorías Relume; hoy sin block maduro → árbol.
  cases: 'testimonial-sections',
  integrations: 'logo-sections',
  contact: 'contact-sections',
  footer: 'footers',
  navbar: 'navbars',
};
/** Un block del rol se usa SIN preguntarle al modelo cuando está MADURO: su render verificó con residuo 0.
 * El render-gate por bloque (Secondary, index@226c7a) mide SOLO el render: renderGate llega 'ok'/'fail'/'none'
 * y deja static/schemaDemo en 'none' (no medidos) salvo donde se corrieron. La madurez exige renderGate 'ok'
 * (fail = demo que no renderiza, none = block sin medir → árbol u otro candidato) y descarta static/schemaDemo
 * solo cuando dieron 'fail'; 'none' (no medido) no descalifica — si no, con este runner ningún ok-block pasaría. */
function isMatureBlock(e: AllowEntry | undefined, role: string): boolean {
  if (!e || e.kind !== 'block' || e.propless) return false;
  // usage (ADR 0001 2-layer) manda cuando lo publica el registry: solo 'section' es sección de landing,
  // 'showcase' es interior. Mientras no llegue (ausente hoy), cae al gate por categoría de landing del rol.
  if (e.usage ? e.usage !== 'section' : e.category !== LANDING_CATEGORY[role]) return false;
  const g = e.gates;
  return !!g && g.renderGate === 'ok' && g.static !== 'fail' && g.schemaDemo !== 'fail';
}

export interface BlockForm { slug: string; form: string }

/** Maduros por rol con su forma, para que el plan elija bloque por intención viendo la página entera (no
 * sección a sección: el loop compone en paralelo y la sección i no ve la forma de i-1). Mismos candidatos
 * que ofrece composeOneSection; el filtro de imagen del hero no se aplica aquí porque necesita schemas, y un
 * bloque elegido que lo incumpla cae a CHOOSE_BLOCK al componer. Roles con menos de 2 no tienen elección. */
export function formsByRole(allow: Record<string, AllowEntry>, roles: readonly string[]): Record<string, BlockForm[]> {
  const out: Record<string, BlockForm[]> = {};
  for (const role of new Set(roles)) {
    const ripe = shortlist(role, '', allow).blocks.filter((b) => isMatureBlock(allow[b], role));
    if (ripe.length >= 2) out[role] = ripe.map((slug) => ({ slug, form: allow[slug].form ?? '' }));
  }
  return out;
}
