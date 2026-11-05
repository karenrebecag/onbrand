# Spec: Blob de catálogo + router de recuperación por intención

Slug: catalogo-blob-router | Fecha: 2026-10-15 | Estado: APROBADO
Brief: docs/research/catalogo-blob-router-agentico.md (APROBADO 2026-10-15)
Briefs que NO contradice: docs/research/runner-e2e-arquitectura.md, docs/research/cohesion-superficie-agnostica.md
Versiones: node=22, bun=1.3.14, react=19.2.8, vite=8.3.0, motion=14.2.0, typescript=6.0.2

Decisiones de Karen ya tomadas (brief §9, `[KAREN:chat 2026-10-15]`); esta spec las implementa, no las reabre:
D1 índice determinista (tags + keywords + whenNotToUse como aristas), sin embeddings · D2 índice JSON en disco + source on-demand por slug (modelo shadcn), generaliza `registry.arc.json` · D3 manifiesto agéntico completo, Arc parseado de su catálogo, Relume/vault DERIVADO bajo gate `verified`, surface/geometry las sigue proponiendo `arc-surface.ts` · D4 dos capas layout (Relume) + inner (Arc) con ADR que firma Karen · D5 LLM solo en límites; v1 con `briefIntent` determinista · D6 router = capa NUEVA sobre `LibraryAdapter`, entrega `candidatesByRole` sin cambiar la firma de `selectPage` · índice unificado con campo `library`.

## 1. Objetivo

Que el motor consulte un índice agéntico unificado (Arc + Relume, con manifiesto por item) y un router determinista acote el pool por la intención del brief ANTES del finding, bajando al scaffold solo el source de los items elegidos; hoy copia bloques a mano al template, `registry.arc.json` es un índice de una sola librería sin keywords ni whenNotToUse, y `selectPage` optimiza sobre todo el pool verificado del rol sin ruteo por intención (brief §2, `src/select.ts:45`).

Métrica de éxito: con `briefs/nimbus-waitlist.json` el router deja en el pool del hero solo candidatos cuyo manifiesto no lo excluya para waitlist y el finding elige `hero-signup`; con `briefs/pulse.json` sigue eligiendo la misma página que hoy (hero-section, logo-marquee, feature-bento, stats-band, cta-section). Ambas corridas son reproducibles byte a byte.

## 2. Requisitos funcionales

Trazabilidad: cada requisito cita el bloque del brief (D1-D6) o su checklist (§10).

