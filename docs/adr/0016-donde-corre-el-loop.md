# ADR 0016: en el deploy, el loop del agente corre como CLI dentro del Sandbox de cada chat

Estado: DECIDIDA [KAREN:chat 2026-11-04 "vamos con propuesta de Arq"; recomendación de Arq; cita transmitida por
WebTransformerOrq] | Fecha: 2026-11-04 | Autora: Arq | Cierra D6 de ADR 0013 (`0013-modelo-de-ejecucion.md:141-147`)

## Contexto

ADR 0013 dejó D6 abierta con dos opciones (`re-iteracion/re-ejecucion/adr-borrador.md` §6, :209-212):

- **i.** El CLI dentro del Sandbox, como hoy pero en la VM.
- **ii.** El loop en el orquestador por AI Gateway, con las tools contra el Sandbox (modelo v0, ejemplo oficial
  "function-calling loop with Vercel Sandbox").

Hechos de main 782d021b que pesan:

- El loop de producto es `claude -p` (ADR 0011; `src/runtime/agent-loop.ts:1-5`): un turno = un proceso, cuyo
  stream-json se traduce a eventos. Encima de eso están el traductor (`agent-stream.ts`), el watchdog de tools
  (`tool-watchdog.ts`), el MCP del workspace (`workspace-mcp.ts`, `agent-mcp.ts`), el steer por stdin
  (`agent-loop.ts:69-81`, `run-cycle.ts:395-403`) y el build-resume (`run-cycle.ts:598-616`).
- `claude -p` no corre en Functions (plan del deploy, `adr-borrador.md:207`).
- Hoy no hay sandbox: el CLI corre con el uid del runtime, y Write/Bash sobre su cwd y `.wt` no están aislados. Es la
  brecha de seguridad #1 (`re-sistema/F3-REPORTE.md:21`, riesgo 2 en `:43`).
- En deploy, `/api/*` va a **un** Sandbox fijo para todos los chats (`infra-requests-onbrand.md:85`, I2b).
- Claude Code se puede facturar por AI Gateway sin reescribir nada: `ANTHROPIC_BASE_URL=https://ai-gateway.vercel.sh/claude-code`
  más un token (docs de Vercel, `ai-gateway/coding-agents/claude-code`). El perfil ya tiene la llave
  `composeProvider: 'cli' | 'gateway'` (`src/config.ts:12-13,63,92`).

## Decisión

**i: el CLI dentro del Sandbox, un Sandbox por chat.** El runtime (`Runtime`, `src/runtime/server.ts`) corre dentro de
esa VM con el workspace, el build y el preview. El orquestador en Functions controla: identidad, índice de chats,
creación y reanudación del Sandbox, y el rewrite al dominio del chat.

Condiciones (sin ellas la decisión no vale):

1. **Un Sandbox por chat, no el fijo de I2b.** Con el agente dentro, una VM compartida mezcla los workspaces de varias
   personas en la misma máquina en que el agente ejecuta código.
2. **Sin secretos en la VM.** `agentEnv` ya quita `AI_GATEWAY_*`, `VERCEL_*`, `BLOB_*` y el secreto de origen del
   entorno del CLI (`agent-loop.ts:97`). Para facturar por Gateway, `ANTHROPIC_BASE_URL` apunta a un proxy del
   orquestador, que autentica con el token de corrida (el mismo patrón que `x-wt-approval-token`, `agent-mcp.ts:101`)
   y agrega la llave del Gateway del lado de Functions. La llave nunca entra en la VM.
3. El token de corrida tiene alcance a un `messageId` y vence al cerrar la corrida (`agent-mcp.ts:84-93`, hoy en memoria).

## Por qué i y no ii

| criterio | i. CLI en Sandbox | ii. loop en orquestador |
|---|---|---|
| Código que cambia | El arranque y el proxy. El loop, el stream, el watchdog, el steer y el build-resume quedan igual | Reescribir el loop, el traductor, el steer y la reanudación sobre un workflow durable (`adr-borrador.md:211-212`) |
| Brecha #1 (F3:21) | La cierra: el agente y sus tools quedan en la VM | La cierra igual: las tools van contra la VM |
| Paridad con el referente | Lovable y Make corren el agente junto al sandbox; v0 separa | Igual a v0 |
| Facturación | Gateway vía `ANTHROPIC_BASE_URL` (docs Vercel) | Gateway nativo |
| Riesgo | La VM se cae → se pierde el proceso del CLI (D2) | El orquestador se reinicia por diseño → reanudar es el camino normal |

