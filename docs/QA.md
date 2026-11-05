# QA — probar una página sobre el pipeline real

QA se hace corriendo los entrypoints del repo tal cual (sin componer a mano). La app revisada ES la
salida de `scripts/run.ts`.

## Preparar (una vez)

En el core solo hace falta la instalación de la raíz y la de `templates/base-scaffold` (la base neutra, sin Arc):

```sh
bun install
(cd templates/base-scaffold && bun install)
```

Las deps del porter (TS en `templates/arc-scaffold`, Tailwind en `fixtures/relume-themed`) viven en subcarpetas que desde el alpha son de la distro; para QA del porter se instalan allí:

```sh
# en el checkout de la distro
(cd templates/arc-scaffold && bun install)
(cd fixtures/relume-themed && bun install)
```

## Generar una página

```sh
# brief + librería + (marca por env). --no-llm = copy determinista (reproducible); sin él usa la CLI de Claude.
WT_BRAND_PACK=<ruta-al-brand-pack> \
  bun scripts/run.ts fixtures/briefs/pulse-completo.json --lib arc --no-llm
```

Sale en `generated/<brief>/`. Briefs disponibles en `briefs/*.json`. Sin `WT_BRAND_PACK` usa el brand
pack base (agnóstico). El brand pack puede fijar identidad (accent/surface/fonts + `tokens`/`tokensDark`)
y sesgo de composición (`composition`).

## Previsualizar

```sh
cd generated/pulse-completo
bun install
bunx vite build      # valida que la salida compila (gate de QA)
bunx vite preview    # sirve en http://localhost:4173
```

- **Modo oscuro:** el contrato usa `:root[data-theme="dark"]` (no `prefers-color-scheme`). En devtools,
  pon `data-theme="dark"` en `<html>` para ver la superficie oscura de la marca.
- **Identidad:** el CSS de marca vive en `generated/<brief>/src/identity.css` (lo inyecta el emit desde
  el brand pack). Ahí se ve qué tokens ancló la marca.

## Qué es hueco (pasada 2, no bloquea QA de estructura/identidad)

Imágenes y cifras/testimonios del fallback son de muestra; la identidad, composición y layout sí son
reales. El copy real llega con la pasada de copy (sin `--no-llm`).

## Log de flujo (comparar con Relume antes de QA)

Cada run escribe `generated/<brief>/flow.json` y `flow.md`: el flujo de llamadas y creación de cada
etapa (plan → marca → router → select → 2-capas → copy → emit), mapeado a su contraparte en los
extracts de Relume (`~/Desktop/relume-extract`: `brief-to-homepage`, `section-component-1`,
`page-content-1`, `text-fit-1`…). Úsalo para comparar nuestro flujo con el de Relume antes de revisar.

Las etapas `page-content`/`text-fit` solo aparecen cuando el copy se **genera** (sin `<brief>.copy.json`
junto al brief); su `detail` es el `inputJson` en la forma exacta de `page-content-1`, comparable
campo a campo con el extract.
