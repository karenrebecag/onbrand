# Publish hosted: la variante de distro publica el dist a Vercel

> **Alcance: distro `atom`, no el core.** Karen (chat 2026-11-04): la publicación a servicios externos va en la
> distro; el core solo entrega el paquete (H9). Esta spec queda aparcada y se retoma desde el perfil `atom`; las
> correcciones de Arq (orquestador en vez de VM para el token, build desde el commit, 202 + stream, recover y
> generación por publish, scope de identidad, citas) se aplican al retomarla. Ver
> `docs/notas/decisiones-publish-2026-11-04.md` §Alcance del core.

Estado: PROPUESTA (Secondary, 2026-11-04). B8 (spec antes de cablear), estándar P1/P2.
Base: `h1-publish-diseno.md` (re-sistema/onbrand), `docs/spec/publish-check-local.md`, ADR 0014 + Enmienda 1.
Brief de frontera: `docs/research/publish-path-agnostico.md §Decisiones` (ratificado por delegación de Karen vía Orq,
2026-11-04). Esta spec no crea el adaptador vercel ni escribe a Vercel: fija el contrato para implementarlo.
Decisiones ya tomadas (ver §7): G1 el adaptador hosted vive **en este repo, gated por el perfil `atom`** (la distro es
un perfil, no un repo aparte); 501 resuelto — `atom` vuelve a `publishProvider: 'local'` hasta que exista el adaptador
vercel (sin 501 silencioso). Queda abierto solo el destino DNS y la retención.

## 1. Qué ya existe (no se rehace — P1)

- `checkPublishable(dir)` y el seam `PublishProvider` en `src/runtime/publish.ts`. El core solo trae `localPublish`
  (copia el dist a una carpeta, `file://`). El hosted es **otro adaptador detrás del mismo seam**.
- `GET /runs/:id/publishable` y `POST /runs/:id/publish` ya viven en `run-reads.ts:217,228`. El POST pasa por el
  mismo gate (`publishable` → 409 `not-publishable` si `ok:false`) y entrega el dist al provider configurado; sin
  provider, 501 (`run-reads.ts:230`, `shared.ts:151`).
- El dist ya está construido por versión (`servableDist`), así que **el publish no corre build** (P1). Es el caso
  Stitch→Netlify, no v0/Lovable (h1:24).

Esta spec añade solo el **adaptador hosted** detrás de `PublishProvider.publish(dir, {chat, commit, externalOrigins})`.
No cambia la firma del seam ni las rutas: `transport.ts`/`server.ts` no se tocan (publish-check-local.md:36).

## 2. Frontera core / distro (puerto agnóstico)

- **Core** (`src/runtime/publish.ts`): el puerto `PublishProvider`, el gate puro `checkPublishable` y `localPublish`.
  Sin red, sin cuenta, sin Vercel. Nada de esto cambia.
- **Distro (ATOM)**: un módulo nuevo `vercelPublish(opts): PublishProvider` **en este mismo repo, gated por el perfil
  `atom`** (G1: la distro es un perfil, no un repo aparte). Es el único punto que conoce la API de Vercel, el token y
  el team `atomchatio`. El core nunca importa Vercel; `scripts/serve.ts` solo lo cablea cuando
  `config().publishProvider === 'vercel'`. Mientras no exista, `atom` resuelve a `'local'` (config.ts), no a 501.
- Contrato que el adaptador debe cumplir del puerto: recibe un `dir` ya validado (el handler corrió el gate antes),
  devuelve `PublishResult { url, files, bytes }`. `externalOrigins` llega para armar la CSP del destino (no bloquea).

## 3. API de Vercel — verificada contra la doc oficial (last_updated 2026-11-05)

h1:50 dejó estos endpoints "por confirmar". Confirmados:

| paso | método y ruta | cuerpo / headers | notas |
|---|---|---|---|
| subir archivo por digest | `POST /v2/files` | body = bytes crudos, `Content-Type: application/octet-stream`; headers `x-vercel-digest` (SHA1, ≤40) y `Content-Length` (o `x-now-size`) | 200 con body vacío/`{urls}`. **Dedup real**: un archivo ya presente por SHA responde 200 sin re-subir, así que solo se suben los que faltan. 400 si el digest o el tamaño no cuadran |
| crear deployment | `POST /v13/deployments` | `name`, `project`, `target:"production"`, `files[]`, `projectSettings.framework:null` | cada `files[]` es inline `{file,data,encoding}` **o** referencia `{file,sha,size}` (el schema exige `file`; la referencia añade `sha`+`size`). `files` **no** se combina con `gitSource`. Query `skipAutoDetectionConfirmation=1` para evitar el 400 de confirmación de framework |
| asignar alias | `POST /v2/deployments/{id}/aliases` | `{alias}` (+ `redirect` opcional) | **exige deployment READY** (400 `not READY` si no). Reasignar mueve el alias y devuelve `oldDeploymentId` = republicar. 403 si no existe un `.vercel.app` que espejar |
| despublicar | `DELETE /v2/aliases/{aliasId}` | — | 200 `{status:"SUCCESS"}`. Es el unpublish |

Todas con `Authorization: Bearer <token>` y `?teamId=atomchatio` (o `slug`).

**Consecuencia para la secuencia (importa para A6):** un deployment estático **no está READY al instante**; pasa por
`QUEUED→INITIALIZING→BUILDING→READY|ERROR` aunque no haya build de usuario (~1 s de Stitch = no corre build propio,
no = READY inmediato). El alias **no se puede asignar hasta READY**. Por tanto el publish hosted es asíncrono:
no puede ser el `publish` síncrono que asume el export local.

## 4. Contrato de `POST /runs/:id/publish` (hosted)

Códigos, reutilizando los que el gate ya define (publish-check-local.md §3):

