# Spec — Variabilidad de la página + Observabilidad del pipeline

**Estado:** BORRADOR v3 (orq 2026-10-22) — v3 integra los extracts de Webflow/Relume (investigación de las dos sesiones): la variante se elige por CONTENIDO, no por marca (corrige RFV1); el scheme es una secuencia nombrada del pack (RFV2b); el pool es ancho y rankeado top-1, no de 1 (RFV3 pasa de 'ensanchar' a 'rankear'); la descripción por sección es la palanca principal (RFV4 sube de prioridad). v2: ataque de Secondary, BLOQUEA RFV3 resuelto. Pendiente lectura de Karen. APROBADA la escribe solo Karen.
**Origen:** investigación independiente de las dos sesiones (orq: `scratchpad/informe-orq-pipeline.md`; Secondary: `inv-report/INFORME.md` + `ataque-spec-variabilidad.md`), consenso 2026-10-21. Karen: "vamos con eso; no dejes fuera observabilidad, es necesario y prioritario".
**Relación:** no toca la política de slots (composicion-slots, #50/#51 en vuelo). RFV3 debe preservar el contrato slot-policy/brand.mark que fija S5 (ver RFV3, riesgo footer).

## 0. Problema (medido, no opinión)
Matriz 5 briefs × 4 packs (20 runs, ambas sesiones): App.tsx sale **byte a byte idéntico** entre packs en casi todos los casos. El pack solo cambia `identity.css` (color, fuente, radios). Causas, por impacto:
1. **Colapsamos un pool ancho a 1.** El shortlist queda en 1 en 8 de 11 roles (organism-first `unitsFirst` como filtro duro en `routeRole` y `select.eligible` + binding). Webflow y Relume SÍ tienen pool ancho (9-83 candidatos por categoría) y eligen **top-1 de una lista rankeada** (Secondary, VERIFIED [941]: el elegido es matches[0] en 11/11). El problema no es que falte catálogo, es que lo colapsamos antes de rankear.
2. **Variante fija por slug** (`arc.ts:61-171`, 6 slugs): `hero-section` (`centered|split|minimal`) siempre sale `centered`/`HeroContent`. En las referencias la variante la decide el **contenido** (nº de items, hay media, textBlocksCount, layoutStyle), no la marca (Secondary, los dos extracts).
3. **`styleSet`/`density` muertos:** `styleSet` se parsea y nunca se lee; `density` la pisa `maxStrips` en los 5 briefs. (La marca SÍ entra al pipeline por ADR 0004, slot reservado — ver RFV3.)
4. **Accent sin consumidor en reposo:** medido en DOM con scroll (aurora): hero **0/5** briefs con accent en reposo; cta solo nimbus (1, el Button de newsletter). `hero-content.module.css:10` usa `--foreground` en `.action`. Refs CSS en bloques emitidos: feature-bento, cta-section, logo-marquee, newsletter, footer = 0; hero-signup 1 (mix 3%); stats-band 6 solo hover/focus.
5. **Desempate alfabético** entre organismos empatados: siempre `section_testimonial13`, `pricing10_block`. Relume trae empates de 4 (hero de 12).
6. **No se puede reconstruir una corrida fallida:** `flow.json` existe pero **sin versión de esquema**, y el **render-gate** (sensor de render real vs props) no está en el repo (vive en `scratchpad/499513d1/wt-bank`). Un gate que juzgue la página debe leer de un registro tipado, no del modelo.

## 1. Objetivo
Que dos marcas (o dos briefs del mismo set de secciones) produzcan páginas **visiblemente distintas** en estructura y color, y que cada corrida deje un **registro versionado, tipado y reproducible** del que los gates leen, sin filtrar lo que no debe salir.

## 2. Requisitos funcionales

### Fase O — Observabilidad (primero; fundamento de la medición). Orden O1 → O3 → O2.
- **RFO1 (diario versionado):** `flow.json` lleva `journalFormat: <n>` (constante `JOURNAL_FORMAT`). Un lector con `journalFormat` ausente o mayor al que soporta falla claro, no malinterpreta.
- **RFO3 (render-gate persistido, antes que O2):** se **recupera** (no se reescribe) el sensor desde `scratchpad/499513d1/wt-bank` (`scripts/render-gate.ts`, `render-probe.mjs`, `render-bank.ts`, `src/render.ts`, `tests/rank-render.test.ts`) al repo, con su test. Su veredicto por bloque alimenta el diario (RFO2).
- **RFO2 (diario tipado; el gate lee del registro):** un diario `generated/_journal/<brief>.<pack-sha>.jsonl` que es una **proyección tipada**, NO las etapas de `flow.json` anexadas. Admite solo `slug | enum | number | boolean | sha256`; **ningún texto libre** (el brief entra como sha del archivo; el pack como `BrandTrace.sha256`, que ya existe; nunca la ruta). Sin saneador porque no hay texto que sanear. El gate de variabilidad (RFV*) y el render-gate leen su veredicto de aquí, no del modelo ni del stdout. Test de paridad: bloque+variante por rol que imprime el runner == el que guarda el diario.
- **RFO4 (privacidad por construcción):** como el diario no admite texto libre, la fuga se previene por el tipo, no por disciplina. `flow.json`, `page-content-input.json` y `copy.generated.json` (que HOY sí llevan `brief.summary` y `brandPack.path`) quedan como **artefactos locales en `generated/` (gitignored)**, no son el diario. Test de centinela: inyectados un valor con forma de secreto y uno de texto de cliente en el copy de entrada, el diario emitido no los contiene; un control (fuga deliberada en el diario) demuestra que el test la detecta.

### Fase V — Variabilidad
- **RFV1 (variante por CONTENIDO) — corregida por los extracts:** ninguna referencia elige la variante por la marca; la atan al **contenido de la sección** (nº de items del copy, presencia de media, textBlocksCount, layoutStyle). Overlay `catalog/variant-policy.json` (patrón slot-policy, NO el manifest: `catalog-import` lo pisaría) con reglas sobre **ejes de contenido primero**, y `styleSet`/`density`/`tone` de la marca solo como desempate secundario. `arcProps` (`arc.ts:61-171`, 6 slugs) lee el overlay; `hero-section` sale `centered|split|minimal` según el copy. Test valida cada valor contra el enum `variant` del schema. CAV1 mide que dos copys del mismo rol con distinto contenido (p.ej. con/sin media) den variante distinta.
- **RFV2 (accent con consumidor + scheme por sección) — afinada por extracts:** (a) los bloques emitidos consumen `var(--accent)` en ≥1 elemento visible en reposo en hero y cta (hoy hero 0/5, cta 1 solo nimbus). (b) El `scheme` es un **eje del pack con secuencia nombrada** (como el `sectionVariance` de Webflow: un ciclo fijo base→secondary→inverse, no optimización por sección); la cohesión solo **valida** (sin 3 oscuros seguidos se cumple por construcción de la secuencia). Implementación: `data-scheme` en el wrapper de sección **redefiniendo los pares opacos** (`--background`/`--surface`/`--foreground`/`--text-secondary`/`--border`/`--accent-foreground`), **nunca `transparent`**. **Riesgo medido:** 14 archivos usan `color: var(--background)` en botones invertidos y 3 shells ponen `--background: transparent` (bug de banda de S5-PR0); por eso los pares van opacos. CA de contraste ≥4.5:1 texto contra su fondo efectivo.
- **RFV3 (rankear el pool ancho top-1, no colapsarlo) — REFORMULADO (BLOQUEA de Secondary + extracts):** el modelo de las referencias es pool ancho → ranking → top-1. No hay que ensanchar nada, hay que **dejar de colapsar y rankear**. La versión anterior ("`composition` al score del router") es la **opción B del ADR 0004, RECHAZADA por Karen** (viola CA7: el router no ordena por marca). Se mantiene la marca **solo en `select`** (punto único) y el rescate por slot reservado del ADR 0004. Para ensanchar el pool, sin tocar el contrato del router:
  - **(i) desempate no alfabético PRIMERO** (Relume trae empates de 4-12), replicando el `PQ(prevSlug)` de Relume de forma determinista: **geometría distinta a la sección anterior**, luego hash estable de brief+rol. No alfabético. Esto YA cambia la página base (testimonials/pricing empatados), así que es la nueva línea base contra la que se mide (ii)/B — ver CAV3.
  - **(ii) `unitsFirst` de filtro duro a sesgo de score** en sus **dos sitios** (`router.routeRole` y `select.eligible`): un organism-first sigue ganando por defecto, pero una molécula/variante/Relume puede ganar si el encaje lo supera.
  - **(iii) acotar el bonus de banda de cohesión** que PUEDE empujar hacia Relume en perfil banded (inferido, no medido; se mide en la fase).
  - **B numérico:** el sesgo de marca (desiredTag = +1 hoy) se fija como número en la spec, con CA "el pack X voltea el rol Y; el pack base no cambia **nada**". Medido: quitar `unitsFirst` cambia picks en 3/4 briefs, pero el footer pasa a `footer10_component` (Relume) en los 4 — **pisa slot-policy y el `brand.mark` de S5**. Por eso RFV3 va **después** de que #50/#51 cierren, y preserva el contrato slot-policy del footer (o el footer queda excluido del cambio de pool).
  - Si Karen quiere además marca en el ranking del router (opción B), es un **ADR 0006 que reemplaza a 0004 y que firma ella** — no se asume en esta spec.
- **RFV4 (descripción por sección) — PALANCA PRINCIPAL, sube de prioridad:** en las DOS referencias la descripción por sección es la señal que más manda sobre qué componente y qué variante (Webflow pasa `sections[{name, description}]`; Relume elige por `{websiteBrief, pageDescription, layoutStyle, sections[description]}`). Una descripción por sección derivada del brief (vía `copygen/claude-*`) alimenta el ranking de RFV3 y los ejes de contenido de RFV1. Va **temprano** en la fase V porque V1 y V3 se apoyan en ella. Degrada a ejes de contenido estructurales (nº items, media) sin LLM.

## 3. Requisitos no funcionales
- Cada fase ≤ 5 archivos de código + datos, mergeable sola, PR con su medición antes/después (los 20 runs como baseline).
- Determinismo: sin LLM, dos corridas del mismo brief+pack dan el mismo diario byte a byte (el diario no lleva reloj).
- El diario nunca frena la corrida: si el disco falla, se degrada y la corrida sigue (append síncrono; una corrida es segundos, no una sesión viva — sin hilo escritor).
- **Variabilidad medible:** con el **set de packs de prueba** (≥2 con composition y styleSet distintos; el **pack base se excluye**, no tiene composition), App.tsx debe diferir en ≥1 de {bloque, variante, scheme} por pack distinto (hoy: 0).

## 4. Criterios de aceptación (verificables)
- **CAO1:** un `flow.json` con `journalFormat` ausente o mayor al que el lector soporta hace fallar el lector con mensaje claro.
- **CAO2:** bloque+variante por rol del stdout del runner == el del diario (paridad).
- **CAO3:** el render-gate recuperado corre en el repo, su veredicto por bloque está en el diario, y su test lo reproduce.
- **CAO4:** inyectado un centinela con forma de secreto y uno de texto de cliente, el diario emitido no los contiene; el control (fuga deliberada) sí se detecta.
- **CAV1:** el mismo brief con dos packs de distinto `styleSet` produce `hero-section` con variante distinta (`centered` vs `split`/`minimal`).
- **CAV2:** en la página emitida, hero y cta tienen ≥1 elemento visible en reposo con `--accent`; ningún texto visible queda con contraste <4.5:1 contra su fondo efectivo (medido en DOM tras aplicar el scheme; el bug real es texto con `color: var(--background)` sobre un `--background` transparente, no bloques adyacentes); no hay 3 schemes oscuros consecutivos.
- **CAV3:** (a) el desempate no alfabético se mide aparte, contra la baseline 2c886b2, y queda anotado (cambia testimonials/pricing, hoy empatados 8×4 y 9×4 y resueltos alfabéticamente a `section_testimonial13`/`pricing10_block`); (b) **con el desempate ya aplicado como nueva línea base**, introducir B/unitsFirst-como-score NO cambia ningún rol con el pack base, y un pack con sesgo voltea ≥1 rol; (c) el footer conserva su contrato slot-policy.
- **CAV4:** con LLM, dos briefs con las mismas `sections` pero producto distinto eligen ≥1 componente distinto por descripción de sección; sin LLM, la salida es la de hoy.

## 5. Datos
- `generated/_journal/*.jsonl` (nuevo, proyección tipada, gitignored salvo un fixture). `JOURNAL_FORMAT` en `src/log/flow.ts`. Overlay `catalog/variant-policy.json` (nuevo). Ningún cambio de esquema destructivo. `flow.json`/`page-content-input.json`/`copy.generated.json` siguen locales y gitignored.

## 6. Dependencias
- Render-gate: existe en `scratchpad/499513d1/wt-bank`; RFO3 lo recupera. Si no, RFV2(a) no se mide automático.
- Generador LLM (`copygen/claude-*`): RFV4 depende de él; sin API cae a determinista.
- #50 (S5) y #51 (ADR 0005) cerrados antes de RFV3 (el footer de pool pisa su contrato).

## 7. Seguridad
- `superficie_expuesta: no` (CLI local, sin endpoints). Riesgo = **fuga en el registro**: se cierra por tipo (RFO2/RFO4: el diario no admite texto libre). Secreto nuevo: ninguno. Hallazgo colateral: credenciales en claro en un HAR en ~/Downloads (fuera del repo) — avisado a Karen para rotar.

## 8. Plan de pruebas
- Unit: esquema del diario (CAO1), paridad (CAO2), centinela de fuga (CAO4), variante por entrada vs enum (CAV1), desempate no alfabético (CAV3).
- Integración (pipeline real): la matriz 5×N (N = packs de prueba) como baseline y gate de no-regresión de variabilidad; render-gate (CAO3).
- Visual (navegador de Karen): un brief con 2 packs lado a lado, debe verse distinto (CAV1/CAV2). Fuera de CI.

## 9. Fases y reparto
Orden: **O1 → O3 → O2 → V4 → V1 → V2 → V3**. O primero (observabilidad prioritaria + instrumento que mide V). V4 (descripción) antes que V1/V3 porque es su insumo (palanca principal en las referencias). RFV3 tras #50/#51 (ya cerrados 2026-10-22). Cada fase su PR, sin auto-merge en UI (V1/V2), con OK visual. RFV3 fija B numéricamente.

## 10. Fuera de alcance (de los extracts)
- **Cardinalidad** (repetir una categoría en una página): Relume repite, Webflow no; es decisión de producto, no de este programa.
- **Template por página** (multipágina): el `structure` de Webflow elige secciones por template de página; nosotros somos una página. Fuera hasta que haya multipágina.
- **Selección de componente por LLM server-side** (Relume `enableComponentRelevancy`): referencia, no se replica el servicio; se replica la IDEA (rankear por descripción) en RFV3/RFV4.
