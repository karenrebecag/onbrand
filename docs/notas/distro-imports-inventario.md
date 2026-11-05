# Inventario: módulos del core que importa el código que salió a la distro

Fuente: `6738b6c3`, el commit anterior a #911. Las rutas de origen son las de `distro-handoff.md` §1.

Método:
- `git grep` de los imports relativos en `6738b6c3`, resueltos a ruta del repo;
- se descartan los que apuntan dentro de lo que también sale;
- "usos en el core" cuenta los archivos de `src/`, `scripts/` y `apps/builder/src` de main (499349e2) que importan el módulo; los tests no cuentan.

En total son 74 módulos y 347 líneas de import.

Este inventario no propone el `package.json`: eso lo deciden Karen y Arq.

## Conteo por clase

| clase | qué es | módulos |
|---|---|---|
| 1 | ya está en `exports` de `package.json` (:6-12) | 0 |
| 2 | debería exportarse: lo usa el pipeline DS de la distro (porter, build-ds-skill, build-registry, catalog*, compliance, gen-schemas, adaptadores) | 32 |
| 3 | la distro puede dejar de necesitarlo: solo lo importan tests de `tests/arc/` o el runner retirado (C5: `scripts/run.ts`, `router-eval.ts`, `smoke-layers.ts`) | 21 |
| 4 | es de la distro: el core no lo usa, o es código de Arc o Relume fuera de ARC_PATHS | 21 |

Clase 1 es 0 porque ninguno de los 5 exports (`session-provider`, `App`, `serve`, `orchestrator`, `build-registry`) es
lo que importa el código que salió.

## Cómo se clasificó

La regla es mecánica, sobre los datos de cada tabla:
- **4**: el nombre tiene `arc`, `relume` o `ingest-ported`; o el core no lo usa; o es `src/ds-skill-agent.ts`, que es
  el skill del agente de Arc (`alpha-checklist.md` §7). La excepción es `src/runtime/preview-vite.config.ts`: el
  runtime lo carga por ruta (`src/runtime/wt-bridges-plugin.ts:3`), no por import, así que va a la 3.
- **3**: todos sus importadores son tests de la distro o el runner retirado.
- **2**: lo demás. Al menos un importador es del pipeline de la distro.

Hay que revisar a mano:
- **Clase 4 con uso en el core:** `src/catalog/ingest-arc` (2), `manifest-arc` (3), `ingest-relume` (1), `manifest-relume`
  (2), `src/adapters/arc-surface` (1) y `src/ds-skill-agent` (1, `src/runtime/agent-composer.ts`). Antes de mover cada uno,
  el core tiene que dejar de importarlo.
- **`src/ds-skill` y `src/ds-skill-icons`** salen como 2, no como 4. `alpha-checklist.md` §7 los cuenta como código de Arc,
  pero el core los usa en 11 y 7 archivos, entre ellos `scripts/build-base-registry.ts`.
- **Clase 2 grande por un solo importador:** `src/orchestrator/chat-index` solo lo importa
  `src/adapters/vercel-blob/client.ts:5`, el `BlobStore` de la distro. Es el contrato del puerto, así que va como 2.

## Clase 2: debería exportarse (32)