| caso | respuesta |
|---|---|
| sin provider (perfil core) | 501 `publish no está habilitado` (ya existe, `run-reads.ts:230`) |
| mensaje inexistente | 404 |
| mensaje sin versión | 409 `todavía no tiene versión` |
| versión sin dist servible | 409 `{code:'no-build'}` |
| el dist no pasa el gate | 409 `{code:'not-publishable', errors[], externalOrigins}` |
| publicado | 200 `{url, files, bytes, externalOrigins, deploymentId, alias, publishedCommit}` |
| Vercel falla (token, cuota, READY→ERROR) | 502 `{code:'provider-error', detail}` — el detalle nunca incluye el token |

El cuerpo 200 del hosted amplía el del local con `deploymentId`, `alias`, `publishedCommit`.

### Eventos y estado (A2 / A6)

- `publish.started` y `publish.done` (y `publish.error`) van **al log del mensaje**, por el mismo stream NDJSON
  `GET /runs/:id/events` (h1:55). No hace falta canal nuevo. El builder los recibe por el stream que ya consume.
- **A6 (estado antes que evento):** `publishedCommit`, `deploymentId` y `alias` se escriben en la entrada del índice
  **antes** de emitir `publish.done`. La recuperación confía en el índice, no en el evento.
- **A2 (un dueño del estado persistente):** el handler escribe por `deps.updateEntry(id, {publishedCommit, deploymentId,
  alias})`, nunca mutando la entrada; el guardado a disco queda en `Transport`/estado del ciclo (ADR 0014 regla 3 y 5).
  El adaptador de Vercel **no toca el índice**: devuelve el `PublishResult` + ids y el handler persiste. Así el provider
  sigue siendo reemplazable y sin estado.
- Como el deployment es asíncrono (§3), `publish.started` se emite al crear el deployment y `publish.done` tras
  READY + alias asignado. Entre ambos, el estado del índice es "publicando" (deploymentId sin alias). Un fallo deja
  `publish.error` y no escribe `alias`.

## 5. Seguridad (P2)

- La ruta ya pasa por `guardWrite` como toda escritura. **I3/I4 (identidad) van antes de exponer el publish en deploy**
  (h1:61, estandares.md:106): hoy `/api` en deploy solo lo cubre `x-origin-secret`+Origin, y cualquiera que pase el
  rewrite del builder publicaría con la cuenta del team. En local (loopback) alcanza. → **(b) antes que (c)**.
- El token de Vercel vive **solo en el entorno del transport/distro**, acotado al team; nunca llega al builder (h1:57).
- El gate corre siempre antes de subir nada: el dist es dato del agente (symlinks, orígenes de dev, rutas del
  transport, secretos). El fix de symlink de publish-check-local.md §4 ya está en `publish.ts` (`lstatSync`,
  `cpSync` sin `dereference`); el hosted se apoya en él, no lo duplica.
- `vercel.json` del sitio publicado (incluido como archivo en el upload, no en `projectSettings`): rewrite SPA a
  `/index.html` + headers CSP (`frame-ancestors`), `nosniff`, HSTS. Supera a Make/Netlify, que solo mandan HSTS
  (h1:56). La CSP usa `externalOrigins` del gate.

## 6. HACK pendiente del gate (B5)

publish-check-local.md §5 lo dejó anotado; con el hosted pasa a pesar más (el dist se expone a internet):

```
HACK: los archivos de texto >=2 MiB no se escanean (publish.ts walk, `st.size < 2*1024*1024`), así que un bundle
JS grande puede esconder un secreto que se publica. Disparador: escanear por streaming cuando un dist real pase de
2 MiB en JS, o antes del primer publish hosted a un dominio público.
```

El disparador es "antes del primer hosted público", no "cuando moleste": el hosted es justo el caso que el tope deja
pasar. Va en `publish.ts` junto al `walk`, con su cita.

## 7. Decisiones (G1-G3 / 501) y lo que aún espera de Karen

Tomadas por delegación de Karen (brief §Decisiones, vía Orq 2026-11-04):

- **G1 — frontera:** el adaptador hosted vive en este repo, gated por el perfil `atom`. La distro es un perfil, no un
  repo aparte. El core solo expone el puerto + `localPublish`.
- **G2 — Blob:** el write-path a Blob va detrás de un puerto `atom` (el core solo lee). No es de esta spec (afecta al
  registry, no al publish del sitio), anotado para no cruzarlo.
- **G3 — build-registry se queda** tal cual.
- **501 — resuelto:** `atom` vuelve a `publishProvider: 'local'` hasta que exista el adaptador vercel, así `POST
  /publish` hace export local en vez de 501 silencioso. Hecho en código (config.ts + test), entrega aparte.

Aún abierto (solo esto bloquea la implementación de (c) hosted, junto con (b) identidad):

1. **Dominio:** `*.vercel.app` o un wildcard propio del team (`<slug>-<chat8>`). Costo de DNS. Decide el alias.
2. **Retención** de deployments viejos al republicar (mover alias deja el anterior colgando).

Dos puntos de h1:63-67 que el brief no cierra y conviene confirmar al implementar, no bloqueantes del diseño:
aprobación antes de publicar (cabría en `approvals`, h1:67) y crear el token de Vercel acotado al team (gasto → OK de
Karen, no lo hace un agente). La exposición hosted sigue gateada por identidad (P2 de estándares, (b) antes de (c)).

## 8. Fuera de alcance

- La UI del builder (botón publicar, estado "publicando", enlace) — va aparte, como en publish-check-local.md §5.
- El export a zip/Figma (`export-zip-mcp.md`) es otro destino, no este.
- H9 (lo que sea P1/P2 de H9) espera decisión de Karen; no bloquea ni lo bloquea esta spec.
