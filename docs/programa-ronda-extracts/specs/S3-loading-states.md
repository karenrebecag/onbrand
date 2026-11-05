# S3 Loading states y animaciones del builder
Estado: APROBADA · Dueño: UI

## Objetivo
Los estados de carga de las referencias, cada uno con su extract. Filas de ~/Desktop/web-transformer-sesiones/re-iteracion/viabilidad/ui.md.

## Ola 2 (S)
- 6: el draw overlay ya lo pinta el puente (S2, U l.2549-2561). working-dash y mark-region-flash quedan fuera: en Stitch son la región que marca la persona, no la generación, y ningún JS de generación los usa (re-generacion-gap.md). No tienen destino en nuestro builder.
- 9: toast "listo" de 10 s, con "View" solo si el frame está fuera de vista. Rutas en stitch-ui/deob-2026-11-02/webcrack/, verificadas por Orq:
  - disparo: DesignPage-s8oa9o80 :13100-13115 ("New screens are ready", :13110-13112);
  - toast: OutageBanner-foTfEjHF, componente Un en :1696-1717 (View :1698, fuera de vista :1705) y hook Gn en :1727-1741 (duración 10000, :1737).
- 10: tips cada 12 s en orden aleatorio. DP:19244-19284, :51421.
- 13: puntos de pensando. DP:47568-47600, :47714-47726.
- 18: título con shimmer solo si está activo. V0:13887-13895, :14111-14122, :40295-40311.
- 19: agentPendingEnter. DP:13684, :13990, :14161, :14288, :14297, :14354. Cerrada sin código: `@keyframes agentPendingEnter` no existe en los 14 CSS ni en los 188 chunks JS de Stitch capturados, y un animation-name sin @keyframes no anima (https://www.w3.org/TR/css-animations-1/#animation-name); en producción Stitch no la muestra. Evidencia: re-iteracion/re-css-18-19/fila-19-agentPendingEnter.md.
- 22: skeleton. DP:6457-6464, V0:13720, V0RT:8821-8861, LAPP:12614. Va en el frame sin url (hoy shimmer + banner, AC2:361-362).
- 23: barra de progreso del preview. LLAZY:46038-46134.
- 24: auto-follow del chat. V0:12138, :12256-12262.
- 25: notificación del navegador solo si document.hidden y hay permiso. Aprobada por Karen el 2026-11-02.
  - Cuándo se notifica: LLAZY:23621-23735.
  - Hook del permiso: LLAZY:23589-23625. El permiso se lee con useSyncExternalStore sobre Notification.permission (:23589, :23599) y se pide con await Notification.requestPermission() (:23609).
  - Qué dispara el pedido: no hay extract, porque el botón está en un chunk que no tenemos. Se funda en MDN (https://developer.mozilla.org/en-US/docs/Web/API/Notification/requestPermission_static), que exige un gesto del usuario.
  - Nuestro disparador: un botón "Avisarme al terminar" en el composer.

## Ola 3 (M)
- 8: cámara animada de 600 ms, maxZoom 1, preventZoomIn y 650 ms de gracia. I18:11666-11690, DP:33253-33400, SU:876-975. Solo fitScreens al empezar y al cambiar de tamaño. "Seguir lo nuevo" no tiene extract y queda fuera.
- 20: vista larga de carga. DP:6380-6430. Cerrada sin código: en el bundle actual (DesignPage-s8oa9o80, 2026-11-02) la vista larga jh (DP:6378-6430) solo la usa un componente memo sin asignar (deob :6704-6775), así que no se monta; estaba viva en DeNbrR8l (wakaru :59028, :59133) y Stitch la sacó. Lo que hoy se ve es la fila 13. Evidencia: re-iteracion/re-fila-20/fila-20-long-loading-view.md.
- 16, 17 y 21: mapa de pendiente/hecho por tool y pasos con ETA. DP:14164-14215, V0:13738-13750, LEDB:321-349. Fila 16: alcanza con el tipo de pedido que el builder ya conoce al lanzar (use-builder.ts). Filas 16 y 17: el estado pendiente o hecho se toma de tool y kind. Los textos son los labels que ya manda el servidor (stepOf, agent-stream.ts:66-82, traducidos en step-labels.ts); no hay tabla de textos propia. Fila 21: una tabla estática por flujo (T1, follow-up, patch, restore) con estimateMs. El estado sale por índice, como LEDB:388-409, y el formato "Xm SSs" de LEDB:413-422. Filas 17 y 21: usan tool?, el label con path, los stepIds exactos y la regla de omitida (S4). Depende del contrato del evento de fase de S4: S3 ola 3 no pasa a APROBADA antes de que ese contrato esté en S4.
- 5: reveal de imagen. vr-runtime processNextImage, con provider cli.

## Fuera de alcance
- 28: ThinkingText de Lovable.
- 29: Make sin extract.

## Contrato con QA
Cada estado de carga lleva `data-wt-loading="<fila de ui.md>"` en su raíz mientras está visible (arnes.md, A4).

## Archivos (nombrados; nada fuera de esta lista sin pedírselo a Orq)
- components/builder/: agent-panel.tsx (+.module.css), chat-panel.tsx, composer incluido para el botón "Avisarme al terminar" (25); el chip y la cola de S6 también son de UI, así que no hay choque, composer-extras.tsx, canvas-chrome.tsx, next-steps.tsx (+.module.css), versions-menu.tsx, workspace-panes.tsx, builder.module.css, stitch-theme.css.
- lib/: step-labels.ts y un hook nuevo para la notificación.
- artboard-canvas.tsx: la cámara (fila 8), el toast (9), el skeleton del frame sin url (22) y la barra de progreso (23). S2 ya está commiteada (706f775).
- No son de S3: wt-reveal-bridge.ts (S2), element-context.ts y edit-popover.tsx (S6), run-state.ts y run-client.ts (S4).

## Terminado
Captura antes/después por fila y arnés A4.
