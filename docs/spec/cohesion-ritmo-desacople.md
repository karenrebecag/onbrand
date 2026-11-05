# Spec — Cohesión: desacoplar density de ritmo + invariante de perfil efectivo

**Estado:** REVISADA — WebTransformerSecondary verificó RF1-RF5 / CA1-CA6 contra el código (consenso de ambas sesiones; FALSO inicial corregido en RF3 por tema y RF2 router). APROBADA la escribe solo Karen.
**Research:** `docs/research/cohesion-superficie-agnostica.md` (APROBADO; el MODELO ya está en main, commit `607142a`) + deep-research `wf_d8dddb65` + propuesta independiente de Secondary (`propuesta-cohesion-agnostica.md`).
**Aviso:** el modelo de cohesión (surface/geometry/perfiles) NO se reescribe — ya existe y pasa su checklist. Esta spec cierra el bug vivo que quedó encima.

## 1. Objetivo
Que el perfil de ritmo de la cohesión refleje lo que el pool puede entregar: ningún pack vuelve a imponer un perfil con banda sobre una librería sin bandas (el `flatPenalty -5` inevitable), y la marca pide contraste de forma **explícita**, no inferido de la densidad. Métrica: una corrida Arc con pack `density: spacious` deja de recibir `-5` y el report no miente sobre el perfil.

## 2. Decisiones que implementa (y el bug que cierra)
- **D1 (bug vivo, VERIFICADO):** `d3b91d0` (2026-10-18) acopló `density→perfil` (`plan.ts:99` `DENSITY_PROFILE={spacious:banded}`, `run.ts:109` `profileForDensity(density) ?? adapter.rhythm`). Un pack `spacious` fuerza `banded`; Arc no tiene bandas (47 bloques base salvo hero-signup tinted; 0 dark/media) → `flatPenalty -5` inevitable vuelve. Reproducido: `density spacious → "cohesión (perfil banded): … plana sin banda real -5"` vs Base `→ "perfil quiet … +2"`.
- **D2a (invariante):** una penalización que ningún candidato puede evitar no es señal (la research lo dijo en prosa; el código no lo garantiza).
- **D2b (desacople):** density es ESPACIADO; rhythm es CONTRASTE. Ninguna fuente (Arc/Relume/Dawn/AstroWind) los acopla.

## 3. Requisitos funcionales
- **RF1 (D2b):** eliminar `DENSITY_PROFILE` y `profileForDensity` (`plan.ts`); `run.ts` usa `adapter.rhythm` salvo override del pack.
- **RF2 (`composition.rhythm`):** el brand pack puede declarar `composition.rhythm?: RhythmProfile` (`banded|quiet|neutral`), validado contra el enum en el parse (frontera de confianza). Ausente = sin override. Precedencia: `pack.rhythm > adapter.rhythm`. **El perfil pedido también mueve el shortlist del router:** hoy `routeCandidates` usa `SHORTLIST[adapter.rhythm]` (`router.ts`) y `run.ts` no pasa `shortlist`, así que el override no llegaría; `run.ts` debe pasar `RouteOptions.shortlist = SHORTLIST[pedido]` (`RouteOptions.shortlist` ya existe, no se toca router.ts). Una marca puede pedir `quiet` sobre Relume (efecto coherente, no bug: `standard` es un `layoutStyle` real de muchos bloques → dos vecinos `standard` restan `-3`).
  - `HACK:` `quiet` tiene su propia penalización potencialmente inalcanzable (`sameGeometryAdjacent` si todo el top-K vecino comparte geometría). No se resuelve en v0. Disparador: cuando un pack pida `quiet` sobre una librería cuyo pool no da variedad de geometría. Misma invariante que RF3, extendida a esa penalización.
