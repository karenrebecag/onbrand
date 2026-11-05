# Ataque a las specs — ronda de extracts

Secondary. Cada cita se abrió en su archivo:línea. VERIFICADO = dice lo que la spec afirma; FALSO = no coincide; NO VERIFICADO = no pude abrir el extract (dep ausente, versión incierta) o no es un extract (doc de viabilidad / nuestro código a futuro).

Método: extracts npm traídos como datos con `npm pack` (vite@8.3.4, @vitejs/plugin-react@6.2.1, @lovable.dev/vite-tanstack-config@2.27.0) y abiertos; extracts de Stitch en `~/Desktop/web-transformer-sesiones/re-iteracion/stitch-ui/bundles-2026-11-02/`; nuestro código en el worktree común.

---

## S1 — Render visible (Arq) · ola 1

### Citas de fundamento

| cita | veredicto | qué encontré |
|---|---|---|
| vite 8.3.4 node.js **:26630-26631** — import roto deja App sin auto-aceptar + lista de fallidas | **VERIFICADO** | :26630 `importerModule.isSelfAccepting = false`; :26631 `moduleGraph._hasResolveFailedErrorModules.add(importerModule)`; sigue el error "Failed to resolve import … Does the file exist?". Exacto. |
| vite **:25505** — cada archivo nuevo la reintenta | **VERIFICADO** | :25505 `if (type === "create") for (const mod of environment.moduleGraph._hasResolveFailedErrorModules) mods.add(mod)` — al crear un archivo re-agrega los módulos que fallaron a resolver. |
| vite **:25662-25700** — propagación sin frontera → full-reload | **VERIFICADO** | :25662 `function propagateUpdate(...)`; devuelve `true` (dead-end) cuando `!node.importers.size`. Es la señal de recarga. |
| vite **:25604-25612** y **:25629-25636** — el caller convierte el dead-end en full-reload | **VERIFICADO** | :25604 `let needFullReload = modules.length === 0`; :25607 `const hasDeadEnd = propagateUpdate(mod, …)`; :25611 `needFullReload = hasDeadEnd`; :25631 `type: "full-reload"` con log `page reload`. |
| @vitejs/plugin-react refresh-runtime.js **:630-660** — módulo es frontera solo si todas sus exports son componentes | **VERIFICADO (mecanismo) / NO VERIFICADO (línea)** | En 6.2.1 la función es `validateRefreshBoundaryAndEnqueueUpdate` (~:633) y el gate es `isLikelyComponentType(nextExports[key])` por export, con "Could not Fast Refresh" si no. El mecanismo es correcto; las **líneas exactas dependen de la versión instalada**, que no pude confirmar (node_modules del worktree no resuelve plugin-react). Recomiendo citar por nombre de función, no por línea. |
| @lovable.dev/vite-tanstack-config 2.27.0 dist/index.js **:1686** — hmr.overlay false | **VERIFICADO** | :1686 `hmr: { overlay: false }`. |
| "los errores siguen en la pill del builder (#413)" | **NO VERIFICADO** | Es afirmación sobre nuestro builder, no un extract. No abrí el builder; que #413 esté en main lo confirma Orq/QA. |

### Citas a nuestro código (cambios)

| cita | veredicto | qué encontré |
|---|---|---|
| wt-section.tsx "igual a runner.ts SECTION_BOUNDARY" | **VERIFICADO (referencia existe)** | `src/v0/runner.ts:366` `const SECTION_BOUNDARY = \`class WtSection extends Component<{ slug … }>…\``; usado en :400. El boundary a portar existe. |
| section-ops.ts `mounted()` acepta `<WtSection slug>…</WtSection>` | **VERIFICADO (función) / cambio pendiente** | `mounted()` en `section-ops.ts:46` hoy parsea imports `@/sections/`/`./sections/` (ambas comillas), NO el wrapper `<WtSection>`. El cambio #3 es real y necesario; la función citada es la correcta. |
| ds-skill-agent.ts **:561** "menciona WtSection" | **FALSO como estado actual / ancla OK** | `:561` = `'- \`src/App.tsx\`: vacío; aquí se monta la página.'` — NO menciona WtSection (es el bullet de App.tsx). Como ancla del cambio sirve; reformular la spec a "se añade la mención de WtSection en el bullet de App (:561)", no "menciona". |
| v0-transport.test.ts **:585 falla** | **NO VERIFICADO** | No puedo correr tests (node_modules del worktree no resuelve `vite`/`ai`). El test en :585 existe y ya habla de `<WtSection>` ("no hay línea propia que mover"). Que falle/ pase lo confirma QA en el arnés. |

