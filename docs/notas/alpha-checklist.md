# Checklist del PR del alpha (0.1.0-alpha.1)

Inventario exacto del PR que corta el primer alpha del core. Base: main b5028e2b, 2026-11-05.

Fuentes:
- ADR 0017:29-35, el orden que destraba el alpha;
- ADR 0017:223-228, "Corte alpha y corte final";
- `decisiones-pendientes-2026-11-04.md` §3, filas 10, 11 y 15, que `estado-2026-11-05.md:70-71` cita como §3.10 y §3.11.

Quién ejecuta cada fila:
- **Orq**: todo lo que es git (git mv, git rm, commit, tag, PR, merge).
- **Karen**: las configs raíz (`package.json`, `tsconfig.json`, `LICENSE`) y la creación de repos (fila 15 de §3: la
  delegación de ADR 0017 no las cubre).
- **ec**: las ediciones de código y docs que siguen a cada movimiento, con su test.

El alpha sale con las excepciones fechadas que no son de Blob ni de Arc todavía vivas:
- `MOVER_WA`, `MOVER_IMAGEN`, `MOVER_WA_ATTR` y `README_B4` (`tests/core-sin-terceros.test.ts:83-92`);
- `0.1.0` final sale sin ninguna (ADR 0017:226).

## 1. Sale del core (Arc, ARC_PATHS)

Lista tal como está en `tests/core-sin-terceros.test.ts:211-219` (ARC_EXIT en :210). Todo sale entero: el core se queda sin
estos paths y el repo de la distro los recibe desde el commit anterior al tag (§6).

| path | qué es | quién |
|---|---|---|
| `templates/arc-scaffold/` | scaffold de Arc, con su `node_modules` propio | Orq |
| `registry-arc/` | registry materializado de Arc | Orq |
| `fixtures/relume-themed/` | fixture de Tailwind del porter | Orq |
| `tools/porter/` | porter (se tipa con el scaffold de Arc, `tsconfig.json:5`) | Orq |
| `tests/arc/` | 59 archivos: tests de Arc y `fixtures/` (brandpack-red-arc, aa-report de base-real, arc-scaffold-env) | Orq |
| `src/adapters/arc.ts`, `src/catalog/ingest-ported.ts` | adaptador y catálogo portado | Orq |
| `scripts/block-contract.ts`, `build-ds-skill.ts`, `build-registry.ts`, `catalog.ts`, `catalog-ingest.ts`, `compliance.ts`, `gen-schemas.ts`, `ingest-sample-build.ts`, `motion-render-gate.ts`, `svg-to-icons.ts`, `tailwind-to-modules.ts`, `token-probe.ts` | herramientas de Arc (:214-216) | Orq |
| `scripts/run.ts`, `router-eval.ts`, `smoke-layers.ts`, `catalog-ingest-ported.ts`, `port.ts`, `form-distance.ts` | importan alguna de las de arriba (:217-218) | Orq |

Después del movimiento (ec):
- en la guarda, quitar ARC_EXIT, ARC_PATHS y los 3 tests de la regla 4 (:207-256);
- la regla de nombre (NAMES_ARC) queda sin excepciones.

## 2. Se borra del core (Blob)

| path | línea | quién |
|---|---|---|
| `src/adapters/vercel-blob/` (`client.ts`, `reader.ts`) | guarda :38-40 (BLOB_DIR, BLOB_EXIT) | Orq |
| `tests/chat-index-blob-live.test.ts` | importa `@vercel/blob` (:5) y el cliente (:7) | Orq |
| `tests/vercel-blob-adapter.test.ts` | importa el cliente (:2). No estaba en la lista de BLOB_EXIT: sale igual | Orq |
| `@vercel/blob` en `package.json:22` | dependencia | Karen |
| guarda: BLOB_DIR, BLOB_EXIT y su chequeo de `package.json` (`tests/core-sin-terceros.test.ts:38-60`) | se quitan con la carpeta | ec |

`src/orchestrator/chat-index.ts:4` ya no importa `@vercel/blob`: el cliente entra por deps (A3), así que no cambia.

## 3. package.json (lo escribe Karen)

Hoy (`package.json:2-4`) es `"name": "web-transformer"`, `"version": "0.0.0"` y `"private": true`, sin `exports` ni `bin`.

| campo | valor | archivo de origen |
|---|---|---|
| `exports` session-provider | `setSessionProvider` y `SessionProvider` | `apps/builder/src/lib/session-provider.ts:13,34` |
| `exports` App | componente raíz del builder | `apps/builder/src/App.tsx` |
| `bin` serve | arranque del runtime | `scripts/serve.ts` |
| `bin` orquestador | arranque del orquestador | `src/orchestrator/main.ts` |
| `bin` build-registry | registry del DS | ver nota |
| `version` | `0.1.0-alpha.1` | ADR 0017:35 |
| `dependencies` | sin `@vercel/blob` (:22) | §2 |

