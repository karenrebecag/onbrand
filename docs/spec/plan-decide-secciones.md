# Spec: el plan decide las secciones (ADR 0010)

Estado: BORRADOR, espera la firma del ADR 0010 y el sensor `plan.roles` de QA en rojo sobre abbcfe51.
Dueña: orqWebTransformer (L5). Juniors Sonnet permitidos para los pasos marcados [junior]; orq lee cada diff.

## Objetivo

Que `page.sections[]` salga del brief (vía el plan) y el composer componga exactamente eso, con el marco fijo
(navbar, footer). Medible: sensor `plan.roles` en verde sobre atomchat, j049 y un brief tipo Lumbre.

## Archivos

| Archivo | Cambio |
|---|---|
| `src/runtime/roles.ts` | `ROLE_VOCABULARY: readonly string[]` = CONTENT_ROLES + `cases`, `integrations`, `contact`; `DEFAULT_ROLES` se conserva solo como fallback sin plan y para `--role-set` |
| `src/runtime/retrieve.ts` | `ROLE_CATEGORIES` y `ROLE_HINTS` para los roles nuevos, con categorías Relume reales: `cases` → `testimonial-sections`, `stats-sections` ("case study customer result metric quote"); `integrations` → `logo-sections` ("logo integration connect tools"); `contact` → `contact-sections` ("contact form address map whatsapp") [junior] |
| `src/runtime/page-plan.ts` | `planUserJson(brief, vocabulary)` → `{ brief, vocabulary }`; `PLAN_SYSTEM`: reglas de secciones (enumeradas → en orden; si no, hero + 2-5 + cta; rol más cercano del vocabulario; `cases` para casos de éxito); `parsePagePlan(raw, vocabulary)`: rol ∈ vocabulario, 1-10 secciones, `hero` presente; fuera "faltan secciones" |
| `src/runtime/composer.ts` | `computePagePlan(infer, brief, vocabulary, …)`; `roles = plan ? [...FRAME_FIRST, ...plan.sections.map(s => s.role), ...FRAME_LAST] : DEFAULT_ROLES`; `hrefPolicy` después del plan con esos roles; `createComposer(skillDir, imageGen?)` sin parámetro `roles` (los scripts que lo pasaban usan `--role-set` por otra vía, ver abajo) |
| `src/runtime/compose-layout.ts` | sin cambios de firma: sigue recibiendo `req.roles`; un follow-up sin repair que tiene `parentPage` compone `parentPage.sections.map(s => s.role)` |
| `scripts/v0layout.ts`, `scripts/v0compose.ts` | `--role-set` pasa a ser override: si viene, se saltea la decisión del plan (se inyecta como `vocabulary` cerrado y se exige completo); si no, el plan decide [junior] |
| `tests/page-plan-contract.test.ts` | plan con roles fuera del vocabulario → error; plan sin hero → error; 2 `features` → ok; brief que enumera → mismo orden (test del parser, no del modelo) |
| `tests/composer-plan.test.ts` | `computePagePlan` devuelve `page.sections` con los roles del plan y el composer compone esos roles (fake infer) y calcula las anclas sobre ellos |
| `docs/adr/0010-…`, `docs/adr/README.md` | fila APROBADO la escribe Karen |

## Contrato

```
planUserJson(brief, vocabulary) → { brief: { summary, goal?, name? }, vocabulary: string[] }
PagePlan.sections[]: { role ∈ vocabulary, objective, avoid, surface, emphasis, motion }   // sin 'proof'/'density' nuevos
pageDocOf(plan).sections → page.json.page.sections (ya existe; ahora manda)
roles compuestos = [navbar, ...plan.sections.role, footer]
```

Reglas del system (texto a cerrar en el PR):
- "Elige las secciones de ESTA página. Si el brief las enumera, son esas, en su orden, con el rol del vocabulario que
  mejor encaje (beneficios → features; cómo funciona → steps; casos de éxito → cases; precios → pricing; preguntas → faq).
  Si no las enumera, elige las mínimas que el negocio necesita: hero, entre 2 y 5 de contenido, y cta. No añadas
  logos, stats ni testimonials si el brief no da motivo. Navbar y footer no se listan: van siempre."

## Restricciones

- Nada por bloque: un rol nuevo sin bloque maduro compone como árbol por la ruta existente.
- El marco no se decide: `FRAME_FIRST`/`FRAME_LAST` fijos.
- Sin plan, comportamiento actual (`DEFAULT_ROLES`) y paso en error visible.
- Cero créditos de v0; medición con `claude -p` en transport propio (no :5300) y `scripts/page-sensors.ts` + sensor
  `plan.roles` de QA.
- Deps, gasto, deploy y OK visual: Karen.

## Verificación

0. Vocabulario del plan ⊆ `ROLE_WORDS` de `src/plan-sensors.ts` (#142), mismos nombres; `cases` separado de
   `testimonials` en los dos lados.
1. `bun test tests/page-plan-contract.test.ts tests/composer-plan.test.ts tests/compose-layout.test.ts` verde.
2. Corrida real con los 3 briefs (atomchat ES, j049 EN, Lumbre ES sin lista) en transport propio con registry:
   secciones = predicción del ADR; `bun scripts/plan-sensors.ts manifest.json` (con el `--json` de page-sensors de cada
   página) → `plan.roles` y `variety.sequence` 0 defectos; `factsCoherence` sigue 0/0/1; lang/título ok.
3. Tabla antes/después en el PR con los roles por brief, el tiempo de plan y cuántas secciones salieron en árbol por
   rol nuevo (`cases`/`integrations`/`contact` sin bloque maduro).

## Fuera de alcance (P1, otros ADR)

Editar en sitio en follow-up, y agregar o quitar secciones en un follow-up; adjuntos en el plan (Secondary ya entrega
`ComposeRequest.attachments[i].asset` como `PageAsset`, rama feat/attachments-public; el plan decide sección y posición y
reescribe el alt, que hoy sale del nombre de archivo saneado); imagen por sección desde `facts`; `facts.links` + CTA
`wa.me`; selección por intención entre maduros (Arq, revisada por orq).

## Riesgos

- El modelo elige `testimonials` donde el brief dice "casos": lo mide `plan.roles`; se corrige en el system o en el
  vocabulario (mapa de sinónimos por idioma), nunca por bloque.
- Un rol nuevo en árbol se ve peor que un bloque: es visible y medible (render-gate), y es el disparador para que
  Arq/Secondary publiquen el bloque.