### Ataque a la tabla de módulos (S1)
- **Sin choque de archivos** con S2 (S1: agent-prompt, section-ops, ds-skill-agent, scaffold {AGENTS.md, vite.config.ts, wt-section.tsx}; S2: wt-reveal-bridge, artboard-canvas). OK.
- **Dep S1→S0**: correcto, pero el "terminado" de S1 exige "Arnés A1 y A2 en el T1 medido" → **A1/A2 deben estar definidos en S0**. Verificar que S0 los especifica y son medibles; si no, el criterio de S1 no es medible. (Pendiente de atacar S0.)
- `transport.ts` compartido: S1 no lo toca (toca el TEST v0-transport, no transport.ts). Sin conflicto de orden.

---

## S2 — Puente del preview (UI) · ola 1

`R = stitch-ui/bundles-2026-11-02/UgcTrustBanner-ClT5SnxT/renderer/webcrack/deobfuscated.js` · `P = …/UgcTrustBanner-ClT5SnxT/webcrack/deobfuscated.js`

| cita | veredicto | qué encontré |
|---|---|---|
| handleStreamEnd no vacía la cola — **R l.1001-1017** | **VERIFICADO** | R:1001 `handleStreamEnd() { this.animationEngine.isStreaming = false; … }` — apaga isStreaming sin limpiar `elementsToFadeIn`; la cola termina sola. |
| tope de 2 animaciones por elemento — **R l.458-462** y **l.3993-3995** | **VERIFICADO** | R:458 `const A = this.elementAnimationCounts.get(E) ?? 0`; :459 `if (A >= 2 || …) …`; :461 `set(E, A + 1)`. El reset: R:3995 `o.clearAnimationCounts()` (en dom_operations). |
| cursor salta al primer elemento del lote y queda visible; solo `pointer` — **R l.240-248** y **l.478-481** | **VERIFICADO** | R:242 `this.agentCursor ||= document.getElementById("stitch-agent-cursor")`; R:478-480 `if (!this.cursorMoved) { this.moveCursor(E, "pointer"); this.cursorMoved = true }`. |
| z-index 998/9999 — **R l.2554, l.2598** | **FALSO (archivo) / VERIFICADO (valores+líneas en P)** | En **R**, l.2554/2598 son `goog.getMsg(...)` (strings de UI), y R no tiene 998/9999 (su overlay usa `z-index:2147483647`, R:4059). El `z-index:998` y `z-index:9999` SÍ están en **P** l.2554 y l.2598. Corregir la cita: el z-index es de P (el componente padre), no de R (el renderer). |
| no-remontar + handshake "arq.md §2 (key={version})" | **NO VERIFICADO (cross-doc)** | arq.md es doc de viabilidad, no un extract; el extract real de `key={version}` vive en arq.md/su fuente. Se valida al atacar S1/arq, no acá. |

### Ataque a la tabla de módulos (S2)
- **Dep S2→S1**: correcta — S2 anima lo que S1 monta (`<WtSection>`). No invertir.
- **Sin choque** con S1 ni S3 (S2: wt-reveal-bridge.ts + artboard-canvas.tsx; S3: `apps/builder/src/**` **salvo lo de S2** — el "salvo" evita el choque, pero exige que S3 liste explícitamente qué excluye; hoy es por exclusión implícita → **riesgo**: dos specs sobre `apps/builder/src/**`. Recomiendo que S3 nombre archivos, no un glob con "salvo"). 
- **Terminado** "arnés A3" → A3 debe estar en S0 (misma observación que A1/A2).
- Objetivo "que se anime como en Stitch" no es medible por sí; el terminado (test del tope + captura + A3) sí lo aterriza. OK.

