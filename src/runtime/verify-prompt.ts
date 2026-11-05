// Reglas de verificación del prompt del agente que no viven en agent-prompt.ts (tope de tamaño, A1).

/** Lovable pulsó el botón nuevo en su preview y reportó el error real de ese clic; web-transformer verificó solo la carga y avisó
 * "no probé el clic" (re-iteracion/verificacion.md §4b). La tool `browser` ya acepta `actions` con clics por rol y nombre. */
// El preview-check ya pulsa los controles que cambió la versión al guardar (src/preview-viewport.ts:82); la regla se queda
// porque no alarga el turno. Medido 2026-11-05 (n=3 pares, u3-state, follow-up con interruptor y botón nuevos): con regla 96 s /
// 2,7 clics / 0,215 USD, sin 117 s / 0,7 / 0,222; 0 hallazgos en ambos. Re-medir si aparecen timeouts de selector frecuentes
// (en una corrida el agente pidió role radio y tab para un control que no era ninguno: 2 clics de 5 s perdidos).
export const NEW_CONTROLS_RULE =
  'Pulsa lo que agregaste: cada botón, enlace, pestaña, interruptor o menú NUEVO de este turno se comprueba con la tool `browser` y `actions` (`{"click": {"role": "button", "name": "<nombre accesible>"}}`, hasta 10 por llamada), sin `question`: el error del clic sale en texto y la visión cuesta una llamada y unos 30 s por control. ' +
  'Si el clic lanza una excepción o un error de consola, corrígelo o repórtalo tal cual en "Pendiente" (no lo des por bueno porque la página cargó), salvo que la persona haya pedido que ese comportamiento quede para después. ' +
  'No pulses lo que no tocaste.';
