# S5 Tooling del agente
Estado: APROBADA · Dueño: ec · UI de builder: UI, dentro de S3, con el contrato que fija S5

## Objetivo
Darle al agente las tools que tienen las referencias y nos faltan, con el contrato sacado del código desofuscado. Detalle en viabilidad/ec.md §Ronda 2.

## Cambios
1. data-alt, citas (cada una respalda una cosa distinta):
   - **el atributo data-alt con el prompt:** solo en la salida capturada de Stitch, stitch-ui/d-screen-code.html (6 img data-alt). Ningún bundle de cliente lo lee. Lo cita agent-prompt.ts:63, junto con el cambio 2;
   - **que la imagen llegue después y se aplique en su lugar:** vr-runtime webcrack (stitch-ui/deob/webcrack/vr-runtime/deobfuscated.js) :182 (PLACEHOLDER_IMG), :583-590 y :3129-3131 (PENDING_SRC a src), verificado por Orq. Lo cita image-slots.ts, ahora.
   El llenado es implementación propia: el de Stitch ocurre en su servidor.
2. generate_image y edit_image como tools MCP del agente, con aprobación. La tool devuelve **solo texto con target_path**, sin bloque image: las imágenes no entran al contexto del agente (vision.ts:1-4, Audit-2: ~448 k tokens releídos por llamada). El paso del builder muestra la imagen leyéndola del preview.
   - prompt: MediaGenerationApprovalCard deob :153;
   - edit_image (mode inpaint, mask_path, transparent_background, target_path): registry :4892-4899 y app-lazy-shared :21603;
   - target_path: siempre en public/images/ y se usa como src string, nunca con import. Es una adaptación declarada: Lovable importa desde src/assets (ZAP 1854), y eso choca con la regla de imports de S1;
   - model, width y height: sin extract. Se usa la documentación del provider en uso (AI Gateway image, bfl/flux en image-step.ts:14), con URL y sección;
   - aprobación una vez o siempre, con nota de créditos: :133-196, persistida en approvals.ts. Usa kind 'spend', que agrega S4;
3. Enhancer de prompt: usePromptPreview :22-43 (system prompt), :44-89 (stream, abort, uno a la vez), :962-976; PostMessageClient :919-928. El modelo no tiene extract: documentación de AI Gateway.
4. Variantes: el prompt sale de DesignPage-s8oa9o80 :34420-34475 (aspectos fM, prompt pM, refine/medium/yolo, 2-5 vía variantCount). Las N generaciones las hace el servidor de Stitch, así que no tienen extract. Hueco: solo se implementa el prompt; correr N veces espera documentación o una decisión de Karen.

## Archivos
- workspace-tools.ts y workspace-mcp.ts: generate_image y edit_image.
- approvals.ts.
- image-slots.ts.
- agent-composer.ts:220-236 (preflight).
- Un módulo nuevo para el enhancer.
- agent-prompt.ts: después de que S1 esté commiteada.
- transport.ts:1351 y el endpoint del enhancer: en el turno de transport que fije Orq, después de S4.
- Builder (tarjeta de aprobación, botón del enhancer, UI de variantes): UI, en S3 ola 3.

## Enmienda de ADR 0011 (la firma Karen)
Decisión de Karen del 2026-11-02: generate_image reemplaza al preflight de imagen de producto en el T1. Los slots data-alt quedan de respaldo hasta que lo mida el arnés. Es una enmienda de ADR 0011 en § entradas del turno: la imagen deja de ser un dato que llega antes del turno y pasa a decidirla el agente. Karen firma el texto de la enmienda al aprobar esta spec.

