# ADR 0010: El plan decide las secciones de la página

Estado: APROBADO (Karen) | Fecha: 2026-10-23
Origen: prioridad de Karen "siempre genera la misma pinche página" → `qa-atomchat/DIAG-misma-pagina-orq.md` (y los DIAG de
QA y Secondary), brecha 1 de `re-v0/AUDITORIA-orqWebTransformer.md`, fila 1 de `qa-atomchat/AUDITORIA-orqWebTransformer.md`.
Spec de implementación: `docs/spec/plan-decide-secciones.md`. Depende del sensor `plan.roles` de QA (en rojo sobre
abbcfe51 antes de implementar). Interfaz con ADR 0008 (el contrato ya tiene `page.sections[]`) y 0009 (los bloques por rol).

## Contexto

Las secciones de toda página salen de una lista fija escrita en código antes de que el modelo lea el brief:

- `src/v0/roles.ts:7-10`: `CONTENT_ROLES = [hero, logos, features, stats, steps, testimonials, pricing, faq, cta]`,
  `DEFAULT_ROLES = [navbar, ...CONTENT_ROLES, footer]`.
- `src/v0/composer.ts:107` `createComposer(skillDir, roles = DEFAULT_ROLES)`; `scripts/v0serve.ts:67` lo llama sin roles;
  `transport.ts` no conoce la palabra `roles`.
- `src/v0/composer.ts:124` → `page-plan.ts:117` `planUserJson = { brief, roles }`: el plan recibe la lista; el system
  (`page-plan.ts:113`) exige "una entrada por rol recibido, en el mismo orden" y el parser rechaza el plan si falta uno
  (`page-plan.ts:94` "faltan secciones").
- Aunque el plan propusiera otra lista, `composer.ts:161` pasa `roles` a `composeLayoutBySection` y `compose-layout.ts:373`
  compone `req.roles`; `page.sections` del contrato solo se usa para surface/motion (`runner.ts` `sectionContracts`).

Resultado medido sin corridas nuevas: 11 de 11 workspaces de 11 secciones con la secuencia idéntica (Nimbus EN ×7, Orbit,
atomchat ES, 817da32c ES); los 7 workspaces de 8 secciones son la misma lista fija anterior a #78. En atomchat
(`abbcfe51`) el brief pedía beneficios, cómo funciona, casos de éxito con métricas, precios y FAQ; salieron además
logos y stats, y "casos de éxito" quedó repartido entre stats y testimonials porque no existe un rol para ello. El
plan hace bien su trabajo: rellena con objetivos la lista que le dieron.

v0, mismo brief (`qa-atomchat/FLUJO.md`, chat n5znXnBtCXV): plan "header, hero con mockup de chat, beneficios, cómo
funciona, casos, precios, FAQ, CTA final y footer"; escribió además un strip de métricas y ninguna fila de logos. En
j049 (brief que enumera 9) escribió esas 9 (`v0-j049-src/page.tsx:16-24`); en Café Lumbre (brief sin lista) escribió 4
(`v0-lumbre-src/page.tsx:10-14`): hero, features, testimonials, order-cta. No hay lista fija: dos briefs, dos listas.
El marco (header/footer) sí va siempre, sin que el brief lo pida.

El legado `src/plan.ts` (modo catálogo) ya infería secciones del brief por palabras clave (`KEYWORDS`, `planSections`):
determinista, pero ciego a "casos de éxito con métricas" y a cualquier formulación que no esté en la lista. El modo v0
no lo usa.

## Decisión

1. **El plan decide `page.sections[]`; el composer compone eso.** El input del plan deja de traer `roles` y pasa a traer
   `{ brief, vocabulary }`. El system pide: si el brief enumera secciones, esas en su orden; si no, las mínimas que el
   negocio necesita (hero + 2 a 5 de contenido + cta), con el rol del vocabulario que mejor encaje y, para lo que no
   encaje, el rol más cercano (hoy "casos de éxito" → `cases`). Cae la regla "una entrada por rol recibido" y la
   validación "faltan secciones".
2. **Vocabulario de roles como dato** (`src/v0/roles.ts` `ROLE_VOCABULARY`): los roles que el catálogo y el retrieve ya
   conocen (`ROLE_CATEGORIES`, `retrieve.ts:12-24`: hero, logos, features, stats, steps, testimonials, pricing, faq,
   cta) más tres que el brief de atomchat y los de Lumbre piden y hoy no existen: `cases` (casos de éxito con métricas),
   `integrations`, `contact`. Un rol sin bloque maduro compone como árbol con los átomos del shortlist (ruta existente,
   `compose-layout.ts` `LAYOUT_RULE`); cuando Secondary/Arq publiquen un bloque maduro para ese rol, se fija solo. El
   vocabulario es del DS, no del plan: vive junto a `ROLE_CATEGORIES` y `ROLE_HINTS`, y cada rol nuevo lleva su entrada
   en los dos, apuntando a categorías Relume reales del catálogo (revisión de Arq): `contact` → `contact-sections`,
   `integrations` → `logo-sections`, `cases` → `testimonial-sections` + `stats-sections`.
