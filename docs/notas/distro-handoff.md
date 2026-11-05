# Handoff a la distro: lo que salió del core en el alpha

Nota operativa para montar el repo de la distro con lo que salió del core en #911 (499349e2).

- **SHA fuente:** `6738b6c3`, el commit anterior a #911. Todo lo de abajo se lee de ese árbol.
- **Comandos:** los de §6 los ejecuta Orq. Los repos los crea Karen (`alpha-checklist.md` §6).

## 1. Rutas que recibe la distro

### Arc

Es ARC_PATHS tal como estaba en la guarda (`6738b6c3:tests/core-sin-terceros.test.ts:211-220`).

| ruta | nota |
|---|---|
| `templates/arc-scaffold/` | scaffold de Arc, con su `package.json` y lockfile |
| `registry-arc/` | registry materializado de Arc |
| `fixtures/relume-themed/` | fixture Tailwind del porter |
| `tools/porter/` | porter |
| `tests/arc/` | 68 archivos en `6738b6c3`; #910 sumó fixtures desde `tests/` |
| `src/adapters/arc.ts`, `src/catalog/ingest-ported.ts` | adaptador y catálogo portado |
| `scripts/block-contract.ts`, `build-ds-skill.ts`, `build-registry.ts`, `catalog.ts`, `catalog-ingest.ts`, `compliance.ts`, `gen-schemas.ts`, `ingest-sample-build.ts`, `motion-render-gate.ts`, `svg-to-icons.ts`, `tailwind-to-modules.ts`, `token-probe.ts` | herramientas de Arc (:215-217) |
| `scripts/run.ts`, `router-eval.ts`, `smoke-layers.ts`, `catalog-ingest-ported.ts`, `port.ts`, `form-distance.ts` | importan alguna de las anteriores (:219) |

### Blob

| ruta | nota |
|---|---|
| `src/adapters/vercel-blob/client.ts`, `reader.ts` | `BlobStore` y `RegistryStore` sobre Blob (ADR 0017 §2) |
| `tests/chat-index-blob-live.test.ts` | prueba en vivo; importa `@vercel/blob` (:5) |
| `tests/vercel-blob-adapter.test.ts` | contrato del cliente (:2) |

### Tests que salieron con un script

| ruta | nota |
|---|---|
| `tests/build-ds-skill-vault.test.ts` | ejecuta `scripts/build-ds-skill.ts` (:9). Sale con él (`alpha-checklist.md` §7) |

## 2. package.json de la distro

| entrada | valor | de dónde sale |
|---|---|---|
| `dependencies` `@vercel/blob` | `^2.8.2` | `6738b6c3:package.json:22` |
| `dependencies` `onbrand` | dependencia git por tag del core | ADR 0017 §4, opción (a) |
| `devDependencies` `playwright` | `1`, igual que el core (`package.json` hoy: devDependencies) | lo usan `tests/arc/e2e/fidelity.spec.ts` y `tools/porter/fidelity-runner.ts` (`PLAYWRIGHT_MODULE`) |
| `typescript` | no va en la raíz | el porter lo toma de `templates/arc-scaffold` (`~6.0.2`, `6738b6c3:templates/arc-scaffold/package.json:44`), como decía `6738b6c3:tsconfig.json:5` |
| tailwind del porter | no va en la raíz | lo trae `fixtures/relume-themed` (`^3.4.17`, su `package.json:27`) |

`@vercel/sandbox` y `@clerk/backend` ya están aprobadas para la distro (decisiones-pendientes §3, fila 2). Se instalan ahí.

