# Spec — Composición de slots: átomos y moléculas dentro de los organismos

**Estado:** REVISADA (v3) — VERIFICADA por WebTransformerSecondary 2026-10-21 (fd9933a: §6 con EmitEntry.role?/emittable?, opts.showcases, expansión de literales acotada a los que contienen ReactNode). Pendiente lectura de Karen; APROBADA la escribe solo ella. Decisiones de Karen 2026-10-21 (criterio único "como Relume": fill-or-omit, nunca default horneado): celda del bento sin stat colapsa su visual; un rol consumido por `fill.from` no se emite como bloque propio; `brand.mark` = `""` (wordmark: el pack no trae logo, no se inventa); ADR 0005 camino (a) fork en el vault. Orq 2026-10-21. v3 cierra la segunda pasada de Secondary (sin BLOQUEA; 2 AJUSTA: `brand.mark` necesita expandir literales de objeto en `tsPropsOf`, y S1/S3/S4 recortadas a ≤5 archivos de código). v1: §1-4 y §9 por orq; §0b, §5b, §6-8, plan y ataque (§11) por WebTransformerSecondary (NO VERIFICADO: 1 BLOQUEA en RF7 + 7 AJUSTA). v2 incorpora los 8 puntos (esta cabecera, RF1-RF9, §3, CA1-CA6). Pendiente segunda pasada de Secondary (→ REVISADA). APROBADA la escribe solo Karen.
**Discovery (local, no versionado):** diagnóstico del flujo de construcción 2026-10-21 + capturas Webflow (`~/Desktop/orq-webtransformer-contexto-2026-10-21/wf-ai-capturas/`) + `~/Desktop/relume-extract`. Resumen en §0.
**Base:** main `001a8a9` (política de slots visibles completa: #30, #31, #36-#41, #29, #40).
**Relación:** extiende la política de slots visibles (`docs/spec/politica-slots-visibles.md`): un slot `media`/`omit` que hoy se vacía o se reporta pasa a poder LLENARSE con un componente del catálogo. No toca ADR 0005 (fork hero-signup, decisión pendiente de Karen).

## 0. Lo que el discovery dejó probado (la spec no lo repite, lo cita)

- **Nosotros hoy.** Catálogo: 47 bloques Arc, 838 Relume, 6 layouts, **0 componentes** aunque el ingest escanea `ui-react/components` (`scripts/catalog-ingest.ts:60,84`: los marca `status: 'component'` y no los indexa porque `CatalogEntry.role` es obligatorio, `schema.ts:79,219`). El scaffold vendoriza 23 átomos (button, input, avatar, sparkline, animated-counter, segmented-control…) que nadie elige. El único punto de composición es `slots.inner` de los 6 layouts (`compose-layers.ts:55-68`, un slot por rol; la admisión de propless en el inner vive en `arc.ts:358`). Los props viajan como JSON (`emit.ts` `propsConst` = `JSON.stringify`), así que los **13 props ReactNode** de los bloques Arc (12 en 10 verified + `ai-chat.notice` gate-ok; survey con `tsPropsOf`: `feature-bento.visuals`, `hero-section.media`, `cta-section.visual`, `hero-signup.title/description/footnote/proof`, `newsletter-signup.privacyNote`, `contact-section.channels[].icon/detail`, `site-header.brand.mark`, `site-footer.brand.mark`, `ai-chat.notice`) son **inalcanzables por construcción** (`schema-gen.ts:159` además los deja fuera del schema, y con ellos `brand` entero en header y footer). El porter sí compone: `KIT_TO_ARC` (`port-imports.ts:15-35`) mapea 28 símbolos de `@kit/ui` a 19 componentes Arc (`Button`, `Input`, `Dialog`, `Tabs`, `Accordion`…) y deja 66 en `null`.
- **Webflow (captura real).** Un componente tiene props escalares, rich text, imagen y **slot**; `<wf-slot>` acepta instancias de componente o HTML. En la home capturada, el Hero lleva un `button-group wf-component-slot` con dos instancias del mismo átomo `Button` (la segunda con `is-secondary`), cada una con su slot `Text`. Las variantes son el mismo átomo con otra clase.
- **Relume (extract + vault).** 2.519 secciones importan átomos de `@kit/ui` (`Button` 979, `Input` 135, `Dialog` 129, `Tabs` 67). Cada sección **declara** sus átomos en sus Defaults con variante (`buttons: [{ title }, { title, variant: 'secondary' }]`, `header-1.tsx:51`) y sus slots ReactNode (`icon` 91, `children` 33) con el SVG del Default. El flujo de IA (`section-component-1`, `page-schemes-1`, `page-content-1`) elige categoría de sección y scheme por industria y rellena campos de texto por id; nunca toca átomos.
- **Conclusión.** Dos modelos válidos: Webflow = slot tipado que acepta instancias; Relume = átomo declarado por el autor de la sección con variantes. Esta spec implementa el primero sobre nuestros bloques Arc y toma del segundo la regla de oro: el pipeline no inventa composición, solo llena slots que el bloque declara, con componentes del catálogo y datos del brief.

### 0b. Verificación de anclas (Secondary, sobre main `001a8a9`)
- **Componentes fuera del índice: CONFIRMADO.** `scripts/catalog-ingest.ts:60` escanea `ui-react/components`; `:84` los deja en el reporte como `status: 'component'` sin crear entrada; `schema.ts:79` (`role: Role`) + `:219` (`fail('role')`) lo impiden. Matiz: `kind: 'component'` YA existe (`schema.ts:10,114`); lo que falta es `role` opcional, y además `category`, `tags`, `surface` y `geometry`, que también son obligatorios (`schema.ts:220-223`).
- **23 átomos vendorizados: CONFIRMADO** (23 carpetas en `templates/arc-scaffold/src/components/arc/` sin contar `blocks/` ni `lib/`).
- **Composición solo por `slots.inner`: CONFIRMADO.** `pickInner` está en `compose-layers.ts:55-68` (no 52-64). La admisión de `emittable:false` en el inner NO vive en compose-layers: es `usable` en `src/adapters/arc.ts:358` (`opts.innerSlot || e.emittable !== false`).
- **13 props ReactNode: CONFIRMADO, con dos matices.** El survey con `tsPropsOf` sobre los 47 bloques Arc (27 vendorizados y 20 desde el vault) da exactamente esos 13.
  - `ai-chat` es gate-ok, no verified: son 12 props en 10 bloques verified, más `ai-chat.notice`.
  - Quien deja fuera los ReactNode es `src/catalog/schema-gen.ts:159` (`/ReactNode|Record</` sin `[]`), no `gen-schemas`. Por esa misma regla, `site-header.brand` y `site-footer.brand` (`{ name; href?; mark?: ReactNode }`) quedan fuera del schema ENTEROS, no solo `mark`.
  - 15 bloques Arc no tienen tipo de props que `tsPropsOf` reconozca (`agent-run`, `metrics-dashboard`, `pricing-calculator`…), y tampoco los 3 propless verified (`plan-comparison`, `scroll-story`, `spotlight-grid`).
- **Porter: AJUSTA las cifras.** `KIT_TO_ARC` está en `port-imports.ts:15-35`: 94 símbolos de `@kit/ui`, de los que **28 mapean a 19 componentes Arc distintos** y **66 quedan `null`**. No son "20 átomos y 67 sin equivalente".

## 1. Objetivo
Que un slot ReactNode de un bloque Arc pueda llenarse con un componente del catálogo (átomo o molécula Arc) elegido por semántica y alimentado con datos del brief, y que lo que no se pueda llenar siga la política de slots visibles (vacío, omit, reporte). Métrica: en `nimbus-waitlist` + Aurora las celdas del bento dejan de tener el hueco de 184 px vacío porque reciben un visual del catálogo con un dato REAL del brief (`animated-counter`/`metric-card` con las cifras del copy de stats; nunca una serie inventada), `demoVisible` no crece, y la página sigue determinista y construible (`vite build`). Segunda métrica: ningún showcase propless (`spotlight-grid` y los 23 `emittable:false`) entra como inner si el brief no lo nombra.

## 2. Requisitos funcionales

### Fase S1a — átomos y moléculas al índice (código: `src/catalog/schema.ts`, `src/catalog/ingest-arc.ts`, `scripts/catalog-ingest.ts`, `src/adapters/types.ts` + `src/adapters/arc.ts:385` (`EmitEntry.role?`), `tests/catalog-ingest.test.ts`; datos: `catalog/index.json`)
- **RF1 (entrada `kind: component`):** `kind: 'component'` ya existe en el esquema (`schema.ts:10,114`); lo que cambia es `role?: Role` (obligatorio salvo `kind === 'component'`, parser `:219` y retorno `:252`), `semantics?: SlotSemantic[]` (vocabulario cerrado, §3) y valores fijos para lo que el parser exige (`category: 'component'`, `tags: []`, `surface: base/base`, `geometry: 'component'`). `EmitEntry.role` (`adapters/types.ts:16`) pasa a opcional. **Instalable** = deps npm declaradas en el scaffold (`catalog-ingest.ts:106`, que hoy deja pasar 153/153) **y cierre de imports** como `lintArc` (`arc.ts`: sin `next/*` salvo `next/image`, `lib/*` resolubles en el scaffold): los 4 que importan `lib/uikit-provider` (`avatar`, `breadcrumb`, `lightbox-gallery`, `share-access`) quedan fuera y se cuentan en el reporte hasta reconciliar el provider en el vault (decisión de Karen, fuera de alcance). N = 144 (medido en S1a, PR #44: además de esos 4, el gate rechaza `segmented-control` y `toast` por tener solo `export default` cuando emit importa named, y los 3 presets `theme-switch-eclipse/rise/split` por no tener archivo propio). Entrada con `source`, `export`, `importPath` (`@/components/arc/<slug>/<slug>`), `verified: false` + `gate`.
### Fase S1b — schemas y semánticas de componente (código: `scripts/gen-schemas.ts`, `src/catalog/schema-gen.ts` (`enumValues` con alias, `:68`), `src/catalog/slot-semantics.ts` (loader, misma validación que `slot-policy.ts`), `tests/schema-gen.test.ts`; datos: `catalog/schemas/components/*.json`, `catalog/slot-semantics.json`)
- **RF2 (schema por componente):** `gen-schemas` genera `catalog/schemas/components/<slug>.schema.json` (carpeta aparte: `tests/slot-policy.test.ts:15-24` recorre la raíz buscando bloques y fallaría) para los componentes del índice, resolviendo su fuente en `arc/<slug>/<slug>.tsx` (`sourceOf`, `gen-schemas.ts:25-28`, hoy solo `blocks/`). `x-variants` cuando `variant` es una unión de literales inline o un alias de tipo del MISMO archivo (`button.tsx:10` `ButtonVariant`; `enumValues` `schema-gen.ts:68` solo parsea inline hoy).
- **RF3 (semántica de slot):** la verdad es el overlay humano `catalog/slot-semantics.json` (`{ version, components: { <slug>: SlotSemantic[] } }`, misma validación cerrada que `slot-policy.json`); el ingest solo propone desde `doc.md` para rellenar el borrador inicial (las categorías `Type:` son gruesas: `data` mezcla `avatar`, `card`, `empty-state`, `metric-card`), sin `confidence`. Un componente sin entrada en el overlay NO es elegible como filler. Inventario inicial = tabla de §5b.

### Fase S2 — el contrato del slot (código: `src/catalog/ts-props.ts`, `src/catalog/schema-gen.ts`, `scripts/gen-schemas.ts`, `src/catalog/slot-policy.ts`, `tests/slot-policy.test.ts`; datos: `catalog/slot-policy.json`, schemas regenerados)
- **RF4 (`x-slot`):** un prop cuyo tipo TS es `ReactNode` o `Record<string, ReactNode>` entra al schema (hoy `schema-gen.ts:159` lo salta; `brand` de header/footer entra entero con `mark` como sub-schema) como nodo sin `type` con `{ "x-slot": { "accepts": SlotSemantic[], "cardinality": "one" | "map" | "list" } }`; un slot ANIDADO (`brand.mark`, `channels[].icon`) lleva su `x-slot` en el sub-schema correspondiente (`brand.properties.mark`, `channels.items.properties.icon`). `channels[].icon` ya sale de `tsPropsOf` (expande items de array); `brand.mark` NO: `tsPropsOf` devuelve `brand` como un prop con el literal `{ name: string; href?: string; mark?: ReactNode }` entero, así que S2 expande en `ts-props.ts` los literales de objeto inline a `brand.name`, `brand.href`, `brand.mark` (misma forma `a.b` que ya usan las rutas de regla) y `schema-gen` los anida en `properties`. Una render-prop (`(count) => ReactNode`, `hero-signup.proof`) NO es slot: queda fuera (ADR 0005). `accepts` sale del overlay `slot-policy.json` (regla nueva `{ fill: SlotSemantic[], from?: RoleKey, else: null | "" | "omit" }`), no se adivina del nombre. `inject-schema` no cambia: un nodo sin `type` ni `format` cae al `default` de `scalarValue` (`inject-schema.ts:69-76`) y no se llena.
- **RF5 (política ampliada):** `isRule`/`parseSlotPolicy` validan `{ fill, from?, else }`; `applySlotPolicy` la salta (hoy escribiría el objeto como valor) y el filler (RF7) decide; `gen-schemas` copia `fill` a `x-slot.accepts` y `else` a `x-empty`. Sin componente ni dato, el slot cae a `else`; `else: omit` entra a `unsetOmits` y por tanto a `demoVisible` y `unboundFor` (con copy canónico un `{ fill, from: 'stats' }` cuenta como cubierto: correcto, un brief sin stats lo deja en `else`).

### Fase S3a — emit escribe JSX para un slot (código: `src/emit.ts`, `src/catalog/slot-value.ts`, `tests/emit.test.ts`)
- **RF6 (valor de slot serializable):** un slot lleno viaja en los props como `{ "$component": "<slug>", "props": { … }, "children"?: string }` (JSON válido, determinista). `renderApp` detecta `$component` en cualquier profundidad, resuelve `Export`/`importPath` SOLO desde el índice (slug desconocido = error de emit, nunca un import libre), dedupe imports con los de bloque y emite `<Export {...JSON} />` con los props como un único spread `{...${JSON.stringify(props)}}` (nunca atributo por atributo con texto interpolado); `children` de texto va como `{${JSON.stringify(text)}}`. `cardinality: map` produce `{ f0: <AnimatedCounter {...} />, … }`, `list` un array JSX. Un valor sin `$component` sigue siendo JSON byte a byte.
### Fase S3b — el filler (código: `src/catalog/slot-fill.ts`, `src/adapters/arc.ts` (`propsFor` llama a `fillSlots` tras `applySlotPolicy`), `tests/slot-fill.test.ts`)
- **RF7 (filler por semántica, sin inventar datos):** `fillSlots(entry, props, copy, index, semantics)` recorre los `x-slot` del schema del bloque y, para cada uno sin valor del binding, elige el primer componente del índice (orden estable por slug) cuya `semantics` cruza `accepts` **y para el que el copy trae el dato real**: `metric` → `stats.stats[i]` (`animated-counter`: `value`/`prefix`/`suffix`; `metric-card`: `label`/`value`/`context ← detail`), `avatar` → `testimonials.items[i].name`, `logo` → `brief.brands[i]` (D4), `action` → CTA del rol como `children`, `media` → foto por `fillImages`. **Un componente cuyo prop obligatorio no sale de un dato del brief no se usa**: `sparkline`, `line-chart`, `bar-chart`, `gauge` sin serie/porcentaje real quedan fuera (misma ética que D4; una serie "determinista por seed" es un dato inventado). `icon` no tiene componente en el catálogo (los iconos son `lucide-react`): cae siempre a `else`. Sin dato → `else`. Sin aleatoriedad. Corre en `propsFor` del adaptador Arc DESPUÉS de `applySlotPolicy` (política → relleno → reporte).

### Fase S4a — showcases propless fuera del inner (código: `src/types.ts` (`Brief.showcases?`), `src/adapters/types.ts` (`candidatesByRole` opts gana `showcases?: string[]`), `src/router.ts:332` (pasa `brief.showcases` en los opts; `pickInner` ya hereda el brief en `scoped`), `src/adapters/arc.ts:358`, `tests/adapter-arc.test.ts`)
### Fase S4b — propless en demoVisible (código: `src/adapters/types.ts` (`EmitEntry.emittable?`), `src/adapters/arc.ts:385`, `src/emit.ts:170` (`demoVisibleOf` lee `emittable`), `tests/emit.test.ts`)
- **RF8:** la admisión de `emittable: false` en el inner vive en `usable` (`arc.ts:358`, `opts.innerSlot || e.emittable !== false`), no en compose-layers: deja de ser por defecto. Un showcase propless entra al slot inner SOLO si el brief lo nombra (`brief.showcases?: string[]`, `src/types.ts`) o la `composition` de marca lo pide por tag (ADR 0004). Medido por Secondary: ninguna de las 5 páginas cambia. Para `demoVisible`, emit lista un propless emitido como `{ slug, props: ['*'] }` leyendo `emittable === false` del índice, sin regla en el overlay (una regla `"*"` rompería CA2 y los propless no tienen tipo de props); CA1/CA2 de slots visibles saltan los propless.

### Fase S5 — nimbus de punta a punta (datos: `catalog/slot-policy.json`, `catalog/slot-semantics.json`, `briefs/nimbus-waitlist.copy.json`)
- **RF9:** la tabla de §5b es el contrato: `feature-bento.visuals` = `{ fill: ['metric'], from: 'stats', else: "" }` (map por `features[].id`); `hero-section.media` = `{ fill: ['media'], else: null }`; `cta-section.visual` = `{ fill: ['illustration'], else: null }` (solo variante split); `contact-section.channels[].icon` = `{ fill: ['icon'], else: "" }` (cae siempre a `else` hasta que haya componente icono); `brand.mark` de header/footer = `""` (decisión de Karen: el pack no trae logo, el nombre queda como wordmark y no se pinta la marca de Arc; cuando un pack traiga logo entra como semántica nueva, sin tocar código). **Rol consumido:** si una regla `fill` con `from` dejó un componente en su ruta, el bloque propio de ese rol se omite con motivo `consumido` (`resolveBlocks`, como Relume: un rol alimenta una sección; el mismo dato no se pinta dos veces). Texto (`hero-signup.title/description/footnote`, `newsletter-signup.privacyNote`) sigue siendo string del binding. `proof` queda fuera (ADR 0005).

## 3. Vocabulario `SlotSemantic` (cerrado)
`metric | series | illustration | media | avatar | logo | icon | badge | action`. `series` existe para el día en que un rol traiga una serie real (hoy ninguno: ningún componente la declara en `slot-semantics.json`). Un componente puede declarar varios; un slot acepta varios. Añadir uno es cambiar este archivo y el overlay, no inventar en código.

## 4. Requisitos no funcionales
- **RNF1 (agnóstico):** core (`plan/route/rank/select/compose-layers/types`) no conoce `$component` ni semánticas Arc: el filler vive en el adaptador y `renderApp` solo sabe serializar `$component`. Un adaptador sin filler emite JSON como hoy.
- **RNF2 (vendor prístino):** ningún `.tsx` del scaffold cambia; los átomos se vendorizan por `catalog fetch` como los bloques.
- **RNF3 (determinismo):** dos runs → mismo `App.tsx` (CA10 de slots visibles se mantiene).
- **RNF4 (construible):** `vite build` del generado en verde con cualquier combinación del filler; un componente que no compila con las deps del scaffold no entra al índice (RF1).
- **RNF5 (CI sin vault):** tests sobre fixtures de catálogo en `tests/fixtures` + los schemas en git; el ingest real es local.
- **RNF6 (coste):** filler O(slots × componentes con semántica cruzada), sin lectura de source en runtime (todo del índice y los schemas).

## 5. Criterios de aceptación
- **CA1 (RF1):** tras `catalog ingest` sobre el vault, `index.json` tiene 144 componentes `kind: component` sin `role`; `button`, `animated-counter`, `metric-card`, `badge` están; `avatar`, `breadcrumb`, `lightbox-gallery`, `share-access` NO están y el reporte los lista por `uikit-provider`; un fixture con dep npm no declarada tampoco entra (`tests/catalog-ingest.test.ts`).
- **CA2 (RF2):** `catalog/schemas/components/button.schema.json` existe y trae `x-variants: ['primary','secondary','ghost','danger']` resolviendo el alias `ButtonVariant`; `tests/slot-policy.test.ts` CA1/CA2 siguen verdes (no recorren `components/`).
- **CA3 (RF4):** `feature-bento.schema.json` tiene `visuals` con `x-slot.cardinality: map` y `accepts: ['metric']`; `site-header.schema.json` tiene `brand` con `properties.mark['x-slot']`; `contact-section.schema.json` tiene `channels.items.properties.icon['x-slot']`; `hero-signup.proof` NO lleva `x-slot`. CA1/CA2 de slots visibles siguen verdes (una regla `fill` cuenta como clasificación).
- **CA4 (RF6):** `renderApp` con `visuals: { f0: { $component: 'animated-counter', props: { value: 200, suffix: '+' } } }` escribe `import { AnimatedCounter } from '@/components/arc/animated-counter/animated-counter'` una sola vez y `visuals: { f0: <AnimatedCounter {...{"value":200,"suffix":"+"}} /> }`; `{ $component: 'button', children: "a<b}'c" }` emite `<Button>{"a<b}'c"}</Button>`; un `$component` con slug fuera del índice lanza error de emit; sin `$component` el output es idéntico al actual byte a byte (regresión sobre el `App.tsx` de nimbus).
- **CA5 (RF7):** con `stats.stats = [6h, 3×, +200]` y bento de 3 celdas, `propsFor('feature-bento')` devuelve `visuals` con 3 `$component` (`animated-counter` o `metric-card`) y exactamente esos valores/prefijos/sufijos; sin `stats` en el copy, `visuals` cae a `else` (`""`) y `demoVisible` no cambia; un `accepts: ['series']` sin dato nunca produce `$component`; dos llamadas → mismo resultado.
- **CA6 (RF8):** `candidatesByRole(['features'], { innerSlot: true })` sin `brief.showcases` no incluye `spotlight-grid`; con `brief.showcases: ['spotlight-grid']` sí; si entra, `demoVisible` lo lista como `{ slug: 'spotlight-grid', props: ['*'] }`; el test actual "innerSlot admite un organismo propless" (`tests/adapter-arc.test.ts`) se reescribe a este contrato; las 5 páginas actuales no cambian.
- **CA7 (RF9, visual en el navegador de Karen):** nimbus + Aurora: cada celda del bento con stat del brief muestra un visual del catálogo con esa cifra (3 de 6 en nimbus; sin "Weekly active 12,480"), una celda sin stat colapsa su área visual (`.visual:empty`, sin hueco de 184 px), `stats-band` no se emite (`stats (consumido por feature-bento)`), header y footer muestran "Nimbus" sin la marca de Arc, el runner no lista nada nuevo en `demoVisible`, `vite build` verde, y la página sigue siendo la misma composición (hero-signup, bento, stats, cta3, footer).
- **CA8 (regresión):** `bun test` de router, eligibility-router, slot-policy, emit, compose-layers, adapter-arc, core, catalog-ingest, schema-gen verde.

## 5b. Medición e inventario (Secondary)

### N de CA1
`scanArc(vault, 'component')` encuentra **153** componentes: 107 Free y 46 Pro. La categoría `Type: Component (…)` del doc.md se reparte así: data 39, special 38, inputs 33, actions 17, disclosure 13, feedback 9, text 4.
- **El filtro de `catalog-ingest.ts:106` (deps npm de `registry.json` declaradas en el scaffold) deja pasar 153 de 153.** No hay ningún componente con dep npm no declarada, así que la segunda mitad de CA1 ("uno con dep no declarada no está") solo se puede probar con un fixture.
- **Ese filtro no basta para "instalable".** 4 componentes (`avatar`, `breadcrumb`, `lightbox-gallery`, `share-access`) importan `../lib/uikit-provider`, que el vault renombró: el scaffold tiene `lib/arc-provider`. Ese archivo usa `next/*` sin shim. Además, el `avatar` del vault (sha `24b6bca6…`) ≠ el vendorizado (`94c22aa1…`), una adaptación local con `ArcImage`. RF1 tiene que exigir además el cierre de imports (sin `next/*` distinto de `next/image`, con los `lib/` resolubles), como ya hace `lintArc` (`arc.ts`, `nextImport`).
- **N = 149** con esa regla (corregido a 144 en S1a, ver RF1). De ellos, los **candidatos a filler** son los que tienen props serializables y obligatorios alimentables desde el copy:

| slug | Type | Acceso | Props obligatorios (`tsPropsOf`) | semantics propuesta | Dato del copy |
|---|---|---|---|---|---|
| animated-counter | data | free | `value:number` | `metric` | `stats.stats[i].value/prefix/suffix/label` |
| metric-card | data | free | `label`, `value:number`, `context` | `metric` | `stats.stats[i]` (+ `detail` como context) |
| gauge | data | free | `value:number`, `label` | `metric` | solo un `%` (`suffix: '%'`) |
| sparkline | data | free | `data:number[]`, `label` | `sparkline` | **ninguno**: el copy no trae series |
| line-chart / bar-chart / donut-chart / waffle-chart | data | free | `data:…[]`, `label` (+ `series`/`period`) | `sparkline` | **ninguno** |
| avatar | data | free | `name` | `avatar` | `testimonials.items[i].name` (excluido hasta reconciliar el provider) |
| avatar-group | data | free | `members[]` | `avatar` | `testimonials.items[].name` |
| badge | data | free | — | `badge` | texto corto del copy (tagline) |
| button | actions | free | — (label en `children`) | `action` | CTA del rol |
| button-group | actions | free | `items[]`, `label` | `action` | CTAs del rol |
| data-flow / dot-grid | special | **pro** | — | `illustration` | sin dato: decorativo |
| image-compare / photo-grid | data / special | free / **pro** | `before/after: ReactNode` / `photos[]` | `media` | fotos (fillImages) |
| orbit-logos | special | **pro** | `logos[]` | `logo` | `brand.brands` real (D4) |

No son filler los que exigen handlers (`chip-group.onValueChange`) ni los de estado de formulario. `icon` no tiene componente en el catálogo: los iconos vienen de `lucide-react`, no de `ui-react/components`.

### Los 13 slots (contenido de RF9)
| slot | cardinality | accepts | from | else |
|---|---|---|---|---|
| `feature-bento.visuals` (`Record<id, ReactNode>`) | map por `features[].id` | `metric` | `stats` | `""` (celda sin visual, como hoy) |
| `hero-section.media` | one | `media` | — (fillImages) | `null` (no se renderiza: default undefined) |
| `cta-section.visual` | one | `illustration` | — | `null` (solo variante split; usamos centered) |
| `contact-section.channels[].icon` | list | `icon` | — | `""` (sin componente `icon`: cae siempre a else) |
| `contact-section.channels[].detail` | list | — (texto) | — | exception: variante channels, no la usamos |
| `hero-signup.title/description/footnote` | one | — (texto) | `hero` | el binding ya los pone como string |
| `hero-signup.proof` (render-prop `(count) => ReactNode`) | — | — | — | fuera: una función no es `$component` (ADR 0005) |
| `newsletter-signup.privacyNote` | one | — (texto) | `cta.note` | `""` (ya regla en el overlay) |
| `site-header.brand.mark` / `site-footer.brand.mark` | one, anidado | `logo` | identidad de marca (brand pack) | `""` (wordmark; el pack no trae logo, decidido 2026-10-21) |
| `ai-chat.notice` | one | — | — | `omit` (ya en el overlay) |

Hay contenido que se escribe de verdad solo en `feature-bento.visuals` (desde `stats`) y, si hay foto, en `hero-section.media`. El resto son texto (ya cubierto) o caen siempre a `else`. Eso encaja con la métrica de §1, pero **solo con `metric`**: un `sparkline` necesita una serie que el brief no trae (ver ataque RF7).

## 6. Datos (Secondary)
- **`CatalogEntry`** (`src/catalog/schema.ts:74-100`):
  - `role?: Role` solo con `kind: 'component'`. Cambian el parser (`:219`: exigir `role` salvo `kind === 'component'`) y el retorno (`:252`: `role` solo si viene).
  - `semantics?: SlotSemantic[]` validado contra el vocabulario de §3.
  - Para componentes: `category: 'component'`, `tags: []`, `surface: { light: 'base', dark: 'base' }` (no se pinta solo, hereda) y `geometry: 'component'`. Lo exige el resto del parser (`:220-223`).
  - `EmitEntry` (`src/adapters/types.ts:14-25`) cambia en dos sitios:
    - `role?` (S1a): `arc.ts:385` lo copia del índice.
    - `emittable?` (S4b): para que `demoVisibleOf` (`emit.ts:170`) liste un propless como `{ slug, props: ['*'] }`.
  - `LibraryAdapter.candidatesByRole` (`adapters/types.ts:40`): `opts` gana `showcases?: string[]` (S4a). `router.ts:332` lo pasa desde `brief.showcases`.
- **`TsProp`** (`src/catalog/ts-props.ts:12`, S2): un prop cuyo tipo es un literal de objeto inline se expande a sus hojas con ruta punteada (`brand` → `brand.name`, `brand.href`, `brand.mark`), igual que hoy se expanden los items de array (`channels[].icon`). Medido sobre main: `tsPropsOf(site-header)` devuelve hoy `brand: { name: string; href?: string; mark?: ReactNode }` como un único prop. El prop padre se conserva para `required`. `cleanProp`/`insert` (`schema-gen.ts:54`, `:117`) ya anidan rutas punteadas en `properties`. **Alcance de la expansión: solo literales que contienen `ReactNode`.**
- Medido sobre main: hay 10 props con literal de objeto inline en los bloques Arc vendorizados: `ai-chat.user`, `budget-variance.departments[].owner`, `comparison-table.cta`, `faq-section.contact`, `kpi-drilldown.dimensions`, `newsletter-signup.privacyLink`/`readers`, `site-footer.status`/`brand` y `site-header.brand`. Solo `brand` (×2) lleva `ReactNode`.
- Una expansión general metería unas 25 hojas nuevas a CA1 de slots visibles (`contact.label`, `status.tone`…) cuyo padre ya tiene regla (`contact: null`, `status: null`) y el test las pediría clasificadas.
- Con la expansión acotada, CA1 (`tests/slot-policy.test.ts`, que enumera con `tsPropsOf`) solo pasa a ver `brand.name`, `brand.href` y `brand.mark` en header y footer. `brand.mark` necesita regla o exception en el overlay en el mismo PR (hoy, sin regla: exception "pendiente de Karen: ¿marca del pack como logo?").
- **`JsonSchema`** (`src/catalog/schema-gen.ts:10`): `'x-slot'?: { accepts: SlotSemantic[]; cardinality: 'one' | 'map' | 'list' }` y `'x-variants'?: string[]`. `schema-gen.ts:159` deja de saltar ReactNode: emite el nodo sin `type`. `validate` (`:176`) ya acepta un nodo sin `type`.
- **Overlay `catalog/slot-policy.json`:** regla `{ fill: SlotSemantic[]; from?: RoleKey; else: null | "" | "omit" }`.
  - `isRule`/`parseSlotPolicy` (`src/catalog/slot-policy.ts`) la validan.
  - `applySlotPolicy` la salta: hoy escribiría el objeto como valor (`Array.isArray(rule) ? [] : rule`).
  - `gen-schemas.ts:148-155` copia `fill` a `x-slot.accepts` y `else` a `x-empty`, no el objeto entero.
- **Nuevo `catalog/slot-semantics.json`:** `{ version: 1, components: { <slug>: SlotSemantic[] } }`, misma validación cerrada.
- **`Brief.showcases?: string[]`** (`src/types.ts:28-44`).
- **Schemas de componentes** en `catalog/schemas/components/<slug>.schema.json`. Si van en la raíz, `tests/slot-policy.test.ts:15-24` (CA1/CA2 de slots visibles) los recorre y busca su `.tsx` en `blocks/`: falla.
- **Reversible:** sin reglas `fill`, sin `slot-semantics.json` y sin entradas `kind: component`, `propsFor` y `renderApp` emiten lo de hoy. Las entradas de componente son aditivas: el pool por rol las filtra por `e.role === role` (`arc.ts:360`, `registry.ts:73`).

## 7. Dependencias (Secondary)
- **npm:** ninguna nueva. Los 144 componentes de N resuelven sus deps npm con `templates/arc-scaffold/package.json`. Los 4 con `uikit-provider` quedan fuera hasta reconciliar `lib/arc-provider` ↔ `lib/uikit-provider` en el vault, que es decisión de Karen y queda fuera de esta spec.
- **Vault:** ingest y fetch leen `~/Desktop/SoftwareDevProjects/Knowledge/Frontend/Components/ui-react` en solo lectura. Sin vault, el índice y los schemas en git bastan para emitir; los átomos que se usen deben estar vendorizados (`catalog fetch`) o `materialize` los trae.
- **Licencia:** 46 de los 153 son Pro (`data-flow`, `dot-grid`, `photo-grid`, `orbit-logos`…). Vendorizarlos es copiar la copia licenciada del vault, igual que con los bloques Pro. No hace falta reconstruir nada.
- **Internas:** `tsPropsOf` (`ts-props.ts:141`), `fillImages` (`images.ts`), `applySlotPolicy`/`unsetOmits` (`slot-policy.ts`), `unboundFor` (adaptador) y `fetch`/`materialize`.

## 8. Seguridad (Secondary)
`superficie_expuesta: no`, confirmado: no hay endpoint, red ni input externo nuevo. El brief y el copy.json ya son la entrada, y ya se serializan en `App.tsx` con `JSON.stringify` (`emit.ts` `propsConst`), lo que escapa cualquier string dentro de un literal JS.
- **Riesgo nuevo y único:** RF6 sale de JSON y escribe JSX (`<Export {...props} />`). Regla: los props de un `$component` se emiten como `{...${JSON.stringify(props)}}`, nunca atributo por atributo con texto interpolado. Un `children` de texto va como `{${JSON.stringify(text)}}`.
- El nombre del componente (`Export`) y el `importPath` salen del índice, nunca del copy: un `$component` cuyo slug no esté en el índice con `semantics` es error de emit, no un import libre. Sin esa regla, un copy.json a mano podría inyectar `{"$component": "x' ; evil()"}`.
- CA4 lo prueba con `<`, `}` y `'` en el texto y con un slug desconocido.

## 9. Fuera de alcance
- Que el LLM elija átomos o invente composición (Relume tampoco lo hace): el filler es determinista por semántica.
- Portar los 67 átomos Relume sin equivalente Arc.
- Secciones Relume: sus átomos ya los pone el porter; sus `icon` ReactNode siguen con el SVG del Default.
- hero-signup `proof`/`count` (ADR 0005).
- Un layout dentro de otro (ADR 0001, máximo un nivel).

## 10. Plan de pruebas y reparto — *(Secondary completa el plan; reparto fijado por orq)*
- **orq:** §1-4, §9, RF6/RF7 (S3), RF9 (S5), integración visual con Karen.
- **Secondary:** verificar cada ancla de §0 contra main `001a8a9`; medir N (CA1) y el inventario de los 13 slots con su `accepts` propuesto; completar §6-§8 y este plan (unit / integración / fuera); atacar RF1-RF5 y RF8; implementar S1, S2 y S4 cuando la spec esté APROBADA.
- Orden de entregas: S1a → S1b → S2 → S3a → S3b → S4a → S4b → S5. Cada una ≤ 5 archivos de código + datos, PR con auto-merge --squash (Karen lo autorizó para este programa), salvo S5 que lleva su OK visual. Reparto de implementación: Secondary S1a, S1b, S2, S4a, S4b; orq S3a, S3b, S5.

### Plan de pruebas (Secondary)
- **Unit (CI, sin vault):**
  - `tests/catalog.test.ts`: parser con `kind: component` sin `role` acepta; un bloque sin `role` falla; un valor de `semantics` fuera del vocabulario falla.
  - `tests/catalog-ingest.test.ts`: fixture con 2 componentes en `tests/fixtures/vault/ui-react/components`, uno instalable y otro con dep no declarada o con import `next/link` → solo entra el primero y el segundo sale en el reporte (CA1).
  - `tests/schema-gen.test.ts`: `x-variants` resolviendo el alias `ButtonVariant` (CA2) y `x-slot` en `visuals` y `media` (CA3).
  - `tests/slot-policy.test.ts`: regla `{ fill }` válida, `{ fill: ['nope'] }` rechazada, `applySlotPolicy` no escribe el objeto, `else: omit` entra a `unsetOmits` (RF4/RF5).
  - `tests/emit.test.ts`: `$component` → import único y JSX; escape de `<`, `}` y `'`; slug desconocido → error; sin `$component`, el App.tsx de un fixture queda byte-idéntico (CA4).
  - `tests/adapter-arc.test.ts`: filler (CA5) y el test propless reescrito (CA6).
  - `tests/compose-layers.test.ts`: `pickInner` sin `showcases` no elige propless, y con `showcases` sí (CA6).
- **Integración (local, vault):** `bun scripts/catalog-ingest.ts` real (N = 144); `bun scripts/run.ts briefs/nimbus-waitlist.json --lib arc --no-llm`, `vite build` del generado y dos runs idénticos (RNF3/RNF4).
- **Fuera de CI:** CA7 visual en el navegador de Karen (bento con cifras del brief); render-gate de Secondary antes/después por bloque.
- **Medido para RF8:** sin admitir `emittable:false` en el inner (`arc.ts:358`), los 5 briefs (pulse, -completo, -testimonios, nimbus-waitlist, lumen-citas) × pool verified/unverified componen **exactamente** la misma página y las mismas capas. La única capa hoy es nimbus `cta3_shell > newsletter-signup`. Solo cae `tests/adapter-arc.test.ts` "innerSlot admite un organismo propless…", que es el test que CA6 reescribe.

## 11. Ataque de Secondary (RF1-RF5, RF8; más dos de S3 que afectan a CA1/CA4)
1. **RF1 — AJUSTA.**
   - `kind: 'component'` ya existe (`schema.ts:10`): el cambio es `role` opcional más valores fijos para `category`, `tags`, `surface` y `geometry` (§6).
   - "Instalable" no puede ser solo el filtro de `catalog-ingest.ts:106`, que deja pasar 153/153. Tiene que incluir el cierre de imports, porque 4 rompen el build con `uikit-provider` (§5b).
   - `role` opcional no rompe tests existentes:
     - `tests/catalog.test.ts:18-28` compara `catalogFor('arc')` con `loadArcRegistry().filter(library === 'arc')`, y los dos incluirían los componentes por igual;
     - los pools por rol (`arc.ts:360`, `registry.ts:73`) los excluyen;
     - ningún slug de componente colisiona con uno del índice.
   - Sí rompe el tipo de `EmitEntry.role` (`adapters/types.ts:16`, que `arc.ts:385` rellena).
2. **RF2 — AJUSTA.**
   - `tsPropsOf` devuelve `variant: ButtonVariant`, el alias, no la unión (`button.tsx:10,14`). `enumValues` (`schema-gen.ts:68`) solo parsea uniones inline, así que `x-variants` exige resolver el alias de tipo del mismo archivo.
   - `gen-schemas` solo resuelve fuentes en `blocks/` (`sourceOf`, `gen-schemas.ts:25-28`) y no encontraría `arc/<slug>/<slug>.tsx`.
   - Si los schemas de componente van a `catalog/schemas/`, CA1/CA2 de slots visibles (`tests/slot-policy.test.ts:15-24`) los recorren y fallan. Hay que ponerlos en `catalog/schemas/components/` o filtrar por `kind`.
3. **RF3 — AJUSTA.** Las categorías de `Type:` son gruesas: `data` mezcla `avatar`, `card`, `empty-state`, `image-compare` y `metric-card`. La regla de `ingest-arc.ts` solo propone; la verdad es `slot-semantics.json` (tabla de §5b). `confidence` sobra si el overlay manda.
4. **RF4 — AJUSTA.**
   - El salto de ReactNode está en `schema-gen.ts:159`.
   - `brand.mark` y `channels[].icon` son slots ANIDADOS: `one | map | list` en la raíz no los expresa. Hace falta `x-slot` en el sub-schema (`brand.properties.mark`, `channels.items.properties.icon`), y que `brand` entre al schema, porque hoy cae entero.
   - `inject-schema` no se rompe: un nodo sin `type` ni `format` cae al `default` de `scalarValue` (`inject-schema.ts:69-76`) y no se llena.
   - CA3 pide `x-slot` para `hero-signup.proof`, pero una render-prop no puede ser `$component`, y §9 la deja fuera: hay que quitarla de CA3.
5. **RF5 — OK con nota.** `else: omit` tiene que entrar a `unsetOmits` y, por tanto, a `unboundFor`. Como `unboundFor` llama a `propsFor(CANONICAL_COPY)` y el filler corre dentro de `propsFor` (RF7), un slot `{ fill, from: 'stats' }` cuenta como cubierto con copy canónico. Es correcto: un brief sin stats lo deja en `else`.
6. **RF8 — AJUSTA.**
   - Medido: no cambia ninguna página (§10).
   - El filtro está en `arc.ts:358`, no en `compose-layers.ts`.
   - `brief.showcases` suma `src/types.ts`.
   - La regla `"*": "omit"` choca con dos cosas:
     - CA2 de slots visibles exige que cada ruta de regla exista en los props TS;
     - los 3 propless verified no tienen tipo de props, y `tsPropsOf` lanza.
     Hace falta un campo propio (`exceptions.<slug>."*"` o `propless: true` en el overlay), con CA1/CA2 saltando los propless.
7. **RF7 (de orq, afecta a CA1/§1) — BLOQUEA tal como está.** "`sparkline` con serie determinista por seed" es inventar datos: una tendencia que el brief no tiene. Es la misma ética que D4 con los logos. `stats` trae un valor por cifra, no una serie. Propuesta: `metric` (`animated-counter`/`metric-card` con el valor real) sí; `sparkline` solo con `from` que traiga una serie real (hoy ningún rol la trae), si no `else`.
8. **CA4 (de orq) — AJUSTA.** `Sparkline` no tiene `values`: tiene `data: number[]` y `label` obligatorios (`sparkline.tsx:138`). Y `Button` lleva el texto en `children`, así que el shape `$component` necesita `children` (texto escapado) para `action`.
