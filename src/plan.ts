// Brief -> plan de secciones (máx 3 strips). Decide QUÉ secciones pide la página antes de buscar.
// v0: si el brief fija `sections`, se respeta (recortado a 3). Si no, se infieren por palabras clave
// del summary/goal, con un piso sensato (hero + features + cta) — el esqueleto que casi toda landing
// necesita. Mantener corto a propósito.

import type { BrandComposition, Density } from './brand';
import type { Brief, FrameRole, Role, RoleSpec, SectionRole } from './types';

/** Rol -> categoría del MCP Relume + tags que un buen ejemplar de ese rol suele tener. */
// Tags verificados contra el MCP (no inventados). Relume NO tiene categoría de "steps/cómo
// funciona" — timelines es cronología (tag "Date"); así que steps es una variante DISTINTA de
// feature-sections (2 columnas / text-only) para no duplicar el feature-grid de features.
const ROLE_SPEC: Record<Role, Omit<RoleSpec, 'role'>> = {
  hero: { category: 'hero-header-sections', desiredTags: ['2 Columns', 'Buttons', 'Image'] },
  features: { category: 'feature-sections', desiredTags: ['3 Columns', 'Icons'] },
  steps: { category: 'feature-sections', desiredTags: ['2 Columns', 'Text Only'], undesiredTags: ['Background Image'] },
  // un CTA que agenda/contacta: botón, NO un form de newsletter (contradice la intención).
  cta: { category: 'cta-sections', desiredTags: ['Buttons', '1 Column'], undesiredTags: ['Form', 'Newsletter Sign Up', 'Newsletter'] },
  testimonials: { category: 'testimonial-sections', desiredTags: ['Star Rating'], undesiredTags: ['Slider'] },
  pricing: { category: 'pricing-sections', desiredTags: ['Cards'] },
  faq: { category: 'faq-sections', desiredTags: ['Accordion'] },
  logos: { category: 'logo-sections', desiredTags: ['Logos'] },
  stats: { category: 'stats-sections', desiredTags: ['Stats Section', '3 Columns'] },
  // marco (chrome)
  navbar: { category: 'navbars', desiredTags: ['Logo Left', 'Navbar'] },
  footer: { category: 'footers', desiredTags: ['4 Columns', 'Footer'] },
  banner: { category: 'banners', desiredTags: ['Buttons', 'Announcement Banner'] },
};

/** Intención dominante del brief. Cambia QUÉ desea cada rol: una landing de waitlist abre con
 * captura de email (no un hero de botones) y cierra con un form de suscripción (no un CTA que
 * agenda). Sin esto, el finding tiene un solo arquetipo cableado (demo) y nunca elige los bloques
 * de otra intención. Es el stand-in determinista de la clasificación por intención que hará el LLM. */
export type BriefIntent = 'demo' | 'waitlist';

const WAITLIST_RE = /\b(waitlist|wait[- ]?list|lista de espera|early[- ]access|acceso anticipado|join the beta|early bird|s(ú|u)mate a la lista)\b/i;

export function briefIntent(brief: Brief): BriefIntent {
  return WAITLIST_RE.test(`${brief.summary} ${brief.goal ?? ''}`) ? 'waitlist' : 'demo';
}

/** Overrides por intención sobre ROLE_SPEC: solo los roles que cambian; el resto hereda el base.
 * waitlist clava el hero en captura de email y limpia la penalización de Form del cta (ahí un form
 * de suscripción SÍ es la intención correcta). No se tocan los tags de los bloques, solo el deseo. */
const INTENT_OVERRIDES: Record<BriefIntent, Partial<Record<Role, Partial<Omit<RoleSpec, 'role'>>>>> = {
  demo: {},
  waitlist: {
    hero: { desiredTags: ['Email Capture', 'Form', '1 Column'] },
    cta: { desiredTags: ['Form', 'Newsletter Sign Up', '1 Column'], undesiredTags: [] },
  },
};

/** Resuelve el spec de un rol: base de ROLE_SPEC ← sesgo de marca (composition) ← override de la
 * intención. La intención se aplica al final, así que GANA en claves en conflicto (el propósito de
 * la página manda sobre la preferencia de marca; ADR 0003). */
function specFor(role: Role, intent: BriefIntent, composition?: BrandComposition, formByRole?: Record<string, string[]>): RoleSpec {
  const base: RoleSpec = {
    role,
    ...ROLE_SPEC[role],
    ...(composition?.roles?.[role] ?? {}),
    ...(INTENT_OVERRIDES[intent][role] ?? {}),
  };
  // Puente contenido->forma: los tags derivados del contenido se SUMAN a los deseados (el scorer ya
  // los pondera). Así dos secciones con forma distinta dejan de empatar. Ausente = spec base de hoy.
  const form = formByRole?.[role] ?? [];
  if (!form.length) return base;
  return { ...base, desiredTags: [...new Set([...base.desiredTags, ...form])] };
}

