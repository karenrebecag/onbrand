// Contrato de las plantillas del generador determinista: por rol, una función que escribe el
// sub-objeto del RoleCopy de ese rol a partir de los hechos del brief. `pick` elige el primer titular
// no usado en la página (la regla "avoiding repetition of the same headlines" del prompt de Relume,
// page-content.js:153). Las cifras, nombres y marcas son de muestra y se declaran como tal.

import type { Role } from '../types';
import type { Facts } from './facts';
import type { Lang } from './generator';
import type { RoleCounts } from './role-fields';

export interface TemplateCtx {
  f: Facts;
  c: RoleCounts;
  lang: Lang;
  /** Primer candidato no usado todavía como titular en la página. */
  pick: (candidates: string[]) => string;
  /** Beneficio i-ésimo del brief, o una muletilla neutra si el brief trae menos. */
  benefit: (i: number) => string;
}

export type RoleTemplate = (ctx: TemplateCtx) => Record<string, unknown>;

export type Templates = Record<Exclude<Role, 'banner'>, RoleTemplate>;

/** Nombres, cargos y empresas FICTICIOS para testimonios (como los "Name Surname" de Relume,
 * pero legibles). Nunca se presentan como reales: el reporte del runner los marca como muestra. */
export const SAMPLE_PEOPLE = ['Ana Ruiz', 'Luis Pérez', 'Marta Gómez'] as const;
export const SAMPLE_BRANDS = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Vandelay', 'Stark', 'Wayne'] as const;
export const SAMPLE_PRICES = ['$19', '$49'] as const;

export const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
