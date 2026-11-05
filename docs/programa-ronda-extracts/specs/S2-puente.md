# S2 Puente del preview
Estado: APROBADA · Dueño: UI

## Objetivo
Animar lo que monta durante el turno como Stitch, sin remontar el iframe en cada versión.

## Fundamento
Archivos (stitch-ui/bundles-2026-11-02/):
- R = UgcTrustBanner-ClT5SnxT/renderer/webcrack/deobfuscated.js
- U = UgcTrustBanner-ClT5SnxT/webcrack/deobfuscated.js
- DP = DesignPage, webcrack

Líneas:
- El fin del stream deja terminar la cola: R l.1001-1017.
- Tope de 2 animaciones por elemento: R l.458-462.
  - Stitch limpia el contador solo en las dom_operations del agente (R l.3993-3995). Nosotros no tenemos ese evento, así que lo limpiamos al empezar cada generación. Es una adaptación declarada.
- El cursor salta al primer elemento del lote y queda visible: R l.240-248, l.478-481.
- El desarme espera a que termine el fundido del último rectángulo, 0.5 s: hideCursorIfIdle y elementDrawRunning (R l.240-248), border-fade (U l.2549-2561).
- z-index 998/9999: U l.2554, l.2598.
- No remontar: Stitch conserva el mismo iframe y reescribe con opacidad 0 hasta load o 1000 ms (DP:7466-7486). La versión nueva la trae el HMR (https://vite.dev/guide/api-hmr).
- Handshake: no hay extract del mecanismo (DP:7449-7495 solo muestra que el runtime viaja en cada HTML). Se funda en MDN postMessage (https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage) y en el evento load del iframe, que llega una sola vez si no se remonta.

## Cambios
1. wt-reveal-bridge.ts:
   - flush al fin del stream;
   - tope de 2 animaciones;
   - cursor;
   - desarme después del fundido;
   - z-index;
   - mensaje wt:bridge-ready al instalarse.
2. templates/arc-scaffold/src/shims/next-image.tsx: el diferido de arriba.
2b. apps/builder/src/lib/use-builder.ts y App.tsx: solo el contador de restores (sale de S3 mientras dure S2).
3. artboard-canvas.tsx:
   - sin key={version};
   - resetSizes solo si cambia la url;
   - responde a wt:bridge-ready con generating y select-mode.
3. **Imágenes que llegan después (patrón diferido de Stitch, sin reintento):**
   - Dónde se difiere: en el shim de imagen del scaffold, templates/arc-scaffold/src/shims/next-image.tsx. Es el `<Image>` del DS que el agente usa con data-alt (agent-prompt.ts:63-64).
     - Con React, el `<img>` nace con el src del JSX y el navegador lo pide en el acto. El MutationObserver del puente llega tarde. Por eso el diferido tiene que ocurrir donde se crea el nodo.
     - Stitch lo hace en su diff del HTML (vr-runtime :583-590); nosotros, en el componente. Es una adaptación declarada.
   - Regla del shim: si tiene data-alt, estamos en import.meta.env.DEV y el puente marcó la generación en curso (flag de window que pone el puente con wt:generating), renderiza src=placeholder y data-wt-pending-src=src real. Si no, renderiza el src real: follow-ups con la imagen ya existente, y build de producción.
   - Al llegar wt:images-ready, el puente aplica el src.
     - Extract: vr-runtime webcrack :182 (PLACEHOLDER_IMG), :583-604 (PENDING_SRC) y :3129-3131 (pending a src).
     - Stitch no reintenta un src que falló (:586, failedSrcs). Por eso nosotros nunca pedimos el src real antes de que exista, y no hace falta cache-bust.
     - Que asignar src dispara la carga lo dice la HTML spec, "update the image data" (https://html.spec.whatwg.org/multipage/images.html#update-the-image-data).
   - El evento wt:images-ready lo manda el builder por postMessage cuando ve el step.end de `agent:images` en el run (artboard-canvas.tsx lee los steps; run-state.ts no se edita).
   - Las imágenes de generate_image (S5) ya existen cuando se escribe el hero: no llevan data-alt y cargan directo.
4. Un helper puro para elegir qué <img> se difieren y cuáles se aplican, testeable sin DOM, igual que admit.
5. tests/preview-reveal-bridge.test.ts: el tope de animaciones y el helper de diferidos.

## Riesgo declarado
- index.html va primero (S1) y produce 1 full-reload antes de la primera sección. El puente se reinstala, vuelve a mandar wt:bridge-ready y la cola todavía está vacía. Sin pérdida.
- Restaurar una versión (restoreTree, transport.ts:996) escribe y borra muchos archivos de golpe. Ahí **se mantiene el remonte**: la key es un contador de restores que lleva use-builder (launch con restoreFrom, use-builder.ts:223-224), no la versión.
- discardChanges (transport.ts:842, :1064, :1173, :1193, :1212) es interno, porque vuelve el workspace a la head cuando hay stop o error. No tiene señal en el builder y no remonta. Si produce un full-reload, se acepta: no es un turno con versión.
- Editar texto ya no recarga el iframe: lo trae el HMR. El turno siguiente tampoco recarga, así que el puente conserva su estado. Es lo que se busca.

## Fuera de alcance
- SCROLL_TO: el frame mide el alto real.
- Reveal de imagen: S3.

## Terminado
- Test del puente en verde.
- Captura antes/después.
- Arnés A3. Depende de S1: antes de S1 solo se ven el flush del final y el cursor.
