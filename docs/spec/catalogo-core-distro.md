# Catálogo: core y distro

Estado: **propuesta para Arq, sin decidir.** Solo diseño, sin código. Origen: `docs/notas/alpha-checklist.md` §7 (pendiente que no bloquea el alpha).

## 1. Hechos (medidos sobre `catalog/index.json`, 1129 entradas)

- 118 entradas tienen `source` en la distro: 111 en `templates/arc-scaffold/` y 7 en `fixtures/relume-themed/`. Por librería/tipo: relume bloque 39 + layout 6, arc componente 19 + bloque 19, bencho 17, morphin 18. El resto (1011) trae `source: null` o apunta a `fixtures/relume-preset/` y `tests/fixtures/` (5 entradas).
- **Todas las entradas con `candidates` (22: morphin 11, arc 9, bencho 2; 28 candidatos verificados) tienen `source` en `templates/arc-scaffold/`.** Es decir, `BLOCK_CANDIDATES` es hoy, íntegro, contenido de la distro. El core no tiene un solo candidato de bloque propio.
- Lectores en runtime del core:
  - `src/directions.ts:391`: `BLOCK_CANDIDATES = blockCandidatesFrom(loadCatalog())`, evaluado al importar. Filtra `verified`, `candidates`, `emittable`, rol (`:379-389`).
  - `src/router.ts:329`: `options.catalog ?? loadCatalog({ requireManifest: false })`; el router indexa por slug (`:193`).
  - `src/registry.ts:21-22`: `catalogFor('relume')` sin `templates/`, es decir el pipeline Relume, no la distro.
  - `src/direction-refs.ts:8,21,37`: consume `BLOCK_CANDIDATES` como default.
  - copygen: `src/copygen/slot-model.ts:10` solo importa `REPO_ROOT`/`VAULT_ROOT` de `catalog/load`; no lee entradas (el pendiente lo nombraba por `inject-copy.ts`/`inject-schema.ts`, que reciben entradas ya cargadas).
- `src/catalog/load.ts:11,18`: la ruta del catálogo es una constante (`CATALOG_PATH`), un solo archivo.
- `src/catalog/schema.ts:270`: `verified === true && source === null` falla el parseo. Es la regla que hace que las entradas "se queden con su `source`" aunque el archivo ya no exista en el árbol.
- El alpha dejó dos parches provisionales: `tests/registry.test.ts:55-62` (HACK: lintea solo fuentes presentes y exige que las ausentes estén bajo `DISTRO_SOURCES`, se quita al partir) y las 118 entradas intactas.
- Puertos del perfil: `catalog` ya existe pero es otra cosa (modelos de texto/imagen, `src/profile.ts:30-31`). Un puerto de entradas sería uno nuevo.

## 2. Las tres opciones

### (a) Partir el índice: `catalog/core.json` + `catalog/<distro>.json` que el perfil aporta

- **Forma.** `loadCatalog` lee `catalog/core.json` y, si el perfil activo declara un puerto (p. ej. `catalogEntries()` en el rol que corresponda, hermano de `registry` en `src/profile.ts:28`), suma sus entradas. El archivo de la distro vive en el repo de la distro.
- **directions.** `BLOCK_CANDIDATES` deja de ser constante de módulo: sin perfil con candidatos queda `[]`. Hay que volverlo función (`blockCandidates()`), o inicializarlo tras `setActiveProfile` (`src/profile.ts:61`). Es el cambio con más superficie: `directionBlocks`/`traceBlocks` usan el default (`direction-refs.ts:21,37`) y cualquier import de la constante.
- **router.** `loadCatalog({ requireManifest: false })` en `:329` pasa a la unión core + distro; con `options.catalog` inyectado no cambia.
- **copygen.** Sin cambio (no lee entradas).
- **Guarda `verified ⇒ source`.** Se queda como está: cada archivo es consistente con su árbol. El core se parsea sin tocar rutas de la distro.
- **Pros.** Fuente de verdad separada; el core no carga datos de terceros; el HACK de `registry.test.ts` se borra; el contrato del puerto es explícito.
- **Contras.** Superficie nueva en el perfil (puerto, validación `isObject…` como en `profile.ts:95`, rol); ciclo de vida: la distro regenera su índice y el core no lo ve hasta tener perfil; `BLOCK_CANDIDATES` deja de ser síncrono-constante; dos archivos que hoy comparten `slug`/ids (`arc/faq-section:accordion`) tienen que mantenerse sin colisión; scripts que escriben el índice (`catalog.ts`, `catalog-ingest*.ts`, `catalog-migrate.ts`) escriben a dos destinos.
- **Tests.**
  - `direction-refs`, `page-sensors-blocks`, `page-sensors-direction` (`cand('arc/...')`, `BLOCK_CANDIDATES.find`): necesitan un perfil o catálogo de prueba que aporte los 22 candidatos; o fixtures propios en `tests/fixtures/` (3 entradas ya viven ahí).
  - `agent-composer` (40k, ids `arc/...`): igual, depende de bloques con `candidates`.
  - `catalog-manifest.test.ts:59,103`: lee `catalogFor('arc')` ("las 11 entradas arc verified"); pasa a tests de la distro o a fixtures.
  - `schema-gen.test.ts:138`: `loadCatalog().filter(kind==='component')` toma los 162 componentes de arc; con partición cambia el conjunto esperado.
  - `registry.test.ts`: se borra el HACK (`:55-62`); solo queda el lint de fuentes del core.