- **RF3 (D2a invariante, POR TEMA):** `cohesionScore` puntúa por tema y promedia (`cohesion.ts:143-151`), así que la degradación global no basta: una banda que solo existe en un tema deja el otro con `flatPenalty` inevitable. La decisión vive en `select.ts` (conoce el pool): calcula la disponibilidad de banda **por tema** sobre el pool evaluado (`rankedByRole` tras `eligible()`+`topKWithBand`) y la pasa a `cohesionScore`; `scoreTheme` aplica `flatPenalty`/`bandPresent` **solo en el tema donde hay banda**. Sin ese dato, `cohesionScore` mantiene su comportamiento actual (el test directo `cohesionScore(flat, RELUME)` sigue exigiendo `'plana sin banda real'`, CA6) — por eso la invariante NO vive en `cohesionScore`.
- **RF4 (razón + contrato):** el finding registra perfil PEDIDO y EFECTIVO con la razón ("perfil banded pedido, pool sin bandas → neutral"); `flow.ts` y el report de `run.ts` los muestran. El efectivo es **por tema**. Contrato (Fase B): `PageResult.profile: RhythmProfile` = el efectivo cuando coincide en ambos temas, si no el pedido (string estable para flow/run/tests) **+** `effective: Record<Theme, RhythmProfile>`; el prefijo por tema va solo en `reasons`/report, misma convención que `cohesionScore`. Hoy coinciden siempre (0 candidatos con superficie distinta por tema).
- **RF5 (desempate determinista):** al degradar, el orden del top-K sigue siendo determinista por slug (`key<` ya en select.ts), sin depender del score que el perfil cambió — la trampa ES de "solo-filtro = sin orden".

## 4. Requisitos no funcionales
- **RNF1:** core puro, sin I/O ni vocabulario de librería (invariante del brief runner-e2e). La degradación es función de `(perfil, pool)`, agnóstica a la fuente del perfil.
- **RNF2:** determinismo — mismo brief+pack+pool → mismo perfil efectivo y mismo orden.
- **RNF3:** sin deps nuevas.

## 5. Criterios de aceptación
- **CA1 (RF1):** `git grep -nE "DENSITY_PROFILE|profileForDensity"` = 0; un pack `density: spacious` ya NO fuerza `banded`.
- **CA2 (RF2):** pack con `composition.rhythm:"banded"` → perfil pedido `banded`; sin `rhythm` → `adapter.rhythm`; un `rhythm` fuera del enum → `parseBrandPack` lanza.
- **CA3 (RF3, por tema):** pool todo base en ambos temas + pedido `banded` → sin `-5` en ningún tema, efectivo `neutral`. Pool con banda solo en light (`{light:media, dark:base}`) → light conserva el crédito de banda, dark NO recibe `-5` (degradación por tema). Pool con banda en ambos → sigue `banded`.
- **CA4 (RF4):** el report nombra perfil pedido Y efectivo + la razón cuando degrada; `flow.json` los lleva.
- **CA5 (RF5, idempotencia):** una corrida con `banded` pedido sobre un pool sin bandas elige EXACTAMENTE la misma combinación que con `neutral` pedido, y la razón de degradación está presente. (El "mismo orden en dos corridas" es trivial para funciones puras; esto prueba que degradar no altera la selección, solo el score/report.)
- **CA6 (regresión Relume):** `bun test core adapter-arc registry` verde; Relume no degrada (tiene media), `page.profile` sigue `banded` donde lo era.

## 6. Datos
Sin entidad nueva. `BrandComposition` gana `rhythm?: RhythmProfile` (el `brandpack.schema.json`, fuera de git, lo documenta Karen; este repo solo consume). `PageResult.profile` pasa a ser el EFECTIVO (contrato entre módulos: lo leen flow/run/tests). Reversible.

## 7. Dependencias
Ninguna nueva. `src/cohesion.ts` (`PROFILES`, `wantsBand`) y `src/select.ts` (`isBandInAnyTheme`, `topKWithBand`) ya existen (`607142a`). Falla seguro: sin clasificación de superficie el pool no tiene bandas → degrada a `neutral`, no rompe.

