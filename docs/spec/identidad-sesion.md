# H3/I3: identidad y sesión con alcance (puerto en el core, proveedor en el perfil)

Estado: DECIDIDA [KAREN:chat 2026-11-04 "el resto, ocupate"; delegada a Orq] (Arq, 2026-11-04, main 782d021b). Implementación: orq fases 1-2, Secondary fases 3-4, perfil de la distro fase 5 con OK de Karen; cada fase con security-reviewer. §6: opción c (dueño implícito `local`; en la distro se migra con (a) cuando exista el adaptador, pidiendo OK por tocar el índice).
Base: `docs/estandares.md` (A2, A3, B3, B8), `docs/adr/0016-donde-corre-el-loop.md` (D6), decisión G1 de
`docs/notas/decisiones-publish-2026-11-04.md:7` (Karen, chat: "eso va en el distro").
Extracts: `re-sistema/onbrand/huecos-ingenieria.md:48` (H3), `infra-requests-onbrand.md:70,86` (I3), anclados a
transport.ts. Esta spec da la ubicación vigente (B9).

## 1. Problema

- La única barrera en deploy es un secreto compartido. El rewrite del builder pone `x-origin-secret`
  (`docs/notas/deploy-builder.md:17`) y el runtime lo compara con el Origin (`isTrustedRequest`,
  `src/runtime/http.ts:21-49`). Quien pasa el rewrite usa la API entera: lista y lee chats, gasta turnos y aprueba.
- Ningún chat tiene dueño. `MessageEntry` (`src/runtime/shared.ts:260-300`) no tiene campo de dueño, y `GET /chats/:id`
  (`http-router.ts:111`) responde a cualquiera que conozca el id.
- El "siempre" es del proceso. Es un `Set<string>` por tool (`approvals.ts:95`) que se persiste en
  `<root>/approvals.json` (`server.ts:154`), así que lo que aprueba una persona vale para todas. El referente lo hace
  por cuenta ("Images generated from any chat", Lovable `registry-CmMIU-Jy :4855-4859`, citado en `approvals.ts:92-94`).
- El token por corrida (`agent-mcp.ts:77-86`, header `x-wt-approval-token` en `:101,118`) protege los callbacks del
  CLI. No es una sesión.

## 2. Qué decide esta spec y qué no

| decide | no decide |
|---|---|
| El puerto `SessionVerifier` y su contrato | El proveedor (Clerk u otro). Es del perfil de la distro (G1) |
| El adaptador local del core | Créditos y planes (dependen de esto, otra spec) |
| Dónde se cablea (`src/config.ts`) y dónde se aplica (`http-router.ts:74`) | Qué pasa con los chats sin dueño (§6: opciones, decide Karen) |
| Dueño por chat, "siempre" por (dueño, tool), códigos y cuerpos | |

## 3. El puerto

```ts
// src/runtime/session.ts (nuevo, solo tipos y el adaptador local)
export interface Session {
  readonly owner: string;                 // id estable del proveedor; 'local' en el core
  readonly scopes: ReadonlySet<Scope>;    // 'chat:read' | 'chat:write' | 'spend' | 'brand:write'
  readonly chats?: ReadonlySet<string>;   // alcance opcional a chats concretos (token de preview, enlaces)
}
export type Rejection = { status: 401 | 403; code: 'no-session' | 'expired' | 'scope'; message: string };
export interface SessionVerifier {
  verify(headers: Readonly<IncomingMessage['headers']>): Promise<Session | Rejection>;
}
```

- El verifier del perfil nunca emite `owner` `'local'` ni vacío: el runtime los rechaza con 401 (`providerVerifier`,
  `session.ts`), porque compartirían marcas, "siempre" y chats con la sesión de loopback del core.
- Es puro respecto del runtime: recibe headers y no toca el índice. El dueño de cada chat lo resuelve el router (§5),
  porque es el único que conoce el índice por getter (A2).
- `Readonly` y sin `this` capturado, igual que las deps de ADR 0014 (A3).

