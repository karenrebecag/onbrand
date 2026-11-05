// Contrato de página (ADR 0008): lo que v0 obtiene por contexto único (un agente escribe todas las
// secciones viendo las anteriores) nosotros lo hacemos explícito, porque las secciones se componen
// aisladas y en paralelo. El plan lo escribe UNA vez en el primer mensaje; L6 lo persiste en
// `page.json.page` y lo hereda en follow-up y repair; cada sección lo recibe como DATO en el userJson
// (no como prosa); el runner escribe lang/title/description en el documento; T mide pedido vs render.

import type { PageLang } from './page-doc';
export type { PageLang };

/** Hechos de la página: los inventa el plan una vez y todas las secciones los reutilizan. Es la parte
 * que en v0 sale literal en varios archivos (4,000+ en logos, stats y cta; Hexabyte en logos y
 * testimonials) porque se escribieron en el mismo contexto. */
export interface PageFacts {
  /** Nombre del producto o negocio tal como se escribe en la página. */
  brand: string;
  /** Acción principal: misma etiqueta y mismo destino en hero, navbar, pricing y cta. */
  cta: { label: string; href: string };
  /** Cifras con lo que afirman; se citan textual. */
  figures: { value: string; claim: string }[];
  /** Marcas ficticias para logos y testimonios: un solo juego para toda la página. */
  companies: string[];
  /** Personas ficticias (testimonios, citas): nombre, cargo y empresa del juego anterior. */
  people: { name: string; role: string; company: string }[];
  /** Precios por plan, si la página tiene pricing. */
  prices?: { plan: string; monthly: string; yearly?: string }[];
  /** Destinos externos de la página: los únicos que una sección puede enlazar fuera de las anclas. `whatsapp` es
   * `https://wa.me/<número>`; cada botón le añade su propio `?text=`. v0 pone WHATSAPP_NUMBER en lib/site.ts y 6
   * enlaces wa.me con mensaje escrito; aquí el número viene del brief o queda el placeholder, a confirmar. */
  links?: PageLinks;
}

export interface PageLinks {
  whatsapp?: string;
  email?: string;
  phone?: string;
  social?: { name: string; href: string }[];
}

/** Número placeholder cuando el brief pide WhatsApp sin dar número: visible como dato a confirmar. */
export const WHATSAPP_PLACEHOLDER = 'https://wa.me/5215500000000';
export const WHATSAPP_RE = /^https:\/\/wa\.me\/\d{6,15}$/;

export interface SectionContract {
  role: string;
  /** Id semántico en el idioma de la página (`customers`, `nosotros`); el runner lo escribe en el wrapper. */
  id: string;
  objective: string;
  avoid: string[];
  surface: 'base' | 'muted' | 'raised' | 'inverse';
  emphasis: 'low' | 'medium' | 'high';
  motion: 'none' | 'entrance';
}

export interface PageImage {
  role: string;
  kind: 'product' | 'photo' | 'logo' | 'avatar';
  alt: string;
}

export interface PageContract {
  lang: PageLang;
  title: string;
  description?: string;
  sections: SectionContract[];
  facts: PageFacts;
  images: PageImage[];
}

/** El bloque de hechos va como DATO en el userJson; esta línea solo le dice al modelo que ahí está. */
export const FACTS_RULE =
  'HECHOS DE LA PÁGINA: el objeto `facts` del input trae la marca, la acción principal (etiqueta y href), las cifras, las marcas ficticias y las personas que usa TODA la página. Cítalos textual y no inventes otras cifras, marcas, personas ni otra etiqueta para la acción principal; lo que no esté en `facts` y no venga del brief no existe. ENLACES EXTERNOS: solo los de `facts.links`. Si hay `facts.links.whatsapp`, todo botón de contacto, demo, pedido o compra enlaza a ESE número con un `?text=` propio de la sección, en el idioma de la página y codificado (p. ej. `https://wa.me/521…?text=Quiero%20el%20plan%20Team`); nunca otro número, nunca un formulario. Redes, correo y teléfono solo si están en `facts.links`. Sin `facts.links.whatsapp`, todo botón de acción (probar, empezar, elegir un plan, comprar, agendar, contactar) enlaza a `facts.cta.href`; `#` solo cuando no hay ningún destino posible, nunca en un botón de plan o de acción.';

/** Nombre largo que entiende LANG_BLOCK / image-step a partir del código del contrato. */
export const LANG_NAME: Record<PageLang, string> = { es: 'español', en: 'English', pt: 'português' };

/** Mapea el nombre largo de detectLanguage al código del contrato. */
export const LANG_CODE: Record<string, PageLang> = { español: 'es', English: 'en', português: 'pt' };