- RF1 (D2, §10.1) Existe un índice unificado en disco, `catalog/index.json`, con una entrada por item y campo `library: "arc" | "relume"`. `registry.arc.json` y `registry.json` dejan de ser leídos por los adaptadores al final de F2; hasta entonces conviven.
- RF2 (D3, §10.3) Cada entrada lleva el manifiesto agéntico: `keywords[]`, `whenToUse[]`, `whenNotToUse[]` (cada una con `alternative?: slug` cuando la doc nombra una), `aiNotes[]`, `injection` (vía de inyección del contenido: `props` | `data-file` | `constants`, con `detail`), `related[]: slug[]`, `props[]: {name, type, default?, description}`. En F1 el manifiesto puede estar vacío (`manifest: null`) sin romper nada; desde F2 un item con `verified:true` y `manifest:null` es error del loader.
- RF3 (D3) Para Arc el manifiesto se PARSEA del `doc.md` del vault (`ui-react/blocks/<slug>/doc.md`, `ui-react/components/<slug>/doc.md`) con un parser determinista por encabezados (`- Keywords:`, `## When to use`, `## When not to use`, `## API reference` tabla de props, `## Notes for AI`, `## Related`). La alternativa de un `whenNotToUse` se resuelve buscando en la frase un nombre de item del propio índice (ej. "Use Hero signup" -> `hero-signup`); si no resuelve, `alternative` queda ausente, nunca inventada.
- RF4 (D3, §10.4) Para Relume/vault (`sections-react`) los campos agénticos se DERIVAN: `keywords` desde categoría + tags del MCP (ya cacheados en `registry.json`) + nombre; `whenToUse` desde la categoría; `whenNotToUse` SOLO desde reglas explícitas ya existentes en el proyecto (los `undesiredTags` de `ROLE_SPEC`, ej. "Form" en cta -> "No para un CTA que agenda; usa un cta con Buttons"). Toda entrada derivada nace con `verified:false` y `manifestOrigin: "derived"`; pasa a `verified:true` solo a mano. Nada se rellena con texto inventado: un campo sin fuente queda vacío.
- RF5 (D2, §10.2) Cada entrada pina su source: `source` (ruta vendorizada relativa al repo, o `null` si todavía no se trajo) y `origin: { kind: "vault", path, sha256 }` con el hash del archivo principal en el vault en el momento del import. Un `catalog fetch <slug>` copia del vault al scaffold SOLO ese item y sus `registryDependencies` transitivas que falten, verifica el sha256 y escribe `source`; nunca copia la librería entera.
- RF6 (D3) `surface` (por tema) y `geometry` siguen siendo campos fijados por una persona en la entrada; el lint del adaptador las contrasta con `deriveArcSurface` y avisa (warning), como hoy. El import/derivación de manifiesto NUNCA escribe `surface`, `geometry`, `verified` ni `emittable` de una entrada existente.
- RF7 (D6) Existe `src/router.ts` con `routeCandidates(brief, adapters, options?) -> { candidatesByRole, trace }`. Para cada rol de `planFrame(brief)` + `planSections(brief)`: toma el pool de `adapter.verifiedCandidatesByRole` (ya filtra `verified && emittable !== false`), aplica EXCLUSIÓN y luego SHORTLIST (ver RF8-RF9) y devuelve el `Record<string, Candidate[]>` que `selectPage`/`composePage` consumen SIN cambio de firma. `trace` explica por rol: excluidos (slug + regla) y preseleccionados (slug + keywords que cruzaron).
- RF8 (D1, exclusión) Un candidato se EXCLUYE del rol cuando una línea de su `whenNotToUse` cruza con los términos de intención del brief (RF10) Y su `alternative` está presente en el pool del mismo rol. Sin alternativa presente no se excluye (se degrada a penalización 0: queda en el pool), para que un rol nunca se quede vacío por una arista que apunta fuera del catálogo.
- RF9 (D1, shortlist) Los no excluidos se ordenan por `routeScore` = nº de `keywords` del manifiesto que cruzan con los términos de intención (RF10), desempate estable por slug, y se recortan a `options.shortlist` (default 4, el `TOP_K` de `select.ts`). Un item sin manifiesto (F1) tiene routeScore 0 y nunca se excluye. El ranking FINO (tags deseados, superficie, cohesión) lo sigue haciendo `selectPage`: el router es "filter context", `selectPage` es "query context" (brief §3, Elasticsearch).
- RF10 (D5, v1 determinista) Los términos de intención son: los términos del perfil de `briefIntent(brief)` (tabla fija en `src/router.ts`: `demo` -> demo, product, buttons, schedule; `waitlist` -> waitlist, early access, email capture, signup, join) + los tokens normalizados (minúsculas, sin tildes, ≥4 letras) de `summary` y `goal`. Una keyword del manifiesto "cruza" cuando, normalizada igual, es substring del texto normalizado del brief o coincide con un término del perfil. Sin LLM en v1; cuando entre (D5-C) sustituye SOLO la construcción de esta lista de términos, con `briefIntent` de fallback.
- RF11 (D6) `scripts/run.ts` llama al router antes de `composePage` y imprime `trace` por rol junto a las razones de cohesión. Con `--no-router` pasa el pool crudo del adaptador (comportamiento actual), para comparar.
- RF12 (D4, F4) Una entrada puede ser `kind: "layout"` con `slots: { inner: { allow: Role[], max: 1 } }` (patrón `SlotField.allow` de Puck). Si el finding elige un layout para un rol, `composeLayers` resuelve `inner` corriendo el router + `selectPage` sobre el pool de la librería `inner` acotado a `allow`, y el anidamiento se guarda en los props del layout (`props.inner = { slug, props }`), no en un árbol aparte.
- RF13 (D4) `emit` renderiza un layout con su inner como `<Layout {...props}><Inner {...innerProps} /></Layout>` dentro de UN solo scaffold generado. Cómo se resuelve el stack de estilos de la cáscara Relume dentro del scaffold Arc es la decisión abierta DA1 (sección 9); F4 no arranca hasta que el ADR de F0 la cierre.
- RF14 (seguridad local) Toda ruta que el índice declara (`source`, `origin.path`, `files[]`) se resuelve y se verifica que quede DENTRO de la raíz del repo o de la raíz del vault; una ruta que escape (`..`, absoluta fuera) hace fallar el loader con el slug en el mensaje. El índice es un archivo de datos que dirige copias de archivos: no se confía en él a ciegas.

