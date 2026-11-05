// Inyector de copy SLOT-DRIVEN, calcado del modelo Relume (editor de-ofuscado 2026-10-12,
// docs/research/runner-e2e-arquitectura.md): una sección se llena leyendo SU esquema de contenido
// (aquí `manifest.props`) y poniendo copy real en CADA slot, fiteado a un presupuesto de longitud
// (el `text-fit-1` de Relume, derivado con jq de los Defaults del bloque: src/copygen/budget.ts).
// Así el wireframe sale content-complete: ningún prop cae al default
// inglés de Relume ni al Lorem ipsum. El estilo es una pasada posterior (tokens Arc), no aquí.
//
// A diferencia de un template por rol, esto recorre los props declarados y mapea cada uno por su
// SEMÁNTICA (nombre + tipo). Lo que no reconoce se llena vacío o con placeholder, nunca con el
// default del componente. Regla de imágenes: todo slot de imagen va al placeholder de Relume + alt
// semántico (la capa de imágenes lo resuelve); los Defaults traen logos de Webflow que, sin esto,
// se filtrarían. Es el fallback de `propsFor` para bloques Relume no curados.

import type {
  FeatureItem, PricingPlan, RoleCopy, StatItem, StepItem, TestimonialItem,
} from '../copy';
import { fitToBudget, type Budget } from '../copygen/budget';
import { budgetFor, semanticOf, type SlotBudgets, type Semantic } from '../copygen/slot-model';
import type { CatalogEntry, ManifestProp } from './schema';

const PLACEHOLDER = 'https://d22po4pjz3o32e.cloudfront.net/placeholder-image.svg';
const img = (alt: string) => ({ src: PLACEHOLDER, alt });

// Claves que no son copy (HTML de términos, URLs) y no se recortan.
const UNFITTED = new Set(['termsandconditions', 'url', 'href', 'src', 'alt']);

// Holgura al FITEAR copy ya escrita (archivo/LLM): un titular real varía más que el placeholder del
// bloque. Sin esto se cortaba a mitad de frase ("…y recupera" en vez de "…y recupera cada venta").
// No toca la generación (budgetFor sigue derivando el tope del Default); solo evita el corte al fitear.
const FIT_TOLERANCE: Partial<Record<Semantic, number>> = { heading: 1.6, tagline: 1.5 };
const tolerantFit = (semantic: Semantic, budgets: SlotBudgets | undefined): Budget => {
  const b = budgetFor(semantic, budgets);
  const tol = FIT_TOLERANCE[semantic];
  return tol && b.unit === 'words' ? { unit: 'words', n: Math.ceil(b.n * tol) } : b;
};

/** Text-fit sobre toda hoja string con semántica reconocida (recursivo, inmutable). El presupuesto es
 * el jq del default del propio bloque para esa semántica, o el canon Relume si el bloque no lo trae. */
export function fitProps<T>(value: T, budgets: SlotBudgets | undefined, path: string[] = []): T {
  if (typeof value === 'string') {
    const leaf = path[path.length - 1] ?? '';
    if (UNFITTED.has(leaf.toLowerCase())) return value;
    const semantic = semanticOf(path);
    return (semantic ? fitToBudget(value, tolerantFit(semantic, budgets)) : value) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => fitProps(v, budgets, path)) as unknown as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fitProps(v, budgets, [...path, k])])) as unknown as T;
  }
  return value;
}

/** Contenido agnóstico de un rol, con proveedores por semántica. Las listas solo existen en los roles
 * que las tienen. `undefined` si el rol no trae copy (el bloque queda con sus Defaults). */
export interface RoleContent {
  brand: string;
  heading: string;
  description: string;
  tagline: string;
  buttons: { title: string; variant?: string }[];
  features?: FeatureItem[];
  stats?: StatItem[];
  pricing?: PricingPlan[];
  testimonials?: TestimonialItem[];
  faq?: { question: string; answer: string }[];
  faqContact?: { heading: string; description: string; cta: string };
  steps?: StepItem[];
  logos?: string[];
  columns?: { title: string; links: string[] }[];
  legal?: string[];
  navLinks?: string[];
}

const ctaButtons = (primary: string, secondary?: string) =>
  [{ title: primary }, ...(secondary ? [{ title: secondary, variant: 'secondary' }] : [])];