3. **El marco sigue fijo en código**: `navbar` primero y `footer` último (`FRAME_FIRST`/`FRAME_LAST`), como en v0. El
   plan no los decide ni los omite.
4. **Validación del plan** (`parsePagePlan`): cada `sections[].role` ∈ vocabulario (error con el rol y la lista), entre
   1 y 10 secciones de contenido, `hero` presente (una landing sin hero no es landing: error, no corrección silenciosa).
   Roles repetidos se permiten (dos `features`), `sectionIds` ya los numera.
5. **Composición**: `roles = [...FRAME_FIRST, ...plan.sections.map(s => s.role), ...FRAME_LAST]`. Las anclas válidas
   (`hrefPolicy`, hoy `composer.ts:157` calculadas antes del plan) se calculan después, sobre esos roles. Sin plan
   (fallo del modelo) se compone con `DEFAULT_ROLES` y el paso queda en `error` visible, como hoy.
6. **Follow-up y repair** componen sobre `parentPage.sections` (ya lo hace el repair, `compose-layout.ts:251`); un
   follow-up que recompone usa los roles del padre, no `DEFAULT_ROLES`. Editar en sitio, y agregar o quitar secciones
   en un follow-up, quedan para el ADR de P1: este ADR solo decide las secciones de la primera versión.
7. **Sensor**: `plan.roles` + `variety.sequence` de QA (PR #142, `src/plan-sensors.ts`) miden las secciones de la
   página contra las que el brief nombra (`ROLE_WORDS`, es/en/pt; hero y cta cuentan como implícitos, como en v0) y que
   dos briefs distintos no den la misma secuencia. En rojo sobre abbcfe51 (logos sin pedir; misma secuencia que
   Nimbus); v0 da 0 en j049, Lumbre y atomchat. El vocabulario del plan usa los MISMOS nombres que `ROLE_WORDS`; `cases`
   se añade allí separado de `testimonials` (acordado con QA). Predicciones
   medibles: atomchat → navbar, hero, features, steps, cases, pricing, faq, cta, footer (9; stats opcional si el plan lo
   justifica, como hizo v0) y sin logos; j049 → las 9 del brief + marco (11, igual que hoy); un brief tipo Lumbre → ≤ 7.

## Consecuencias

- Una cafetería deja de recibir pricing, stats, faq y logos que no pidió; una SaaS que enumera 9 recibe 9.
- Aparecen secciones nuevas (`cases`, `integrations`, `contact`) que hoy componen como árbol: peor forma hasta que
  Arq/Secondary les den bloque maduro; mejor que no existir o disfrazarse de testimonials. El PR de implementación
  cuenta, por brief, cuántas secciones salieron en árbol por rol nuevo (dato para el lote de ports de Arq).
- Con 2 o más maduros por rol el modelo ya elige (`CHOOSE_BLOCK_RULE`); el cuello de la variedad de bloques es la
  oferta (20 de 821 Relume portados), no la selección. Este ADR decide secciones; la oferta es de L0/L1.
- El plan es la única fuente de qué secciones hay: QA puede medirlo contra el brief y el builder puede mostrarlo
  ("Armé la landing con …" pasa a ser lo que el brief pidió).
- `--role-set` de `scripts/v0layout.ts`/`v0compose.ts` queda como override explícito para experimentos; el transport
  no lo expone.
- Riesgo: el modelo elige mal el rol (p. ej. `testimonials` para "casos"). El sensor lo mide; la corrección va en el
  system del plan o en el vocabulario, no por bloque.

## Alternativas descartadas

- **Inferir por palabras clave** (`src/plan.ts` legado): determinista pero no entiende "casos de éxito con métricas" ni
  briefs sin lista en otro idioma; v0 lo hace con el modelo, nosotros también.
- **Que el plan solo quite roles de `DEFAULT_ROLES`**: no puede añadir `cases` ni `integrations`; sigue siendo la misma
  plantilla recortada.
- **Secciones en el `ComposeRequest` del transport**: el transport no sabe de negocio; la decisión es del plan (L5),
  igual que lang/título/hechos (ADR 0008).
- **Un rol nuevo por cada brief**: sin vocabulario no hay shortlist, ni gates, ni sensor por rol. El vocabulario crece
  con evidencia (dos briefs lo pidieron), no por cada palabra del usuario.
