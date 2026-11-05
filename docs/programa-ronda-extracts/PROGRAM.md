# Programa: ronda de extracts (2026-11-02)

Objetivo (Karen): llevar a web-transformer todo lo que el RE encontró de generación visible, loading states, animaciones y tooling, en un solo programa spec-driven. Todo el código tiene fundamento:
1. un extract desofuscado (webcrack, wakaru o código publicado sin ofuscar) con archivo:línea;
2. si el extract no es compatible con nuestro código, documentación web oficial citada con URL y sección.
Lo medido en vivo es observación y no fundamenta (RULESET regla 8).

## Rutas
- Worktree común: `/Users/karenrebecaog/Desktop/SoftwareDevProjects/wt-ronda-extracts`, rama `feat/ronda-extracts`, desde main 4abe005.
- Este programa: `docs/programa-ronda-extracts/` (PROGRAM.md, specs/).
- Viabilidad (fuente de los ítems): `~/Desktop/web-transformer-sesiones/re-iteracion/viabilidad/` (CONSOLIDADO.md, ui.md, arq.md, ec.md, secondary.md, qa.md, orq-make.md).
- Extracts: `~/Desktop/web-transformer-sesiones/re-iteracion/` (stitch-ui/deob*, deob/, lovable-details/, figma-make/, transport/lovable/deob/).

## Roles
| Rol | Sesión | Hace | No hace |
|---|---|---|---|
| Orquestador | WebTransformerOrq | Edita PROGRAM y specs. **Único que opera git**: branch, commit, push, PR y merge. Integra, corre el arnés y mide el T1 (gasto local autorizado por Karen). | Implementar specs ajenas |
| Secondary | WebTransformerSecondary | Ataca cada spec (VERIFICADO / FALSO / NO VERIFICADO por afirmación y cita) y verifica cada diff contra su criterio de terminado | Editar docs o código |
| QA | QAWebTransformer | Define y corre los casos del arnés en vivo (:5400/:5298) y cierra cada ítem con evidencia | Editar código de producto |
| Implementadores | Arq, UI, ec, orqWebTransformer | Implementan su spec APROBADA en el worktree común, solo en sus archivos. Ante un hueco se detienen y lo reportan. | Git de cualquier tipo; tocar archivos de otra spec |

## Reglas del implementador
1. Solo se implementa una spec en estado APROBADA. APROBADA la pone solo Karen.
2. Cada cambio cita su fundamento en un comentario WHY, con archivo:línea del extract o la URL de la documentación.
3. Cada uno toca solo los archivos de su spec (tabla de módulos). Si necesitás un archivo de otro, se lo pedís a Orq.
4. Un test por comportamiento de lógica; UI con captura antes/después. Tests solo del área.
5. Al terminar un ítem, mandás a Orq: archivos, mensaje de commit (`type(scope): por qué`) y tests corridos. Orq commitea, Secondary verifica el diff y QA el arnés.
6. Prohibido: git, deps nuevas, configs raíz, abrir servidores extra, gastar créditos sin OK de Karen en tu sesión.

## Estados de spec
BORRADOR → REVISADA (Secondary la atacó y Orq corrigió) → APROBADA (Karen) → HECHA (QA cerró el arnés).