export function contentFor(entry: CatalogEntry, copy: RoleCopy): RoleContent | undefined {
  const brand = copy.navbar?.brand ?? copy.footer?.brand ?? copy.hero?.heading ?? 'Producto';
  switch (entry.role) {
    case 'hero':
      return copy.hero && { brand, heading: copy.hero.heading, description: copy.hero.description, tagline: '', buttons: ctaButtons(copy.hero.primaryCta, copy.hero.secondaryCta) };
    case 'features':
      return copy.features && { brand, heading: copy.features.heading, description: copy.features.description, tagline: '', buttons: [], features: copy.features.items };
    case 'cta':
    case 'banner':
      return copy.cta && { brand, heading: copy.cta.heading, description: copy.cta.description, tagline: '', buttons: ctaButtons(copy.cta.primaryCta, copy.cta.secondaryCta) };
    case 'stats':
      return copy.stats && { brand, heading: copy.stats.heading, description: '', tagline: '', buttons: [], stats: copy.stats.stats };
    case 'pricing':
      return copy.pricing && { brand, heading: copy.pricing.heading, description: copy.pricing.description ?? '', tagline: copy.pricing.tagline ?? '', buttons: [], pricing: copy.pricing.plans };
    case 'testimonials':
      return copy.testimonials && { brand, heading: copy.testimonials.heading, description: copy.testimonials.description ?? '', tagline: '', buttons: [], testimonials: copy.testimonials.items };
    case 'faq':
      return copy.faq && { brand, heading: copy.faq.heading, description: copy.faq.description ?? '', tagline: '', buttons: [], faq: copy.faq.items, ...(copy.faq.contact ? { faqContact: copy.faq.contact } : {}) };
    case 'logos':
      return copy.logos && { brand, heading: copy.logos.heading, description: '', tagline: '', buttons: [], logos: copy.logos.brands };
    case 'steps':
      return copy.steps && { brand, heading: copy.steps.heading ?? '', description: '', tagline: '', buttons: [], steps: copy.steps.steps };
    case 'navbar':
      return copy.navbar && { brand, heading: brand, description: '', tagline: '', buttons: ctaButtons(copy.navbar.primaryCta, copy.navbar.secondaryCta), navLinks: copy.navbar.links };
    case 'footer':
      return copy.footer && { brand, heading: brand, description: copy.footer.tagline ?? '', tagline: '', buttons: [], columns: copy.footer.columns, ...(copy.footer.legal ? { legal: copy.footer.legal } : {}) };
    default:
      return undefined;
  }
}

const has = (s: string, ...needles: string[]): boolean => needles.some((n) => s.includes(n));
const statText = (s: StatItem): string => `${s.prefix ?? ''}${s.value}${s.suffix ?? ''}`;
const linkList = (labels: string[]) => labels.map((title) => ({ title, url: '#' }));

/** Mapea UN prop declarado a su valor desde el contenido del rol, por semántica (nombre + tipo).
 * Devuelve `{ set: false }` para dejar el default del componente (p. ej. contadores numéricos o
 * iconos sociales, que no renderizan texto inglés). */