### (b) El core guarda las entradas; `verified` exige `source` solo en la distro

- **Forma.** El índice no se parte. `schema.ts:270` se condiciona: `source` obligatorio si `verified` salvo que la entrada declare distro (campo nuevo, p. ej. `host: 'distro'`, o prefijo de `source` en una lista `DISTRO_SOURCES`), y la carga no comprueba existencia en disco.
- **directions / router / copygen.** Sin cambio de código ni de tiempos: `BLOCK_CANDIDATES` sigue constante (`directions.ts:391`).
- **Guarda.** Se relaja en `schema.ts:270`; hay que decidir si el discriminante es un campo o un prefijo, y si el core exige `source` presente para lo que no es distro.
- **Pros.** Es lo que ya hace el alpha; mínimo cambio; cero superficie en el perfil; los 18+ tests siguen verdes.
- **Contras.** El core sigue enviando 118 entradas (y 22 con candidatos, 28 candidatos verificados) de bloques de terceros: no hay separación real, solo se declara. `BLOCK_CANDIDATES` apunta a `importPath` de componentes que no existen en el árbol del core (`directions.ts:384`): una composición con la base neutra puede elegir un bloque inexistente en `templates/base-scaffold`. Es el riesgo funcional real, no solo de higiene.
- **Tests.** `registry.test.ts` conserva la excepción (pasa de HACK a regla); `schema` gana un caso para la nueva condición; el resto no cambia. Lo que sí hay que añadir: un test de que ninguna composición del core elige un candidato cuyo `importPath` no resuelve en el scaffold activo.

### (c) El core sin catálogo de bloques de terceros; `BLOCK_CANDIDATES` viene del registry base

- **Forma.** Se quitan del índice las 118 entradas (o todas las que no son del core) y los candidatos salen de lo que declara el registry del scaffold activo (`templates/base-scaffold`, `scripts/build-base-registry.ts`), que hoy no declara `candidates`.
- **directions.** `BLOCK_CANDIDATES` se calcula del registry cargado por `ds`/perfil (cambio de origen, no solo de timing: hay que definir en el registry base el equivalente de `candidates` — roles, `forms`, `variant`, `focal`; hoy esa forma vive en `schema.ts` `isBlockForms`). Con la base neutra el resultado puede ser `[]` hasta que se publiquen bloques base.
- **router.** Pierde la entrada de arc/morphin/bencho; lo que el router decide para un DS sale del catálogo del core (relume y base). Hay que comprobar qué slugs consulta (`:193`).
- **copygen.** Sin cambio.
- **Guarda.** `schema.ts:270` ya no ve rutas de la distro: se queda.
- **Pros.** Separación más limpia a largo plazo: el catálogo es del DS que se usa; sin puertos de entradas ni campo de distro.
- **Contras.** Es la opción más grande: diseñar y poblar la forma `candidates` en el registry base (spec nueva), tocar el contrato `Registry` y su build, y mantener dos fuentes (índice para relume, registry para bloques). Pierde la inyección de `candidates` verificados de Morphin/Bencho/Arc que hoy alimentan el selector de direcciones hasta que la distro los aporte por otra vía (en la práctica termina en (a) para la distro).
- **Tests.** Los 7 archivos cambian de fuente de datos: los candidatos salen de un registry de prueba (el del scaffold base o fixture). `catalog-manifest` y `schema-gen` pierden sus conjuntos de arc; `registry.test.ts` pierde el HACK.

## 3. Tabla comparativa

| | (a) partir + puerto | (b) relajar `verified` | (c) sin terceros en core |
|---|---|---|---|
| Entradas de terceros en el core | 0 | 118 (22 con candidatos) | 0 |
| `BLOCK_CANDIDATES` | función/perfil | constante, igual | derivado del registry base |
| Superficie nueva | puerto del perfil + validación | campo/prefijo en schema | forma `candidates` en el registry base |
| Riesgo funcional | ids en dos archivos | candidatos cuyo import no existe en el core | selector vacío con la base neutra |
| Tests a tocar (de los 7) | 6 (fixtures/perfil) | 1-2 (`registry`, `schema`) | 7 |
| Cuánto trabajo | medio | mínimo | alto |

Los 7: `direction-refs`, `page-sensors-blocks`, `page-sensors-direction`, `agent-composer`, `catalog-manifest`, `schema-gen`, `registry`.

## 4. Preguntas para Karen

1. ¿El core debe poder elegir hoy bloques de Arc/Morphin/Bencho (el comportamiento actual de las direcciones) o con la base neutra el selector de bloques puede quedar vacío hasta que haya una distro conectada?
2. Si la distro aporta datos: ¿por puerto del perfil (a) o por archivo que la distro coloca en `catalog/` al instalarse? ¿El índice de la distro lo regenera la distro (su propio `catalog.ts`) y el core solo lo lee?
3. ¿Quién es dueño de la forma `candidates` (roles, formas, variantes): el core (schema único) o cada DS (c)?
4. ¿Es aceptable (b) como estado de salida del alpha, con fecha de revisión, sabiendo que el core lleva 22 entradas con candidatos cuyo `importPath` no existe en `templates/base-scaffold`?
5. ¿Las 5 entradas con fuente en `fixtures/relume-preset/` y `tests/fixtures/` se quedan en el core?
6. Fecha límite: el HACK de `tests/registry.test.ts:55` pide un disparador; ¿se cierra antes de publicar el repo de la distro o después?