Installs que hacía CI del core para esto (`6738b6c3:.github/workflows/ci.yml:30,32`; los dos salieron en #911):
- `cd templates/arc-scaffold && bun install --frozen-lockfile`
- `cd fixtures/relume-themed && bun install --frozen-lockfile`

El env `WT_PORTER_DEPS_ROOT: ${{ github.workspace }}` (`6738b6c3:.github/workflows/ci.yml:21`) vuelve al CI de la distro.

## 3. Variables de entorno de la distro

Solo nombres.

| variable | quién la lee en `6738b6c3` |
|---|---|
| `BLOB_READ_WRITE_TOKEN` | `src/adapters/vercel-blob/client.ts:2`, `reader.ts:2`, `scripts/build-registry.ts`, `tests/chat-index-blob-live.test.ts:9` |
| `BLOB_STORE_ID` | `src/adapters/vercel-blob/client.ts:2`, `scripts/build-registry.ts` |
| `WT_PROFILE_MODULE` | el core, para cargar el perfil de la distro (`.env.example:52`) |
| `WT_FACTS_URL` | necesita un perfil con el puerto facts (`.env.example:74`) |
| `WT_SCAFFOLD_DIR`, `WT_AGENT_SKILL` | el core, para montar el scaffold y el skill de la distro (`src/config.ts:142-143`) |
| `WT_BRANDS_ROOT` | `scripts/build-registry.ts`; el core también (`src/config.ts:137`) |
| `WT_VAULT_ROOT` | `scripts/build-ds-skill.ts` (`tests/build-ds-skill-vault.test.ts:11`; `.env.example:81`) |
| `WT_PORTER_SCAFFOLD`, `WT_PORTER_DEPS_ROOT`, `WT_PORTER_OUT_ROOT`, `PLAYWRIGHT_MODULE` | `tools/porter/build.ts`, `deps-root.ts`, `pipeline.ts`, `fidelity-runner.ts` |
| `WT_BRIDGES_DIR`, `PORTER_E` | `tests/arc/base-scaffold-infra.test.ts`, `tests/arc/e2e/fidelity.spec.ts` |

Las variables de Clerk y de Sandbox no figuran en `6738b6c3`: llegan con esos adaptadores.

## 4. Qué importa del core por tag

Solo lo que exporta `package.json` (ADR 0017:162: "Un import a `onbrand/src/...` es un error de revisión").

| export | archivo |
|---|---|
| `onbrand/session-provider` | `apps/builder/src/lib/session-provider.ts` (`package.json:7`) |
| `onbrand/App` | `apps/builder/src/App.tsx` (:8) |
| `onbrand/serve` | `scripts/serve.ts` (:9) |
| `onbrand/orchestrator` | `src/orchestrator/main.ts` (:10) |
| `onbrand/build-registry` | `scripts/build-base-registry.ts` (:11) |

`bin` (:13-17): `serve`, `onbrand-orchestrator`, `build-registry`.

## 5. Pendiente de partir

1. **Imports internos.** El código de §1 importa 74 módulos internos del core (`src/`, `scripts/`, `apps/`), por ruta relativa. Lo
   medí con `git grep` sobre `6738b6c3` en las rutas de §1, sin contar los imports entre archivos que también salen. El
   detalle por módulo está en `distro-imports-inventario.md`. Copiado tal cual a la distro, cada uno es un import a
   `onbrand/src/...`, que ADR 0017:162 prohíbe. Hay dos caminos:
   - el core exporta lo que la distro necesita (cambio de `package.json`, Karen);
   - la distro deja de necesitarlo.

   No bloquea el handoff de archivos, pero sí el primer CI verde de la distro. Necesita un inventario por módulo antes
   de decidir.
2. **`catalog/index.json`** (`alpha-checklist.md` §7):
   - 118 entradas con `source` en `templates/arc-scaffold/` (111) o `fixtures/relume-themed/` (7) se quedan en el core;
   - `tests/registry.test.ts` exige que las fuentes ausentes estén bajo esos dos prefijos (HACK con disparador).
   Hay que partirlo en core y distro, o que la distro aporte sus entradas por el puerto del perfil. Para Arq.
3. **Código de Arc fuera de ARC_PATHS:** `src/ds-skill*.ts`, `src/catalog/*` (`ingest-arc.ts` y otros), `src/runtime/skill.ts` y
   `src/svg-icons.ts` se quedaron en el core (`alpha-checklist.md` §7). Van al barrido post-alpha.

## 6. Comandos sugeridos (los ejecuta Orq)

Desde el checkout del core, sin tocar su árbol:

```bash
SRC=6738b6c3
git archive --format=tar "$SRC" -- \
  templates/arc-scaffold registry-arc fixtures/relume-themed tools/porter tests/arc \
  src/adapters/arc.ts src/catalog/ingest-ported.ts src/adapters/vercel-blob \
  tests/chat-index-blob-live.test.ts tests/vercel-blob-adapter.test.ts tests/build-ds-skill-vault.test.ts \
  scripts/block-contract.ts scripts/build-ds-skill.ts scripts/build-registry.ts scripts/catalog.ts \
  scripts/catalog-ingest.ts scripts/compliance.ts scripts/gen-schemas.ts scripts/ingest-sample-build.ts \
  scripts/motion-render-gate.ts scripts/svg-to-icons.ts scripts/tailwind-to-modules.ts scripts/token-probe.ts \
  scripts/run.ts scripts/router-eval.ts scripts/smoke-layers.ts scripts/catalog-ingest-ported.ts \
  scripts/port.ts scripts/form-distance.ts \
  | tar -x -C <checkout-de-la-distro>
```

Comprobación:

```bash
git archive "$SRC" -- <rutas de arriba> | tar -t | grep -c node_modules   # 0
git ls-tree -r --name-only "$SRC" -- tests/arc | wc -l                     # 68
```

El commit en la distro cita el SHA fuente: `feat: rutas de la distro desde onbrand@6738b6c3`.