## Tabla de módulos
| Spec | Dueño | Archivos | Depende de | Ola |
|---|---|---|---|---|
| S0 arnés y medición | Orq + QA | `scripts/v0serve.ts` (log del vite del preview), `tests/` del arnés | — | 0 |
| S1 render visible | Arq | `src/v0/agent-prompt.ts` (reglas de App, index.html), `src/v0/section-ops.ts`, `src/ds-skill-agent.ts`, `templates/arc-scaffold/{AGENTS.md,vite.config.ts,src/wt-section.tsx}` | S0 | 1 |
| S2 puente del preview | UI | `templates/arc-scaffold/src/wt-reveal-bridge.ts`, `apps/builder/src/components/builder/artboard-canvas.tsx` (remount y handshake) | S1 | 1 |
| S3 loading states | UI | `apps/builder/src/**` salvo lo de S2 | S2 | 2-3 |
| S4 traza y edición del turno | orqWebTransformer | `src/v0/agent-stream.ts`, `agent-composer.ts` (AgentTrace.context), `events.ts`, `event-model.ts`, `apps/builder/src/lib/run-state.ts` y `run-client.ts` (solo lib); `transport.ts` versions/statsOf en su turno (S4 antes que S5) | — | 2 |
| S5 tooling del agente | ec | `workspace-tools.ts`, `workspace-mcp.ts`, `approvals.ts`, `image-slots.ts`, `agent-composer.ts:220-236`, módulo nuevo del enhancer; `agent-prompt.ts` después de S1; `transport.ts` en su turno; la UI del builder la hace UI (S3) | S1, S4 | 3-4 |
| S6 selección con archivo:línea | Arq (marcador) + UI (chip y cola) | `templates/arc-scaffold/vite.config.ts` (marcador dev), `apps/builder/src/lib/element-context.ts` | S1, S2 | 3 |

`src/v0/transport.ts` es compartido: lo edita una spec a la vez, en el orden que fije Orq.

## Flujo
1. Orq escribe la spec (BORRADOR) → Secondary la ataca → Orq corrige → REVISADA → Karen la APRUEBA.
2. El implementador trabaja en el worktree común y avisa a Orq por ítem.
3. Orq commitea en `feat/ronda-extracts` → Secondary verifica el diff → QA corre el arnés.
4. Al cerrar cada ola: PR a main, merge por Orq con el arnés verde.

## Decisiones de Karen que gobiernan esto (2026-11-02)
- "vamos con todo", con la notificación de navegador incluida. El RE de comentarios queda para después.
- data-alt: fundamentar. El atributo lo respalda la salida capturada `stitch-ui/d-screen-code.html`; el llenado diferido, vr-runtime webcrack :182, :583-590, :3129-3131.
- generate_image reemplaza al preflight de imagen de producto en el T1, con los slots data-alt de respaldo. Es una enmienda de ADR 0011 que firma Karen al aprobar S5.
- ADR E aceptado. Brand pack editable por proyecto; un reset o un proyecto nuevo lo restauran.
- Git: solo Orq.
- [KAREN:chat 2026-11-02] "si puedes fundamentar los guards sobre arquitectura sólida, la spec está aprobada para todos los agentes". Condición cumplida: arnes.md, "Fundamento de los umbrales" (sin constantes de tiempo inventadas; los tiempos son observación). El estado APROBADA lo pone Karen.

## Línea base (main 4abe005, worktree común, bun test completo, 2026-11-02)
1380 pass, 3 fail. Los 3 fallan desde antes y no son regresión de la ronda:
- "la ranura de Button sale de su código";
- "paso de imagen de producto > el plan de imagen exige foco nítido";
- "slot-policy CA1/CA1b".
Setup del worktree: `bun install --frozen-lockfile` en la raíz, en apps/builder y en templates/arc-scaffold.

## Borradores a portar (sin commit, fuera del worktree común)
- S1: ~/Desktop/SoftwareDevProjects/wt-arq-app (feat/app-incremental, sin commit). Se porta y se arregla tests/v0-transport.test.ts:585.
- S2: ~/Desktop/SoftwareDevProjects/wt-perf-ui (perf/ui-puente-ola1, sin commit).
- S4: O2-B está en scratchpad wt-o2b (feat/o2b-context-trace, sin commit).
Cada dueño porta el suyo al worktree común cuando su spec esté APROBADA. Después, Orq borra el worktree viejo.

