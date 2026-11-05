import type { ButtonProps } from '../ui/button';

/** Una acción de sección es un Button con destino: el contrato de bloque pide `actions[]` como datos, no como nodos. */
export type Action = Pick<ButtonProps, 'label' | 'variant'> & { href: string };
export interface NavLink { label: string; href: string }
/** Ancla y slug del contrato de página: el bloque los pasa a su Section, así los sensores y el editor lo encuentran. */
export interface SectionAnchor { id?: string; slug?: string }
