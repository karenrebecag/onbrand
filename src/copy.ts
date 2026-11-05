// Capa de copy (pasada 2). El contenido por rol sale de un archivo fixtures/briefs/<name>.copy.json
// (generado por el LLM contra el brief, con presupuesto de longitud) o del fallback determinista.
// El adaptador de cada librería mapea este copy agnóstico a los props reales de sus bloques.

import type { Brief } from './types';

export interface HeroCopy {
  heading: string;
  description: string;
  primaryCta: string;
  secondaryCta?: string;
}
export interface LogosCopy {
  heading: string;
  // Opcional porque un copy.json escrito a mano puede traer la sección sin marcas.
  brands?: string[];
}
export interface FeatureItem {
  title: string;
  description: string;
}
export interface FeaturesCopy {
  heading: string;
  description: string;
  items: FeatureItem[];
}
export interface StatItem {
  value: number;
  prefix?: string;
  suffix?: string;
  label: string;
  detail?: string;
}
export interface StatsCopy {
  heading: string;
  stats: StatItem[];
}
export interface CtaCopy {
  heading: string;
  description: string;
  primaryCta: string;
  secondaryCta?: string;
  note?: string;
}
/** Un testimonio: quote ≤220 caracteres; name/role/company son texto plano (sin links). */
export interface TestimonialItem {
  quote: string;
  name: string;
  role: string;
  company: string;
}
/** heading ≤60, description ≤160, 3 items. Fotos y logos no van en el copy: son el hueco de imágenes. */
export interface TestimonialsCopy {
  heading: string;
  description?: string;
  items: TestimonialItem[];
}
/** Un plan: precios como texto ya formateado ("$19"); features ≤6 líneas cortas. */
export interface PricingPlan {
  name: string;
  monthlyPrice: string;
  /** Línea bajo el precio ("o $199 al año"); opcional. */
  yearlyNote?: string;
  features: string[];
  cta: string;
}
/** heading ≤60, description ≤160, 2 planes; periodLabel es el sufijo del precio ("/mes"). */
export interface PricingCopy {
  tagline?: string;
  heading: string;
  description?: string;
  periodLabel: string;
  plans: PricingPlan[];
}
export interface FaqItem {
  question: string;
  /** Texto plano ≤300 (es lo que el buscador del bloque Arc indexa). */
  answer: string;
}
/** Cierre "¿todavía tienes dudas?": lo rinde la cáscara Relume (faq7_shell), no el acordeón. */
export interface FaqContact {
  heading: string;
  description: string;
  cta: string;
}
/** heading ≤60, description ≤160, 4-6 preguntas. */
export interface FaqCopy {
  heading: string;
  description?: string;
  items: FaqItem[];
  contact?: FaqContact;
}
/** Un paso de "cómo funciona": tagline corto ("Paso 1"), title ≤60, description ≤200. */
export interface StepItem {
  tagline: string;
  title: string;
  description: string;
}
/** 2-4 pasos; el heading es opcional (el bloque Relume layout-122 no tiene cabecera propia). */
export interface StepsCopy {
  heading?: string;
  steps: StepItem[];
}
export interface NavbarCopy {
  brand: string;
  links: string[];
  primaryCta: string;
  secondaryCta?: string;
}
export interface FooterColumn {
  title: string;
  links: string[];
}
export interface FooterCopy {
  brand: string;
  tagline?: string;
  columns: FooterColumn[];
  legal?: string[];
}

export interface RoleCopy {
  hero?: HeroCopy;
  logos?: LogosCopy;
  features?: FeaturesCopy;
  steps?: StepsCopy;
  stats?: StatsCopy;
  testimonials?: TestimonialsCopy;
  pricing?: PricingCopy;
  faq?: FaqCopy;
  cta?: CtaCopy;
  navbar?: NavbarCopy;
  footer?: FooterCopy;
}

/** Marcas reales del brief, o undefined si no trae ninguna utilizable. */
export function briefBrands(brief: Brief): string[] | undefined {
  const brands = (brief.brands ?? []).map((b) => b.trim()).filter(Boolean);
  return brands.length ? brands : undefined;
}

/** Fallback determinista: copy mínimo pero coherente desde el brief, sin LLM. Marca el hueco sin
 * romper: la página generada compila y dice algo del producto aunque no haya archivo de copy. */
export function deterministicCopy(brief: Brief): RoleCopy {
  const name = brief.summary.split(/[:.]/)[0].trim().slice(0, 40) || 'Tu producto';
  const one = brief.summary.slice(0, 160);
  const cta = brief.goal ? capitalize(brief.goal) : 'Empezar';
  const brands = briefBrands(brief);
  return {
    navbar: { brand: name, links: ['Producto', 'Precios', 'Recursos'], primaryCta: cta },
    hero: { heading: name, description: one, primaryCta: cta, secondaryCta: 'Saber más' },
    ...(brands ? { logos: { heading: `Confían en ${name}`, brands } } : {}),
    features: {
      heading: 'Lo que hace',
      description: one,
      items: [
        { title: 'Beneficio 1', description: 'Descripción breve del beneficio.' },
        { title: 'Beneficio 2', description: 'Descripción breve del beneficio.' },
        { title: 'Beneficio 3', description: 'Descripción breve del beneficio.' },
      ],
    },
    steps: {
      heading: 'Cómo funciona',
      steps: [1, 2, 3].map((n) => ({ tagline: `Paso ${n}`, title: `Paso ${n}`, description: 'Descripción breve del paso.' })),
    },
    stats: {
      heading: 'En números',
      stats: [
        { value: 3, suffix: '×', label: 'Mejora', detail: 'vs. antes' },
        { value: 24, suffix: '/7', label: 'Disponibilidad', detail: 'sin pausas' },
        { value: 99, suffix: '%', label: 'Satisfacción', detail: 'de clientes' },
      ],
    },
    // Placeholders neutros: el fallback no inventa testimonios con voz de cliente.
    testimonials: {
      heading: 'Lo que dicen los clientes',
      items: [1, 2, 3].map((n) => ({ quote: `Testimonio ${n} sobre ${name}.`, name: 'Nombre', role: 'Cargo', company: 'Empresa' })),
    },
    // Sin precios inventados: el fallback deja el precio como hueco explícito.
    pricing: {
      heading: 'Planes',
      periodLabel: '/mes',
      plans: ['Básico', 'Pro'].map((n) => ({ name: n, monthlyPrice: '$—', features: ['Característica 1', 'Característica 2', 'Característica 3'], cta })),
    },
    faq: {
      heading: 'Preguntas frecuentes',
      items: [1, 2, 3, 4].map((n) => ({ question: `Pregunta ${n} sobre ${name}`, answer: 'Respuesta breve.' })),
      contact: { heading: '¿Todavía tienes dudas?', description: one, cta },
    },
    cta: { heading: `¿Listo para empezar?`, description: one, primaryCta: cta, secondaryCta: 'Hablar con ventas', note: 'Sin tarjeta.' },
    footer: {
      brand: name,
      tagline: one.slice(0, 60),
      columns: [
        { title: 'Producto', links: ['Características', 'Precios', 'Integraciones'] },
        { title: 'Empresa', links: ['Sobre', 'Blog', 'Contacto'] },
      ],
      legal: ['Privacidad', 'Términos'],
    },
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
