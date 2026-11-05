# Estándares de desarrollo

Estado: CONSENSO 2026-11-04 (Arq, orq, Secondary, ec, UI, QA) sobre main c2516f39 | Dueño: Orq | Cambios por PR.

Lo que costó en el refactor del runtime (ADR 0014 + Enmienda 1 + ADR 0015, #530 → #642) convertido en reglas, para no
repetirlo en el siguiente módulo. Cada regla cita de dónde sale; una regla sin procedencia no entra. Los extracts
(`~/Desktop/web-transformer-sesiones/re-sistema/`) son el estándar de producto; esto es el estándar de código.

## A. Módulos

- **A1. ≤ 800 líneas por archivo de código propio, sin excepciones.** El ADR 0014 rechazó la opción B porque "la
  regla pierde fuerza en todo el repo si su mayor archivo es la excepción" (0014:255-262; regla 4, :55). Objetivo
  200-400. El código portado de terceros (`templates/arc-scaffold/src/components/arc/**`, que desde el alpha vive en el repo de la distro) queda fuera del alcance:
  no lo escribimos ni lo mantenemos línea a línea.
- **A2. Un dueño por estado persistente.** El que persiste escribe (`updateEntry`); los demás leen por getter
  (`deps.index()`) y nunca capturan la referencia (reglas 3 y 5, 0014:50-57; trampa real en keepStopped, #555).
  Vale también para estado por usuario: un "siempre" de aprobación keyed por tool (`approvals.ts:95`) deja de cumplir
  A2 en cuanto hay identidad; pasa a (dueño, tool).
- **A3. Deps explícitas, Readonly, sin `this`.** Cada colaborador recibe `XDeps` en el constructor; lo que viaja es
  `Readonly<...>` (PR 1 estuvo rojo en `adr-0014-index-owner` hasta que lo fue). Patrón: `HttpRouterDeps`
  (`http-router.ts:22-40`).
- **A4. Grafo sin ciclos de valor.** Entre colaboradores solo `import type`; una hoja no importa a nadie del grupo
  (`run-checks.ts`, `run-input.ts`; regla 2, 0014:33-48).
- **A5. Enlace tardío en callbacks de cierre:** `(...a) => this.end(...a)`, nunca `close: this.close` ni
  desestructurar (6.9, 0014:49; guarda `tests/adr-0014-late-binding.test.ts`).
- **A6. Estado antes que evento.** Lo que persiste se escribe antes de emitir el evento que lo anuncia (`endedAt`
  antes de `message.end`, #612); la recuperación confía en el índice solo con marca estricta (`>`, mismo ms, #632;
  0014:251).
- **A7. Toda corrida tiene id de generación** (`runSeq`, #627; 0014:154-174): un settle tardío no pisa al siguiente.
  Cada corte nombra su motivo: `SUPERSEDED` (`run-checks.ts:20`, `run-cycle.ts`) frente al apagado.
- **A8. Nombres por rol, no por historia.** Nada del producto copiado ni de la metáfora vieja (v0 → runtime,
  transport → server/Runtime; ADR 0015). Datos en disco e ids de eventos no se renombran.
- **A9. Un solo escritor de `CanvasDoc` en el builder.** Hoy hay dos `PUT` del mismo doc con `rev`
  (`use-canvas-nodes.ts:99`, `use-favorites.ts:108`) y un reintento como parche (`use-favorites.ts:32-33`, H14/Q3).
  Un módulo con cola por rev; nodes y favorites le mandan parches. Guarda: `putCanvas` solo ahí.
- **A10. La lógica del builder va en fábricas puras `createX(deps)`** que se prueban sin React; el hook solo las
  envuelve (`use-favorites.ts:34` `createFavoriteSync` + `tests/builder-favorites.test.ts`). Es A3 en el front.
- **A11. Un cambio de scaffold o puente se entrega por el plugin del runtime, no por la copia del ws.**
  `prepareWorkspace` sale si el ws ya es repo y un chat viejo nunca lo recibía (#641, `wt-bridges-plugin.ts:1-9`).
  Un ws viejo sigue funcionando: sus `install*` quedan no-op (:7-8) y el builder tolera un puente mudo
  (`artboard-canvas.tsx:314-315`, #621). `BRIDGE_INSTALLS` solo crece: nunca quitar ni renombrar una export.
- **A12. `postMessage` siempre con `targetOrigin` explícito, nunca `'*'`.** Sin origen del builder el puente queda
  inerte (`wt-error-bridge.ts:104-105`; `artboard-canvas.tsx:413,422,432`) y el preview manda `frame-ancestors`
  (`preview-serve.ts:121-125,168`).

## B. Cambios

- **B1. Mecánico y arreglo en PRs distintos** (regla 1, 0014:30). Un PR mecánico lleva: diff de cuerpos = 0, grep de
  nombres viejos = 0 con lista de excepciones, lista de tests obligatoria antes y después (condición 6,
  0014:203-217), tsc antes y después.
- **B2. Renombres por script con dry-run y `git mv`** (R100 detectado), repo congelado, suite completa de QA sobre la
  rama antes del merge (#642).
- **B3. Cada regla estructural tiene una guarda ejecutable** (`adr-0014-index-owner`, `adr-0014-late-binding`,
  `transport-write-guard`). Una regla sin test se rompe con el siguiente refactor. A1 y A4 entran como
  `test.failing` con los infractores de C nombrados y pasan a `test` al cerrarse (QA). Un test de comportamiento
  (`builder-favorites`) no sustituye a la guarda del dueño.
- **B4. Cada hallazgo de QA nace como `test.failing`** con el número del PR y pasa a `test` al cerrarse (#632, #635).
  Junto a cada `test.failing` va un test de lista exacta de infractores: un failing solo, mientras está rojo, no ve a
  un infractor nuevo (`tests/estandares-*.test.ts`, QA).
- **B5. `HACK:` con tope y disparador.** Ledger: `grep -rnE '(#|//) ?HACK:' src apps/builder/src scripts tools tests`
  (31 en c2516f39, QA; sin templates ni fixtures). Un HACK sin
  disparador es deuda muda (`page-sensors.ts:229,448,473,526`, `step-labels.ts:1`); uno cuyo disparador ya se
  cumplió se quita (`artboard-canvas.tsx:38-39` LEGACY_H tras #641, pendiente de verificar con un chat pre-#641 vivo).
- **B6. Los defaults salen del extract, no se inventan.** WT_TZ se resolvió con `user_timezone` por request
  (`re-sistema/lovable/datos/prompt-pipeline.md:156`, #598); C7 `data-alt` salió por no tener extract (#614). Si el
  referente pregunta, nosotros preguntamos.
- **B7. Comentarios = por qué, con la cita** (hallazgo, PR o extract archivo:línea).
- **B8. Spec antes de cablear si cruza módulo** (`publish-check-local.md`, `export-zip-mcp.md`): códigos HTTP, cuerpos
  y quién decide qué, antes del primer handler. El cliente puede adelantarse con copy honesto (501/404, #635).
- **B9. Las citas se re-anclan.** Una spec en `docs/` cita líneas vigentes de main; el PR que renombra o mueve
  re-ancla las citas de `docs/` en el mismo PR. Los extracts quedan anclados a su commit (`h1-publish-diseno.md`
  "anclado a a207b97") y la spec que los usa añade la ubicación actual. Los briefs de `docs/research/` no se versionan (`.gitignore:13`): una decisión tomada sobre un brief se
  registra en un documento versionado (`docs/notas/` o el ADR). Deuda cerrada: 12 citas `transport.ts:` en
  `docs/spec/contexto-agente.md` y `docs/spec/plan-mode.md` (Arq, re-ancladas por contenido).
- **B10. Cuarentena, nunca borrado.** Un flaky va a `test.skip` con `// HACK: cuarentena — <causa>. Reactivar con
  <condición>` (`tests/preview-robustez.test.ts:55-56`, `tests/workspace-tools-signal.test.ts:20-21`).
- **B11. Sin esperas ni aserciones de reloj real:** timers falsos o espera determinista; las dos cuarentenas
  actuales son de reloj. La suite completa corre en CI (`.github/workflows/ci.yml:45`); en local se filtra, salvo B2.

## P. Publish e identidad

- **P1. Publish sube estáticos; el build de publish es nuestro, nunca de Vercel.** El artefacto publicado es un
  `vite build --mode publish` (sin puentes, P3) construido desde el commit de la versión en nuestro lado (#651;
  409 `not-at-commit` si HEAD ≠ commit o árbol sucio, el mismo code que el export: #694/#698); nunca un build en el destino (`h1-publish-diseno.md:24`). Modelo
  Stitch/Netlify, no Lovable/v0. El dist de versión del preview (`saveDist`) no es el que se publica.
- **P2. Identidad antes de exponer; token solo en el runtime.** La escritura pasa por `guardWrite`; I3/I4 van antes
  de exponer `/runs/:id/publish` en deploy (h1:61; `infra-requests-onbrand.md:86`). Puerta vigente: `http.ts:21`
  `isTrustedRequest` y `http-router.ts:74`, único punto de entrada; token de corrida en `run-cycle.ts:149`. El token
  de Vercel nunca llega al builder (h1:57) ni a la VM del agente (ADR 0016 condición 2): en deploy, el adaptador
  hosted corre en el orquestador y la VM solo entrega el dist validado; en local no cambia nada.
- **P3. El dist publicado no lleva los puentes del preview** (nota B, `wt-bridges-plugin.ts:10-11`): build de publish
  sin el plugin, o `apply: 'serve'` y el build de versión aparte, antes de exponer publish hosted.

## C. Código que hoy no cumple (medido en main 22f13e60, 2026-11-04)

Guardas en verde: A1 (`tests/estandares-a1-lineas.test.ts`), A4 (`tests/estandares-a4-ciclos.test.ts`), 404 antes que
403, "siempre" por dueño, un solo escritor del lienzo y el ledger de HACK (`tests/estandares-*.test.ts`).

| qué | medida | regla | cuándo |
|---|---|---|---|
| `src/brand.ts` | 368 líneas, en cinco módulos y sin el ciclo `brand ↔ identity-ephemeral` | A1, A4 | cerrado (#695, #702) |
| `apps/builder/.../artboard-canvas.tsx` | 732 | A1 | cerrado; quien lo toque no suma |
| `tests/v0-transport.test.ts` | partido por familia de ruta (el mayor queda en 790, `runtime-runs.test.ts`) | A1, A8 | cerrado |
| `canvas-chrome ↔ publish-menu ↔ theme-panel` | ciclo por `Off` | A4 | cerrado (#648) |
| `CanvasDoc` con dos escritores | — | A9, B3 | cerrado (#649, `lib/canvas-writer.ts`) |
| `approvals.ts` `always` por tool | — | A2 | cerrado (#647, `approvals-always.ts`); `lockedRoots` queda por proceso (ADR 0016: un Runtime por VM) |
| `events.ts sink`, `thread-fold cache`, `telemetry` | singletons de módulo | A2 | no aplica: ADR 0016 fija un Runtime por VM |
| `run-cycle.ts` 700, `ds-skill-agent.ts` 699, `use-builder.ts` 696, `run-client.ts` 692 | cerca del tope | A1 | quien los toque no suma: extrae (run-cycle bajó de 741 a 700) |
| `src/orchestrator/gateway-proxy.ts` | 430 líneas, archivo nuevo (#727): verificación, reserva, cola por dueño, lectura del SSE y precios en un solo módulo | A1 (sobre el rango de 200-400) | antes de sumarle la familia `/v4/ai`: sacar la lectura del SSE y la cola de reservas a sus propios módulos |
| `src/orchestrator/chat-index.ts` | 245 | — | dentro del rango; sin acción |
| 34 `HACK:` (30 del ledger más los de #727) | todos con disparador | B5 | cerrado (`docs/notas/hack-ledger-2026-11-04.md`, guarda en verde); la fila 18 (`agent-mcp.ts:409`) se quita en el próximo PR que toque el archivo |
| `runtime-write-guard.test.ts:49`, `step-labels.ts:1` | nombres viejos | A8 | cerrado (#712, #713) |
| Citas a `transport.ts` en ADR 0013 | 12 citas | B9 | cerrado (#709) |

## D. Orden del siguiente módulo (ratificado)

Las fuentes ponen publish antes que headers por valor (`huecos-ingenieria.md:114-133`: H1 #2, H4 #3); el orden aquí
los invierte por seguridad (h1:61: I3/I4 antes de exponer publish; `F3-REPORTE.md:21,43`: runtime.sandbox es la
brecha #1).

1. **(a) I4 headers del builder**: `apps/builder/vercel.json` de Report-Only a enforce, con un test que compare
   `frame-src` con `builderOrigins` de `preview-serve.ts` (ec). Si D6 mueve el preview, cambian juntos.
2. **(b) Identidad H3/I3 + decisión D6**: spec de Arq (middleware en `http-router.ts:74`, token por sesión con alcance
   chat/preview que reemplaza el `x-origin-secret` único, dueño por chat en el índice, "siempre" por (dueño, tool))
   y ADR D6 (CLI en Sandbox vs loop en orquestador por Gateway, 0013:141-147: de eso depende dónde se valida el
   token). Referentes: v0 sesión JWE (ZAP 913), Lovable bearer Firebase (1863). Proveedor: decisión de Karen.
3. **(c) Export del paquete (H9)**: zip del build `--mode publish` desde el commit (P1, P3) + MCP de lectura (P2),
   `docs/spec/export-zip-mcp.md`. El publish a servicios externos es de la distro, fuera de este programa
   (`docs/notas/decisiones-publish-2026-11-04.md` §Alcance del core).

En paralelo, sin bloquear: builder (4) con sus refactors de C primero.

**Estado (2026-11-04):** las tres partes están cerradas.
- (a) Enforce en `apps/builder/vercel.json:17`, con `tests/builder-csp.test.ts`.
- (b) Identidad, fases 0-4 (`identidad-sesion.md` §10), marcas por dueño (#706) y ADR 0016.
- (c) Export P1/P3 (#688, #698).

Lo que queda:
- Fase 5 de identidad: el adaptador del perfil de la distro. Es de Karen.
- `docs/spec/deploy-sandbox.md` §5: decisiones de Karen.
- §6, paso 4: Sandbox por chat desde el snapshot base, que necesita `@vercel/sandbox` (dependencia nueva) y deploy.

Ya están en main como módulos puros, sin cablear a rutas ni a la VM:
- Paso 1: el índice global (`src/orchestrator/chat-index.ts`).
- Paso 2: la identidad firmada y el sessionProvider `signed` (#724, #725).
- Paso 3: el proxy de Gateway (#727).

La lista para Karen está en `docs/notas/decisiones-pendientes-2026-11-04.md`.