/** Señales de texto -> rol. El primer match (en orden) de cada rol lo activa. */
const KEYWORDS: Array<[SectionRole, RegExp]> = [
  ['pricing', /\b(pricing|planes?|precios?|tiers?|subscription|suscripci)/i],
  ['faq', /\b(faq|preguntas?|dudas?)/i],
  ['testimonials', /\b(testimoni|rese(ñ|n)as?|clientes dicen|opiniones)/i],
  ['logos', /\b(logos?|marcas|trusted by|confian)/i],
  ['stats', /\b(stats?|m(é|e)tricas?|cifras|n(ú|u)meros|resultados|kpis?)/i],
  ['steps', /\b(c(ó|o)mo funciona|how it works|pasos|steps|proceso|onboarding)/i],
  ['features', /\b(features?|beneficios?|caracter(í|i)sticas?|qu(é|e) hace)/i],
];

const DEFAULT: SectionRole[] = ['hero', 'features', 'cta'];
const MAX_STRIPS = 3;

/** Orden narrativo canónico de una landing. El orden de la página sale de aquí, NO del orden en
 * que una regex detectó cada rol (antes stats caía antes de features). */
const CANONICAL_ORDER: SectionRole[] = ['hero', 'logos', 'features', 'steps', 'stats', 'testimonials', 'pricing', 'faq', 'cta'];
const orderIndex = (r: SectionRole): number => {
  const i = CANONICAL_ORDER.indexOf(r);
  return i === -1 ? CANONICAL_ORDER.length : i;
};

/** Dedup preservando orden. */
function uniq(roles: SectionRole[]): SectionRole[] {
  const seen = new Set<SectionRole>();
  return roles.filter((r) => (seen.has(r) ? false : (seen.add(r), true)));
}

/** Decide los roles de la página. hero siempre abre; cta siempre cierra si hay espacio.
 * El tope es brief.maxStrips (default 3): una landing completa lo sube. */
/** density de la marca -> tope de strips y perfil de ritmo. El brief gana: si fija maxStrips, la
 * densidad no lo pisa (propósito sobre preferencia, igual que marca<-intent). 'default'/ausente =
 * comportamiento actual. */
const DENSITY_CAP: Record<Density, number> = { compact: 2, default: 3, spacious: 4 };
export const capForDensity = (d?: Density): number | undefined => (d ? DENSITY_CAP[d] : undefined);

export function planSections(brief: Brief, composition?: BrandComposition, formByRole?: Record<string, string[]>): RoleSpec[] {
  const cap = Math.max(1, brief.maxStrips ?? capForDensity(composition?.density) ?? MAX_STRIPS);
  let roles: SectionRole[];
  if (brief.sections?.length) {
    roles = uniq(brief.sections);
  } else {
    const text = `${brief.summary} ${brief.goal ?? ''}`;
    const inferred = KEYWORDS.filter(([, re]) => re.test(text)).map(([role]) => role);
    // hero abre siempre; luego lo inferido; cta cierra si no está ya.
    roles = uniq(['hero', ...inferred, 'cta']);
    if (inferred.length === 0) roles = DEFAULT;
  }
  // Orden narrativo canónico (no el orden de detección).
  roles = [...roles].sort((a, b) => orderIndex(a) - orderIndex(b));
  // Recorte al tope conservando el hero (apertura) y el cta (cierre) si están presentes.
  if (roles.length > cap) {
    const hasCta = roles.includes('cta');
    const head = roles.filter((r) => r !== 'cta').slice(0, hasCta ? cap - 1 : cap);
    roles = hasCta ? [...head, 'cta'] : head;
  }
  const intent = briefIntent(brief);
  return roles.map((role) => specFor(role, intent, composition, formByRole));
}

/** Marco de la página: navbar + footer siempre; banner solo si el brief anuncia algo (promo,
 * lanzamiento, oferta). El banner no es decoración: si no hay anuncio, no va. */
const ANNOUNCE_RE = /\b(lanza|launch|promo|oferta|descuento|anuncio|announc|nuevo|new release|beta)/i;

export function planFrame(brief: Brief, composition?: BrandComposition, formByRole?: Record<string, string[]>): RoleSpec[] {
  const roles: FrameRole[] = [];
  if (ANNOUNCE_RE.test(`${brief.summary} ${brief.goal ?? ''}`)) roles.push('banner');
  roles.push('navbar', 'footer');
  const intent = briefIntent(brief);
  return roles.map((role) => specFor(role, intent, composition, formByRole));
}

export { ROLE_SPEC, MAX_STRIPS };
