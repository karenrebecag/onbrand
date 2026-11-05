// Presupuesto de motion de la página (capa L3): decide qué sección puede animar su entrada. Lo decide la
// página y no cada bloque, porque v0 no anima ninguna sección (j049: 0 animaciones en 4 posiciones de
// scroll) y la guía de Arc pide como mucho una entrada orquestada por página. Las micro-interacciones
// (hover, acordeón) no cuentan: son del componente y siguen igual.

export type SectionMotion = 'none' | 'entrance';

/** Roles que pueden llevar la entrada, en orden de preferencia. */
const ENTRANCE_ROLES: readonly string[] = ['hero'];

/** Un valor por sección, en el mismo orden que `roles`. Como mucho `max` entradas, y solo en un rol de
 * ENTRANCE_ROLES: el resto queda en `none`. */
export function motionBudget(roles: readonly string[], max = 1): SectionMotion[] {
  const chosen = new Set(
    ENTRANCE_ROLES.flatMap((preferred) => roles.flatMap((role, i) => (role === preferred ? [i] : []))).slice(0, Math.max(0, max)),
  );
  return roles.map((_, i) => (chosen.has(i) ? 'entrance' : 'none'));
}
