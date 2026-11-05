# ADR 0008: PageContract, el plan de página como dato que viaja

Estado: APROBADO por Karen (2026-10-23, en la sesión de orqWebTransformer: "aprobado, ocupate del merge si hay uno") | Fecha: 2026-10-23
Origen: RE de orqWebTransformer a v0 por capa (`~/Desktop/web-transformer-sesiones/re-v0/orqWebTransformer.md`,
`HIPOTESIS-orqWebTransformer.md` H-A) y síntesis de Arq (`re-v0/SINTESIS.md`, causa A). Experimento E-A1
medido en esta rama (sección Evidencia). Interfaz con el contrato de bloque (ADR 0009, Arq) en la última sección.

## Contexto

v0 escribe una landing en un solo contexto: un agente redacta todas las secciones viendo las anteriores. Por eso
los hechos salen iguales en varios archivos sin que nadie se lo pida. En el código copiado de j049
(`~/v0-fe-capture/calidad-re/orq-re/v0-j049-src/`):

- `4,000+` aparece en `logos.tsx:20`, `stats.tsx:6` y `cta.tsx:18`; `80+` en `features.tsx:29` y `pricing.tsx:30`;
  `14 days` en `hero.tsx:32`, `faq.tsx:8` y `pricing.tsx:54`. Las marcas de logos son las de los testimonios.
- El idioma, el título y la descripción viven una vez en el documento: `layout.tsx:7-9` (`metadata`) y
  `layout.tsx:15` (`<html lang="en">`); Café Lumbre igual con `lang="es"` y título en español (`v0-lumbre-src/layout.tsx:8,16`).
- Las secciones son las del brief, en su orden (`page.tsx:16-24`: 9 secciones de 9 pedidas; Lumbre: 4).
- Cada sección lleva un id semántico en el idioma de la página (`#customers`, `#pricing`; Lumbre `#nosotros`,
  `#testimonios`, `#pedido`) y los CTA apuntan a ellos (`hero.tsx:25,28`).
- El ritmo de fondos lo pone cada sección sobre sí misma: `section--layer` alternado (`how-it-works.tsx:25`,
  `faq.tsx:34`, `globals.scss:69`) y `<Theme theme="g100" as="section">` en el CTA (`cta.tsx:11`, `order-cta.tsx:8`).
- Cero animaciones de entrada en las dos páginas (grep `animate|transition|motion` en los .tsx: 0).

