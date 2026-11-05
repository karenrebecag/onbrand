# Spec — Filtro de elegibilidad por props en el router (curate-then-score, v1 Relume genérico)

**Estado:** REVISADA — chocada por orqWebTransformer corriendo en main (2026-10-20); APROBADA la escribe solo Karen.
**Research:** `docs/research/filtro-elegibilidad-router.md` (rama research/eligibility-filter, `ae34ca1`, ESCALADO resuelto por Karen 2026-10-20: C1, D1, D2, NC1).
**Medición de base:** main `317268a`, simulación estática re-corrida por Secondary sobre el catálogo de main (891 items). Los números de abajo son de main, no del clon.

## 1. Objetivo
Que el router no ponga en la shortlist un bloque Relume genérico que mostraría su copy demo porque el copy del rol no puede llenar un prop de contenido con default visible, cuando el rol tiene otra alternativa que sí se llena. Filtro, no ranking: entre elegibles sigue decidiendo el score.

## 2. Impacto medido en main (léase antes de aprobar)
- Universo gate-ok/verified emittable por rol → elegibles (0 props de contenido sin binding): banner 10→8, cta 56→51, faq 5→5, features 494→352 (12 no verificables), footer 18→6, hero 100→97, logos 7→6, navbar 18→11, pricing 25→11, stats 56→51, steps 2→0 (1 no verificable), testimonials 18→16.
- Props que más bloquean: subHeadings 56, tabs 44, stats 17, socialMediaLinks 15, cardBig 14, defaultTabValue 11.
- Pipeline real (`scripts/run.ts … --lib arc --no-llm`, pack Base) + filtro simulado sobre la shortlist del router, selección conjunta `composePage` antes/después, 4 briefs:
  - **lumen-citas: el pick CAMBIA.** Antes `pricing: section_pricing21` (emite "Feature text goes here", demo visible) y `testimonials: section_testimonial17`. Después `pricing: pricing10_block` y `testimonials: section_testimonial13` (ambos elegibles; testimonials cambia por la optimización conjunta, no por exclusión). Salen de la shortlist de pricing section_pricing21 [featureCategories] y section_pricing26 [defaultValue, tabs, featureCategories]; quedan pricing10_block y section_pricing1.
  - pulse-completo: mismos 2 excluidos de la shortlist de pricing; picks idénticos (ya pickeaba pricing10_block).
  - nimbus-waitlist y pulse: 0 excluibles, picks idénticos.
- El demo que sigue visible tras v1 es de bloques ARC: site-footer (socials, status) y hero-signup (count, people). C1 los deja fuera de v1 a propósito; es el alcance de v2.
- Valor de v1: mata un demo visible hoy (lumen pricing), limpia la shortlist (alternates sin demo) y protege contra el caso medido en el banco (con peso de render 2, lumen regresaba a pricing26 por no estar medido: ahora pricing26 no entra).
- Alcance de la garantía: "elegible" = llenable con CANONICAL_COPY, no "este brief lo llena". En lumen el demo desaparece porque su copy trae pricingPlans, que pricing10_block consume; en un brief cuyo copy no traiga el prop del bloque elegible, el swap puede dejar otro demo. La garantía dura de "sin demo visible" es render.ok (v3), no este filtro.
- Nota de método: una primera versión de esta sección decía "no cambia ningún pick"; estaba medida sobre el primero de la shortlist del router, no sobre la selección conjunta. Corregida con el runner real (orq lo detectó).

## 3. Decisiones que implementa (de Karen, brief §0)
- **C1:** v1 solo `library === 'relume' && kind !== 'layout' && verified === false`. Los 6 slugs con `relumeProps` (arc.ts:196) son todos verified, así que `!verified` es la regla exacta para "genérico = inyectado por injectCopy". Curados y Arc nativos pasan sin filtrar.
- **D1:** requiredUnbound = prop de CONTENIDO con default visible que el copy del rol no llena. "Default visible" = el prop tiene al menos una hoja de texto con semántica reconocida en el `*Defaults` del source (`blockSlotModel(entry).fields`, slot-model.ts:142; `semanticOf` ya descarta alt/src/icon). Props de app quedan fuera por regla explícita: nombre que cruza `/social/i` (el mismo criterio por el que injectCopy los salta, inject-copy.ts:139) y los numéricos/boolean (no tienen hoja de texto, no entran).
- **D2:** si ningún candidato del rol queda elegible → pasa el pool completo, `trace[role].bindingFallback = true`, sin marcar degradado.
- **NC1:** `trace[role].unbound: { slug, props: string[] }[]` con los excluidos por binding.
- **Corrección al brief (§2):** `ManifestProp.default` NO es la fuente: en main 0 de 838 Relume genéricos tienen `default` en `manifest.props` (medido). La fuente es el source (Defaults) vía slot-model, que injectCopy ya lee para los presupuestos; no se añade I/O nuevo.

