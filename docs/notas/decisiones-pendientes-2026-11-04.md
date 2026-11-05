# Decisiones que solo toma Karen (2026-11-04)

Arq, sobre main 22f13e60. Todo lo demás del programa está hecho o asignado (`docs/estandares.md` §D). Ninguna de estas
se decidió por delegación. Cada fila trae la opción que recomienda Arq.

| decisión | por qué es de Karen | recomendación de Arq |
|---|---|---|
| Chips de follow-up del grupo de variantes (`docs/spec/chips-grupo-variantes.md` §4) | gasto | (b): una llamada de haiku por grupo en vez de una por variante. Gasta menos que hoy y es lo que hace Stitch |
| QA con ZAP en vivo (`identidad-sesion.md` §11) | corre contra el deploy de prueba | correrlo una vez, contra el deploy de prueba del perfil `atom`, antes del primer usuario externo, con los 6 casos de §11 **PARCIAL 2026-11-05:** los casos 1-4 y 6 corrieron contra el runtime (`jwt`) y el orquestador local, sin hallazgos (#796); el caso 5 y la corrida contra el deploy esperan el deploy de §3.7 |
| Fase 5: adaptador de identidad del perfil `atom` (`identidad-sesion.md`, anexo) | dependencia nueva y proveedor | Clerk: el equipo ya lo opera en los MCP de Atom (S-M). Entra por el mismo `SessionVerifier` y la VM no cambia (`signed`) **CERRADA 2026-11-05 (§3.6):** Clerk en la distro, sobre el verifier `jwt` del core (#771, #777) |
| Topes de gasto por dueño y su ventana (`deploy-sandbox.md` §5; `caps` del proxy, #727) | gasto | empezar con un tope diario por dueño (ventana de 24 h) y bajo, en USD. Subirlo con el gasto medido. El tope por corrida espera al token por corrida **CERRADA 2026-11-05 (§3.4):** tope diario de 5 USD por dueño, ventana por día (`dayWindow`, chat-index.ts:72), reserva condicional en el rmw (#772) |
| Proveedor de imágenes del perfil `atom` en la VM (`deploy-sandbox.md` §1) | gasto y proveedor | `imageProvider: 'gateway'` (flux) a través del proxy: sin OAuth ni credencial de la persona en la VM. atom-knowledge queda para local o `cli` **CERRADA 2026-11-05 (§3.4):** imágenes por el Gateway en la VM |
| Transcripción en la VM (`deploy-sandbox.md` §1) | gasto | apagada en el primer deploy con Sandbox. Encenderla por el proxy (familia `/v4/ai`) cuando se pida dictado **CERRADA 2026-11-05 (§3.4):** apagada |
| `@vercel/sandbox` en el orquestador (`deploy-sandbox.md` §6, paso 4) | dependencia nueva | sí: es el único camino de ADR 0016 y los pasos 1-3 ya están en main, a la espera de él **CERRADA 2026-11-05 (§3.2, ADR 0017):** aprobada; se instala en `onbrand-atom` con el primer alpha, no en el core |
| Publicar el registry del DS al Blob (`docs/governance.md:54`, `scripts/build-registry.ts --publish`) | publicar es deploy | publicar cuando el deploy de prueba lo necesite, con el pin que use ese deploy. No antes |
| Store Blob privado de prueba para QA del índice global (#717/#720) y del proxy de Gateway (#730) | infra y gasto en el team `atomchatio` | sí: un store aparte del registry, con todo bajo el prefijo `qa/` (QA lo limpia al terminar) y `BLOB_READ_WRITE_TOKEN` solo por env, nunca en el repo ni en logs. **CERRADA 2026-11-05 (Karen):** el store real, no uno aparte, bajo `qa/`; token solo por env (`.env` gitignorado). Evidencia QA: `tests/chat-index-blob-live.test.ts` contra Blob real sobre main 636e0449, 5/5 pass (create-once, ifMatch con etag viejo → `BlobConflictError`, read tras replace ve el etag nuevo con `useCache:false`, dos escritores del contador convergen a 17 y dos creadores a 7); `qa/chat-index-*` vacío al terminar (borra solo lo listado bajo su prefijo de corrida). Sin token el archivo se salta |

## 2. Filas del mapa que esperan a Karen, por lo que desbloquean (cierre 2026-11-04)

Son las 18 filas (A) de `cierre-modulo-2026-11-04.md` §4. Van en orden: primero lo que destraba más filas. El punto 0 se añadió el 2026-11-05: destraba el CI, no filas del mapa.

0. **Bump de Bun en CI de 1.3.14 a 1.4.4 (#766, abierto y sin auto-merge).** Es lo que destraba el CI verde.
   Causa: un bug de Bun 1.3.14 en Linux. Si un hijo con pipes extra sale al instante, el siguiente spawn con pipes extra
   (playwright) se rompe con `connect ENOENT`.
   - Reproducción mínima en CI: 22 de 24 fallos con 1.3.14 y 0 de 36 con 1.4.4.
   - Suite completa: 4 de 4 verdes con 1.4.4 (2173 pass) y 4 de 4 rojas con 1.3.14.
   - Descartados: estado propio, fds, PATH, TMPDIR y cwd. strace no muestra ningún syscall fallido (#764, cerrado).
   - Toca 3 sitios: `ci.yml:28`, `release.yml:52` y `README.md:145`.
   - Coste: Karen sube su Bun local (`bun upgrade`), y hay que volver a medir lo que cita Bun 1.3.14: el `HACK:` de
     `src/runtime/api-handlers.ts:72` y el comentario de `src/runtime/preview-serve.ts:9`.
   - Mientras tanto siguen las 2 cuarentenas de #763: `v0-browser-section` y `child-run`.
   - Recomendación de Arq: sí. Tiene reproducción mínima, la suite con 1.4.4 está verde, y el bug no es nuestro.
1. **Deploy de prueba con Sandbox (H11).** Con él se destraban 9 filas: runtime.sandbox, preview por origen, storage
   durable, deploy.dominio, edge.cdn, H21, H1 falsos HMR en Sandbox, H2 429 en staging y Meta en staging. Para llegar ahí
   hacen falta, de la tabla de arriba: `@vercel/sandbox`, el store Blob de prueba y los topes de gasto. Recomendación:
   primero el deploy de prueba del perfil `atom`, y QA mide las 9 filas sobre él.
2. **Fase 5 de identidad.** Destraba Identidad/CSP y Bearer de fase 5 (2 filas). Recomendación: Clerk, por el mismo
   `SessionVerifier` (fila "Fase 5" de arriba). Necesita el deploy del punto 1 para el QA con ZAP.
3. **Gasto: transcribe, image-edit y billing.creditos** (3 filas). Recomendación: transcripción apagada hasta que se pida
   dictado. image-edit por el proxy cuando haya créditos aprobados. billing.creditos después de medir el gasto real del
   deploy de prueba.
4. **Decisiones sueltas** (4 filas):
   - H9 (atado a H1, publicar a un destino);
   - H16 (cerrada con su disparador: se reabre cuando un conector escriba);
   - feature-bento (ampliación de ADR 0006);
   - C5, archivar props/JSON (atado a "¿se retira el runner?").


## 3. Decididas por Karen (2026-11-05)

Karen las dio en el chat y las trasladó WebTransformerOrq. Cada una cierra su fila de la tabla de arriba o de §2.

| # | decisión | estado |
|---|---|---|
| 1 | Bun 1.4.4 en CI (§2, punto 0). Mergeado en #766; las cuarentenas de #763 salieron en #768 | DECIDIDA [KAREN:chat 2026-11-05] |
| 2 | Dependencias aprobadas: `@vercel/sandbox` (orquestador), `@clerk/backend` (verifier de fase 5) y el paquete de Clerk del builder que nombre UI en su PR | DECIDIDA [KAREN:chat 2026-11-05] |
| 3 | El store Blob de prueba es el store real de `atomchatio` que ya existe, con todo bajo el prefijo `qa/`. `BLOB_READ_WRITE_TOKEN` va solo por env (`.env` gitignorado en los worktrees), nunca en el repo ni en los logs | DECIDIDA [KAREN:chat 2026-11-05] |
| 4 | Gasto aprobado para pruebas reales ("el gasto que necesites"). Tope diario de 5 USD por dueño, transcripción apagada, imágenes por el Gateway en la VM. Es la recomendación del cierre | DECIDIDA [KAREN:chat 2026-11-05] |
| 5 | Se retira el runner (C5): "ADR 0011 ya lo dejó fuera del camino de producto… no se pierde la edición determinista por AST" | DECIDIDA [KAREN:chat 2026-11-05] |
| 6 | Fase 5 de identidad: Clerk | DECIDIDA [KAREN:chat 2026-11-05] |
| 7 | El deploy es el proyecto que ya existe, `vercel.com/atomchatio/wt-builder`. Cada deploy lleva el OK de Karen | DECIDIDA [KAREN:chat 2026-11-05] |
| 8 | G1 (reemplaza la primera versión de ADR 0017, "una distro es un perfil del mismo repo"): "una distro debería estar totalmente separada. Onbrand es un core agnóstico NO anclado a una distro, que se puede distribuir como open source; a partir del repo white label se crean distribuciones" y "el Vercel Blob es infra de Atom". La primera distro es `karenrebecag/onbrand-atom` (privado, lo crea Karen). ADR 0017 propone cómo se cumple | DECIDIDA [KAREN:chat 2026-11-05] |
| 9 | DS base neutral propio en el core, en lugar de Arc; Arc y los demás entran por el registry de la distro (bloqueo para hacerlo público: Arc Pro en `templates/arc-scaffold` y `registry/r`). Spec: `docs/spec/ds-base-neutral.md` | DECIDIDA [KAREN:chat 2026-11-05] (ADR 0017:24-28) |
| 10 | `package.json` del alpha: `exports` y `bin` (session-provider, App, serve, orquestador, build-registry), `LICENSE` MIT y `@vercel/blob` fuera en el mismo PR. Es config raíz: la toca Karen o pasa con su OK | DECIDIDA [KAREN:chat 2026-11-05] (ADR 0017:29-33) |
| 11 | Repo público nuevo, con historial limpio, en el primer alpha y no antes; el repo actual sigue privado | DECIDIDA [KAREN:chat 2026-11-05] (ADR 0017:34) |
| 12 | `tsc --noEmit` en CI. Entró en #802 y salió en #803 por falta de `tsconfig.json` raíz; vuelve con el tsconfig de UI y `@types/bun` (#804). Aplicada a medias | DECIDIDA [KAREN:chat 2026-11-05] (ADR 0017:36) |
| 13 | Reserva de gasto por request del proxy en 16k, aparte del tope diario. Hoy `DEFAULT_MAX_TOKENS = 64_000` (gateway-proxy.ts:67): la aterriza Orq en su PR. Sin aterrizar | DECIDIDA [KAREN:chat 2026-11-05] (ADR 0017:37) |
| 14 | Las cifras de arranque se quedan hasta medirlas en el deploy de prueba: 100 chats por dueño y 10 altas por minuto por instancia (routes.ts:18), 8 VM, 2 por dueño (local-sandbox.ts:44) | DECIDIDA [KAREN:chat 2026-11-05] (ADR 0017:38) |
| 15 | ADR 0017: todos sus pendientes delegados, sin OK por PR; Arq revisa post-merge. No cubre dependencias, configs raíz ni deploys | DECIDIDA [KAREN:chat 2026-11-05] (ADR 0017:19, :251-252) |
| 16 | Los dos bloques de Arc Pro del builder (`apps/builder/src/components/arc/blocks/agent-run`, 12 archivos, y `ai-composer`, 6; importados por 8 archivos del builder y 2 tests; inventario de UI) se quedan en el core, tratados bajo slots para que sean únicos y funcionales solo con este proyecto: "al ser tratados, bajo slots, no es redistribución; la arquitectura sería incompatible". Se distribuyen como librería inicial sobre el core. Los 18 componentes free, `foundation.css` y `lib/` siguen tal cual. `components/arc` no entra a ARC_PATHS ni sale en el alpha | DECIDIDA [KAREN:chat 2026-11-05] |
| 17 | `package.json` del alpha: `name` onbrand; `exports` ./session-provider → apps/builder/src/lib/session-provider.ts, ./App → apps/builder/src/App.tsx, ./serve → scripts/serve.ts, ./orchestrator → src/orchestrator/main.ts, ./build-registry → scripts/build-base-registry.ts; `bin` serve, onbrand-orchestrator, build-registry (el constructor del base; el de Arc sale con la distro); `LICENSE` MIT en raíz; `@vercel/blob` fuera en el mismo PR; `tsconfig.json:5` se queda (el path a typescript de base-scaffold es lo que hace que tsc funcione en un clon) | DECIDIDA [KAREN:chat 2026-11-05 noche] |
| 18 | Los tres valores del DS base sin fuente externa se quedan como valores de base: `--duration-spring` 500 ms (spring considerado), `#ffffff` (`--neutral-0`, `--accent-foreground` claro; blanco estándar), `#121212` (`--background` oscuro; gris oscuro estándar de dark mode, no es de Arc). Una línea en la spec B9: "valores de base; el brand pack los sobrescribe" | DECIDIDA [KAREN:chat 2026-11-05 noche] |
| 19 | Marcas en la raíz (A1b, spec §8.2) no bloquea el alpha y queda para después. Al retomar: tope de 32 marcas por dueño; el puerto `brands` sigue siendo el de hoy (packs en `brands/`); el catálogo por chat es de la distro, no del core. La fecha del alias de conectores (2026-12-05) sigue propuesta | DECIDIDA [KAREN:chat 2026-11-05 noche] |
| 20 | Ajustes a la 17 tras simular la instalación del paquete: `bin` onbrand-serve, onbrand-orchestrator (→ scripts/orchestrator.ts, que sí arranca) y onbrand-build-registry; el export `./App` sale del alpha.1 (alias @/ y deps del builder sin declarar en la raíz; la distro monta el builder por session-provider); `files` en lista blanca (src, scripts, apps/builder/src + tsconfig + index.html, templates/base-scaffold, brands, registry, LICENSE, README); `catalog/` no entra y el core tolera su ausencia (sin candidatos de bloque). El tag espera el OK de QA sobre el clon limpio | DECIDIDA [KAREN:chat 2026-11-05 noche] |

Siguen abiertas:
- de §2: H9, H16 (con su disparador) y feature-bento;
- de la tabla de arriba: los chips del grupo de variantes, el caso 5 y la corrida del ZAP sobre el deploy del punto 7, y la publicación del registry del DS.
- ADR 0017: delegado (§3.15); lo que sigue es de Karen solo en `package.json`, `LICENSE`, deps y deploys (§3.10, §3.12).