Nosotros componemos cada sección aislada y en paralelo (#108), así que nada de eso se comparte solo. En la
corrida 82cd6634 (mismo brief, 11 secciones): logos dice "300 empresas" y stats "1,200 teams"; las marcas de
logos no son las de testimonials; el CTA cita a "Priya Nair, Fieldwork Studio", que no existe en ningún otro
lado; la acción principal tiene 3 etiquetas distintas (navbar, hero, cta). Medido con el sensor de esta rama:
figuresOut 8/10, namesOut 11/13, ctaLabels 3, companiesOutsideLogos 3.

El plan ya calcula parte de esto (`page-plan.ts:62`: lang, arc, objective, proof, avoid, density, surface,
emphasis) pero 5 de 8 campos se tiran en `composer.ts:63` y los 3 que llegan van como prosa en `PLAN_BLOCK`
(`compose-layout.ts:216-220`). El repair compone sin plan (`transport.ts:344-351`). `lang="es"` y
el `<title>` de la demo están fijos en `templates/arc-scaffold/index.html:2,7`. `parentPage` viaja en
follow-up y nadie lo lee (`compose-layout.ts:356`). Ninguna decisión de página tiene dueño, dato ni sensor.

## Decisión

El plan deja de ser prosa y pasa a ser un **contrato de datos de página** (`src/v0/page-contract.ts`):

```
PageContract { lang: 'es'|'en'|'pt'; title; description?; sections: SectionContract[]; facts: PageFacts; images: PageImage[] }
SectionContract { role; id; objective; avoid[]; surface: base|muted|raised|inverse; emphasis: low|medium|high; motion: none|entrance }
PageFacts { brand; cta{label,href}; figures[{value,claim}]; companies[]; people[{name,role,company}]; prices?[{plan,monthly,yearly?}] }
PageImage { role; kind: product|photo|logo|avatar; alt }
```

Quién escribe y quién lee cada campo:

| Campo | Escribe | Lee / aplica | Mide |
|---|---|---|---|
| `lang`, `title`, `description` | L5 plan, una vez, en el primer mensaje | L6 persiste en `page.json.page` y proyecta a `<html lang>`, `<title>`, `<meta description>` (PR #124, `page-doc.ts`) | T: `lang` del documento = `lang` pedido; título ≠ el de la demo del scaffold |
| `sections[].role`, `id` | L5 plan (los roles salen del brief, no de `roles.ts:7`) | L1 runner escribe `id` en el wrapper; `href-check` valida anclas contra esos ids | T: secciones = pedidas; anclas rotas = 0 |
| `sections[].objective`, `avoid` | L5 plan | L4 compose-layout, como dato en el userJson | revisión de copy |
| `sections[].surface`, `emphasis`, `motion` | L5 plan (reglas: inverse ≤ 1, high ≤ 2) | L1/L2 por el wrapper del bloque (ADR 0009): `data-wt-surface`, `data-theme=dark` para inverse, `data-wt-motion` | T render-gate: contraste y residuo |
| `facts` | L5 plan, una vez | L4 cada sección lo recibe como DATO (`userJson.facts`) + `FACTS_RULE` en el system | T `factsCoherence`: figuresOut, namesOut, ctaLabels, companiesOutsideLogos |
| `images` | L5 plan (qué imagen y para qué rol); la dirección visual la decide Front | `image-step` genera antes de componer; el repair la hereda | T: hero con imagen tras repair |

Reglas:

1. El contrato se escribe **una vez** por página y se hereda: en follow-up y repair el transport entrega
   `req.parentPage.page`; si el composer no devuelve `page`, L6 hereda el del commit padre (#124).
2. L6 valida solo `lang` (es|en|pt), `title` (1-120) y `description` (≤300); el resto es opaco para L6 y
   lo valida L5 (`page-plan.ts` hoy, con `facts` y `images` añadidos en la Entrega 2).
3. Los hechos viajan como **dato**, no como prosa. Una sección que necesita una cifra, una marca, una persona
   o la etiqueta de la acción principal la toma de `facts`; lo que no está en `facts` ni en el brief no existe.
4. El pin del registry queda fuera del contrato (es del transport, #112).
5. Esta Entrega 1 incluye el tipo, el sensor (`facts-coherence.ts`), el flag `--facts` en `v0layout.ts` y el
   paso de `facts` al userJson. La Entrega 2 hace que el plan los genere y que `RunnerPage` devuelva `page`.

## Evidencia (E-A1)

Pregunta: ¿el modelo respeta un pool de hechos entregado como dato? Mismo brief literal de j049
(`briefs/nimbus-j049.json`), mismos 7 roles (navbar, hero, logos, stats, testimonials, pricing, cta), registry
blob + verify, `claude -p` (cero créditos de v0). 3 corridas con `--facts briefs/nimbus-j049.facts.json`
(pool espejo del de v0) y 3 de control sin facts. Medidas con `bun scripts/exp/facts-coherence.ts`.
Salidas en `~/Desktop/web-transformer-sesiones/re-v0/ea1/`.

| Corrida | figuresOut | namesOut | ctaLabels | companiesOutsideLogos |
|---|---|---|---|---|
| facts 1 | 0/10 | 0/10 | 1 | 0 |
| facts 2 | 0/10 | 0/10 | 1 | 0 |
| facts 3 | 0/10 | 0/10 | 1 | 0 |
| control 1 | 6/7 | 12/14 | 2 | 3 |
| control 2 | 6/10 | 12/14 | 1 | 3 |
| control 3 | 6/10 | 13/14 | 1 | 3 |

Predicción cumplida en 3/3: con el pool como dato, cero cifras y cero nombres fuera, una sola etiqueta para la
acción principal y las empresas de los testimonios son las de la fila de logos. Sin pool, cada corrida inventa
su propio juego (logos y testimonials nunca coinciden; stats inventa `99.98%`, `12000+`, `2.4m`; pricing inventa
precios). Nota del sensor: la primera medición marcó `4000+` fuera del pool porque stats-band devuelve `value: 4000`
numérico + `suffix: "+"` y el pool dice `4,000+`; se corrigió la normalización (sin separadores de miles),
no el dato.

## Consecuencias

- La coherencia de hechos deja de depender de la suerte del fan-out: se decide una vez y se mide.
- El plan crece (facts, images, title, description, ids, motion): una llamada más larga, no una llamada más.
- Lo que hoy es texto fijo del scaffold (`lang`, `<title>`) pasa a ser proyección del contrato: desaparece el
  `lang="es"` en páginas EN sin tocar cada plantilla.
- El repair y el follow-up heredan todo el contrato, así que dejan de recomponer en otro idioma o sin imagen.
- Queda un sensor nuevo (`factsCoherence`) que T puede correr sobre cualquier page.json con su `page.facts`.
- Riesgo: un pool mal inventado por el plan se propaga a toda la página. Es el mismo riesgo que en v0 y es
  preferible a once pools distintos; el plan es el lugar donde se corrige.

## Alternativas descartadas

- **Pasar los hechos como prosa en el system prompt.** Es lo que hace `PLAN_BLOCK` con objective/avoid y no
  evita que cada sección parafrasee; un objeto JSON en el userJson se cita textual (E-A1).
- **Componer en secuencia pasando las secciones anteriores.** Replica a v0 pero multiplica el wall time del
  fan-out (#108 lo bajó a 60s con 11 en paralelo) y solo cubre hechos, no lang/título/ids/surface.
- **Validar coherencia después (verify/checkLayout) y reparar.** Queda como sensor (T), no como mecanismo:
  reparar una sección por incoherencia es parchar por bloque, y el control muestra que sin pool no hay a qué
  converger.
- **Pool de hechos por sección.** Es exactamente la causa del problema.

## Interfaz común con el contrato de bloque (para ADR 0009)

Confirmado con RE sobre el código de v0, no con memoria:

- **surface:** v0 la pone por clase en la propia sección (`section--layer`, `globals.scss:69`) y por
  `<Theme theme="g100" as="section">` para la zona oscura (`cta.tsx:11`). Es decisión de página aplicada en el
  wrapper de la sección, no dentro del bloque. Encaja con `data-wt-surface` + `data-theme=dark` para inverse en
  el wrapper del runner (`runner.ts:250`).
- **align:** v0 no decide alineación por sección: todo `start`. Es política del DS (`layout.sectionHeaderAlign`
  en el v0.json de la skill), así que **no va en el contrato de página**; `--section-align` solo como override
  si algún día una sección lo pide. Por eso `SectionContract` no lo lleva.
- **motion:** v0 no anima nada (0 en las dos páginas). Es presupuesto de documento; el contrato lo lleva por
  sección (`none|entrance`) con default `none`, aplicado por `data-wt-motion` en el wrapper, nunca dentro del
  bloque.
- **lang, title, description, marca:** por documento (`layout.tsx`), nunca por sección. Las secciones heredan
  `lang` del contrato (hoy `detectLanguage` lo adivina por sección; el mapa `LANG_CODE` cubre la transición).
- **Colección (Arc/Relume):** no viaja en el contrato de página; la decide el selector por bloque.