Nota sobre build-registry: `scripts/build-registry.ts` es de Arc y sale en §1 (ARC_PATHS :214). El registry del core lo
arma `scripts/build-base-registry.ts`. El `bin` tiene que apuntar a ese, o a un alias con el nombre `build-registry`. Lo
decide Karen al escribir el campo.

`private` y `name`: el repo público nuevo (§6) es el que se publica. Si `private` y `name` cambian en este PR o en el
repo nuevo, lo decide Karen.

## 4. LICENSE

| archivo | estado hoy | quién |
|---|---|---|
| `LICENSE` (raíz) | no existe | Karen |

Va MIT, en el mismo PR (fila 10 de §3).

## 5. CI, tsconfig y README

| archivo:línea | qué cambia | quién |
|---|---|---|
| `.github/workflows/ci.yml:19` | el comentario del porter (scaffold + relume-themed) sale con él | ec |
| `.github/workflows/ci.yml:30` | `cd templates/arc-scaffold && bun install` sale | ec |
| `.github/workflows/ci.yml:32` | `cd fixtures/relume-themed && bun install` sale | ec |
| `.github/workflows/release.yml:55-65` | el paso `skill` (instala arc-scaffold :62, `build-ds-skill --mode agent` :63, tgz arc-agent :64) sale o pasa a `build-base-registry` | ec propone, Karen decide si el release adjunta el skill base |
| `tsconfig.json:5` | el comentario de tools/porter sale | Karen |
| `tsconfig.json:30` | `"tools/porter"` sale del `exclude` | Karen |
| `tsconfig.json:16` | `typescript` → base-scaffold: se queda | — |
| `README.md:189` | la frase que nombra el host del cliente | Secondary (README_B4, :90) |
| `README.md:234` | la fila de `--registry` y `--facts` que nombra la variante del cliente | Secondary (README_B4) |

README_B4 vence el 2026-12-15 (:90). No bloquea el alpha: queda como excepción viva hasta `0.1.0`.

## 6. Secuencia

| # | paso | quién | condición |
|---|---|---|---|
| 1 | PR del alpha con §1-§5 en un solo PR | Orq (git), Karen (§3, §4, tsconfig), ec (guarda, CI) | CI verde. La guarda queda sin ARC_EXIT ni BLOB_EXIT |
| 2 | tag `0.1.0-alpha.1` sobre el merge | Orq | ADR 0017:35 |
| 3 | repo público nuevo, con historial limpio, desde el árbol del tag | Karen (crea el repo), Orq (push del árbol) | fila 11 de §3: el repo actual sigue privado |
| 4 | el repo de la distro deja de estar congelado | Karen | ADR 0017:13-15. Recibe §1 y §2 desde el commit anterior al tag, con `git show <sha>^:<path>` o un export de esos paths. Fija `onbrand` al tag (ADR 0017 §4, opción a). Ahí se instalan `@vercel/sandbox` y `@clerk/backend`, aprobadas en la fila 2 de §3 |
| 5 | deploy de prueba de la distro | Karen (OK por deploy) | decisión 7 |

El SHA del commit anterior al tag lo fija Orq en el paso 2. Es la única fuente de §1 y §2 para el paso 4.

## 7. Encontrado al ejecutar §1 (2026-11-05 noche, Orq)

- `catalog/index.json` mezcla core y distro: 118 entradas (111 con `source` en `templates/arc-scaffold/`, 7 en `fixtures/relume-themed/`) son datos que el core usa en tiempo de ejecución (`src/directions.ts:391` arma `BLOCK_CANDIDATES` desde el catálogo; router y copygen también lo leen). Quitarlas rompe 18 tests de lógica del core (direction-refs, page-sensors, agent-composer, catalog-manifest, schema-gen, registry). Decisión de ejecución: las entradas se quedan con su `source` apuntando a rutas que ahora viven en la distro; `tests/registry.test.ts` lintea solo las fuentes presentes y exige que las ausentes estén bajo esos dos prefijos (HACK con disparador). Pendiente, no bloquea el alpha: partir el catálogo en core y distro, o que la distro aporte sus entradas por el puerto del perfil. Para Arq.
- `tests/build-ds-skill-vault.test.ts` ejecutaba `scripts/build-ds-skill.ts`: sale con él (no estaba en ARC_PATHS).
- Código de Arc fuera de ARC_PATHS que solo nombra rutas en comentarios (ds-skill*, catalog/*, runtime/skill.ts, svg-icons, ingest-arc) se queda; barrido post-alpha.
