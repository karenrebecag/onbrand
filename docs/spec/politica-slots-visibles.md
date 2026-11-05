# Spec — Política de slots visibles sin dato (rellenar, omitir o vacío del contrato)

**Estado:** REVISADA (v3; ajustes de implementación 2026-10-21: inventario por contrato TS (proof/privacyNote entran), footer legal/tagline como reglas, nivel de verificación en RF5, `run.ts` en E, `generate.ts` en C1; PRs #31 A, #32 B, #33 D, #34 E, #29 C1) — VERIFICADA por WebTransformerSecondary 2026-10-21 (simulación sobre 8efcae7: 74 pass / 0 fail en router, eligibility-router, core, compose-layers y adapter-arc; CA9/CA10+CA14/CA17 verdes; nimbus conserva hero-signup por bindingFallback, pulse saca hero-signup hacia hero-section sin cambiar la página) — redactada por orq 2026-10-21 sobre el brief ESCALADO y decidido por Karen el mismo día ("vamos con lo recomendado"). v1 atacada por WebTransformerSecondary (NO VERIFICADO: 3 bloquean, 7 ajustan); v2 incorpora los 10 puntos; v3 cierra la segunda pasada (RF5: `unboundFor` opcional + alternativa solo verified y no layout, CA17 intacto). Implementación autorizada por Karen en chat 2026-10-21 ("listo vamos con la spec"); el Estado formal lo escribe solo ella.
**Research:** `docs/research/politica-slots-visibles.md` (local, `docs/research/` no se versiona por decisión de Karen 2026-10-21; deep; D1-D7 según recomendación; referencia viva Webflow §3b).
**Medición de base:** origin/main `8efcae7` **+ PR #28 mergeado** (D6: la base de CA5/CA11 incluye `people:[]`, `shortButtonLabel←primaryCta`, `status:null`, `socials:[]`), build `nimbus-waitlist` + pack bp-aurora.
**Relación con otras piezas:** ADR 0005 (fork hero-signup `count`/`proof`) va DESPUÉS de esta spec (D5). CSS del shell (`cta-3-shell.module.css:58`) es PR0 de 1 línea, fuera.

## 1. Objetivo
Que ningún bloque emitido muestre el default demo horneado en su `.tsx` cuando el brief no llena un slot visible: el pipeline rellena (texto o media), pasa el vacío que el contrato admite (`null`, `[]`, `""`) u omite el bloque, y lo que no puede apagar lo reporta. Métrica: en `nimbus-waitlist` con bp-aurora desaparecen la imagen gris del shell, los avatares/socials/status demo, los logos sin dato real y el chrome del bento; `demoVisible` del reporte lista exactamente lo que queda (`hero-signup.count` y `hero-signup.proof`) hasta ADR 0005.

## 2. Decisiones que implementa (de Karen, brief §0)
- **D1** La política vive en un overlay humano `catalog/slot-policy.json` por slug y prop; `gen-schemas` lo mezcla al schema como `x-empty` (documentación); un test de `bun test` detecta el drift.
- **D2** `propsFor` aplica la política SIEMPRE, también a los casos curados.
- **D3** Un rol sin copy no se emite; pasa a omitidos con motivo `sin copy`.
- **D4** El generador no fabrica marcas: `logos.brands` solo desde `brief.brands`; sin marcas reales el rol `logos` se omite, en las tres rutas (determinista, fallback, LLM). El `copy.json` escrito a mano es INPUT: lo que declare se honra; por eso el de nimbus deja de declarar marcas que no son suyas.
- **D5** Prop con default visible y sin vacío admitido → regla `omit`: cuenta como "sin binding" en el filtro de elegibilidad (extendido a Arc vía adaptador) y, si el bloque se emite igual, emit reporta `demoVisible`. Política primero; fork (ADR 0005) después.
- **D6** PR #28 mergeado tal cual; la política produce los mismos vacíos y los cubre hacia adelante.
- **D7** Un `kind: layout` hosteado en Arc devuelve desde `propsFor` sus slots `media` con el Default del propio shell para que `fillImages` los sustituya; sin constante nueva de placeholder.

## 3. Vocabulario de la política
`catalog/slot-policy.json`:
```json
{
  "version": 1,
  "rules":      { "<slug>": { "<prop.path>": "null | [] | \"\" | media | omit" } },
  "exceptions": { "<slug>": { "<prop.path>": "<motivo>" } }
}
```
- `null` / `[]` / `""`: el vacío que el contrato del bloque admite y que oculta el slot. Verificado por Secondary contra cada `.tsx` del inventario (los defaults de destructuring solo aplican a `undefined`, nunca a `null`/`[]`/`""`).
- `media`: el slot es una imagen; propsFor pasa `{ src: <Default.src del shell>, alt: "" }` para que `fillImages` (`src/images.ts:65-71`, regex `PLACEHOLDER` `:7`) ponga una foto determinista. `alt: ""` es deliberado: no hay copy que la describa y el alt del Default es inglés ("Placeholder image", `cta-3-shell.tsx:43`).
- `omit`: el contrato no admite vacío y el default es visible; sin binding el bloque cuenta como no elegible (RF5) y, si se emite igual, se reporta (RF4).
- `exceptions`: TODO prop de primer nivel que `propsFor` deja sin poner y que no lleva regla, con motivo escrito: config/estado con default invisible (`sticky`, `animateIn`, `hue`, `autoPlay`…), chrome sin copy agnóstico (`contact-section.topics`: "fase i18n"), contenido opcional cuyo default es `undefined` (`hero-section.announcement/install/media/meta/highlight`, `cta-section.points/visual`, `feature-bento.visuals`, `stats-band.description`). El schema NO guarda tipo TS, clase ni visibilidad del default (`schema-gen.ts:72-95`; verificado: `hero-signup.schema.json` trae `count:{type:number}`, `proof:{}`), así que la clasificación la hace una persona una vez y CA1 la mantiene honesta. Volumen esperado: los 23 schemas suman 224 props; la mayoría de las que propsFor no pone irán a `exceptions`. Es el inventario, no un efecto secundario.
- **Inventario inicial de `rules`** (lo cierra CA1, no la mano): hero-signup `people:[]`, `count:omit`, `proof:omit` (render-prop: no está en el schema pero sí en el contrato TS; por eso CA1/CA2 enumeran con `tsPropsOf`, no con el schema); site-footer `status:null`, `socials:[]`, `newsletter:null`; newsletter-signup `publication:null`, `readers:null`, `privacyLink:null`; site-header `secondaryAction:null`; faq-section `contact:null`; cta-section `faces:[]`; feature-bento `description:""`; logo-marquee `brands[].icon:""`; shells con placeholder de Relume en su Default: `cta3_shell`, `header30_shell`, `layout255_shell` → `image:media`. NO llevan regla `media`: `header1_shell` (su Default ya es una foto picsum, `header-1-shell.tsx:43`), `layout237_shell` y `faq7_shell` (sin prop de imagen; una regla ahí rompe CA2).
- **Clasificados con copy mínimo (CA1b):** site-footer `legal:[]` (`legal.length > 0 &&`, `site-footer.tsx:178`) y `tagline:""` (`:207`), newsletter-signup `privacyNote:""`, hero-section `secondaryAction` excepción (default undefined).

## 4. Requisitos funcionales

### Fase A — política en el adaptador (código: `catalog/slot-policy.json`, `src/catalog/slot-policy.ts`, `src/adapters/arc.ts`, `tests/slot-policy.test.ts`, `tests/adapter-arc.test.ts`)
- **RF1 (carga y validación):** `loadSlotPolicy()` lee el overlay una vez (cache), valida shape y vocabulario cerrado; un valor fuera del vocabulario es error, no extensión silenciosa (misma regla que `SEMANTIC_FORMATS`). Overlay ausente → error explícito al arrancar.
- **RF2 (aplicación siempre, D2):** en `arc.ts` `propsFor` devuelve `applySlotPolicy(e, curated ?? generic ?? schemaDriven)`. `applySlotPolicy` es pura: para cada regla del slug cuya ruta NO está puesta en `props` (ausente o `undefined`) escribe el vacío (`null`/`[]`/`""`); `media` escribe `{ src, alt: "" }` con `src` del Default del bloque; `omit` no escribe nada (lo consumen RF4/RF5). Rutas con `[]` (`brands[].icon`) se aplican a cada elemento existente. Una regla nunca pisa un valor que el binding sí puso. Si `props` es `undefined`, el resultado sigue `undefined` para strips (el rol sin copy lo decide RF8), salvo el caso RF3.
- **RF3 (shells, D7):** `isHostedInArc(e) && e.kind === 'layout'` deja de devolver `undefined` seco: `propsFor` devuelve `applySlotPolicy(e, relumeProps(slug, copy) ?? {})` y devuelve `undefined` solo si el resultado queda vacío. El `src` del Default se lee con `extractDefaultLeaves(sourceTextOf(entry))` (`src/copygen/defaults.ts:39`, `src/copygen/slot-model.ts:125`), NO con `blockSlotModel`, que descarta `src`/`alt` (`slot-model.ts:62`). Camino confirmado hasta la foto: `compose-layers.ts:88` → `:92` → `emit.ts:112-119` → `fillImages` `:159` → `images.ts:69` → `photoFor`.
- **RF6 (adaptador sin demo, D6):** `feature-bento` deja de asignar `visual: BENTO_VISUALS[i % 6]`; `BENTO_VISUALS` se elimina (`arc.ts:25,87`). Celda sin visual → sin ilustración (`feature-bento.tsx:190` devuelve `null`).

### Fase A2 — x-empty documental (código: `scripts/gen-schemas.ts`; datos: `catalog/schemas/*.schema.json` regenerados)
- **RF7 (D1):** `gen-schemas` mezcla la regla del overlay como `x-empty` en el prop del schema y falla (`exitCode 1`, como con `docErrors`) si el overlay nombra un prop inexistente. Documentación del contrato: el runtime lee el overlay, no el schema. Mergeable sola; sin ella nada deja de funcionar.

### Fase B — omisión y reporte en emit (código: `src/emit.ts`, `scripts/run.ts`, `src/log/flow.ts`, `tests/emit.test.ts`)
- **RF8 (sin copy → no se emite, D3):** la condición es **`copy[role] === undefined`**, no "propsFor devolvió undefined". `RoleCopy` es 1:1 con `Role` (`src/copy.ts`: `hero|logos|features|steps|stats|testimonials|pricing|faq|cta|navbar|footer`; `banner` no tiene copy y nunca se omite por esta regla). Aplica a strips y a capas: una `Layer` cuyo `sel.role` no tiene copy se omite entera antes de `resolveLayer` (`emit.ts:142`), así el shell no sale vacío. No necesita `kind`, `emittable` ni schema en `EmitEntry`. Un bloque CON copy de rol cuyo `propsFor` devuelve `undefined` (ai-side-panel, market-terminal, wallet-card, week-calendar bajo `features`) se emite como hoy; su demo lo gobiernan `omit`/`exceptions` del overlay, no esta regla.
- **RF4 (demoVisible, D5):** `EmitReport` gana `demoVisible: { slug: string; props: string[] }[]`: por bloque emitido **incluidos los inner de una capa**, las reglas `omit` del overlay cuyo prop no puso el binding. `run.ts` lo imprime (`demo visible: hero-signup[count, proof]`) y `flow.ts` lo copia a la etapa emit.
- **RF9 (dos orígenes, un reporte):** `EmitReport.omitted: { role: Role; reason: 'sin candidato' | 'sin copy' }[]`. `run.ts:108` sigue calculando los `sin candidato` y los pasa a `emit`; emit añade los `sin copy`. `omittedRoles: string[]` se conserva como la unión (compatibilidad con `flow.ts:136` y tests). Sin duplicados.

### Fase C1 — copygen sin marcas inventadas (código: `src/types.ts`, `src/copy.ts`, `src/copygen/generate.ts`, `src/copygen/role-fields.ts`, `src/copygen/templates-es.ts`, `src/copygen/templates-en.ts`; 6 porque las líneas de `SAMPLE_BRANDS` quedan muertas y no se dejan)
- **RF10 (brief.brands, D4):** `Brief` gana `brands?: string[]`. `LogosCopy.brands` pasa a `brands?: string[]` (`copy.ts:15`). `copy.json` no tiene validador (`run.ts:138` castea), así que los existentes siguen cargando.
- **RF11 (tres rutas, y la clave desaparece):** el punto único es `generatePageCopy` (`generate.ts:104`, el único que ve brief y bloques): sin `brief.brands` saca el bloque `logos` de `blocks` antes de `planSection` (vale para LLM y determinista); con `brief.brands`, `logos.brands = brief.brands` verbatim y sin fit tras `assembleRoleCopy`. Así el copy generado **no trae la clave `logos`** (ni determinista `templates-es.ts:49`/`templates-en.ts:47`, ni fallback `deterministicCopy` `copy.ts:143`, ni LLM: `role-fields.ts:59` deja de pedir `logos.brands[i]` y el rol no se genera). Así el rol cae en RF8 `sin copy` sin lógica nueva. `SAMPLE_BRANDS` sigue en `testimonials[].company` (fuera de alcance).

### Fase C2 — adaptador y brief de nimbus (código: `src/adapters/arc.ts`, `tests/copygen-generator.test.ts`; datos: `briefs/nimbus-waitlist.copy.json`)
- **RF12 (adaptador defensivo + nimbus):** `arc.ts:75` deja de hacer `c.brands.map` a ciegas: un `copy.logos` sin `brands` (copy.json a mano) hace que `propsFor('logo-marquee')` devuelva `undefined` en vez de `TypeError`, y un slug con caso curado que devuelve `undefined` ya no cae a `injectBySchema` (`CURATED_ARC`): el schema le habría puesto el title y el bloque, sus marcas demo. En emit, `hasRoleCopy` trata `logos` sin `brands` como rol ausente, así que RF8 lo omite con `sin copy` (D4: sin marcas reales no hay fila). `briefs/nimbus-waitlist.copy.json` quita la clave `logos` entera (Linear/Vercel/Retool no son clientes de nimbus); si algún día los tiene, las declara ahí y la fila vuelve.

### Fase D — elegibilidad por adaptador (código: `src/router.ts`, `src/catalog/eligibility.ts`, `src/adapters/types.ts`, `src/adapters/arc.ts`, `tests/eligibility-router.test.ts`)
- **RF5 (D5, RNF1):** el core no lee overlay ni schema: `LibraryAdapter` gana `unboundFor?(slug): string[] | undefined` (OPCIONAL; `undefined` = "sin opinión, usa la fórmula del core"). El adaptador Arc devuelve, para bloques Arc nativos, **las reglas `omit` del slug cuyo prop no pone `propsFor(slug, CANONICAL_COPY)`**, y `undefined` para todo lo demás (Relume genérico, layouts). Nada de `isContentProp` (por nombre mete config, por format pierde `count/people/socials/status`, por tipo TS clasifica `status` como config). `eligibility()` (`router.ts:263-275`) calcula `props = adapter.unboundFor?.(slug) ?? (isGenericRelume(entry) ? unboundOf(entry, adapter) : [])`: los stubs sin el método (`router.test.ts:24-35`, `eligibility-router.test.ts:26`) conservan el comportamiento actual y ningún test existente se toca. **Alternativa elegible** = candidato con `props` vacío, `kind !== 'layout'` y que no baje de nivel de verificación (si el excluido es verified, la alternativa debe serlo; un genérico gate-ok sí sale ante otro gate-ok elegible, como en #27): un gate-ok del pool de variedad no cuenta (su binding no está verificado: cambiar un demo conocido por uno desconocido no quita nada), y un shell tampoco (el strip excluido volvería como inner vía `pickInner` y la página cambia sin quitar el demo). Si no hay alternativa así, `bindingFallback` y pasa el pool (D2 de #27). `RoleTrace.unbound` no cambia de shape.

### Fase E — i18n mínima con prop (código: `src/adapters/arc.ts`, `scripts/run.ts`, `tests/adapter-arc.test.ts`)
- **RF13:** `createArcAdapter(registry, { lang })` recibe el idioma del run y `stats-band` sale con `locale` (`es-MX`/`en-US`). Único prop de idioma expuesto por un bloque del pool.

## 5. Requisitos no funcionales
- **RNF1 (agnóstico):** `plan/route/rank/select/compose-layers/types` no leen vocabulario Arc/Relume; el overlay lo consumen el adaptador (`propsFor`, `unboundFor`) y el test de inventario.
- **RNF2 (vendor prístino):** ningún `.tsx` del scaffold cambia. Lo que exige tocar el bloque (hero-signup `count`/`proof`) es ADR 0005.
- **RNF3 (determinista, sin deps, sin red):** overlay JSON estático; `applySlotPolicy` pura; `fillImages` ya es determinista por seed.
- **RNF4 (CI sin vault):** CA1/CA2 leen `catalog/schemas/*.json`, el overlay y el source vendorizado de los shells en `templates/arc-scaffold`, todo en git.
- **RNF5 (coste):** una lectura del overlay por proceso; `applySlotPolicy` O(reglas del slug).

## 6. Criterios de aceptación
- **CA1 (inventario, D1/D2):** para los 23 bloques con schema, `tsPropsOf(source)` de primer nivel (el schema deja fuera ReactNode y render-props, justo los que hornean demo) `− keys(propsFor(slug, CANONICAL_COPY))` ⊆ `rules[slug] ∪ exceptions[slug]`. Falla nombrando `slug.prop`. **CA1b:** lo mismo con `MINIMAL_COPY` (solo campos obligatorios de cada `*Copy`), para que los bindings condicionales (`legal`, `tagline`, `privacyNote`, `secondaryAction`) no se escondan detrás del copy canónico.
- **CA2 (drift, D1):** cada `rules[slug][prop]` y `exceptions[slug][prop]` existe en el schema del slug (Arc) o en los Defaults del source (`extractDefaultLeaves`) para shells.
- **CA3 (aplicación siempre, RF2):** `propsFor('site-footer', copy)` devuelve `status: null` y `socials: []`; `propsFor('hero-signup', copy)` devuelve `people: []` y NO escribe `count` ni `proof`; un valor puesto por el binding no se pisa.
- **CA4 (shell, RF3/D7):** `propsFor('cta3_shell', copy)` devuelve `{ image: { src: <Default.src>, alt: '' } }`; tras `fillImages`, `src` es `picsum` determinista; `App.tsx` de nimbus no referencia `placeholder-image.svg`.
- **CA5 (demoVisible, RF4):** nimbus + bp-aurora sobre la base (8efcae7 + #28 + esta spec, sin ADR 0005): `report.demoVisible = [{ slug: 'hero-signup', props: ['count', 'proof'] }]`, también si hero-signup acaba como inner de un shell; `flow.json` lo lleva en emit y el runner lo imprime.
- **CA6 (sin copy, RF8/RF9):** copy sin la clave `features` sobre un pick `feature-bento` → el bloque no está en `App.tsx`, `omitted` contiene `{ role: 'features', reason: 'sin copy' }`, `omittedRoles` lo incluye una vez; una capa cuyo inner es de ese rol no se emite (ni el shell). Copy CON `features` y pick `wallet-card` (propsFor `undefined`) → se emite como hoy.
- **CA7 (logos, RF10-RF12):** brief sin `brands` → `copy` sin clave `logos` en determinista (es/en), `deterministicCopy` y `role-fields`; el run omite `logos` con `sin copy`. Brief con `brands: ['X','Y']` → marquee con exactamente X e Y. `propsFor('logo-marquee', { logos: { heading } })` → `undefined`, sin `TypeError`, y un copy.json con `logos` sin `brands` deja el rol en `omitted` con `sin copy`. Ninguna cadena de `SAMPLE_BRANDS` ni `'Marca'` en `App.tsx`.
- **CA8 (filtro Arc, RF5):** `unboundFor('hero-signup')` = `['count', 'proof']`; `unboundFor('site-footer')` = `[]` (sus vacíos son reglas, no omit); `unboundFor('section_header10')` = `undefined`. Pool `hero` con `hero-signup` + `hero-section` verified elegible → `hero-signup` sale de la shortlist; pool con `hero-signup` + shells + genéricos gate-ok → `bindingFallback`, hero-signup se queda. **`tests/router.test.ts` CA9 (`:47`), CA10+CA14 (`:57`), CA17 (`:164`, pool unverified de 100 con genéricos gate-ok) y `tests/eligibility-router.test.ts` CA2 siguen verdes sin tocarlos.**
- **CA9 (bento, RF6):** `propsFor('feature-bento', copy).features[*]` sin `visual`; render sin "Weekly active 12,480" ni command palette (captura).
- **CA10 (regresión + determinismo):** `bun test tests/adapter-arc.test.ts tests/emit.test.ts tests/eligibility-router.test.ts tests/router.test.ts tests/core.test.ts tests/copygen-generator.test.ts tests/slot-policy.test.ts` verde; dos runs del mismo brief → `demoVisible`, `omitted` y `App.tsx` idénticos.
- **CA11 (visual, en el navegador de Karen):** nimbus + bp-aurora servido con `vite preview` y abierto como página: sin imagen gris en el CTA, sin avatares/X/GitHub/LinkedIn/"All systems normal", sin fila de logos, bento sin chrome inglés. Queda a la vista y así se dice antes: "1,283 finance teams are on the list" (ADR 0005) y el botón del CTA sin label hasta PR0.

## 7. Datos
- Nuevo `catalog/slot-policy.json`. Sin cambio en `catalog/index.json`.
- `catalog/schemas/*.schema.json` ganan `x-empty` (fase A2, documentación).
- `EmitReport` aditivo: `demoVisible`, `omitted`; `omittedRoles` se conserva.
- `Brief.brands?`, `LogosCopy.brands?`; `briefs/nimbus-waitlist.copy.json` pierde `logos`.
- `LibraryAdapter.unboundFor?` (método opcional; los stubs de tests no lo implementan y conservan la fórmula del core).
- Reversible: borrar el overlay y la llamada a `applySlotPolicy` devuelve el comportamiento actual.

## 8. Dependencias
Ninguna nueva. Reusa `extractDefaultLeaves`/`sourceTextOf`, `fillImages`, `CANONICAL_COPY`/`eligibility()`, `EmitReport`/`flow.ts`. Nota de Secondary: los `as const` de los Defaults dan arrays readonly frente a props mutables; ya pasa hoy (`columns`) y no rompe nada porque el runner usa `vite build` sin `tsc` y CI solo corre `bun test`.

## 9. Seguridad
`superficie_expuesta: no`. Sin red, sin endpoint, sin input externo nuevo; `brief.brands` es texto del propio brief que ya se serializa en `App.tsx` por la ruta existente de copy. Sin secretos.

## 10. Plan de pruebas
- Unit: `tests/slot-policy.test.ts` (CA1, CA1b, CA2, CA3, CA4); `tests/emit.test.ts` (CA6 con adaptador stub); `tests/eligibility-router.test.ts` (CA8 con un stub que sí implementa `unboundFor`, junto al existente que no); `tests/copygen-generator.test.ts` (CA7); `tests/adapter-arc.test.ts` (CA9, RF13).
- Integración local, no CI (vault): CA5, CA10 determinismo, CA11 visual, con nimbus + bp-aurora; Secondary re-mide con su render-gate (residuo por bloque antes/después).
- Fuera: snapshots de UI nuevos, tests de casos imposibles.

## 11. Fuera de alcance
- hero-signup `count`/`proof` (ADR 0005; aquí `omit` + `demoVisible`).
- CSS del shell (`cta-3-shell.module.css:58` × `newsletter-signup.module.css:101`): PR0 de 1 línea.
- Chrome en inglés sin prop (validación, "Pause logo motion", "Sign in", `Intl.NumberFormat("en-US")`): fork o aceptación; nombrados para que no vuelvan como "slots". El `<p>` vacío que deja `logo-marquee.description: ""` es cosmético y queda.
- `testimonials` con `SAMPLE_PEOPLE`/`SAMPLE_BRANDS`: misma ética que D4, cuando el brief modele testimonios reales.
- Bloques `features` con `propsFor` `undefined` (ai-side-panel, market-terminal, wallet-card, week-calendar): su demo se declara en el overlay (CA1 obliga), no se resuelve aquí.
- render.ok (v3): `demoVisible` es la declaración estática que el gate confirma midiendo.
- `characteristics` del negocio y `imagePackId`/prompt de imagen por slot (Webflow, brief §3b): research aparte.

## 12. Orden y tamaño
Siete entregas mergeables, cada una ≤5 archivos de código y con sus CA: **A** (política + shells + bento; 5) → **A2** (x-empty; 1 + JSON) → **B** (omisión y reporte; 4) → **C1** (copygen; 5) → **C2** (adaptador + nimbus; 2 + JSON) → **D** (elegibilidad; 5) → **E** (locale; 2). A sola quita 3 de los 5 defectos de nimbus; B hace visible lo que queda; C1+C2 quitan los logos; D evita elegir un bloque que va a quedar en demo cuando hay alternativa que no sea un shell. #28 ya está en la base.
