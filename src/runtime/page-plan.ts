// Schema y validador del PLAN DE PÁGINA (brecha núcleo #1, ADR 0010): una llamada por brief que decide QUÉ
// secciones lleva la página (roles del vocabulario, en orden) y, por sección, qué tiene que lograr para ESE
// negocio (objetivo + prueba + avoid + peso visual). Vive en src/runtime porque lo consume el flujo de producción
// (el composer del agente y los sensores de plan); src/exp/page-plan lo re-exporta y le añade las métricas del experimento.

import { LANG_CODE, WHATSAPP_RE, type PageFacts } from './page-contract';
import { PAGE_LANGS, type PageLang } from './page-doc';

export const PROOFS = ['logos', 'stats', 'testimonial', 'demo', 'feature-detail', 'none'] as const;
export const DENSITIES = ['airy', 'normal', 'dense'] as const;
export const SURFACES = ['base', 'muted', 'raised', 'inverse'] as const;
export const EMPHASES = ['low', 'medium', 'high'] as const;
export const MOTIONS = ['none', 'entrance'] as const;
const TITLE_MAX = 120;
const DESCRIPTION_MAX = 300;
/** Secciones de contenido por página (sin marco): v0 compone 7-9; más de 10 es un brief que lista todo. */
export const MAX_SECTIONS = 10;
/** El hero va siempre: sin él no hay página (v0 lo pone aunque el brief no lo pida). */
const REQUIRED_ROLE = 'hero';

/** Bloques maduros ofrecidos por rol, con su forma (`formsByRole`, compose-layout). El plan elige uno por sección. */
export type BlockForms = Record<string, readonly { slug: string; form: string }[]>;
/** Imagen adjunta por la usuaria, ya escrita en public/images (Secondary): el plan decide en qué sección va y su alt. */
export interface PlanAttachment { id: string; name: string; width: number; height: number }
/** Imagen que una sección coloca: id de un asset de la página y el alt que describe lo que se ve. */
export interface SectionImage { id: string; alt: string }

export interface SectionPlan {
  role: string;
  /** Bloque elegido entre los ofrecidos para el rol (por su forma); ausente si el rol no ofrece varios. */
  block?: string;
  /** Adjunto que esta sección muestra, con alt honesto; ausente si ninguno le corresponde. */
  image?: SectionImage;
  /** Qué tiene que conseguir esta sección para este negocio, en una frase. */
  objective: string;
  /** Qué prueba usa para sostener el objetivo. */
  proof: (typeof PROOFS)[number];
  /** Ideas o frases de secciones anteriores que NO debe repetir. */
  avoid: string[];
  density: (typeof DENSITIES)[number];
  surface: (typeof SURFACES)[number];
  emphasis: (typeof EMPHASES)[number];
  /** Entrada animada o no; presupuesto de página (Front): como máximo una sección `entrance`. */
  motion: (typeof MOTIONS)[number];
}

/** El plan ES el contrato de página (ADR 0008): lo que v0 obtiene por contexto único (idioma, título,
 * hechos compartidos entre secciones) aquí se decide una vez y viaja como dato. title/description/facts
 * son opcionales en el parse para no tumbar un plan que solo trae secciones; el sensor mide si faltan. */