| módulo del core | usos en el core | importado desde la distro (archivo:línea) |
|---|---|---|
| `scripts/motion-gsap-extract` | 1 | `scripts/motion-render-gate.ts:25` |
| `src/adapters/types` | 3 | `scripts/run.ts:16`, `src/adapters/arc.ts:24`, `tests/arc/eligibility-router.test.ts:3` y 2 más |
| `src/brand` | 19 | `scripts/compliance.ts:13`, `scripts/form-distance.ts:6`, `scripts/run.ts:24` y 8 más |
| `src/brand-registry` | 8 | `scripts/build-registry.ts:17` |
| `src/catalog/eligibility` | 1 | `src/adapters/arc.ts:23`, `tests/arc/eligibility-router.test.ts:4`, `tests/arc/slot-policy.test.ts:6` |
| `src/catalog/fetch` | 3 | `scripts/catalog.ts:9`, `scripts/ingest-sample-build.ts:13`, `tests/arc/catalog-fetch.test.ts:6` |
| `src/catalog/hash` | 6 | `tests/arc/catalog-fetch.test.ts:7`, `tools/porter/cache.ts:5`, `tools/porter/parse.ts:8` y 1 más |
| `src/catalog/inject-copy` | 1 | `src/adapters/arc.ts:14`, `tests/arc/eligibility-router.test.ts:5` |
| `src/catalog/load` | 15 | `scripts/block-contract.ts:8`, `scripts/build-ds-skill.ts:15`, `scripts/build-registry.ts:12` y 19 más |
| `src/catalog/port-imports` | 1 | `scripts/tailwind-to-modules.ts:14`, `tools/porter/deps.ts:9` |
| `src/catalog/schema` | 24 | `scripts/build-ds-skill.ts:16`, `scripts/catalog-ingest-ported.ts:9`, `scripts/catalog-ingest.ts:21` y 23 más |
| `src/catalog/schema-gen` | 4 | `scripts/build-ds-skill.ts:12`, `scripts/compliance.ts:14`, `scripts/gen-schemas.ts:12` y 2 más |
| `src/catalog/slot-policy` | 1 | `scripts/gen-schemas.ts:14`, `src/adapters/arc.ts:20`, `tests/arc/slot-policy.test.ts:9` y 1 más |
| `src/config` | 15 | `scripts/build-registry.ts:13` |
| `src/copy` | 11 | `scripts/catalog-ingest.ts:22`, `scripts/compliance.ts:16`, `scripts/run.ts:27` y 7 más |
| `src/copygen/defaults` | 3 | `src/adapters/arc.ts:19`, `tests/arc/slot-policy.test.ts:12` |
| `src/copygen/generator` | 6 | `scripts/run.ts:29`, `src/adapters/arc.ts:25` |
| `src/copygen/slot-model` | 8 | `src/adapters/arc.ts:18`, `tests/arc/eligibility-router.test.ts:7`, `tests/arc/slot-policy.test.ts:13` |
| `src/directions` | 5 | `src/catalog/ingest-ported.ts:10`, `tests/arc/directions.test.ts:3`, `tests/arc/directions.test.ts:98` y 10 más |
| `src/ds-registry` | 1 | `scripts/build-registry.ts:15`, `tests/arc/ds-registry-arc.test.ts:4` |
| `src/ds-skill` | 11 | `scripts/build-ds-skill.ts:20`, `scripts/build-registry.ts:11` |
| `src/ds-skill-icons` | 7 | `scripts/build-ds-skill.ts:23` |
| `src/extension-points` | 6 | `scripts/build-registry.ts:18`, `tests/arc/extension-points.test.ts:5` |
| `src/files-sha` | 1 | `scripts/motion-render-gate.ts:22` |
| `src/motion-gate` | 1 | `scripts/motion-render-gate.ts:23`, `tests/arc/motion-gate.test.ts:2` |
| `src/orchestrator/chat-index` | 9 | `src/adapters/vercel-blob/client.ts:5`, `tests/chat-index-blob-live.test.ts:6` |
| `src/profile` | 4 | `scripts/build-registry.ts:14` |
| `src/runtime/content-rules` | 1 | `scripts/build-ds-skill.ts:21` |
| `src/runtime/registry-source` | 2 | `src/adapters/vercel-blob/reader.ts:5` |
| `src/skill-registry` | 8 | `scripts/build-registry.ts:19` |
| `src/theme/presets-from-css` | 6 | `scripts/compliance.ts:7`, `tests/arc/brand-base-coverage.test.ts:5`, `tests/arc/neutral-tones-arc.test.ts:7` y 1 más |
| `src/types` | 34 | `scripts/catalog-ingest.ts:23`, `scripts/compliance.ts:18`, `scripts/ingest-sample-build.ts:16` y 11 más |

## Clase 3: la distro puede dejar de necesitarlo (21)