ii es el diseño más limpio a largo plazo, pero cuesta la reescritura que ADR 0014/0015 acaban de evitar: el núcleo del
runtime no se toca, y lo que cambia queda en los bordes. **Disparador para revisar este ADR:** si el CLI no puede
correr con la memoria o el tiempo de un Sandbox, o si el proxy de la condición 2 no alcanza para controlar el gasto por
persona.

## Consecuencias

### Dónde se valida el token (spec `docs/spec/identidad-sesion.md`)

- **Sesión de usuario:** en el orquestador (Functions), antes del rewrite al Sandbox del chat. El orquestador resuelve
  el dueño del chat y decide a qué Sandbox reenvía. El `SessionVerifier` corre ahí, con el adaptador del perfil de la distro.
- **Runtime en la VM:** recibe del orquestador la identidad ya resuelta, con un header firmado que el runtime comprueba
  con un secreto que el orquestador le dio al crearlo. El punto de `http-router.ts:74` es el mismo; el verifier del
  runtime en la VM es "confío en el orquestador firmado", no el proveedor.
- **Preview:** `sandbox.domain(port)` por chat (`adr-borrador.md:193`). El token de preview (spec §9) lo valida el
  runtime de la VM.
- **Callbacks del CLI:** no cambian. Son loopback dentro de la VM, con el token de corrida.

### Reanudación D2 (ADR 0013:76)

- Si se cae el orquestador, la corrida **no** muere: el CLI sigue en la VM. Reanudar = que el builder se reconecte al
  log de eventos del runtime de la VM. D2-B ("reanudar sola") se vuelve barata.
- Si se cae la VM (timeout o crash), sigue valiendo D2-A: cerrar `stopped` + "continuar", con `persistent` y
  `onResume` para relanzar vite (`adr-borrador.md:194`). El git vive fuera de la VM (D5-a, bundle en Blob).
- El latido del builder (D3) llama a `extendTimeout` del Sandbox, a través del orquestador.

### Singletons de C (`docs/estandares.md` §C)

Con i hay **un `Runtime` por proceso por VM**, como hoy en local. Los singletons de módulo no se mueven:

| singleton | dónde | con i |
|---|---|---|
| `sink` | `events.ts:33` | Uno por VM. Se documenta el dueño (serve.ts lo fija) |
| `cache` del resumen | `thread-fold.ts:20` | Uno por VM. Un chat por VM: el cache no cruza dueños |
| `lockedRoots` | `server.ts:59` | Uno por VM. Bloquea el root de su único `Runtime` |
| `tracer`, `provider`, `roots`, `steps`, `closed` | `telemetry.ts:78-107` | Uno por VM. El exportador OTLP sale con credenciales del orquestador, no de la VM (condición 2) |

Con ii habría que moverlos todos a la instancia, porque una Function de Fluid compute atiende varios chats por
instancia. Esa refactorización deja de ser un prerrequisito: se mueve solo si dos `Runtime` llegan a convivir en un
mismo proceso (`estandares.md` §C, fila de estado mutable).

### Lo que queda para las specs del deploy

- El proxy de Gateway del orquestador (condición 2): tope de gasto por dueño y por corrida.
- Crear el Sandbox desde un `source: snapshot` con deps (`adr-borrador.md:194`) y el índice global de chats en el
  orquestador (log en Blob, D1/D5).
- Reemplazar el rewrite fijo de I2b por un destino por chat.

## Alternativas descartadas

- **ii. Loop en el orquestador por Gateway.** Descartada por ahora por costo (tabla). Queda como revisión con el
  disparador de arriba.
- **Un Sandbox compartido con el CLI dentro.** Mezcla los workspaces de varios dueños en la VM donde el agente ejecuta
  código. Es lo que la condición 1 prohíbe.
- **Seguir con el runtime fuera de un sandbox.** Mantiene la brecha #1 (F3:21).