function valueFor(prop: ManifestProp, c: RoleContent): { set: true; value: unknown } | { set: false } {
  const n = prop.name.toLowerCase();
  const t = prop.type;
  const set = (value: unknown) => ({ set: true as const, value });
  const skip = { set: false as const };

  // Imágenes: siempre placeholder + alt semántico (nunca el logo de Webflow del Default).
  if (/ImageProps/.test(t) || has(n, 'image', 'logo', 'avatar', 'icon', 'photo', 'picture')) {
    const one = has(n, 'logo') ? img(`Logo de ${c.brand}`) : has(n, 'avatar') ? img(c.testimonials?.[0]?.name ?? c.brand) : img(c.heading || c.brand);
    if (/\[\]/.test(t)) {
      if (c.logos) return set(c.logos.map((b) => img(`Logo de ${b}`)));
      return set([one, img(c.heading || c.brand), img(c.brand)]);
    }
    // navbar/footer logo lleva url además de src/alt.
    return set(has(n, 'logo') && (c.navLinks || c.columns) ? { url: '#', ...one } : one);
  }

  // Listas de dominio (array de objetos) por rol.
  if (/\[\]/.test(t) || has(n, 'testimonials', 'pricingplans', 'questions', 'stats', 'features', 'sections', 'cards', 'navlinks', 'links', 'buttons')) {
    if (has(n, 'button') && c.buttons.length) return set(c.buttons);
    if (has(n, 'button')) return set([]);
    if (has(n, 'navlink') && c.navLinks) return set(linkList(c.navLinks));
    if (has(n, 'columnlink') && c.columns) return set(c.columns.map((col) => ({ title: col.title, links: linkList(col.links) })));
    if (has(n, 'footerlink') && c.legal) return set(linkList(c.legal));
    if (has(n, 'social')) return skip; // iconos, no texto inglés
    if (has(n, 'link') && c.navLinks) return set(linkList(c.navLinks));
    if (has(n, 'testimonials') && c.testimonials) return set(c.testimonials.map(testimonialItem));
    if (has(n, 'pricingplans') && c.pricing) return set(c.pricing.map(pricingPlan));
    if (has(n, 'questions') && c.faq) return set(c.faq.map((q) => ({ title: q.question, answer: q.answer })));
    if (has(n, 'stats') && c.stats) return set(c.stats.map((s) => ({ percentage: statText(s), heading: s.label })));
    if ((has(n, 'sections') || has(n, 'steps')) && c.steps) return set(c.steps.map((s) => ({ tagline: s.tagline, heading: s.title, description: s.description, buttons: [] })));
    // Un bloque de cards genérico (prop `sections`) en un rol de features se llena de sus items, no
    // solo de steps; si no, cae a los Defaults (lorem) del bloque Relume.
    if ((has(n, 'sections') || has(n, 'steps')) && c.features) return set(c.features.map((f) => ({ icon: img(f.title), heading: f.title, description: f.description, buttons: [] })));
    if (has(n, 'features', 'cards') && c.features) return set(c.features.map((f) => ({ icon: img(f.title), heading: f.title, description: f.description })));
    return skip;
  }

  // Objeto único.
  if (has(n, 'pricingplan') && c.pricing?.[0]) return set(pricingPlan(c.pricing[0]));
  if (has(n, 'button')) return set(c.buttons[0] ? { title: c.buttons[0].title } : { title: 'Empezar' });

  // Escalares de texto.
  if (has(n, 'newsletterheading')) return set('Suscríbete al boletín');
  if (has(n, 'newsletterdescription')) return set(c.description || 'Novedades y lanzamientos, sin spam.');
  if (has(n, 'inputplaceholder', 'placeholder')) return set('Tu correo');
  if (has(n, 'termsandconditions')) return set("<p class='text-xs'>Al suscribirte aceptas nuestra política de privacidad.</p>");
  if (has(n, 'footerheading') && c.faqContact) return set(c.faqContact.heading);
  if (has(n, 'footerdescription') && c.faqContact) return set(c.faqContact.description);
  if (has(n, 'footertext')) return set(c.legal?.join(' · ') ?? '');
  if (has(n, 'quote') && c.testimonials?.[0]) return set(`"${c.testimonials[0].quote}"`);
  if (n === 'name' && c.testimonials?.[0]) return set(c.testimonials[0].name);
  if (has(n, 'position', 'jobtitle') && c.testimonials?.[0]) { const x = c.testimonials[0]; return set(x.company ? `${x.role}, ${x.company}` : x.role); }
  if (has(n, 'companyname') && c.testimonials?.[0]) return set(c.testimonials[0].company);
  if (has(n, 'heading', 'title', 'headline')) return set(c.heading);
  if (has(n, 'subheading', 'subtitle', 'description', 'text', 'paragraph')) return set(c.description);
  if (has(n, 'tagline', 'eyebrow', 'kicker', 'label')) return set(c.tagline);
  if (has(n, 'periodlabel')) return set('/mes');

  // Texto sin fuente clara: vacío (nunca el Lorem del Default). Números/otros: default del componente.
  if (t === 'string') return set('');
  return skip;
}

function testimonialItem(t: TestimonialItem): Record<string, unknown> {
  return {
    quote: `"${t.quote}"`,
    name: t.name,
    position: t.company ? `${t.role}, ${t.company}` : t.role,
    companyName: t.company,
    logo: img(`Logo de ${t.company}`),
    avatar: img(t.name),
    image: img(`Logo de ${t.company}`),
  };
}

function pricingPlan(p: PricingPlan): Record<string, unknown> {
  return {
    planName: p.name,
    monthlyPrice: p.monthlyPrice,
    ...(p.yearlyNote ? { yearlyPrice: p.yearlyNote } : {}),
    features: p.features.slice(0, 6),
    button: { title: p.cta },
  };
}

/** Llena los props de CUALQUIER bloque Relume ingestado desde su esquema de contenido (manifest.props),
 * fiteado al presupuesto del bloque (`budgets`, jq de sus Defaults) o al canon. `undefined` si el rol
 * no trae copy. Fallback de `propsFor`. */
export function injectCopy(entry: CatalogEntry, copy: RoleCopy, budgets?: SlotBudgets): Record<string, unknown> | undefined {
  const content = contentFor(entry, copy);
  if (!content) return undefined;
  const props: Record<string, unknown> = {};
  const declared = entry.manifest?.props ?? [];
  // Sin manifiesto, un wireframe mínimo (heading + description) antes que un bloque vacío.
  if (declared.length === 0) {
    return fitProps({ heading: content.heading, description: content.description }, budgets);
  }
  for (const prop of declared) {
    const r = valueFor(prop, content);
    if (r.set) props[prop.name] = r.value;
  }
  return fitProps(props, budgets);
}
