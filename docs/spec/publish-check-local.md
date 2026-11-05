# H1 local: comprobar si una versión se puede publicar, sin publicarla

Estado: PROPUESTA (Arq, 2026-11-04). Dueño de código: Secondary, después del PR 1 de la Enmienda 1 de ADR 0014.
Base: `docs/research/publish-path-agnostico.md` (ESCALADO). Esta spec **no toca** las decisiones de Karen
sobre el formato del artefacto (bloque A, zip) ni G1-G3: no crea providers, no escribe a Blob ni a Vercel y no
cambia `PublishProvider`.

## 1. Problema

`checkPublishable(dir)` (`src/runtime/publish.ts`) solo corre dentro de `POST /runs/:id/publish`, y ese endpoint
responde 501 si no hay provider (perfil de la distro hoy, `serve.ts:227`). En ese perfil, la persona no tiene cómo
saber si su versión es publicable. Además, el gate tiene un agujero: no detecta symlinks (§4).

## 2. Endpoint

`GET /runs/:id/publishable`. Solo lectura y sin red. No depende del provider: responde igual en `core` y en la distro.

| caso | respuesta |
|---|---|
| el mensaje no existe | 404, como el resto de `/runs/:id` |
| el mensaje no tiene versión (`versionOf`) | 409 `el mensaje … todavía no tiene versión` |
| la versión no tiene dist servible | 409 `{code:'no-build'}`, el mismo que `publishRun` |
| el dist pasa | 200 `{ok:true, externalOrigins, files, bytes}` |
| el dist no pasa | 200 `{ok:false, errors, externalOrigins, files, bytes}` |

El veredicto es el dato que se pide, así que un dist que no pasa responde **200 con `ok:false`**, no 409. El 409
`not-publishable` sigue siendo solo de `POST /publish`, que sí intentó una acción.

- No se cachea: el dist es por commit, pero el gate es barato (tope de 2000 archivos) y su regla puede cambiar
  entre deploys.
- `errors[]` mantiene la forma `{code, path, detail}` y nunca incluye el valor de un secreto.

Implementación: `RunReads.publishable(id)` reutiliza `versionOf` y `servableDist` (ya existen). `publishRun` pasa
a llamar a `publishable` y lanza el 409 si `ok:false`, así los dos caminos usan el mismo gate. La ruta va en
`http-router.ts`, junto a `/publish`. Archivos: `publish.ts`, `run-reads.ts` y `http-router.ts`, más los tests.
`transport.ts` no se toca, por la condición 3 de la Enmienda 1.

## 3. Qué valida (contrato)

Igual que hoy. Los códigos son estables y la UI los muestra:

| code | cuándo |
|---|---|
| `unreadable` | no se pudo recorrer el dist |
| `bad-path` | symlink, entrada ilegible o ruta con `..` |
| `asset-missing` | no hay `index.html` en la raíz |
| `too-large` | más de 2000 archivos o más de 50 MiB |
| `forbidden-file` | archivo oculto (`.env`, `.git`, `.*`) o sourcemap `.map` |
| `dev-origin` | localhost, 127.0.0.1, `*.localhost`, `/@vite/`, `/@fs/` o `__vite_ping` |
| `transport-route` | referencias a `/runs`, `/approvals`, `/chats` o `/api/` |
| `secret` | patrones `sk-`, `ghp_` o JWT |

`externalOrigins` son los hosts http(s) externos, ordenados. Sirven para la CSP de un destino hosted y no bloquean.

## 4. Bug de seguridad (reproducido; ec lo arregla en un PR aparte)

`walk()` comprueba `isSymbolicLink` sobre `statSync`, que sigue el enlace, así que la comprobación nunca da true.
Al filtro de `cpSync` en `localPublish` le pasa lo mismo.

Repro sobre `origin/main` b70cc248:
- Un dist con `index.html` y `link -> ../outside/` (que contiene `secret.txt`) da `checkPublishable` = `{ok:true}`.
- `localPublish` copia `outside/secret.txt` a la carpeta publicada.

Un agente que escriba un symlink en el dist puede publicar archivos de fuera del workspace.

Fix:
- `walk()` usa `lstatSync` antes de `statSync`. Un symlink da `bad-path` y no se recorre.
- `localPublish` filtra con `lstatSync(src).isSymbolicLink()` y quita `dereference: true`. Así hay defensa también
  si alguien llama al provider sin pasar el gate.

Tests: un symlink a un directorio de fuera da `bad-path` y `ok:false`, y `localPublish` no copia el destino del
enlace. Van el test y el fix en el mismo commit, y lo revisa security-reviewer porque es input no confiable. H1 se
apoya en ese fix; no lo duplica.

## 5. Fuera de alcance (anotado, no se arregla aquí)

- Los archivos de texto de 2 MiB o más no se escanean, así que un bundle JS grande puede esconder un secreto. Hay
  que marcarlo con `HACK:`, con este disparador: escanear por streaming cuando un dist real pase de 2 MiB en JS.
- `externalOrigins` incluye URIs de namespace (`www.w3.org` en SVG). Es ruido para la CSP, no un riesgo.
- `rel.includes('..')` marca nombres como `a..b.js`. Es un falso positivo raro.
- La UI (botón "Comprobar" o la lista de errores) va aparte. Esta spec fija solo el contrato del servidor.

## 6. Tests

- `GET /publishable` da 200 `ok:true` con un dist limpio y 200 `ok:false` con los `errors` de un dist con
  `.map`.
- Da 409 `no-build` sin dist y responde igual sin provider configurado (no da 501).
- Da 409 cuando el mensaje no tiene versión.
- `POST /publish` sigue dando el 409 `not-publishable` con los mismos `errors` que `GET /publishable`.
- El test del symlink (§4) va en el PR de ec.
