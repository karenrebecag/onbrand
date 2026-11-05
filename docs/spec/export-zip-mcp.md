# H9: ratificar el zip y sumar MCP

Estado: PROPUESTA (Arq, 2026-11-04). Base: `src/runtime/export.ts` (#494), `run-reads.ts` (`exportVersion`) y
`docs/research/publish-path-agnostico.md` (ESCALADO).

Esta spec cubre solo lo que **no** depende de la decisión de Karen sobre G1-G3 ni del 501 de publish. Quién hospeda el
MCP en el despliegue y con qué auth cae en G1 y en H3. Aquí solo se fija el contrato de lectura y el MCP local.

## 1. Qué entra hoy en cada formato

`GET /runs/:id/export` sin `format` da la disponibilidad: `{commit, formats: {source, site, design-md, brief, page}}`.
Con `format` da el archivo como `attachment` con `no-store`.

| format | contenido | si no hay | errores |
|---|---|---|---|
| `source` | `git archive --format=zip --prefix=<slug>/ <commit>`: todo lo commiteado en esa versión | siempre existe | 413 (más de 50 MiB), 422 (symlink en el árbol) |
| `site` | ZIP store del dist servible de la versión, sin `.base` y sin nombres inseguros. Los bytes salen deterministas | 404 sin build | 413, 422 |
| `page` | `index.html` del dist en un solo archivo, con CSS, JS, imágenes y fuentes inline | 404 sin build | 413, 422 (sin `index.html`) |
| `design-md` | `DESIGN.md` del commit | 404 | |
| `brief` | `page-plan.md` del commit | 404 | |

El zip `source` lleva el scaffold completo (`package.json`, lockfile, config de vite y `src/`), `page.json`,
`src/sections`, `src/App.tsx`, `DESIGN.md`, `page-plan.md` y los archivos de marca aplicados. Lleva además dos
archivos que no son la página:
- `request.json`, el pedido completo de la versión (`requestRecord`, `run-checks.ts:38`). Trae el `prompt`, las
  `instructions`, los `connectors` y `attachments` con su `path` del servidor, y `brand` con sus `facts`, sus
  `instructions` y la **`memory` de la marca** (M2).
- `instructions.json`, las instrucciones de marca heredadas.

Fuera del zip, porque git o el `.gitignore` del scaffold los ignoran: `.wt/` (logs, planes, capturas, dist),
`node_modules`, `dist`, `render-input.json` y `render.json`.

Ratificado tal cual: los formatos, los nombres (`<slug>-<sha7>-codigo.zip`, `-sitio.zip`, `.html`), los topes, el
rechazo de symlinks y que todo sea solo lectura y sin red. La única duda abierta es la P1 (§4).

## 2. Qué falta para que un MCP lo consuma

Stitch exporta a MCP con un **puntero**, no con el contenido. Copia un prompt con los ids del proyecto y de las
pantallas, y el cliente MCP, autenticado, trae el código por id (`re-sistema/stitch/export-formats/mcp/decode.md`).
Se copia ese modelo: el contenido solo sale hacia quien tiene acceso al transport.

Hoy faltan tres cosas:
1. **Leer sin binario.** Un cliente MCP consume texto o JSON, no un zip en `attachment`. `GET /runs/:id/files` solo
   devuelve `PAGE_PATHS`. Falta leer el árbol completo del commit como lista de rutas y el contenido de una ruta, sobre
   el mismo `listFiles` y `showFile` que ya usa `exportVersion`. Se aplican las mismas reglas que a `source`: lo
   commiteado, sin symlinks y con el tope de 50 MiB.
2. **Identificar la versión.** El puntero es `messageId` más `commit`. Un `messageId` sin versión ya da 409 en
   `versionOf`, y el menú ya conoce `commit` por `GET /export`.
3. **Un servidor MCP.** El repo ya tiene el patrón: `scripts/workspace-mcp.ts` es un stdio MCP escrito a mano, sin
   SDK, y `workspace-mcp.ts` adapta el contenido. El MCP de export es otro script stdio de solo lectura que habla con el
   transport por HTTP, con `x-origin-secret` si está configurado. No crea dependencias: el SDK de MCP no está en
   `package.json`.

### Contrato (solo lectura)

| tool | entrada | salida |
|---|---|---|
| `list_versions` | `chat` (messageId raíz) | versiones del hilo con su `messageId`, `commit`, `title` y `formats` disponibles |
| `get_version_files` | `messageId` | rutas del commit, con su tamaño |
| `read_file` | `messageId`, `path` | contenido de texto. Binarios: 422 con su tamaño, y se descargan con `export_url` |
| `export_url` | `messageId`, `format` | la URL de `GET /runs/:id/export?format=`, para bajarla con `curl -L` como en Stitch |

Los errores HTTP pasan a errores de tool con el mismo texto (404, 409, 413 y 422). No hay tools que escriban: un
MCP que cree turnos o modifique una versión queda fuera (ver P2).

### Builder

En el menú Exportar, la opción "Copiar para MCP" copia el puntero. Es un texto con el título, el `messageId` de la
versión, `commit`, los formatos disponibles y la instrucción de usar el MCP `onbrand`. Igual que en Stitch, no lleva
contenido. Se habilita con la misma disponibilidad de `GET /export`.

## 3. Archivos y orden

1. **Transport:** endpoint de árbol y archivo (`run-reads.ts` y `http-router.ts`, sin tocar `transport.ts` por la
   condición 3). Lo hace Secondary.
2. **Script stdio** `scripts/export-mcp.ts` y su config para Claude Code y Cursor, en local contra `127.0.0.1`. Lo hace
   ec.
3. **Builder:** "Copiar para MCP". Lo hace UI.

Tests:
- El árbol no lista `.wt` ni `node_modules`.
- `read_file` rechaza `..` y symlinks.
- Un commit con symlink da 422, igual que `source`.
- Un mensaje sin versión da 409.

## 4. Preguntas cerradas para Karen

- **P1. ¿El zip `source` (y el MCP) llevan `request.json` e `instructions.json`?**
  - (A) Sí, tal cual. El zip permite re-correr la página, pero sale el prompt, la memoria y los hechos de la marca, y
    las rutas de adjuntos del servidor.
  - (B) No: se excluyen con `:(exclude)` en `git archive` y en el árbol del MCP.
  - **Recomiendo B.** Quien descarga o lee por MCP quiere la página, y la memoria de la marca no es parte de ella.
- **P2. ¿El MCP es solo lectura (A) o también abre turnos (B)?** **Recomiendo A**, como Stitch. Escribir por MCP
  necesita identidad (H3) y gasta créditos.

Lo que depende de G1 y H3 no se pregunta aquí: dónde vive el MCP en la distro y con qué auth para usuarios externos.