## 4. Requisitos funcionales
- **RF1 (cómputo puro):** `unboundTextProps(model: BlockSlotModel, bound: ReadonlySet<string>): string[]` en `src/catalog/eligibility.ts`: `textProps = unique(fields.map(f => f.path.split('.')[0]))` menos APP_PROPS (`/social/i`) menos `bound`. Ordenado, determinista. Sin disco.
- **RF2 (copy canónico):** `CANONICAL_COPY: RoleCopy` en el mismo archivo: un RoleCopy completo con todos los roles y listas de 3 (features), 2 (steps), 3 (stats), 3 (testimonials), 2 (plans), 2 (faq) y navbar/footer/logos llenos. Es lo que el copy real puede dar como máximo; un prop que ni con eso se llena nunca se llenará con un brief.
- **RF3 (binding real):** `bound = keys(adapter.propsFor(slug, CANONICAL_COPY) ?? {})`. Usa la ruta de binding real (injectCopy para genéricos), nunca una reimplementación.
- **RF4 (filtro en el router):** en `routeRole`, DESPUÉS de `exclusion()` por whenNotToUse y ANTES de `unitsFirst`/score (router.ts:238-247): para cada `kept` cuyo entry cumple C1, `props = unboundTextProps(blockSlotModel(entry), bound)`; si `props.length > 0` va a `unbound`. Si `kept − unbound` queda vacío → D2 (se restaura `kept`, `bindingFallback: true`). Un entry sin source legible (`model.fields.length === 0`) se considera sin evidencia → pasa (nunca se excluye sin evidencia).
- **RF5 (trace y report):** `RoleTrace` gana `unbound` y `bindingFallback?`; `traceLines` emite `router: <rol> -> sin binding <slug>[prop,prop] …` y `router: <rol> -> sin alternativa elegible, pasa el pool completo`; `flow.ts` copia `unbound`/`bindingFallback` al detail de la etapa route.
- **RF6 (sin reabrir):** firma de `routeCandidates` y shape de `candidatesByRole` intactos; `RouteOptions` sin campos nuevos; determinista; sin deps; sin red con `--no-llm`.

## 5. Requisitos no funcionales
- **RNF1:** el core (rank/cohesion/select/plan/types) no cambia. El filtro vive en el router (filter context), como la exclusión por whenNotToUse.
- **RNF2:** coste acotado: `blockSlotModel` está memoizado por slug (slot-model.ts:139) y `propsFor` ya corre por pick en emit; medido en la simulación: <1 s para 809 items.
- **RNF3:** en CI sin vault, los gate-ok con `source:null` no tienen source legible → sin evidencia → pasan. El filtro es inerte allí, no falla ni excluye de más. Los tests no dependen del vault (RF1 es puro y se prueba con `modelFromSource` sobre un source fixture).

## 6. Criterios de aceptación
- **CA1 (RF1/D1):** fixture Relume con Defaults `{ heading, description, featureCategories:[{title}], socialMediaLinks:[{url}], count: 3 }` y bound `{heading, description}` → `['featureCategories']` (ni social ni count).
- **CA2 (RF4/C1):** pool de pricing con un entry curado verified (bound vacío por stub) y dos genéricos, uno elegible y uno con `featureCategories` sin binding → el genérico con unbound sale, el curado y el elegible quedan, `trace.unbound = [{slug, props:['featureCategories']}]`.
- **CA3 (D2):** pool donde TODOS los genéricos tienen unbound y no hay curado → `candidatesByRole[role]` = pool completo, `bindingFallback: true`, `unbound` lista a todos.
- **CA4 (integración, main, pack Base):** `WT_BRAND_PACK=<Base> bun scripts/run.ts briefs/lumen-citas.json --lib arc --no-llm` → trace del router muestra `pricing -> sin binding section_pricing21[featureCategories], section_pricing26[defaultValue,tabs,featureCategories]`; pick de pricing pasa de `section_pricing21` a `pricing10_block` y `App.tsx` pasa a Pricing10 los planes del copy ("Feature text goes here" solo sobrevive como const Defaults no usado dentro de pricing-10.tsx, no se renderiza); testimonials pasa a `section_testimonial13`. pulse-completo, nimbus-waitlist y pulse: picks idénticos a antes del filtro (diff de `flow.json` solo en la etapa route).
- **CA5 (NC1/RF5):** `flow.json` de ese run lleva `unbound` y `bindingFallback` por rol; `traceLines` imprime la línea.
- **CA6 (regresión):** `bun test tests/router.test.ts tests/core.test.ts tests/adapter-arc.test.ts` verde; CA9 del router (página 100% Arc idéntica) intacto.
- **CA7 (determinismo):** dos runs del mismo brief → `unbound` idéntico y en el mismo orden.