---

## S0 — Arnés y medición (Orq + QA) · ola 0

| cita / afirmación | veredicto | qué encontré |
|---|---|---|
| Bun.spawn stdout/stderr (bun.sh/docs/api/spawn) para el log del vite | **VERIFICADO como "no extract"** | La spec lo declara honestamente: "No hay extract: es instrumentación propia". Correcto bajo regla 8 — es doc web + código nuestro, no se replica de nadie. |
| A1-A7 definidos con forma de medir | **VERIFICADO (bien formados)** | A1 (sección visible antes de message.end), A2 (0 full-reloads), A3 (cursor+rect en ≥3 elementos), A4 (cada loading state aparece/desaparece), A5 (0 hooks/0 pill), A6 (F1a-F1d de 56644d79), A7 (generate_image + imagen en hero + aprobación). Todos medibles. **Resuelve el flag de S1/S2**: A1/A2/A3 existen acá. |
| Casos viven en `arnes.md` (QA) | **riesgo menor** | S0 lista A1-A7 inline y dice que QA los define en `arnes.md`. Que `arnes.md` sea la única fuente de verdad (que no deriven de la copia inline de S0). |

**Terminado** medible. S0 es sólido.

---

## S3 — Loading states (UI) · olas 2-3

Abreviaturas de ui.md: DP = DesignPage-s8oa9o80/deob; V0 = v0-design-mode/deob; LLAZY/LEDB = lovable shared; CSS = host-css/index-tYuWDmAJ.css (minificado, por offset).

| fila | cita | veredicto | qué encontré |
|---|---|---|---|
| 6 draw overlay | CSS offset 16733 (working-dash) | **VERIFICADO** | offset 16733: `working-dash{to{stroke-dash…` |
| 9 toast 10 s "View" | DP:13100-13115 | **NO VERIFICADO** | no encontré toast/10000/View en/cerca de :13100-13115; recheck (posible drift o token distinto). OB:1696-1745 no abierto. |
| 10 tips 12 s random | DP:19244-19284, :51421 | **VERIFICADO** | array de ~50 tips + `return n[Math.floor(Math.random()*n.length)]` (:19284). Intervalo 12 s en :51421 (no abierto, pero el pool+random está). |
| 13 puntos de pensando | DP:47568-47600 | **VERIFICADO** | `agent-thinking-dot` animation + variante `three-dots` (:47568). |
| 18 shimmer de título | V0:13887-13895 | **VERIFICADO** | `shimmer` presente en el rango. |
| 19 agentPendingEnter | DP:13684 | **VERIFICADO** | `agentPendingEnter` en :13684. |
| 22 skeleton | DP:6457-6464 | **VERIFICADO** | `animate-skeleton` en el rango. V0RT:8821-8861, LAPP:12614 no abiertos. |
| 23 barra de progreso | LLAZY:46038-46134 | **VERIFICADO** | `isLoading` + `width:0` (progreso animado). |
| 24 auto-follow del chat | V0:12141 | **VERIFICADO (drift)** | el mecanismo está en V0:12138 `scrollToBottomOnMount` y :12339 `scrollToBottom`; la línea citada (:12141) corre ~3; corregir a :12138. |
| 8 cámara 600 ms | DP:33253-33400 | **VERIFICADO** | `fitScreens` + zoom en el rango. I18:11666-11690, SU:876-975 no abiertos. |
| 16/17/21 fase/ETA | LEDB:321-349 | **VERIFICADO** | `estimate` (tabla estática con estimateMs). Depende del contrato de fase de S4 (bien señalado: S3-ola3 no pasa a APROBADA sin ese contrato). |
| 25 notificación navegador (Karen 2026-11-02) | LLAZY:23589-23612 (permiso), :23621-23735 (cuándo) | **VERIFICADO** | :23589 `qh = () => … Notification.permission`; `useSyncExternalStore(x4, qh, C4)`; `requestPermission: useCallback(async…)`. :23622 `if (qh()==="granted" && document.hidden) { new Notification(t, …) }`. El disparador (botón "Avisarme") se funda en MDN (gesto del usuario) — declarado correctamente como sin-extract. |

