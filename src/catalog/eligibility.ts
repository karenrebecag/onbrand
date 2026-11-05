// Elegibilidad por props (spec filtro-elegibilidad-router, v1): un bloque Relume genérico es elegible
// si ningún prop de CONTENIDO con default visible queda sin binding con el copy canónico del rol.
// Lo que no se llena ni con el copy más completo posible nunca se llenará con un brief: el bloque
// mostraría su demo ("Feature text goes here"). Cómputo puro: el router aporta el modelo de slots
// (Defaults del source) y las claves que la ruta de binding real (propsFor) devuelve.

import type { RoleCopy } from '../copy';
import type { BlockSlotModel } from '../copygen/slot-model';

/** Props de app, no de contenido: su default no es texto inglés visible (iconos sociales). Es el mismo
 * criterio por el que injectCopy los salta a propósito (inject-copy.ts, `has(n, 'social')`). */
export const APP_PROPS = /social/i;

/** Copy canónico: todos los roles, listas llenas. Es el MÁXIMO que el copy real puede aportar; un prop
 * que ni con esto se llena es un prop sin proveedor. Los textos no se emiten: solo cuentan las claves. */
export const CANONICAL_COPY: RoleCopy = {
  hero: { heading: 'H', description: 'D', primaryCta: 'P', secondaryCta: 'S' },
  logos: { heading: 'H', brands: ['A', 'B', 'C'] },
  features: { heading: 'H', description: 'D', items: [{ title: 'T1', description: 'D1' }, { title: 'T2', description: 'D2' }, { title: 'T3', description: 'D3' }] },
  steps: { heading: 'H', steps: [{ tagline: 'P1', title: 'T1', description: 'D1' }, { tagline: 'P2', title: 'T2', description: 'D2' }] },
  stats: { heading: 'H', stats: [{ value: 3, suffix: 'x', label: 'L1' }, { value: 24, label: 'L2' }, { value: 35, prefix: '+', suffix: '%', label: 'L3' }] },
  testimonials: { heading: 'H', description: 'D', items: [{ quote: 'Q1', name: 'N1', role: 'R1', company: 'C1' }, { quote: 'Q2', name: 'N2', role: 'R2', company: 'C2' }, { quote: 'Q3', name: 'N3', role: 'R3', company: 'C3' }] },
  pricing: { tagline: 'T', heading: 'H', description: 'D', periodLabel: '/mes', plans: [{ name: 'A', monthlyPrice: '$1', yearlyNote: 'o $10', features: ['f1', 'f2'], cta: 'C' }, { name: 'B', monthlyPrice: '$2', features: ['f1', 'f2', 'f3'], cta: 'C' }] },
  faq: { heading: 'H', description: 'D', items: [{ question: 'Q1', answer: 'A1' }, { question: 'Q2', answer: 'A2' }], contact: { heading: 'H', description: 'D', cta: 'C' } },
  cta: { heading: 'H', description: 'D', primaryCta: 'P', secondaryCta: 'S', note: 'N' },
  navbar: { brand: 'Marca', links: ['A', 'B'], primaryCta: 'P', secondaryCta: 'S' },
  footer: { brand: 'Marca', tagline: 'T', columns: [{ title: 'C', links: ['A', 'B'] }], legal: ['L'] },
};

/** Props de contenido con default visible: primer segmento de la ruta de cada hoja de texto con
 * semántica reconocida en los Defaults, sin los props de app. Ordenado y sin repetidos. */
export function textProps(model: BlockSlotModel): string[] {
  const names = new Set<string>();
  for (const f of model.fields) {
    const head = f.path.split('.')[0];
    if (head && !APP_PROPS.test(head)) names.add(head);
  }
  return [...names].sort();
}

/** Props de contenido con default visible que el binding real NO cubre. Vacío = elegible. Un modelo
 * sin campos (source ilegible, bloque sin Defaults) no es evidencia de nada: también vacío. */
export function unboundTextProps(model: BlockSlotModel, bound: ReadonlySet<string>): string[] {
  return textProps(model).filter((name) => !bound.has(name));
}