| módulo del core | usos en el core | importado desde la distro (archivo:línea) |
|---|---|---|
| `scripts/brandpack-red` | 1 | `tests/arc/brandpack-paridad.test.ts:4`, `tests/arc/brandpack-red-arc.test.ts:5`, `tests/arc/fixtures/brandpack-red-arc.ts:6` |
| `src/brand-aa` | 4 | `tests/arc/brandpack-red-arc.test.ts:7` |
| `src/brand-components` | 4 | `tests/arc/brand-components.test.ts:7` |
| `src/brand-sensors` | 3 | `tests/arc/brandpack-paridad.test.ts:8` |
| `src/brand-skill` | 2 | `tests/arc/brand-components.test.ts:6` |
| `src/compose-layers` | 2 | `scripts/run.ts:20`, `scripts/smoke-layers.ts:8`, `tests/arc/compose-layers.test.ts:5` y 1 más |
| `src/copygen/claude-transport` | 1 | `scripts/run.ts:30` |
| `src/copygen/generate` | 1 | `scripts/run.ts:28` |
| `src/emit` | 1 | `scripts/run.ts:23`, `scripts/smoke-layers.ts:10`, `tests/arc/emit.test.ts:2` y 1 más |
| `src/identity-ephemeral` | 8 | `tests/arc/brandpack-paridad.test.ts:9`, `tests/arc/check-brand-v1.test.ts:9`, `tests/arc/directions.test.ts:4` |
| `src/images` | 1 | `tests/arc/slot-policy.test.ts:14` |
| `src/lint` | 2 | `tests/arc/lint.test.ts:3` |
| `src/page-sensors` | 18 | `tests/arc/brandpack-paridad.test.ts:10` |
| `src/plan` | 4 | `scripts/router-eval.ts:8`, `scripts/run.ts:17` |
| `src/registry` | 5 | `tests/arc/adapter-arc.test.ts:8`, `tests/arc/catalog-ingest.test.ts:11` |
| `src/router` | 2 | `scripts/router-eval.ts:9`, `scripts/run.ts:19`, `scripts/smoke-layers.ts:11` y 4 más |
| `src/runtime/agent-prompt` | 2 | `tests/arc/skill-avatars-emoji.test.ts:5` |
| `src/runtime/preview-vite.config` | 0 | `tests/arc/base-scaffold-infra.test.ts:7` |
| `src/runtime/runner` | 10 | `tests/arc/serve-fixture-allowlist.test.ts:7` |
| `src/select` | 7 | `scripts/router-eval.ts:10`, `scripts/run.ts:18`, `scripts/smoke-layers.ts:12` y 5 más |
| `src/theme/neutral-tones` | 1 | `tests/arc/neutral-tones-arc.test.ts:6` |

## Clase 4: es de la distro y debería irse con ella (21)

| módulo del core | usos en el core | importado desde la distro (archivo:línea) |
|---|---|---|
| `scripts/brandpack-migrate-v2` | 0 | `tests/arc/brandpack-migrate-v2.test.ts:4`, `tests/arc/brandpack-paridad.test.ts:6` |
| `scripts/catalog-migrate` | 0 | `tests/arc/catalog.test.ts:5` |
| `src/adapters/arc-surface` | 1 | `src/adapters/arc.ts:26`, `tests/arc/adapter-arc.test.ts:4` |
| `src/catalog/block-contract` | 0 | `scripts/block-contract.ts:7`, `scripts/tailwind-to-modules.ts:13`, `tests/arc/block-contract.test.ts:2` |
| `src/catalog/ingest-arc` | 2 | `scripts/catalog-ingest.ts:13`, `tests/arc/catalog-ingest.test.ts:6` |
| `src/catalog/ingest-relume` | 1 | `scripts/catalog-ingest.ts:17`, `tests/arc/catalog-ingest.test.ts:7` |
| `src/catalog/ingest-report` | 0 | `scripts/catalog-ingest.ts:18`, `tests/arc/catalog-ingest.test.ts:8` |
| `src/catalog/inject-schema` | 0 | `src/adapters/arc.ts:15` |
| `src/catalog/manifest-arc` | 3 | `scripts/catalog-ingest.ts:20` |
| `src/catalog/manifest-relume` | 2 | `scripts/catalog-ingest.ts:19`, `tests/arc/catalog-ingest.test.ts:9` |
| `src/catalog/materialize` | 0 | `src/adapters/arc.ts:17`, `tests/arc/materialize.test.ts:6` |
| `src/catalog/slot-fill` | 0 | `src/adapters/arc.ts:21` |
| `src/catalog/slot-semantics` | 0 | `src/adapters/arc.ts:22` |
| `src/catalog/ts-props` | 0 | `scripts/build-ds-skill.ts:13`, `scripts/catalog-ingest-ported.ts:10`, `scripts/compliance.ts:15` y 4 más |
| `src/content-form` | 0 | `scripts/run.ts:33` |
| `src/copygen/claude-code-transport` | 0 | `scripts/run.ts:31` |
| `src/ds-skill-agent` | 1 | `scripts/build-ds-skill.ts:22`, `tests/arc/directions.test.ts:80`, `tests/arc/ds-skill-agent.test.ts:5` y 4 más |
| `src/log/flow` | 0 | `scripts/run.ts:25` |
| `src/motion-attrs` | 0 | `scripts/motion-render-gate.ts:24` |
| `src/motion-render` | 0 | `scripts/motion-render-gate.ts:21` |
| `src/svg-icons` | 0 | `scripts/svg-to-icons.ts:11`, `tests/arc/svg-icons.test.ts:4` |

