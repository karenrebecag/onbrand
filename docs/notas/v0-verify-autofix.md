# v0: cómo verifica y auto-corrige (ingeniería inversa propia, 2026-10-22)

**Fuente:** chat ya generado `https://v0.app/atomchatio/chat/j049syuEqqA` (Nimbus con el DS Carbon, "Worked for 5m 29s", "v0 Max used 2.15 credits"), leído en el Chrome de Karen.
- Solo lectura: se expandieron los pasos del agente en la UI. No hubo corridas nuevas ni créditos gastados.
- Se contrastó con el post público de Vercel `v0-composite-model-family`.

**Etiquetas:** VERIFIED = visto en la traza o en el doc público; INFERRED = deducido.

## Traza completa del agente (VERIFIED, en orden)

1. **Carga y lectura.** Loaded v0-example-carbon design system → Set up environment → Read starter ×5 → Explore • 2 Files ("Read Carbon docs").
2. **Primer chequeo.** Checked icon names ×2.
3. **Escritura, primera tanda.** Wrote header / hero / logos / features / how it works / stats / testimonials.
4. **Corrección a mitad.** Fixed testimonials layout ×2.
5. **Segundo chequeo.** Checked icon names ×2.
6. **Escritura, segunda tanda.** Wrote pricing / FAQ / CTA / footer / page.
7. **Correcciones y estilos.** Fixed logo icons → Updated metadata → Added client directives → Trimmed starter styles → Wrote landing styles → Re-read styles → Wrote landing styles.
8. **Cierre.** Type-checked → Loaded agent-browser skill → Screenshotted page → Aligned pricing switcher ×2 → Tested toggle and mobile → resumen final.

## Qué hace cada paso de verificación (VERIFIED, contenido expandido)

**Checked icon names: verificación contra la FUENTE REAL, ANTES de escribir.**
- Con bash en el sandbox revisa los nombres candidatos contra el paquete instalado:
  - primero `grep -q "\bName\b" node_modules/@carbon/icons-react/lib/index.d.ts`;
  - después `[ -f "$n.js" ]` en `node_modules/@carbon/icons-react/lib`.
- Imprime `ok X` / `MISSING X` y reintenta con otros nombres hasta tenerlos verificados. Ejemplo: Hexagon, Wave, Pentagon, Circle aparecen MISSING y los cambia por HexagonOutline, WaveDirection, CircleDash.
- En la misma pasada lee el `.d.ts` del componente que va a usar: `grep -n "onChange\|selectedIndex\|size" .../ContentSwitcher.d.ts`. Es decir, verifica props contra el tipo real.
- Nunca usa un nombre que no verificó. Es la regla textual de la doc del DS-skill: "if a component, prop, or token can't be verified, should not use it".

**Fixed testimonials layout / Fixed logo icons / Aligned pricing switcher: edición dirigida de un archivo ya escrito.**
- El cuerpo expandido viene vacío: son ediciones de archivo, no comandos.
- Las dos primeras ocurren durante la escritura, sin screenshot previo.
- "Aligned pricing switcher" ocurre después de "Screenshotted page", así que es una corrección visual (INFERRED por el orden).

**Added client directives: corrección por regla del framework.**
- Antepone `'use client'` a los archivos de sección que usan estado. Es un fix determinista por convención de Next RSC.
- En la misma pasada borra los archivos de demo del starter (foundations.tsx, component-showcase.tsx…).

**Trimmed starter styles / Re-read styles.** Recorta el globals.scss del starter hasta su marca `// Hero` y vuelve a leerlo antes de reescribir. Limpia el residuo del starter.

**Type-checked:** `npx tsc --noEmit | head -30`, el gate de tipos al cierre.

**Screenshotted page:**
- `agent-browser open localhost:3000`, viewport 1440x900;
- `wait --text "Ship together"`, es decir, espera texto propio de la página, no el del starter;
- `screenshot --full`;
- `agent-browser errors`.

**Tested toggle and mobile:** `agent-browser find role tab click --name "Monthly"`, `get text ".pricing-grid"` (comprueba que el precio cambió), viewport 375x800 y screenshot. Es una prueba de comportamiento, no solo visual.

**Resumen final:** el agente declara lo que quedó inventado ("all customer names, quotes, stats and prices are invented"), lo que no está conectado (footer, CTAs) y una limitación (sin menú móvil).

## Modelo compuesto (VERIFIED en el doc público, no visible en la UI)

`https://vercel.com/blog/v0-composite-model-family`:
- AutoFix (`vercel-autofixer-01`) revisa el stream MIENTRAS se genera;
- una pasada final atrapa lo restante;
- un linter corre sobre la salida.

En la UI no aparece como paso: es invisible, a nivel de stream (INFERRED: los "Fixed …" de la traza son del agente, no del AutoFix).

## Observación

En el preview de este chat, el header y el hero todavía muestran el demo del starter ("Carbon Design System", "v11", "View on GitHub"), aunque el resumen describe un hero de Nimbus y el screenshot esperó "Ship together".
- Puede ser que el preview muestre otra versión (INFERRED, sin verificar).
- La lección vale igual: **el residuo de la demo del starter es un fallo que hay que medir, no suponer resuelto**. Nuestro render-gate lo mide.

## Lo que replicamos (`src/runtime/verify.ts`)

| v0 | nuestro |
|---|---|
| Checked icon names: nombres y props contra node_modules / `.d.ts` | `verifySection`: cada componente contra `allowlist.json`, cada prop contra el schema COMPLETO (tipo, enum, required, minItems, additionalProperties, dentro de items y objetos anidados) |
| No usa lo que no verificó | Violación + `feedback` para el reintento; nada pasa "porque parece razonable" |
| AutoFix determinista en el stream | `fix`: quita props inventadas y callbacks (no viajan en JSON) solo si así la sección queda limpia |
| Fixed X layout (reescribe la sección) | Reintento de la sección con `feedback` (lo llama el loop de orq) |
| Sección vacía (nuestro caso nimbus/testimonials) | `empty-section` → reintento |
| Anidar solo donde el tipo lo admite | `nesting-not-accepted`: `$component` solo bajo props `accepts` o nodos ReactNode del schema; el anidado se valida también |
| Linter final | `lintPage`: re-verifica todas las secciones y detecta roles repetidos |
| Texto inventado declarado | `placeholder-text`: rechaza el relleno de librería (lorem, "goes here") |
| Residuo del starter (lo que el preview de v0 dejó) | `propless-as-content` (un propless siempre pinta su demo) y `demo-fallback` (organismo sin `title` cae a su demo); `missing-required` cubre listas obligatorias como `features` o `brands`. El resto lo mide el render-gate |
| Type-checked / Screenshotted / Tested | Ya existen: tsc del scaffold + render-gate (residuo, imágenes rotas, visibilidad). Se enchufan al cierre del loop |

**Hallazgo al replicar:**
- 143 de 163 schemas no traen `children` (solo listan props propios), pero 20 componentes lo heredan de `HTMLAttributes`.
- `build-ds-skill` ahora lo agrega a `accepts` cuando la interfaz extiende `*HTMLAttributes`/`ComponentProps` sin `Omit<…"children">`. Si no, el verify rechazaría `<Button>Empezar</Button>`.