**Adaptador local (core):** `localVerifier` devuelve `{ owner: 'local', scopes: todos }` solo si `isTrustedRequest`
pasa sin secreto, es decir por loopback (`http.ts:37-49`). Con `trust.secret` configurado y sin un verifier del perfil,
el arranque falla (`scripts/serve.ts:140`, el mismo patrón que hoy exige `WT_ORIGIN_SECRET` fuera de loopback). Un
deploy sin identidad no arranca: no queda abierto en silencio.

**Cableado:** `Config` gana `sessionProvider: 'local' | <id del perfil>` con el mismo patrón que
`transcribeProvider`/`publishProvider` (`src/config.ts:22-27,62-73`). Por defecto, `core` es `local`; la distro es `local`
hasta que su adaptador esté cableado, la misma regla que el 501 de G1 ("nada de 501 silencioso"). `serve.ts` construye
el verifier y lo pasa como `opts.session` a `Runtime`.

## 4. Dónde se aplica

Un solo punto: `HttpRouter.handle`, después de `isTrustedRequest` (`http-router.ts:74`) y antes de `guardWrite` y de
cualquier ruta.

1. Las rutas de callback del CLI (`approval-requests`, `connector-mcp`, `mcp/:id`, `http-router.ts:73`) siguen
   exigiendo el token de corrida y **no** pasan por el verifier. Ese token ya ata la llamada a un `messageId`
   (`agent-mcp.ts:84`).
2. `GET /models` y `GET /image-models` (`:76-77`) pasan sin sesión: no exponen datos de nadie.
3. Todo lo demás: `verify(headers)`. Si devuelve un rechazo, se responde §7 y no se lee el body.
4. La sesión viaja a los handlers como argumento explícito (A3), no como estado del router.

El secreto de origen **no** se quita: sigue siendo la barrera entre la web y el runtime, y la identidad va encima
(`re-sistema/onbrand/next/arq-spec.md`, "Restricciones": quitarlo expone el runtime a quien adivine su URL). Lo que
sí reemplaza el token de sesión es su papel de **única** credencial: una request con secreto válido y sin sesión ya no
entra.

## 5. Dueño por chat (A2)

- **Campo:** `MessageEntry.owner?: string`. Solo se escribe en el primer mensaje de un ws, en `RunCycle` donde hoy se
  crea la entrada (`run-cycle.ts:340`, `updateEntry(messageId, { ws, ... })`), con `session.owner`. Los mensajes
  siguientes lo heredan del padre en el mismo `updateEntry`. Nadie más lo escribe: un solo dueño del estado, que es
  `updateEntry` (A2).