Reglas que trae el cambio:
0. **Reemplazo, no suma:** con la tool activa, el preflight de agent-composer.ts:226 se apaga. Hoy corre siempre que hay imageGeneration y, sin ese gate, el T1 generaría la imagen dos veces. Para el hero se usa la tool o los slots, nunca los dos.
1. **Aprobación en el T1:** preaprobada cuando el turno corre con imágenes habilitadas (hoy --images). Esa es la opción de la persona. La tarjeta "una vez / siempre" aplica en los follow-ups. Es una adaptación declarada: la política del T1 de Lovable no tiene extract. Sin esto, el T1 se frena esperando a la persona.
2. **Fallo de la tool (403 o cuota):** regla en el prompt: sin imagen, el producto va en código y sin data-alt. Hoy eso depende de productImage (agent-composer.ts:224-227).
3. **Orden con S1:** el agente llama a generate_image antes de escribir el hero y escribe el hero con la ruta que devuelve. Nunca un <img> sin archivo.
4. **Código que se va:** req.productAsset (el preflight en paralelo en el transport), productImageHook, .wt/image-plan.json, wantsProductImage(direction) y el bloque "Imagen de producto ya generada / No hay imagen generada" de agent-prompt. El plan de imagen con haiku (#384) pasa al modelo del agente. El costo por T1 se mide en A7.
5. **agent-prompt.ts:** S5 solo toca el bloque de imágenes.
6. **slotsOn sigue con guarda:** si generate_image falla (403 o cuota) en workspace-mcp, el transport se entera y apaga slotsOn. Así fillImageSlots no corre contra el mismo fallo. Hoy lo hace el preflight en agent-composer.ts:224-227.
7. **Señal de la dirección:** wantsProductImage(direction) (directions.ts:279) no se borra. Cuando es false, el prompt dice "esta dirección no lleva imagen de producto en el hero".
8. **Los dos gates del preflight se apagan:** agent-composer.ts (`heroImage = !direction || wantsProductImage(direction)`, directions.ts:279) y transport.ts:1353 (imageJob en paralelo con el DS).
9. **Archivos en public/:** un archivo nuevo en public/ no dispara módulos ni reload (vite 8.3.4 node.js:25045-25061, :25576-25583). Por eso la regla 3 exige generar antes de escribir el <img>.
10. **Pre-aprobación del T1:** viaja como followUp=false desde agent-composer.ts:206 hasta approvals.ts. Una pre-aprobación del T1 no persiste un "siempre".
11. **Rastro del prompt de imagen:** los args de generate_image quedan en el stream del turno. Reemplazan a .wt/image-plan.json como diagnóstico (caso 999ea0e0).

## Gasto
Cada generación de prueba de ec necesita el OK de Karen en su sesión. El caso A7 lo corre Orq con su autorización local.

## Terminado
- Tests: schema de args, rechazo sin aprobación, aprobación "siempre" persistida, abort del enhancer, y el prompt de variantes (aspectos, MUST NOT, rango).
- Arnés A6, más A7: un T1 en el que el agente llama a generate_image y la imagen queda en el hero. El tiempo del T1 contra 56644d79 se registra como observación: la tool bloquea al agente mientras genera y el preflight corría en paralelo.

## edit_image ahora
[KAREN:chat 2026-11-02] "tienes extracts completos para gen_image y edit_image? si sí, dale de una vez". Extracts del cliente: registry :4867-4902 (tool id, aprobación narrowed con alwaysAllowSpendsCredits, tres modos por label: inpaint o mask_path, transparent_background, edición simple), app-lazy-shared :21563-21603 (target_path del tool call, salida "saved to: <ruta>"). El schema de args vive en el servidor de Lovable: el nombre del parámetro de la imagen de origen es adaptación declarada. Llamada al modelo: AI SDK 7 node_modules/ai/docs/07-reference/01-ai-sdk-core/10-generate-image.mdx (prompt {images, text, mask}) y node_modules/ai/docs/03-ai-sdk-core/35-image-generation.mdx §Checking Image Editing Support (supportsFileInputs, supportsMaskInputs; solo `true` cuenta). Sin extract ni doc estándar para transparent_background: ese modo queda fuera hasta tener doc del provider.

## Variantes: en paralelo, como Stitch
[KAREN:chat 2026-11-02] "bien, entonces vamos así", sobre la propuesta de re-iteracion/re-variantes/README.md §5. Extract: una StreamCreateSession con variantCount en la posición 7 del input (ZAP 26790; T1 24252 lleva 1); en el primer snapshot dos `edit_html_full_regen` en curso a la vez; un prompt propio por variante; placeholders que se llenan intercalados y terminan en el orden en que acaba cada generación. Implementación: un turno con variantsPrompt (82194b2) y variantCount; el agente escribe un prompt por variante, se crean N marcos SideBySide (I18nStore :22402-22502, 64 px) y las N generaciones corren concurrentes. Reemplaza la opción "serie" del cambio 4.