## 3. Requisitos no funcionales

- RNF1 Determinismo: dos corridas de `catalog import`, `routeCandidates` y `scripts/run.ts` sobre el mismo vault y brief producen salida byte a byte idéntica (índice JSON ordenado por `library, slug`; claves en orden fijo).
- RNF2 Sin red ni credenciales: tests, router, import y fetch funcionan sin conexión. El único acceso remoto permitido es un cross-check OPCIONAL del manifiesto Arc contra `https://uiarc.dev/r/catalog.json` (URL fija, pública, sin headers), detrás de `--check-remote`, que solo REPORTA diferencias y no escribe. `ARC_PRO_TOKEN` no se lee en ningún punto del proyecto.
- RNF3 Rendimiento: cargar y validar un índice de 300 entradas + rutear 7 roles tarda < 50 ms en bun (medido con `performance.now()` en un test, umbral con margen x4 sobre lo esperado; sin aserción de reloj de pared en CI: el test imprime el tiempo y asserta solo el resultado).
- RNF4 Falla ruidoso: un índice mal formado lanza con `catalog[<i>] (<slug>): campo inválido "<campo>"`, nunca degrada a "sin candidatos" (mismo patrón que `parseEntry` hoy).
- RNF5 Tamaño: ningún archivo nuevo de `src/` supera 400 líneas; el índice JSON no tiene límite, pero una entrada no embebe source (solo rutas y hashes).
- RNF6 Vault READ-ONLY: ningún script abre un archivo del vault en modo escritura; los tests que tocan el vault lo hacen sobre fixtures copiadas a `tests/fixtures/vault/`, no sobre el vault real.
- RNF7 Compatibilidad: los 50 tests actuales siguen verdes en cada fase; `selectPage`, `composePage`, `cohesionScore`, `LibraryAdapter` no cambian de firma (D6).

## 4. Criterios de aceptación

Formato dado / cuando / entonces. `qa-reviewer` mapea cada uno a un test del plan (sección 8).