## 8. Seguridad
`superficie_expuesta: no`. Sin endpoint/auth/red nueva. `composition.rhythm` es input en frontera de confianza (brand.json externo): se valida contra el enum CERRADO en `parseComposition` (rechaza cualquier valor fuera de `banded|quiet|neutral`), igual que `density` hoy. Sin secretos nuevos. Sin familias `offensive-*`.

## 9. Plan de pruebas
- **Unit:** `parseComposition` acepta `rhythm` del enum y rechaza fuera de él (CA2); la invariante de degradación (CA3) con pool sintético todo-base vs con-media; desempate (CA5).
- **Integración (run real):** pulse-completo con pack `spacious` → sin `-5`, efectivo `neutral`, report con razón (CA3/CA4); con pack Base → `quiet` sin cambio.
- **Regresión:** `bun test core adapter-arc registry` (Relume banded verde, CA6).
- **Fuera:** no se instrumenta nada nuevo del render-gate; no se toca el modelo de superficie.

## 10. Fuera de alcance
- El modelo de cohesión (surface/geometry/perfiles) — ya en main (`607142a`), no se reescribe.
- `accent` (Dawn scheme-5 `#334FB4`) y `dark` del enum sin productor — pospuestos (YAGNI; Karen 2026-10-15).
- `geometry: 'standard'` placeholder en 26 organismos showcase — solo si entran al pool emittable (hoy no); se nota, no se arregla aquí.
- Inventar bandas para Arc por wrapper (patrón AstroWind) — Arc es `quiet` por diseño; AstroWind alterna TINTES, no bandas (deep-research: `isDark` 0 usos, Hero lo omite).

## 11. Riesgos
- `brand-composition.test.ts:63-66` fija `density→perfil` (4 expects): se reescriben contra `composition.rhythm` (esperado, no accidental).
- `PageResult.profile` efectivo cambia el valor al degradar: `core.test.ts:154` (Relume banded) no degrada, sigue verde; el contrato lo leen flow/run.
- La degradación se decide y aplica **por tema** (RF3); una banda solo-light no debe eximir al tema dark. Hoy el catálogo no tiene superficie distinta por tema (0 candidatos), así que el efectivo es una sola palabra; el modelo igual debe soportar la divergencia (patrón AstroWind `bg-blue-50 dark:bg-transparent`).
- Relume 'banda' = media; una media sin imagen inyectada es un rectángulo vacío → cruza con la elegibilidad estática (otra spec); aquí se nota, no se resuelve.

## 12. Archivos (7 con tests → parte en 2 fases mergeables de ≤5)
Excede la guía de 3-5 archivos, así que se parte:
- **Fase A (D2b + router):** `src/plan.ts` (quitar `DENSITY_PROFILE`/`profileForDensity`), `src/brand.ts` (`composition.rhythm` en `parseComposition`), `scripts/run.ts` (`adapter.rhythm` + `pack.rhythm`; pasar `RouteOptions.shortlist`), `tests/brand-composition.test.ts` (reescribir density→perfil contra `composition.rhythm`). CA1, CA2.
- **Fase B (D2a invariante por tema):** `src/select.ts` (disponibilidad de banda por tema + perfil efectivo), `src/cohesion.ts` (param opcional de disponibilidad por tema en `cohesionScore`/`scoreTheme`), `src/log/flow.ts` + `scripts/run.ts` (perfil pedido+efectivo), `tests/core.test.ts` (CA3/CA5/CA6). CA3, CA4, CA5, CA6.
`scripts/run.ts` se toca en ambas; Fase A primero, B encima. Cada fase es QA-verde y mergeable sola.

## 13. Git / entrega
Worktree propio off main; QA local 100% + Secondary verifica CA1-CA6 → push + PR sin auto-merge (toca selección/score, Karen lee). CI es el gate del merge.