## 7. Datos
Sin cambio de esquema del catálogo. `RoleTrace` (router.ts:141) gana `unbound: Unbound[]` y `bindingFallback?: true` (aditivo; `flow.ts` lo copia). `CANONICAL_COPY` es una constante de código, no un fixture de test.

## 8. Dependencias
Ninguna nueva. Reusa `blockSlotModel`/`modelFromSource` (slot-model.ts), `contentFor`/`injectCopy` vía `adapter.propsFor`, `RoleTrace`/`traceLines` (router.ts). Falla segura: sin source → pasa; sin elegibles → D2.

## 9. Seguridad
`superficie_expuesta: no`. Sin red, sin endpoint, sin input externo nuevo: el source que se lee es el vault/repo que ya lee slot-model. Sin secretos.

## 10. Plan de pruebas
- Unit (`tests/eligibility-router.test.ts`): CA1 con `modelFromSource` sobre un source fixture inline; CA2 y CA3 con `stubAdapter` del router.test.ts extendido con `propsFor` por slug y `catalog` inyectado con entries relume `verified:false` + un `source` fixture bajo `tests/fixtures/` (sourceTextOf lee `REPO_ROOT/source`).
- Integración local (no CI): CA4/CA5/CA7 con los 4 briefs; Secondary y orq comparan picks antes/después.
- Regresión: CA6.

## 11. Fuera de alcance
- Arc nativos y curados (C1). v2 = ampliar a Arc con defaults del destructuring de la firma (`function Export(`), heurístico que hoy deja 9 showcase como NO VERIFICADO; necesita decisión de Karen y su propia medición. Es donde está el demo visible hoy (site-footer, hero-signup).
- Tabla de proveedores (subHeadings, tabs, sections, socialMediaLinks): research del peer, acotado a steps/footer/pricing/navbar.
- Reordenar por elegibilidad o puntuarla: el filtro no rankea (brief §6).
- `defaultTabValue` como string que injectCopy pone en `''` (inject-copy.ts:175): bug aparte del inyector, se anota.

## 12. Riesgos
- Sobre-exclusión por `has()` de injectCopy: un prop de contenido que injectCopy sí llena pero bajo otro nombre no existe (bound sale de propsFor real), así que no hay falso unbound por nombre. El falso positivo posible es un prop con hoja de texto que NO se renderiza (p.ej. `defaultValue` de tabs): se excluye un bloque que no mostraría demo. Mitiga D2 y que solo aplica con alternativa. Se revisa con la lista `unbound` del trace en los 4 briefs (CA4).
- Elegible ≠ llenado por este brief: el filtro usa CANONICAL_COPY (el máximo que el copy puede dar); si el copy real de un brief omite el prop que el bloque elegible consume, ese bloque renderiza su default. Verificado que NO ocurre en lumen (pricingPlans presente). Cierre real: render.ok (v3) mide lo emitido, no lo llenable.
- Vault ausente en CI (RNF3): el filtro queda inerte y nadie lo nota. Mitiga: CA4/CA5 se corren en local por las dos sesiones y el trace va al PR.
- `CANONICAL_COPY` desalineado con lo que copygen produce de verdad (p.ej. faq sin `contact`): un prop se marca bound que el copy real no llena. Mitiga: CANONICAL_COPY se construye con los mismos campos de `role-fields.ts`; test que asserta que cada rol de `contentFor` devuelve contenido no vacío con CANONICAL_COPY.
- Rendimiento con el pool entero (838 × propsFor): medido <1 s; si creciera, cachear `unbound` por slug en la misma corrida.

## 13. Archivos (4)
`src/catalog/eligibility.ts` (nuevo: CANONICAL_COPY, unboundTextProps, APP_PROPS), `src/router.ts` (filtro en routeRole, RoleTrace.unbound/bindingFallback, traceLines), `src/log/flow.ts` (copiar unbound/bindingFallback al detail), `tests/eligibility-router.test.ts` (CA1-CA3 + fixture inline).

## 14. Git / entrega
Rama `feat/eligibility-filter` off main; QA local 100% (CA1-CA7) + orq verifica corriendo → push + PR sin auto-merge (toca el router, Karen lee). CI es el gate del merge.