- CA1 (RF1) Dado `catalog/index.json` con entradas `library:"arc"` y `library:"relume"`, cuando `loadCatalog()` corre, entonces devuelve las entradas tipadas y `createArcAdapter()` sin argumentos arma el mismo pool por rol que hoy (`hero: [hero-section, hero-signup]`, `features: [feature-bento]`, `cta: [cta-section, contact-section, newsletter-signup]`).
- CA2 (RF1, migración) Dado el `registry.arc.json` actual, cuando corre `bun scripts/catalog-migrate.ts`, entonces produce `catalog/index.json` con 11 entradas `arc` cuyos campos existentes (slug, role, tags, surface, geometry, variant, emittable, verified, source, export, importPath, notes) son iguales uno a uno, `manifest: null`, y `bun test` sigue en 50 verdes.
- CA3 (RF2) Dado un índice con una entrada `verified:true` y `manifest:null`, cuando el loader corre en F2 o posterior, entonces lanza `catalog[i] (slug): campo inválido "manifest"`.
- CA4 (RF3) Dado el `doc.md` de `hero-section` del vault, cuando corre el parser, entonces `keywords` tiene 7 elementos empezando por "react hero section", `whenNotToUse` contiene una línea con `alternative: "hero-signup"`, y `props` incluye `{ name: "variant", type: "\"centered\" | \"split\" | \"minimal\"" }`.
- CA5 (RF3) Dado un `whenNotToUse` cuya frase no nombra ningún item del índice, cuando corre el parser, entonces la línea queda sin `alternative` y el test lo afirma (no hay valor por defecto).
- CA6 (RF4) Dado `section_stats10` de `registry.json` (tags "3 Columns", "Background Image", "Stats Section"), cuando corre la derivación Relume, entonces la entrada resultante tiene `verified:false`, `manifestOrigin:"derived"`, `keywords` que incluyen "stats section" y "background image", y `whenNotToUse` vacío (ninguna regla explícita aplica a stats).
- CA7 (RF4, RF6) Dado el índice con una entrada Relume ya `verified:true` y `surface` fijada a mano, cuando se vuelve a correr la derivación, entonces `verified`, `surface`, `geometry` y `emittable` quedan intactos y solo cambian los campos del manifiesto marcados `derived`.
- CA8 (RF5) Dado `catalog fetch newsletter-signup` sobre un scaffold que ya tiene `segmented-control` y `animated-counter` pero no `switch`, cuando corre, entonces copia `blocks/newsletter-signup/*` y `switch/*`, NO toca los existentes, escribe `source` y verifica el sha256 del `.tsx` principal; con un sha que no coincide, falla y no escribe `source`.
- CA9 (RF7, RF9) Dado `briefs/pulse.json`, cuando `routeCandidates` corre y su salida va a `composePage`, entonces la página es exactamente la de hoy (site-header, hero-section, logo-marquee, feature-bento, stats-band, cta-section, site-footer) y `trace.hero.excluded` está vacío.
- CA10 (RF8) Dado `briefs/nimbus-waitlist.json`, cuando `routeCandidates` corre, entonces `hero-section` aparece en `trace.hero.excluded` con la regla "whenNotToUse: waitlist -> hero-signup", `hero-signup` queda en el pool, y `composePage` elige `hero-signup`.
- CA11 (RF8) Dado un pool de hero con `hero-section` y SIN `hero-signup`, cuando el brief es waitlist, entonces `hero-section` NO se excluye (la alternativa no está en el pool) y el rol no queda vacío.
- CA12 (RF9) Dado un rol con 6 candidatos y `shortlist: 4`, cuando el router corre, entonces devuelve 4 ordenados por routeScore desc y slug asc, y los 2 descartados aparecen en `trace` con su score.
- CA13 (RF10) Dado un brief con summary "Súmate a la lista de espera", cuando se calculan los términos de intención, entonces incluyen "waitlist" (perfil) y "lista", "espera" (tokens), y la keyword "email capture" cruza vía perfil aunque no esté en el texto.
- CA14 (RF11) Dado `bun scripts/run.ts briefs/nimbus-waitlist.json --lib arc`, cuando corre, entonces imprime una línea `router: hero -> excluido hero-section (whenNotToUse: waitlist -> hero-signup)`; con `--no-router` no imprime trace y la página coincide con la de hoy.
- CA15 (RF12) Dado una entrada `kind:"layout"` con `slots.inner.allow: ["features"]` elegida para el rol features, cuando `composeLayers` corre, entonces `props.inner` es `{ slug: <item arc de features>, props }` y un layout cuyo `allow` no contiene el rol del strip hace fallar la composición con el slug.
- CA16 (RF14) Dado un índice con `source: "../../etc/passwd"`, cuando `loadCatalog()` corre, entonces lanza con el slug y la ruta, y nada se copia.
- CA17 (RNF1) Dado el mismo vault y brief, cuando `catalog import` y `run.ts` corren dos veces, entonces `diff` de `catalog/index.json` y de `generated/<brief>/src/App.tsx` es vacío.
- CA18 (RNF2) Dado el entorno sin red, cuando corre `bun test`, entonces ningún test hace fetch (se verifica con un `globalThis.fetch` que lanza si se invoca).
- CA19 (RNF6) Dado los tests que leen "vault", cuando corren, entonces solo abren rutas bajo `tests/fixtures/vault/` (aserción sobre las rutas abiertas por el loader de fixtures).

## 5. Datos

Entidad `CatalogEntry` (`src/catalog/schema.ts`), vocabulario del core, nunca el crudo de una librería:

```
CatalogEntry {
  library: 'arc' | 'relume'
  kind: 'block' | 'component' | 'layout'      // layout solo desde F4
  slug, name, role: Role, category, tags[]
  surface: { light: Surface, dark: Surface }  // fijado por persona (brief cohesión)
  geometry: string
  variant?: string
  emittable?: boolean                          // default true (commit 6cdc2e7)
  verified: boolean                            // gate humano
  source: string | null                        // vendorizado en el repo, o null si no se trajo
  origin: { kind: 'vault', path: string, sha256: string }
  export: string, importPath: string
  registryDependencies?: string[]              // slugs de components del mismo índice
  manifest: Manifest | null
  manifestOrigin?: 'parsed' | 'derived'
  slots?: { inner: { allow: Role[], max: 1 } } // solo kind layout (F4)
  notes?: string
}
Manifest {
  keywords: string[]
  whenToUse: string[]
  whenNotToUse: { text: string, alternative?: string }[]
  aiNotes: string[]
  injection: { kind: 'props' | 'data-file' | 'constants', detail: string }
  related: string[]
  props: { name: string, type: string, default?: string, description: string }[]
}
```

Migración:
- F1: `scripts/catalog-migrate.ts` lee `registry.arc.json` y escribe `catalog/index.json` (manifest null, origin con sha256 calculado del `.tsx` en el vault). `src/adapters/arc.ts` pasa a leer del índice filtrando `library:'arc'`; `registry.arc.json` se borra en el mismo commit (queda en git).
- F2b: lo mismo para `registry.json` (Relume, 12 entradas): `library:'relume'`, `surface`/`geometry` se calculan UNA vez con `relumeSurface`/`relumeGeometry` y quedan fijados en el índice; `layoutStyle` deja de existir fuera del script de migración. `src/registry.ts` pasa a leer del índice.
- Reversibilidad: `scripts/catalog-migrate.ts --reverse` regenera `registry.arc.json` y `registry.json` desde el índice (descarta manifest/origin); el test de ida y vuelta afirma que `reverse(migrate(x)) == x` campo a campo. Revertir una fase es `git revert` del commit + `--reverse` si hubo entradas nuevas.

## 6. Dependencias

- Vault `~/Desktop/SoftwareDevProjects/Knowledge/Frontend/Components` (READ-ONLY). Si falta la raíz o un item: `catalog import`/`fetch` fallan con la ruta; el router y el runner NO lo necesitan (consumen el índice y el scaffold ya vendorizado).
- `catalog/index.json`. Si falta o no valida: todo falla ruidoso (RNF4); no hay fallback a los JSON viejos tras F2.
- `LibraryAdapter` (Arc; Relume cuando F2b lo cree sobre `src/registry.ts`). El router consume `verifiedCandidatesByRole`; si un adaptador devuelve un rol vacío, el router lo deja vacío y `composePage` lo omite, como hoy.
- `briefIntent` (`src/plan.ts`). Si no detecta waitlist, la intención es `demo` y el router no excluye nada por whenNotUse de waitlist: degradación segura (la página de hoy).
- Catálogo público de Arc (`/r/catalog.json`), solo con `--check-remote`. Sin red: el flag imprime "sin red, cross-check omitido" y sale 0.
- `@radix-ui/react-switch` y las demás deps npm del scaffold: `catalog fetch` NO instala deps; si un item declara una dep npm ausente en `templates/arc-scaffold/package.json`, falla ANTES de copiar y nombra la dep (la decisión de instalarla es de Karen).

## 7. Seguridad

`superficie_expuesta: no`.

Razón: no hay endpoint, servidor, auth, upload ni pago. Las entradas de datos son (a) briefs JSON escritos por Karen en `briefs/`, (b) el índice JSON del repo, (c) el vault local de solo lectura, (d) opcionalmente una URL FIJA pública (`https://uiarc.dev/r/catalog.json`) sin credenciales ni input de usuario, por lo que no hay vector SSRF (la URL no se construye desde el brief ni desde el índice). El consumo del vault es lectura de archivos propios; la salida es una app estática en `generated/`.