export interface PagePlan {
  lang: PageLang;
  title?: string;
  description?: string;
  facts?: PageFacts;
  /** Arco narrativo de la página en una frase (hero → prueba → cómo → cierre). */
  arc: string;
  sections: SectionPlan[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = <T extends readonly string[]>(xs: T, v: unknown): v is T[number] => typeof v === 'string' && (xs as readonly string[]).includes(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const strList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

/** El modelo a veces responde con el nombre del idioma ("English") en vez del código: se acepta y se mapea. */
const langCode = (v: unknown): PageLang | undefined => (oneOf(PAGE_LANGS, v) ? v : typeof v === 'string' ? LANG_CODE[v] : undefined);

/** Valida el pool de hechos del contrato. Listas vacías valen (una página sin logos no tiene empresas). */
export function parseFacts(raw: unknown): { facts?: PageFacts; errors: string[] } {
  if (!isObj(raw)) return { errors: ['facts: debe ser un objeto'] };
  const errors: string[] = [];
  if (!isStr(raw.brand)) errors.push('facts.brand: falta');
  const cta = raw.cta;
  if (!isObj(cta) || !isStr(cta.label) || !isStr(cta.href)) errors.push('facts.cta: se espera { label, href }');
  if (!Array.isArray(raw.figures) || !raw.figures.every((f) => isObj(f) && isStr(f.value) && isStr(f.claim))) errors.push('facts.figures: lista de { value, claim }');
  if (!strList(raw.companies)) errors.push('facts.companies: lista de nombres');
  if (!Array.isArray(raw.people) || !raw.people.every((x) => isObj(x) && isStr(x.name) && isStr(x.role) && isStr(x.company))) errors.push('facts.people: lista de { name, role, company }');
  if (raw.prices !== undefined && (!Array.isArray(raw.prices) || !raw.prices.every((x) => isObj(x) && isStr(x.plan) && isStr(x.monthly) && (x.yearly === undefined || isStr(x.yearly))))) errors.push('facts.prices: lista de { plan, monthly, yearly? }');
  if (raw.links !== undefined) {
    if (!isObj(raw.links)) errors.push('facts.links: debe ser un objeto');
    else {
      const l = raw.links;
      if (l.whatsapp !== undefined && !(typeof l.whatsapp === 'string' && WHATSAPP_RE.test(l.whatsapp))) errors.push(`facts.links.whatsapp: se espera https://wa.me/<número>, llegó ${String(l.whatsapp)}`);
      if (l.email !== undefined && !(typeof l.email === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(l.email))) errors.push('facts.links.email: correo inválido');
      if (l.phone !== undefined && !(typeof l.phone === 'string' && /^\+?[\d\s()-]{6,20}$/.test(l.phone))) errors.push('facts.links.phone: teléfono inválido');
      if (l.social !== undefined && !(Array.isArray(l.social) && l.social.every((s) => isObj(s) && isStr(s.name) && typeof s.href === 'string' && /^https:\/\//.test(s.href)))) errors.push('facts.links.social: lista de { name, href https }');
    }
  }
  return errors.length ? { errors } : { facts: raw as unknown as PageFacts, errors };
}

/** `{ id, alt }` de un adjunto de la página con alt propio; cualquier otra cosa es undefined. */
export function parseSectionImage(raw: unknown, attachments: readonly PlanAttachment[]): SectionImage | undefined {
  if (!isObj(raw) || !isStr(raw.id) || !isStr(raw.alt)) return undefined;
  return attachments.some((a) => a.id === raw.id) ? { id: raw.id, alt: raw.alt.trim().slice(0, 200) } : undefined;
}

/** Valida la salida del modelo contra el schema; devuelve los errores en vez de un plan parcial.
 * `vocabulary` son los roles que el plan puede elegir (ADR 0010): uno fuera rebota el plan entero, porque el
 * composer no sabría componerlo. `required` (opcional) exige que esos roles estén: es el modo `--role-set`,
 * donde la lista de secciones viene cerrada desde fuera y el plan solo aporta objetivo/avoid. */
export function parsePagePlan(raw: unknown, vocabulary: readonly string[], required: readonly string[] = [], forms: BlockForms = {}, attachments: readonly PlanAttachment[] = []): { plan?: PagePlan; errors: string[] } {
  const errors: string[] = [];
  if (!isObj(raw)) return { errors: ['la salida no es un objeto'] };
  const lang = langCode(raw.lang);
  if (!lang) errors.push(`lang: se espera ${PAGE_LANGS.join('|')}, llegó ${String(raw.lang)}`);
  if (typeof raw.arc !== 'string' || !raw.arc.trim()) errors.push('arc: falta');
  if (raw.title !== undefined && (!isStr(raw.title) || raw.title.length > TITLE_MAX)) errors.push(`title: texto de 1 a ${TITLE_MAX} caracteres`);
  if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > DESCRIPTION_MAX)) errors.push(`description: texto de hasta ${DESCRIPTION_MAX} caracteres`);
  const facts = raw.facts === undefined ? { errors: [] as string[] } : parseFacts(raw.facts);
  errors.push(...facts.errors);
  if (!Array.isArray(raw.sections)) return { errors: [...errors, 'sections: falta'] };
  const sections: SectionPlan[] = [];
  raw.sections.forEach((s, i) => {
    if (!isObj(s)) return errors.push(`sections[${i}]: no es un objeto`);
    if (typeof s.role !== 'string') return errors.push(`sections[${i}].role: falta`);
    if (!vocabulary.includes(s.role)) errors.push(`sections[${i}].role: ${s.role} no está en el vocabulario (${vocabulary.join('|')})`);
    if (typeof s.objective !== 'string' || !s.objective.trim()) errors.push(`sections[${i}].objective: falta`);
    if (!oneOf(PROOFS, s.proof)) errors.push(`sections[${i}].proof: ${String(s.proof)} no está en ${PROOFS.join('|')}`);
    if (!Array.isArray(s.avoid) || !s.avoid.every((a) => typeof a === 'string')) errors.push(`sections[${i}].avoid: debe ser string[]`);
    if (!oneOf(DENSITIES, s.density)) errors.push(`sections[${i}].density: ${String(s.density)}`);
    if (!oneOf(SURFACES, s.surface)) errors.push(`sections[${i}].surface: ${String(s.surface)}`);
    if (!oneOf(EMPHASES, s.emphasis)) errors.push(`sections[${i}].emphasis: ${String(s.emphasis)}`);
    if (s.motion !== undefined && !oneOf(MOTIONS, s.motion)) errors.push(`sections[${i}].motion: ${String(s.motion)} no está en ${MOTIONS.join('|')}`);
    // El bloque se valida en código: uno que no esté entre los ofrecidos para el rol se descarta sin error
    // (la sección sigue por CHOOSE_BLOCK); el modelo no puede fijar un slug que no vio.
    const { block: _drop, image: _dropImage, ...rest } = s as unknown as SectionPlan & { block?: unknown; image?: unknown };
    const block = typeof s.block === 'string' && (forms[String(s.role)] ?? []).some((b) => b.slug === s.block) ? s.block : undefined;
    // Igual que block: una imagen que no es un adjunto de la página se descarta sin error (el modelo no inventa ids).
    const image = parseSectionImage(s.image, attachments);
    sections.push({ ...rest, ...(block ? { block } : {}), ...(image ? { image } : {}), motion: oneOf(MOTIONS, s.motion) ? s.motion : 'none' });
  });
  const got = sections.map((s) => s.role);
  if (raw.sections.length < 1 || raw.sections.length > MAX_SECTIONS) errors.push(`sections: entre 1 y ${MAX_SECTIONS} secciones, llegaron ${raw.sections.length}`);
  if (!got.includes(REQUIRED_ROLE) && raw.sections.length) errors.push(`sections: falta ${REQUIRED_ROLE}`);
  const missing = required.filter((r) => !got.includes(r));
  if (missing.length) errors.push(`faltan secciones: ${missing.join(', ')}`);
  if (errors.length || !lang) return { errors };
  return {
    plan: {
      lang,
      arc: String(raw.arc),
      sections,
      ...(isStr(raw.title) ? { title: raw.title.trim() } : {}),
      ...(typeof raw.description === 'string' && raw.description.trim() ? { description: raw.description.trim() } : {}),
      ...(facts.facts ? { facts: facts.facts } : {}),
    },
    errors,
  };
}

export const PLAN_SYSTEM = [
  'Eres el director de diseño de una landing page. Antes de que nadie componga una sección, escribes el PLAN DE PÁGINA para este negocio concreto: qué secciones lleva la página y en qué orden, qué tiene que lograr cada una, con qué prueba, qué no debe repetir de las anteriores, y su peso visual.',
  'Responde SOLO con un objeto JSON, sin texto alrededor, con este schema exacto:',
  '{ "lang": "<es|en|pt>", "title": "<título del documento: marca + propuesta, 1-120 caracteres>", "description": "<meta description, hasta 300 caracteres>", "arc": "<una frase con el arco de la página>", "facts": { "brand": "<nombre del negocio tal como se escribe>", "cta": { "label": "<etiqueta de la acción principal>", "href": "#<rol de la sección destino>" }, "figures": [ { "value": "<cifra con unidad: 4,000+, 38%, 6.5 hrs>", "claim": "<qué afirma>" } ], "companies": ["<marca ficticia>"], "people": [ { "name": "<nombre>", "role": "<cargo>", "company": "<una de companies>" } ], "prices": [ { "plan": "<plan>", "monthly": "<$12>", "yearly": "<$10>" } ], "links": { "whatsapp": "https://wa.me/<número>", "email": "<correo>", "phone": "<teléfono>", "social": [ { "name": "<red>", "href": "https://…" } ] } }, "sections": [ { "role": "<rol del vocabulario>", "block": "<slug elegido en forms[rol], solo si el rol está en forms>", "image": { "id": "<id de attachments>", "alt": "<qué se ve, honesto>" }, "objective": "<una frase: qué consigue esta sección para ESTE negocio>", "proof": "logos|stats|testimonial|demo|feature-detail|none", "avoid": ["<idea o frase de secciones anteriores que no repite>"], "density": "airy|normal|dense", "surface": "base|muted|raised|inverse", "emphasis": "low|medium|high", "motion": "none|entrance" } ] }',
  'SECCIONES: elige las secciones de ESTA página usando solo roles de `vocabulary`. Si el brief las enumera, son esas, en su orden, con el rol del vocabulario que mejor encaje (beneficios o funciones → features; cómo funciona o pasos → steps; casos de éxito con métricas → cases; testimonios o reseñas → testimonials; precios o planes → pricing; preguntas frecuentes → faq; integraciones → integrations; contacto → contact; logos de clientes → logos; cifras → stats). Si no las enumera, elige las mínimas que el negocio necesita: hero, entre 2 y 5 de contenido, y cta. No añadas logos, stats ni testimonials si el brief no da motivo. Un rol puede repetirse si el brief lo pide (dos bloques de beneficios distintos). Navbar y footer no se listan: van siempre.',
  'FORMA: `forms` trae, por rol, los bloques disponibles con su forma (columnas, imagen, alineación). Para cada sección cuyo rol está en `forms`, elige en `block` el slug cuya forma mejor sirve al objective y al contenido de esa sección (con foto o métricas → una forma con imagen o cifras; lista de puntos → columnas o cards). Si el rol no está en `forms`, omite `block`.',
  'ADJUNTOS: `attachments` son las imágenes que la usuaria adjuntó (id, nombre de archivo, tamaño). TODAS van en la página: cada una en la sección donde más sirve (una infografía del proceso → steps; una captura del producto → hero o features; un logo o foto de equipo → donde encaje), una por sección, como `image: { id, alt }` con un alt que describe lo que se ve, nunca el nombre del archivo. Si no hay `attachments`, omite `image`.',
  'CANAL: `facts.links` son los únicos destinos externos de la página. Si el brief pide conversión, contacto, pedidos o demo por WhatsApp, `facts.links.whatsapp` es `https://wa.me/<número>` con el número del brief (solo dígitos, con país); si el brief no da número, exactamente `https://wa.me/5215500000000` (queda como dato a confirmar). Entonces `facts.cta.href` es ese enlace con `?text=<mensaje corto en el idioma, codificado>` en vez de un ancla. Correo, teléfono y redes solo si el brief los da; si no, omite la clave.',
  'Reglas: `hero` va siempre y primero. El objetivo es específico del negocio y del público (no "mostrar las funciones": decir cuáles y por qué importan a ese cliente). La prueba cambia entre secciones: dos secciones seguidas no usan la misma. `avoid` acumula lo ya dicho. `surface: inverse` es la sección oscura; como máximo una. `emphasis: high` como máximo en dos secciones. `motion: entrance` como máximo en una sección; el resto `none`. `facts` es UN solo juego de datos plausibles para TODA la página (como haría un redactor en un solo documento): 4-6 cifras con unidad, 5-7 marcas ficticias, 2-3 personas con cargo en esas marcas, precios solo si hay pricing; las secciones los citarán textual y no inventarán otros. `facts.cta.href` apunta a una sección elegida (`#pricing`, `#cta`). `title` y `description` van en `lang`. Escribe en el idioma del brief.',
].join('\n');

/** Entrada del modelo: el brief tal cual y el vocabulario de roles entre los que decide (ADR 0010). */
export const planUserJson = (brief: { summary: string; goal?: string; tone?: string; name?: string }, vocabulary: readonly string[], forms: BlockForms = {}, attachments: readonly PlanAttachment[] = []): string => JSON.stringify({ brief, vocabulary, ...(Object.keys(forms).length ? { forms } : {}), ...(attachments.length ? { attachments } : {}) });