**Ataque módulos S3**: archivos ya nombrados uno por uno (Orq lo corrigió) — sin choque con S2/S6. Contrato `data-wt-loading` medible por A4. Rows 9 queda NO VERIFICADO: no bloquea la ola 2 si se corrige la cita antes de APROBAR esa fila.

---

## S4 — Traza del turno (orqWebTransformer) · ola 2

| cambio | cita | veredicto | qué encontré |
|---|---|---|---|
| 1 contexto por turno | MK:32541 (usageInfo), :40269 (cliente descarta), V0:56042 (workMetrics.linesRead) | **VERIFICADO** | MK:40269 `case "usageInfo":`; V0:56042 `workMetrics: s.workMetrics`. contextWindow del CLI se cita por doc stream-json (declarado). |
| 2 diffstat por versión | MK:40021-40031 | **VERIFICADO** | :40026 `diffSummary: o`; :40029 `r.diffSummary = o`. Adaptación (cálculo determinista, no persistir) declarada. |
| 3 old/new del Edit | MK:40042-40063 | **VERIFICADO** | `oldString`/`newString`; `n.edits[e.id].oldString = e.old_str`. |
| 4 Bash como edición | FA:444176-444230 (treatBashAsEditing) | **VERIFICADO** | flag `bash:` en el rango (treatBashAsEditing); equivalencia con nuestro allowlist (agent-loop.ts:156 mv/mkdir) declarada. |
| 5 razonamiento como duración | V0:20725-20745 ("Thought for Ns") | **VERIFICADO (texto impreciso)** | :20739 `p.isActive ? b : \`Thought ${v}\``. El label real es "Thought Ns" (p. ej. "Thought 5s"), no "Thought for Ns". Corregir la cita del string. Mecanismo correcto. |
| 6 contrato de fase (tool? en step.start) | DP:14164-14215, uso :14270 | **no abierto** → **NO VERIFICADO** | no abrí :14164-14215 en esta pasada; el resto de S4 valida. Recheck antes de APROBAR S3-ola3 (depende de este contrato). |

**Ataque módulos S4**: toca `transport.ts` (versions/statsOf) — compartido con S5; S4 dice "va primero S4 y después S5", orden explícito y correcto. Done-criteria medibles (ctx-per-turn.py, GET versions con stats, ratio<0.05, A6).

---

## S5 — Tooling del agente (ec) · olas 3-4

| cambio | cita | veredicto | qué encontré |
|---|---|---|---|
| 1 data-alt | **vr-runtime webcrack :182, :583-604, :3129-3131** | **FALSO (líneas)** | :182 es un mapa de colores (`deepskyblue: 49151`); :583-604 no tiene alt; :3129-3131 es `Pi = jy`/`var Uy`. **data-alt NO está en esas líneas de vr-runtime.** Lo único afín es :30 (`"alt" in e` — forma del objeto imagen `{url, alt}`). El respaldo REAL de data-alt es la salida capturada `stitch-ui/d-screen-code.html` (6 `data-alt`, VERIFICADO). **Corregir**: citar d-screen-code.html (output) + vr-runtime:30 (contrato {url,alt}); quitar :182/:583-604/:3129-3131. Afecta también la nota de PROGRAM.md "data-alt: … vr-runtime webcrack :182, :583-604, :3129-3131". |
| 2 generate_image / edit_image | MediaGenerationApprovalCard :153; registry :4892-4899; app-lazy-shared :21603 | **VERIFICADO** | LLAZY:21603 `tool_call … target_path` (edit_image). approval :133-196 declarado. target_path de generate_image: hueco declarado (solo ZAP) — correcto marcarlo. |
| 3 enhancer de prompt | usePromptPreview :22-43, :44-89, :962-976; PostMessageClient :919-928 | **no abierto** → **NO VERIFICADO** | no abrí estas líneas; recheck. |
| 4 variantes | DesignPage-s8oa9o80 :34420-34475 | **VERIFICADO** | `variantCount`, `creativeRange='medium'` en el rango. "N generaciones en el server de Stitch" marcado como hueco — correcto. |