Lo que sí se endurece aunque no sea superficie expuesta:
- RF14/CA16: el índice dirige copias de archivos; se valida que toda ruta quede dentro del repo o del vault (evita que un índice editado a mano o mal migrado copie archivos arbitrarios al scaffold).
- RF5/CA8: sha256 por item; un source cambiado en el vault no se copia en silencio.
- RNF2: ningún secreto nuevo. `ARC_PRO_TOKEN` no existe en este proyecto y no se introduce; el source viene del vault procesado (ADR F0).

No aplica `threat-modeling` ni familias `offensive-*`: no hay frontera de confianza con terceros. Si en el futuro el runner se expone como servicio (brief por HTTP) esta spec caduca en este punto y `superficie_expuesta` pasa a `sí` con `offensive-ssrf` (fetch) y `offensive-file-upload`/path traversal (índice).

## 8. Plan de pruebas

Unit (bun test, sin red, fixtures en `tests/fixtures/vault/` con 2 docs Arc y 2 entradas Relume):
- `tests/catalog.test.ts`: schema/loader (CA1, CA3, CA16), migración ida y vuelta (CA2 + reversibilidad), orden determinista (CA17 sobre el índice).
- `tests/catalog-manifest.test.ts`: parser doc.md (CA4, CA5), derivación Relume (CA6, CA7).
- `tests/catalog-fetch.test.ts`: fetch por slug con deps transitivas, sha256, no-overwrite (CA8), dep npm ausente falla antes de copiar.
- `tests/router.test.ts`: exclusión con/sin alternativa (CA10, CA11), shortlist y trace (CA12), términos de intención (CA13), pulse sin cambios (CA9).
- `tests/compose-layers.test.ts` (F4): slot allow y anidamiento en props (CA15).
- `tests/core.test.ts`, `tests/adapter-arc.test.ts`, `tests/registry.test.ts`: siguen tal cual; su verde en cada fase es RNF7.

Integración (local, no en CI por `bun install`): `bun scripts/run.ts` sobre `pulse` y `nimbus-waitlist` con y sin `--no-router` (CA14), build de `generated/` con `bunx vite build` como ya se hace.

Fuera: pruebas de render visual (van por captura cuando Karen lo pida, como hasta ahora); pruebas contra el catálogo remoto de Arc (opcional, no determinista por depender de red); LLM de intención (fuera de v1 por decisión de Karen); rendimiento con aserción de reloj (RNF3 solo imprime).

## 9. Fases (máx 3-5 archivos por cambio, cada una mergeable y verde)

| Fase | Entrega | Archivos | Verde = |
|---|---|---|---|
| F0 | ADR dos capas (borrador; Karen firma) | `docs/adr/0001-dos-capas-layout-inner.md` (nuevo), `docs/adr/README.md` (índice, nuevo) | linter de briefs no aplica; Karen escribe `Estado: APROBADO` |
| F1 | Índice unificado + migración Arc | `src/catalog/schema.ts` (tipos + parseEntry + validación de rutas RF14), `src/catalog/load.ts` (loadCatalog, filtro por library), `scripts/catalog-migrate.ts` (+ `--reverse`), `src/adapters/arc.ts` (lee del índice), `tests/catalog.test.ts`; borra `registry.arc.json`, crea `catalog/index.json` | CA1, CA2, CA16, CA17 + 50 tests actuales |
| F2a | Manifiesto Arc parseado del vault | `src/catalog/manifest-arc.ts` (parser doc.md), `scripts/catalog-import.ts` (`import arc <slug>...`, opcional `--check-remote`), `tests/catalog-manifest.test.ts`, `tests/fixtures/vault/**`, `catalog/index.json` (11 manifiestos) | CA3, CA4, CA5, CA18, CA19 |
| F2b | Manifiesto Relume derivado + migración Relume | `src/catalog/manifest-relume.ts` (derivación), `scripts/catalog-migrate.ts` (Relume), `src/registry.ts` (lee del índice; `relumeSurface`/`relumeGeometry` quedan solo para la migración), `tests/catalog-manifest.test.ts`, `catalog/index.json`; borra `registry.json` | CA6, CA7 + `tests/registry.test.ts` verde |
| F2c | Fetch on-demand por slug | `src/catalog/fetch.ts` (copia desde vault + deps transitivas + sha256 + no-overwrite), `scripts/catalog.ts` (CLI `fetch <slug>`), `tests/catalog-fetch.test.ts` | CA8 |
| F3 | Router determinista | `src/router.ts` (términos de intención, exclusión, shortlist, trace), `scripts/run.ts` (router + `--no-router` + impresión del trace), `tests/router.test.ts`, `src/plan.ts` (solo si hace falta exportar la tabla de perfiles; preferible que viva en router.ts) | CA9-CA14 |
| F4a | Contrato de slot + composición en el finding (sin emit) | `src/catalog/schema.ts` (`kind: layout`, `slots`), `src/compose-layers.ts`, `tests/compose-layers.test.ts`, `catalog/index.json` (1 layout Relume de prueba, `verified:false` hasta render) | CA15 |
| F4b | Emit de layout + inner | `src/emit.ts`, `scripts/run.ts`, test de emit, y lo que DA1 decida (ver abajo) | build de `generated/` con una página de dos capas |