## Decisiones de Karen (2026-11-02, tarde)
- [KAREN:chat 2026-11-02] edit_image entra en esta ronda (S5 §"edit_image ahora").
- [KAREN:chat 2026-11-02] "la apruebo como plan b. dale a toda la spec, implementa": si P2 (bd37158, prompt) no deja A1 en verde, entra P1 de Arq: el transport monta cada sección en App durante el T1 al ver su Write, en el orden de page-plan.md. Enmienda de ADR 0011: en el T1 App es del sistema; en los follow-ups sigue siendo del agente.
- [KAREN:chat 2026-11-02] Avatares /media/people/*.jpg de cta-section: opción (a), seguir ADR 0005. Se llevan #308 y #332 al vault (Knowledge/.../blocks/cta-section) y se hace el refetch al scaffold; queda abierta la escritura del vault para esos bloques y para los que importan lib/media con media inexistente.
- [KAREN:chat 2026-11-02] "amplía": ADR 0006 se amplía a los 13 bloques de re-iteracion/media-demo-arq.md (grupo A: vaciar el default de media; grupo B: quitar la media fija del JSX), vía vault y refetch según ADR 0005. Escritura del vault abierta para esos 13 bloques.
- Variantes: diseño de ec aprobado por Orq sobre la decisión de Karen (e16971d): una variante = un chat con workspace propio (fork del ws fuente), concurrencia por MAX_RUNNING 3, "siempre" de imagen global como Lovable (registry :4855-4859, "Images generated from any chat"), preaprobación por grupo cuando viene con imágenes, falla parcial independiente (hueco declarado).
- [KAREN:chat 2026-11-02] AutoFix en variantes: "como lo hagan en los extracts". Se decide por evidencia de Stitch/v0, no por criterio propio.
- [KAREN:chat 2026-11-02] Contraste (avisos de preview-check 2.81:1 y 4.12:1 en variantes): va a una ronda propia sobre cómo las apps RE corren auditorías de accesibilidad. Fuera de esta ronda.
- [KAREN:chat 2026-11-02] Imágenes del agente: MCP por HTTP servido por el transport con token por corrida (como Lovable integration "imagegen", registry deob :4835-4866), en lugar de credenciales en el entorno del CLI.
- [KAREN:chat 2026-11-02] Gate de copys (precios, clientes, métricas y contactos inventados como si fueran de la marca real, T1 422da91f page-plan "inventado"): ronda aparte, con RE de v0/Lovable/Stitch primero. Fuera de esta ronda.
- Pestaña del preview abierta en 422da91f a las 17:25:06 UTC: la abrió Karen con el Play. No es bug; las filas 9/25 y A3 de esa ventana quedan contaminadas.
- [KAREN:chat 2026-11-02] AutoFix en versiones normales: alinear con v0. Nada de turno automático tras una versión; los errores del preview esperan una acción manual como "Fix with v0" (HALLAZGOS-secondary-autofix-sandbox.md §AutoFix).
- [KAREN:chat 2026-11-03] REVOCA la decisión anterior: se persigue auto-repair de runtime/render estilo figma-make (auto-envía un mensaje oculto con errors[] + tope), fundamentado en AUTOFIX-REF.md. El disparo es en settle() tras el preview-check tardío, solo si la versión no es ya un repair (tope 1 como el build), outcome ok, sin pregunta ni turno en el ws. UI mantiene fallback manual.
- [KAREN:chat 2026-11-02] "vamos con todas las recomendaciones. ok a todo. siempre fundamentando con extracts". Aprueba:
  - A1: solo la captura de v0 de expiración a mitad de turno (gasta; el OK va en la sesión de orqWebTransformer). A2 y el resto de capturas quedan como huecos declarados.
  - ADR modelo de ejecución (re-iteracion/re-ejecucion/adr-borrador.md): D1 estado durable en el log; D2 stopped + "continuar" ahora, reanudar sola con runner remoto; D3 latido de ws visibles, dist por versión como snapshot, recreación desde el commit, url estable por ws; D4 endurecer las tools in-process (orden de auditoria-propia.md), hijo solo si no aguanta; D5 git del deploy como bundle en Blob; D6 abierta para otro ADR. Reglas comunes: arranque limpio desde el commit padre, settled como terminal único, desenlace en el índice.
  - Contexto (re-iteracion/re-contexto/sintesis.md): C1 a), C2 a), C3 a), C4 a) junto con el gate de copys, C5 a) archivar el camino props/JSON (delete aprobado), C7 slots solo sin tool. C6 era bug y ya está arreglado (8462dbe, 93e2d5c, 633e878, 86e9cdf).
  - E1: PR de feat/ronda-extracts ahora; la robustez va en rama nueva. E2: después, gate de copys y luego accesibilidad.