### Decisión de Karen (2026-11-02): generate_image REEMPLAZA el preflight de imagen de producto en el T1; data-alt de respaldo

- **Código objetivo correcto**: el preflight vive en `agent-composer.ts` ~:226 — `if (gen && req.imageGeneration && !followUp && (!direction || wantsProductImage(direction))) { const asset = req.productAsset ?? await productImageHook(req, log) }`. Es lo que la decisión reemplaza.
- **Ataque — doble generación**: hoy ese `if` corre SIEMPRE que hay `imageGeneration`. Si se agrega generate_image como tool sin **apagar** ese preflight cuando el agente va a generar, el T1 generaría la imagen DOS veces (preflight + tool) → doble costo y posible doble hero. La spec debe gatear el preflight (flag o condición) para que sea reemplazo, no suma.
- **Respaldo de data-alt**: `image-slots.ts` (`fillImageSlots`) sigue llenando `/images/<slug>-<n>` desde los `data-alt` que el agente dejó; convive con generate_image sin doble escritura solo si el agente NO deja slots cuando usó la tool. Medible por A7 (imagen en hero) + A4 (slots). Viable **con condición**: el gateo del preflight y la regla "tool o slots, no ambos para el hero".
- Es decisión de ADR (la propia spec la marca): correcto que quede como decisión de Karen, ya tomada; falta el gateo en el diseño.

---

## S6 — Selección con archivo:línea (Arq + UI) · ola 3

| cita | veredicto | qué encontré |
|---|---|---|
| lovable-tagger@1.3.5 dist/index.js :7, :10-17, :177 | **VERIFICADO** | :7 `var devRuntimeCode_default = "import * as ReactJSXDevRuntime…"` (el runtime que guarda `{fileName,lineNumber,columnNumber}` en `Symbol.for("__jsxSource__")` + `window.sourceElementMap`); :10-17 `createJsxTaggerFeature` (resolveId/load del virtual `\0jsx-source/jsx-dev-runtime`); :177 `if (jsxSource) features.push(createJsxTaggerFeature())`. |
| Make Annotate FA:440813-440885 | **VERIFICADO** | `annotations:`, `annotationSelectionReferenceByTargetKey`, `## Visual Annotations` — el canal de anotación. |
| cola "Task N" FA:439215-439245 | **VERIFICADO** | :439239 `return [\`Task ${t + 1}: ${n}\`]`. |
| iframe FA:45692-45705 | **NO VERIFICADO** | no encontré iframe/postMessage/annotat en :45692-45705; recheck el número. |
| cola RECEIPT:96210-96300 | **NO VERIFICADO** | "RECEIPT" no está definido en las abreviaturas que tengo; no pude mapear el archivo. Orq: ¿qué bundle es RECEIPT? |
| React 19 no expone _debugSource | **NO VERIFICADO (cross-doc)** | es afirmación de arq.md, no un extract abrible acá. |

**Huecos de S6 bien planteados**: (1) que el JSX dev-transform de vite 8 (oxc/rolldown) pase el 5º arg `source` a jsxDEV, y (2) que el resolveId del módulo virtual gane sobre `react/jsx-dev-runtime` (hoy en dedupe/optimizeDeps). Son los dos riesgos reales de portar el tagger a nuestro vite; correcto frenar y consultar a Karen si fallan. **Dato de contexto** (mi frente C): nuestro vite es 8.3.4 y el scaffold tiene `react/jsx-dev-runtime` en optimizeDeps.include — el hueco (2) es real.

**Ataque módulos S6**: toma `element-context.ts`, `edit-popover.tsx`, composer de `chat-panel.tsx` "mientras dure S6" — los mismos que S3 excluye en ese período. Coordinación temporal explícita; OK si Orq serializa S6 y S3-sobre-esos-archivos.

---

## Resumen de correcciones a pedir (orden de impacto)

