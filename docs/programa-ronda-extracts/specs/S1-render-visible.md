# S1 Render visible durante el turno
Estado: APROBADA · Dueño: Arq

## Objetivo
Cada sección monta en el preview apenas se escribe, por HMR y sin full-reloads. Hoy hay 18 recargas y todo monta junto a los ~245 s (qa.md §2.1).

## Fundamento
- vite 8.3.4 dist/node/chunks/node.js, de npm, sin ofuscar:
  - :26630-26631: un import roto deja App sin auto-aceptar y en la lista de resolución fallida;
  - :25505: cada archivo nuevo vuelve a intentarlo;
  - :25662-25700, :25604-25612 y :25629-25636: cuando la propagación no encuentra frontera, termina en full-reload.
- @vitejs/plugin-react 6.1.2 (la instalada en el scaffold), dist/refresh-runtime.js, validateRefreshBoundaryAndEnqueueUpdate :630-660 con isLikelyComponentType :526: un módulo es frontera de Refresh solo si todas sus exports son componentes. Por eso WtSection va en su propio archivo. El accept lo inyecta un builtin de rolldown (constructors-BDv3zGhp.mjs:60-67).
- Overlay apagado: @lovable.dev/vite-tanstack-config 2.27.0 dist/index.js:1680-1688: `hmr: { overlay: false }` solo dentro de `if (isSandbox)`, el equivalente a nuestro preview del builder; fuera del sandbox no se pone (:1689-1692). Copia verificada en ~/Desktop/web-transformer-sesiones/re-iteracion/extracts-npm/lovable-vite-tanstack-config-2.27.0/package/dist/index.js. Los errores siguen visibles en la pill del builder (#413). **Es config del scaffold: Karen lo decide al aprobar esta spec.**
- Detalle: viabilidad/arq.md.

## Cambios
1. agent-prompt.ts, regla APP_INCREMENTAL:
   - se escribe cada sección y después su línea en App, `<WtSection slug="…"><X /></WtSection>`, en una sola línea;
   - nunca un import a un archivo que no existe. Las imágenes van por ruta pública (`/images/…` como string) y nunca con import de un asset;
   - orden del T1: identity.css → page-plan.md → index.html → secciones y App. index.html se escribe una sola vez, después de la identidad y del plan (el <link> de fuentes sale de la identidad), y no se vuelve a tocar en el T1. Va antes de App y de las secciones. Un .html siempre fuerza full-reload (vite node.js:25576-25583, :25629): al principio no hay nada montado que perder. Al final cortaría la cola del puente;
   - el follow-up agrega la línea igual.
2. templates/arc-scaffold/src/wt-section.tsx: el boundary, igual a runner.ts SECTION_BOUNDARY. Navbar y footer también van envueltos; main.tsx:17 los reconoce por `static wtSection` y no duplica logs.
3. transport.ts:1178-1180 (sectionOp remove/duplicate), en el turno de S1: primero se escriben los archivos nuevos, después App y al final se borra. Borrar antes deja a App importando un archivo inexistente (:26630-26631) y termina en full-reload, que sin remonte ahora se ve.
4. section-ops.ts: mounted() acepta la línea con WtSection; quitar y duplicar renumeran el slug.
5. templates/arc-scaffold/vite.config.ts: server.hmr.overlay false.
6. Se agrega la mención de WtSection en AGENTS.md del scaffold y en ds-skill-agent.ts:561, que hoy es el bullet "src/App.tsx: vacío".

## Límites conocidos
Un follow-up que cambia title, lang o fuentes edita index.html y recarga el preview una vez. Es esperado y no cuenta como regresión de A2.
S1 no mueve la línea de productImage (agent-prompt.ts:61): la reemplaza S5.

Un WtSection repartido en varias líneas hace que sectionOp responda "unsafe → Editar con IA". Es a propósito: esa línea no se mueve entera. El prompt pide una sola línea.

## Terminado
- Tests del área en verde, v0-transport incluido.
- Compatibilidad: páginas viejas sin WtSection y páginas mezcladas siguen pasando sectionOp.
- Arnés: A2 (a lo sumo 1 full-reload, la de index.html antes de la primera sección; 0 después de la primera sección y 0 en sectionOp) y A1 con cada sección entrando por HMR en su momento, no todas juntas al final.

## Fuera de alcance
import.meta.glob (enmienda de ADR 0011), salvo que A1 o A2 fallen.