Orden obligatorio: F0 antes de F4a. F1 -> F2a -> F2b -> F2c -> F3 pueden ir seguidas; F3 no depende de F2c (el router consulta el índice, no el vault). F4b no arranca sin DA1 cerrada en el ADR.

## 10. Decisiones de Karen (resueltas 2026-10-15)

- DA1 → **(a) CSS modules con tokens Arc** al vendorizar. [KAREN:chat 2026-10-15] Además: construir un **transformer script Tailwind→CSS-modules** (en el paso de vendorizado F4a) que porte el grueso automáticamente — resuelve cada clase utilitaria a sus declaraciones CSS desde el config resuelto de Tailwind, agrupa en una clase `.module.css` y reescribe `className`→`styles.x`; variantes `hover:`/`md:`/`dark:` a selectores/`@media`. Revisión humana acotada (O(revisión)) de: valores arbitrarios, mapeo de colores Tailwind→tokens semánticos Arc (`--surface`/`--foreground`), e imports `@kit/ui` (son componentes, no utilidades → se mapean a componentes Arc o se portan). El ADR de F0 deja escrito el modelo (a) + el transformer.
- DA2 → **solo `undesiredTags`** en v1 (recomendación). Ampliar cuando una corrida real muestre un rol mal ruteado.
- DA3 → **leído del perfil**: 4 en `quiet`, 6 en `banded` (recomendación).
- DA4 → **`catalog/index.json` en la raíz** (recomendación).

Resto de la spec: aprobado por Karen [KAREN:chat 2026-10-15].

## 10b. Planteo original de las decisiones (histórico)

- DA1 (F4b, bloqueante) Stack de la cáscara Relume dentro del scaffold Arc. La versión limpia del vault (`sections-react`) es JSX con clases Tailwind y deps `@kit/ui`; el scaffold Arc es CSS modules + tokens sin Tailwind. Opciones: (a) portar cada layout elegido a CSS modules con tokens Arc al vendorizarlo (trabajo por layout, coherente con el scaffold, cero deps); (b) añadir Tailwind v4 al scaffold Arc (dep + config raíz, mezcla dos sistemas de estilo en una página); (c) emitir la página de dos capas en un scaffold tercero. Recomendación: (a), acotado a los layouts que el finding pueda elegir (pocos), y que el ADR lo deje escrito. Procedencia: brief §6 "cada adaptador declara UN solo scaffold".
- DA2 (F2b) Granularidad de `whenNotToUse` derivado para Relume: solo desde `undesiredTags` de `ROLE_SPEC` (propuesta, cero invención) o también desde pares categoría-rol (ej. "testimonial con Slider -> usa uno con Star Rating"). Recomendación: solo `undesiredTags` en v1; ampliar cuando una corrida real muestre un rol mal ruteado.
- DA3 (F3) Valor de `shortlist`: 4 (igual a `TOP_K`) o 6 (deja margen a la reserva de banda del perfil `banded`). Recomendación: 4 en `quiet`, 6 en `banded`, leído del perfil del adaptador; si prefiere una sola constante, 4.
- DA4 (F1) Ubicación del índice: `catalog/index.json` en la raíz (propuesta, junto a `briefs/`) o `src/catalog/index.json`. Recomendación: raíz, porque es dato, no código, y lo editan a mano.