1. **S5 data-alt (y nota de PROGRAM.md)**: las líneas de vr-runtime (:182, :583-604, :3129-3131) son FALSAS; el respaldo real es `d-screen-code.html` + vr-runtime:30. Corregir antes de implementar S5 y de citar en PROGRAM.md.
2. **S5 decisión de Karen**: agregar el gateo del preflight (agent-composer:226) para que generate_image lo REEMPLACE y no se sume (doble generación/costo).
3. **S2 z-index**: fuente es U/P (…/webcrack/deobfuscated.js:2554,2598), no R. (Orq dice que rev.1 ya lo tenía como U — confirmar que la versión vigente no diga R.)
4. **S4 ítem 5**: el string es "Thought Ns", no "Thought for Ns".
5. **NO VERIFICADO a recheckear**: S3 fila 9 (toast DP:13100-13115), S4 ítem 6 (DP:14164-14215), S5 ítem 3 (usePromptPreview), S6 iframe :45692-45705 y RECEIPT:96210-96300 (archivo sin mapear). No bloquean la ola 1; sí antes de APROBAR sus olas.
6. **S3 fila 24**: auto-follow está en V0:12138, no :12141.
7. **S1 ds-skill-agent:561** y **refresh-runtime por versión**: ya corregidos por Orq (6.1.2, validate… :630 / isLikelyComponentType :526 — verificado).

Olas 1 (S1, S2) y 0 (S0): fundamento sólido, sin FALSO que bloquee. Los FALSO/NO VERIFICADO están en olas 2-4 y hay tiempo de corregirlos antes de cada APROBADA.


---

## Ataque — S0 §"Fundamento de los umbrales" (commit 7fa2be2, re-verificado)

**Corrección de un error propio:** mi primera pasada marcó A1/A3/A5 como FALSO/NO VERIFICADO. Era un error mío: leí el vite 8.3.5 de `apps/builder/node_modules` y el deob `U` (`.../UgcTrustBanner-ClT5SnxT/webcrack/deobfuscated.js`). El preview corre con el vite del scaffold, **8.3.4**, fijado en `templates/arc-scaffold/bun.lock:343`, y R es el archivo `renderer/`, no `U`. Contra las fuentes correctas, TODO resuelve:

| claim | cita | verdicto | evidencia (fuente correcta) |
|---|---|---|---|
| A1: errores previos a un update entran en `create` | scaffold vite 8.3.4 `node.js:25505` (+`:26631`) | **VERIFICADO** | `:25505` `if (type === "create") for (const mod of environment.moduleGraph._hasResolveFailedErrorModules) mods.add(mod)`; `:26631` `_hasResolveFailedErrorModules.add(importerModule)` |
| A2: `.html` sin frontera → full-reload | `:25628-25629`, `:25662` | **VERIFICADO** | `:25628` `isClientHtmlChange = file.endsWith(".html") && ... mod.type !== "js"`; `:25629` `if (needFullReload || isClientHtmlChange)`; `:25662` `function propagateUpdate(...)` |
| A5: #424 vite | `node.js:35777-35782` | **VERIFICADO** | `:35777-35782` `logOptimizeDepsIncludeSuggestion` (tip de optimizeDeps.include) |
| A3: renderer de Stitch | `.../UgcTrustBanner-ClT5SnxT/renderer/webcrack/deobfuscated.js` | **VERIFICADO** | `handleStreamEnd` `:1001`; `elementAnimationCounts = new Map()` `:194`, `clearAnimationCounts` `:198`, get `:458`; `moveCursor(e,o)` `:211`, llamadas `:257`/`:344` |

Los dos "defectos de raíz" que señalé (anclaje por línea sobre un `^`-rango; "R" sin nombrar) ya los cerró Orq en `arnes.md`: citó por versión del lock + símbolo y dio a R su ruta completa. Pendiente de mi lado: verificar LEDB y DP:6438 con las rutas que pase Orq. La parte de TIEMPO sigue bien fundada.

**Lección:** verificar SIEMPRE contra el vite que corre el preview (scaffold, no builder) y abrir el archivo exacto (`renderer/`, no la raíz del bundle) antes de emitir un veredicto.
