# ADR 0004: El sesgo de marca sobrevive al shortlist del router por un slot reservado, no entrando al ranking del router

Estado: APROBADO | Fecha: 2026-10-18
Origen: límite hallado al habilitar los showcase arc como inner (commit 21ed8f5). Extiende ADR 0002 (pool) y ADR 0003 (marca determinista).

## Contexto

Habilitados los organismos de producto de arc como showcase inner del 2-layer (ADR 0001), un
showcase **rankea #1 en el score** cuando el sesgo de marca aplica (probado: `metrics-dashboard`
score 7 con `desiredTags` de dashboard). Pero en el pipeline completo casi nunca gana, por una
razón estructural, no un bug:

- `routeCandidates` (`src/router.ts`) **shortlistea el pool por términos de intención** (intent) antes
  de que `selectPage` puntúe con el sesgo de marca. El shortlist es `SHORTLIST[rhythm]` (top-K).
- Por **CA7 / ADR 0002** la marca está deliberadamente **fuera del router** (el test de punto único
  prohíbe que `router.ts` ramifique sobre `composition`). El router solo conoce la intención.
- Un showcase tiene vocabulario de app ("analytics dashboard", "kanban"), no de landing, así que su
  intent-score es ~0 y **se corta del shortlist** antes de que la marca pueda elevarlo.

Resultado: la marca puede sesgar *qué gana entre lo que sobrevive el shortlist*, pero no puede
**rescatar** un candidato que la intención no shortlisteó. Para los showcases —cuyo valor es
precisamente que la marca los prefiera aunque la intención no los nombre— eso los deja inalcanzables.

## Opciones

- **A — Slot reservado (recomendada).** El shortlist reserva `R` lugares (p. ej. 2) para los
  candidatos cuyos tags cruzan los `desiredTags` de la `composition` activa, llenados DESPUÉS del
  top-K por intención. El router **no rankea por marca** (sigue sin ramificar su orden sobre
  `composition`): solo **garantiza inclusión** de un puñado de candidatos marca-deseados para que
  `selectPage` —el punto único— decida. Preserva el espíritu de CA7 (la marca no decide el orden del
  router) y la primacía de la intención (el top-K por intent va primero). Contrato nuevo: el router
  lee `composition.roles[role].desiredTags` solo para incluir, no para ordenar.

- **B — Marca en el ranking del router.** Sumar los `desiredTags` al score del shortlist. Simple,
  pero **viola CA7 / ADR 0002**: la marca pasaría a decidir el orden del router, duplicando el punto
  de sesgo. Rechazada salvo que se decida mover el punto único.

- **C — El inner salta el shortlist.** `pickInner` rankea el pool completo del rol (sin top-K) en
  `selectPage`, solo para el slot inner. La marca aplica entera. Acotado al inner (pool de un rol),
  pero pierde el filtrado de `whenNotToUse` del router y abre la puerta a que el inner ignore reglas
  que las secciones sí respetan. Más barato hoy, incoherente a futuro.

## Decisión

**A** (aprobada por Karen 2026-10-18; implementada en commit 628416b). Es el único que da a la marca
poder de *rescate* sin mover el punto único de sesgo ni romper CA7, y es spec-able (RF: "el shortlist
reserva R lugares para marca-deseados; R y el criterio de match son config"). B mueve el contrato de
sesgo; C fragmenta las reglas entre sección e inner.

Implementación: `routeCandidates` lee `composition.roles[role].desiredTags` solo para incluir; tras el
top-K por intención rescata hasta `RESERVED_BRAND_SLOTS=2` desde `dropped` cuyos tags cruzan los
deseados, sin reordenar. `RoleTrace.rescued` lo traza. E2E: una marca con `features.desiredTags`
de dashboard rescata `kpi-drilldown` (intent-score 3) y gana la sección.

## Consecuencias

- Nuevo contrato acotado del router: lee `composition` **solo para incluir** (no ordenar); CA7 se
  reescribe como "el router no ORDENA por composition" en vez de "no la toca".
- Un test nuevo: un candidato marca-deseado de intent-score 0 llega a `selectPage` y puede ganar.
- `R` por defecto conservador (2) para no diluir la intención; se afina como decisión de diseño.
- Sin esto, los 18 showcase propless (y los 12 emittable de vocabulario de app) quedan habilitados
  pero inalcanzables por marca: la feature existe a medias.