- **Lectura:** `ownerOf(ws)` en `RunReads`, por getter `deps.index()`, sin guardar la referencia (A2, trampa #555).
- **Chequeo:** toda ruta con chatId, messageId o ws resuelve el dueño **antes** del handler: `/chats/:id/*`,
  `/runs/:id/*`, `/variants/:id/cancel`, `uploads` ligados a un chat y `preview/heartbeat`. Si
  `owner !== session.owner` → **404**, no 403, para no confirmar que el chat existe (arq-spec 3b). Si la sesión trae
  `chats` y el id no está → 404.
- **Orden:** ownership antes que scope. El 404 de un chat ajeno sale antes que cualquier 403 de scope, así un chat
  ajeno no se delata con un 403.
- **Export (H9):** `GET /runs/:id/export` (`http-router.ts:135`) y las tools del MCP de solo lectura
  (`docs/spec/export-zip-mcp.md`) piden `chat:read`, sin scope propio: entregan lo mismo que ya lee `GET /runs/:id/files`,
  sin gasto y sin efecto fuera del runtime. Publicar a servicios externos es de la distro y define su scope ahí.
- **Listados:** filtran por dueño. Nada lista chats ajenos.
- **Marcas** (`/brands/*`): escribir exige `brand:write`; leer queda abierto a cualquier sesión. Lo que es de cada dueño
  es el estado que la persona escribe sobre una marca, no el pack: ver §8b.

## 6. Chats existentes sin dueño (opciones; decide Karen)

| opción | qué pasa | costo |
|---|---|---|
| a. Asignar a un dueño fijo | Un script de migración pone `owner` = el id de Karen en el perfil de la distro a todas las entradas sin dueño, con un backup del índice antes | S. Toca el índice: migración, pide OK |
| b. Solo lectura para `admin` | Sin `owner` → visibles solo con el scope `admin`, sin escritura. Se reclaman a mano | S, sin migración. Necesita un scope más |
| c. Dueño implícito `local` | Sin `owner` = `'local'`. En el core se comportan como hoy; en la distro no los ve nadie hasta migrarlos | XS. En la distro "desaparecen" hasta (a) |

El core no necesita ninguna: con `localVerifier` todo es `'local'`, igual que (c).

## 7. Códigos y cuerpos

Mismo formato de error que hoy (`HttpError` → `{ error }` en `http.ts`), con `code` para que el builder no parsee
texto:

| caso | status | cuerpo |
|---|---|---|
| Sin credencial de sesión | 401 | `{ "error": "inicia sesión", "code": "no-session" }` + `WWW-Authenticate: Bearer` |
| Credencial vencida o inválida | 401 | `{ "error": "la sesión venció", "code": "expired" }` |
| Sesión válida sin el scope de la ruta (p. ej. `spend` en `POST /runs` con imágenes) | 403 | `{ "error": "tu cuenta no puede <acción>", "code": "scope" }` |
| Chat de otro dueño o fuera de `chats` | 404 | `{ "error": "no existe el chat <id>" }`, el mismo cuerpo que un id inexistente |
| Secreto de origen inválido (sin cambio) | 403 | `{ "error": "origen no permitido" }` (`http-router.ts:74`) |
| Token de corrida inválido (sin cambio) | 403 | `{ "error": "token de aprobación inválido" }` (`agent-mcp.ts:103`) |

Cliente (`apps/builder/src/lib/run-client.ts`): un 401 lleva al login del perfil; en el core no ocurre. Un 404 de
ownership se ve igual que un chat borrado.

## 8. "Siempre" por (dueño, tool)

- `Approvals.always` pasa de `Set<tool>` a un store con dueño inyectado (`AlwaysStore`, `XDeps` en el constructor,
  A3): `has(owner, tool)`, `add(owner, tool)`, `revoke(owner, tool)`, `list(owner)`.
- En disco: `approvals.json` pasa de `{ tools: [] }` a `{ owners: { [owner]: string[] } }`. Al leer el formato viejo,
  sus tools van a `'local'`. Sigue fallando cerrado ante un archivo ilegible (`approvals.ts:100-106`) y se sigue
  escribiendo con temp + rename (`:123-129`).
- `GET/DELETE /approvals/always` (`http-router.ts:101-102`) responden solo lo de `session.owner`.
- `ask(...)` recibe el dueño de la corrida. Lo saca de `MessageEntry.owner` al abrir la corrida
  (`agent-mcp.ts:84`), no de la request, porque el CLI llama sin sesión.

Este cambio es el **refactor previo** de la propuesta de consenso: primero mecánico (store con dueño fijo `'local'`, sin
cambio de comportamiento, B1), después el comportamiento.

## 8b. Estado de marca por (dueño, marca)

Qué es de quién (enmienda 2026-11-04, Orq; A2 de `docs/estandares.md` §C: estado sin dueño de usuario):

- **El pack es del catálogo.** Los ids y resúmenes de `GET /brands` salen del registry o de `brandsRoot`, los ven todas las
  sesiones y no se escriben por la API. Hoy ninguna marca tiene dueño persona, así que no hay marca "ajena" que dé 404;
  si algún día una persona sube packs propios, seguirán la regla de los chats (§5: ajena = inexistente, 404 antes del 403).
- **Lo que escribe la persona sí tiene dueño:** las instrucciones (`GET|PUT /brands/:id/instructions`) y la memoria
  (`GET|PUT /brands/:id/memory`, y lo que el agente guarda con `remember`). `BrandStore` las lleva por `(dueño, marca)`:
  `instructions(owner, id)`, `memory(owner, id)`, `writeInstructions`, `writeMemory`, `withMemory` (la cadena que serializa
  PUT y `remember` va por la misma llave). El router pasa `session.owner`; escribir sigue pidiendo `brand:write`.
- **La corrida lee la del dueño del chat, no la de la sesión.** `applyPageBrand` y el `remember` del agente toman
  `MessageEntry.owner` (`?? 'local'`), porque el CLI llama sin sesión y porque quien pide un turno sobre un chat es su dueño
  (§5). Un dueño nunca ve ni cambia la memoria de otro.
- **En disco:** el dueño implícito `'local'` conserva `brand-instructions/<id>.json` y `brand-memory/<id>.md`: lo que ya
  existía sin dueño es de `'local'` sin migrar nada (opción c de §6). Otro dueño va a `by-owner/<sha256(owner) en base64url>/` dentro
  de cada carpeta; el id del proveedor no llega crudo a una ruta.

## 9. Preview con alcance

El listener rutea por `Host` `<ws>.<host>` (`preview-serve.ts:2-7`) y no tiene sesión. Quien conoce el ws ve la página.

- Token de preview: `{ ws, owner, exp }` firmado por el runtime con HMAC (`src/runtime/preview-token.ts`). El secreto es
  `WT_PREVIEW_SECRET`, explícito y de al menos 32 bytes (`MIN_SECRET_BYTES`); no se deriva de `WT_ORIGIN_SECRET`, así
  rotar uno no invalida el otro (`docs/notas/deploy-builder.md` §Gate del preview).
- **No hay ruta propia para pedirlo** (enmienda 2026-11-04, Orq). Lo entrega el latido `POST /preview/heartbeat`
  (`http-router.ts:148`, `preview-dist.ts:146`), que ya pasa por la sesión (§4):
  - Por cada ws del dueño de la sesión, `states[ws]` trae `{ status, version, url, previewToken }`. La `url` es la
    estable, sin token. El `exp` es el siguiente límite de hora más 1 h (vida de 1 a 2 h): latidos seguidos devuelven el
    mismo token, y uno emitido a las 10:59 no da una cookie de 1 min.
  - Un ws ajeno o inexistente sale como `{ status: 'absent', version: null, url }`, con su url estable y sin token, igual
    en los dos casos (`http-router.ts` `heartbeat`, `preview-dist.ts:180-182`). La url se deriva del propio id, así que
    no confirma nada, y el builder recibe una entrada por cada ws que pidió. Es el mismo criterio que el 404 de §5.
  - Sin `WT_PREVIEW_SECRET` (gate apagado, local), `previewToken` no se manda.
- El builder agrega `?wt_preview=<previewToken>` en **cada montaje o remonte** del iframe de ese ws, no solo en la
  primera carga: la cookie vence aunque la url no cambie, y una recarga interna (vite full-reload, hmr-recover, meta
  refresh) daría un 401 que no se ve. Si el marco queda mudo después de `load`, el builder lo remonta con el token
  vigente. El listener lo
  canjea por la cookie `wt_preview` del origen del ws con un 307 a la misma ruta sin el token, así el token no queda en
  la barra, el historial ni el Referer. Es el patrón del `vm/open` 307 de v0 con su JWE `__v0_s` (`v0:jwe-serverside`,
  ZAP 913; el cliente nunca lo descifra, `re-sistema/v0/INDICE-EXTRACTS.md:101`).
- Sin token, o con el token de otro ws → 401. Vencido → 401. El upgrade de HMR exige la misma cookie.
- Dónde se valida depende de D6: con el loop en el Sandbox (ADR 0016), el preview vive en `sandbox.domain(port)` y lo
  valida el runtime del Sandbox con el mismo secreto HMAC, que le pasa el orquestador al crearlo.
- Bajo el orquestador el secreto HMAC no puede entrar en la VM: el token pasa a firmarse con Ed25519 (el orquestador firma,
  la VM solo verifica con la pública). El modo, las llaves y el guard del arranque están en `docs/spec/deploy-sandbox.md` §4.

## 10. Fases (cada una con su PR, menos de 5 archivos y security-reviewer)

| fase | qué | test (B3: una guarda por regla) | estado |
|---|---|---|---|
| 0 | Mecánico: `AlwaysStore` con dueño `'local'` fijo (§8), diff de comportamiento = 0 | La suite de approvals igual antes y después | cerrada (#647) |
| 1 | `session.ts` + `localVerifier` + `opts.session` + el punto de §4 | `tests/session-gate.test.ts`: sin sesión → 401 con `trust.secret`; loopback → `'local'`; callbacks con token pasan; `/models` pasa | cerrada (#660, #663) |
| 2 | `MessageEntry.owner` + ownership de §5 | Otro dueño → 404 en cada familia de ruta; guarda estática: ninguna ruta con `:id` se registra sin `ownerOf` | cerrada (#676, #682, #662, #687, #693) |
| 3 | "Siempre" por dueño (§8) | El "siempre" de A no autoaprueba a B; el formato viejo migra a `'local'` | cerrada (#664) |
| 4 | Token de preview (§9) | Sin token, con el de otro ws o vencido → 401; HMR con la cookie pasa | cerrada (#667, #671, #680) |
| 5 | Adaptador del perfil de la distro | Fuera del core: contrato `SessionVerifier` contra el SDK del proveedor (dependencia nueva, OK de Karen) | abierta |

Abiertos: fase 5 (el proveedor en el perfil de la distro; la dependencia nueva la decide Karen). §6 decidida:
opción c (Orq por delegación).

## 11. QA con ZAP (solo contra nuestro preview y nuestro runtime)

Alcance: el runtime local o el deploy de prueba del perfil de la distro, nunca hosts de terceros. ZAP en modo proxy, con el
mismo contexto del audit de infra (`re-sistema/infra/inventario.md:3`).

1. Repetir cada request del historial sin el header de sesión → todas 401, salvo `/models`, `/image-models` y los
   callbacks.
2. Dos usuarios A y B: repetir las requests de A con la sesión de B → 404 en todas las rutas con id. Ninguna 200.
3. Callbacks con la sesión de A y sin token de corrida: `approval-requests` y `connector-mcp` → 403; `mcp/:id` → 401
   (contrato de `tests/v0-approvals.test.ts:256`). La sesión no abre ninguno de los tres.
4. Preview: abrir `<ws de A>` sin cookie y con un token vencido → 401. B no obtiene cookie para `<ws de A>`: con HMAC el
   latido de B lo da `absent` y sin token (el gate autoriza al acuñar); con Ed25519 un token firmado para B → 401 (`ownsWs`).
   Abrir el WS de HMR sin cookie → rechazado.
5. "Siempre": A aprueba "siempre"; un turno de B con la misma tool → aparece la tarjeta.
6. Barrido pasivo de ZAP: ningún token de sesión en la URL después del canje (§9) ni en los logs.

## Anexo informativo (sin decisión): cómo lo resuelven los referentes y qué costaría como adaptador

| referente | mecanismo (extract) | adaptador en el perfil |
|---|---|---|
| v0 | Sesión con `/api/auth/validate` y `/refresh` (ZAP 2817, 1352), OAuth de Vercel/Google; JWE `__v0_s` para el preview (ZAP 913) | Propio: login + JWE. M-L, sin dependencia |
| Lovable | Bearer de Firebase en cada request y en el subprotocolo del WS (ZAP 1863, `infra/inventario.md:18`) | SDK de Firebase Auth. M, dependencia nueva |
| La distro de la casa | Clerk con scopes por área en sus MCP | SDK de Clerk. S-M, dependencia nueva, ya operado por el equipo |

Cualquiera de los tres entra por el mismo `SessionVerifier`: el core no cambia.
