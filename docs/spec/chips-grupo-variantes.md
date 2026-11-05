# Chips de follow-up al cerrar un grupo de variantes (unidad 4 del módulo builder)

Estado: PROPUESTA hasta el punto de decisión (§4). Decide Karen el gasto; lo lleva Orq. Arq, 2026-11-04, main al día.
Base: `docs/notas/siguiente-modulo-builder.md` (unidad 4).
Extract: `re-iteracion/stitch-ui.md` §5 ("D (nuevo)", captura `stitch-ui/d-11-variants-final.png`).

## 1. Qué hace Stitch

Al terminar Variations aparecen sobre el prompt unos **chips de follow-up numerados y escritos para el grupo**, por
ejemplo "¿Cuál de los dos layouts…" (1) y "¿Ajustamos alguna sección…" (2) (`stitch-ui.md` §5, observado en vivo). No
hay extract del código que los genera: no sabemos si sale de una llamada aparte ni con qué modelo. Lo único que hay es
el resultado visible.

## 2. Qué hacemos hoy (leído del código; QA lo confirma, §5)

- Cada variante es una corrida de agente completa: `variants.ts:186` crea la entrada con `prompt`, y el cierre pasa por
  `run-close.ts:358-364`. Ahí `suggest` corre cuando el turno es del agente, `finishReason === 'stop'`, no falló, no se
  interrumpió y tiene `prompt`. **Por lectura, ya se gasta una llamada de sugerencias por variante**, es decir N por
  grupo (N de 2 a 5).
- Esas sugerencias son de cada variante como página suelta (el `SYSTEM` de `suggest.ts:30-35` pide "3 pasos para la
  página entera"). Ninguna habla del grupo ni compara variantes.
- El chat muestra los chips del mensaje visible (`chat-panel.tsx:210,268`). Que muestre o no los de cada variante
  depende de qué mensaje esté visible al cerrar el grupo: hay que verificarlo en la UI.
- Modelo: `haiku` (`scripts/serve.ts:114-115`, OK de Karen del 2026-10-29 para "una llamada de haiku por turno"). Con el
  proveedor `cli` corre por la sesión de Claude Code; con `gateway`, `anthropic/claude-haiku-5.5` (`infer.ts:142-146`).

## 3. Cifras por llamada

Estimadas del código, no medidas. No hay logs de un grupo con `agent:suggestions` en las raíces locales; ver §5.

| | valor | de dónde sale |
|---|---|---|
| Entrada | ~1.500 tokens (sistema ~1.300 caracteres + prompt + resumen del agente) | `suggest.ts:21-35`, `SuggestInput` |
| Salida | ~300 tokens (3 chips de título + mensaje) | `MAX_SUGGESTIONS`, `MAX_TITLE = 40` |
| Precio Haiku 5.5 | US$ 0,10 por M de entrada, US$ 0,50 por M de salida | tabla de precios de Anthropic (caché 2026-10-06); el Gateway cobra lo mismo sin markup (memoria del deploy) |
| **Costo por llamada (gateway)** | **≈ US$ 0,0003** | 1.500 × 0,10/M + 300 × 0,50/M |
| Costo por llamada (`cli`, perfil de la distro hoy) | sin cobro por token: consume la cuota de la sesión de Claude Code | `config.ts`, `composeProvider: 'cli'` |
| Tiempo | 27-52 s por llamada con `cli`; no bloquea la versión (evento tardío) | `AUDIT-COSTO.md:86` y `AUDIT-COSTO-SINTESIS.md:15` |

Un grupo de 3 variantes hoy (por lectura): 3 llamadas, ≈ US$ 0,0009 con gateway.

## 4. Decisión (Karen)

| opción | qué hace | llamadas por grupo de N | costo por grupo (gateway) | fidelidad |
|---|---|---|---|---|
| **a. Una llamada más, de grupo** | Al cerrar el grupo, un `suggestGroup` con los títulos y resúmenes de las N variantes pide 2-3 chips que comparan o eligen. Las N por variante siguen | N + 1 | ≈ US$ 0,0003 más que hoy | la de Stitch (chips del grupo) |
| **b. Reemplazar las N por una de grupo** | Las variantes dejan de sugerir cada una (`run-close` salta `suggest` si `variantOf`), y al cerrar el grupo corre una sola de grupo | 1 | ≈ US$ 0,0006 menos que hoy con N = 3 | la de Stitch, y se pierden los chips por variante |
| **c. Sin modelo** | Al cerrar el grupo, chips fijos derivados del grupo: "Seguir con «<título de la variante k>»" por variante, más "Combinar lo mejor de las variantes". Las N por variante siguen | N | 0 más que hoy | parcial: los chips no los escribe un modelo, y el texto fijo no tiene extract |

**Recomendación de Arq: (b).** Hace lo de Stitch, gasta menos que hoy, y los chips por variante, que hoy nadie compara,
no se echan de menos si el chip del grupo nombra las variantes. Necesita el OK porque cambia lo que Karen aprobó el
2026-10-29 ("una llamada por turno") a "una por turno, salvo las variantes, que llevan una por grupo".

Lo que no cambia con ninguna opción: las sugerencias nunca bloquean la versión (van después del commit, como #394), y
fallar las sugerencias no falla el grupo.

## 5. Antes de implementar (cualquier opción)

1. QA cuenta en el próximo grupo real los `step.end` de `agent:suggestions` por variante: confirma o corrige el "N por
   grupo" de §2. El grupo es gasto que Karen ya aprueba al pedir variantes; no se lanza uno solo para medir.
2. UI verifica qué chips ve hoy la persona al cerrar un grupo (§2, tercer punto).
3. Con la cifra medida, este §3 se actualiza y la decisión se toma con el número real.

Lo que sigue a la decisión (contrato de `suggestGroup`, dónde se dispara en el cierre del grupo con su id de generación
A7, evento, chips en `next-steps.tsx` y tests) se escribe cuando Karen elija.
