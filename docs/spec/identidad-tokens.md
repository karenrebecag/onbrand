# Spec — Capa de identidad por tokens (D3)

**Estado:** APROBADA (Karen, 2026-10-20) — consenso de ambas sesiones, evidencia verificada en código.
**Arnés:** el render-gate (`scripts/render-gate.ts`) + banco de briefs ya existen (equivalente a M-1, construido en R1/R2). El "terminado" de abajo se expresa como casos del gate, no como "compila".

## 1. Objetivo
Que la identidad de marca llegue a la **forma** (radio, escala tipográfica, densidad), no solo al color, movida por el brand pack y medida — convertir "dos marcas → la misma página en B&N" en "dos marcas → forma medidamente distinta".

## 2. Decisiones que implementa
- **D3** (capa de identidad por tokens). Patrón: *global scale factor* (Radix Themes). Evidencia: Radix `packages/radix-ui-themes/src/styles/tokens/{radius,typography,space}.css` @ `79b2ae871b3e` (MIT) — `--radius-N: calc(Npx * var(--scaling) * var(--radius-factor))`, `--font-size-N`/`--space-N: calc(Npx * var(--scaling))`. Nuestro contrato ya consume estos ejes: `foundation.css:61-70`, 812 usos de `var(--…)` en bloques. El pack ya puede pisar tokens del allowlist: `brand.ts:136` (`contractTokens` deriva de foundation.css) + `brand.ts:148-160` (`parseTokens`).

## 3. Requisitos funcionales
- **RF1** — foundation.css expresa la escala de forma como `calc(base * var(--scaling) * var(--radius-factor))` (radios) y `calc(base * var(--scaling))` (`--text-*`, `--space-*`, `--control-height-*`), con `--scaling:1` y `--radius-factor:1` por defecto.
  - **Se factorizan:** `--radius-control/panel/surface`, `--space-1..24`, `--text-xs..5xl`, `--control-height-sm/md/lg`.
  - **Se dejan fijos:** `--radius-pill:9999px`, `--shadow-*` (Fase 2), `--duration-*`/`--ease-*`/`--tracking-*`/`--leading-*`, y `--text-secondary`/`--text-muted` (son COLORES pese al prefijo `text` — excluidos de la regex o se rompe el tema).
- **RF2** — `--scaling` y `--radius-factor` se declaran en `:root` de foundation.css → entran al allowlist; el pack los fija vía `tokens`. Como son factores con default 1 (no identidad), `brandCoverage` las trata como **cubiertas por default** (`FORM_LEVERS` en brand.ts): un pack que no las fija no rompe C1; uno que las fija las cuenta como identidad real (entran a `defined`). **Enmienda (b), aprobada por Karen 2026-10-20**, sobre la (a) original (declararlas en el `inherit` del Base): el Base vive en un repo hermano **sin git**, así que el fix tenía que vivir en web-transformer, versionado y visible a CI, no en una carpeta sin historial. Guarda: `tests/brand-base-coverage.test.ts` carga el Base real y falla nombrando el token si una adición futura al contrato lo deja sin cubrir.
- **RF3** — Un brand pack de control real (fuera de git) fija `--scaling`, `--radius-factor`, ≥1 `--text-*`/`--space-*` y `composition` (density + fuentes). Es autoría, no código.
- **RF4** — El render-gate añade, por bloque: (a) **vector de estilos computados** (border-radius, padding, gap, font-size, line-height, margin, height, width, box-shadow, duration); (b) **entrega por eje** = cuántos elementos responden al mover un solo eje del pack; (c) **distancia de forma** entre dos packs sobre brief+selección fijos; (d) **conteo de literales de forma por bloque** (explica el techo).
  - **Entregado v0:** (c) la distancia con clasificación **factor / override / quieto** a nivel de token (`scripts/form-distance.ts`, caso CA3) — resuelve en px reales y separa la palanca global del override literal del pack (S2). (a) styleVector, (b) entrega por eje y (d) conteo de literales **por bloque** quedan pendientes: requieren el render-gate en rama (hoy vive sin commitear en otro worktree). Son seguimiento, no de este PR.

## 4. Requisitos no funcionales
- **RNF1 (invariante)** — Con `--scaling:1`/`--radius-factor:1`, los valores computados son idénticos a hoy. Se prueba con **snapshot de estilos computados** (no con el gate, que es ciego a la forma).
- **RNF2** — Determinismo: mismo pack dos veces → mismo vector.

## 5. Criterios de aceptación (casos del arnés)
- **CA1 (RNF1, PRIMER COMMIT):** dado el pack Base, cuando se compara el snapshot de estilos computados (border-radius, padding, gap, font-size, margin, height, width) por elemento de pulse antes/después de RF1, entonces **0 diferencias**. Es la prueba del invariante; "el gate pasa" NO cuenta (ciego a la forma).
- **CA2 (RF3/RF4b):** dado el pack control con `--scaling` y `--radius-factor` altos, cuando se mide entrega por eje, entonces **N/M elementos** de la superficie del brief cambian font-size/radio, reportado como número.
- **CA3 (RF4c):** dados pack Base vs control sobre pulse con selección fija, entonces la distancia de forma **> 0** y es atribuible a radius/text/space (no a acento). Resultado medido 2026-10-20 (Base vs Rotundo, pulse-completo, 11 slugs iguales, mismo accent neutral): **27 tokens distintos — 26 por el factor global** (radio ×1.84, espaciado/tipografía ×1.15) **y 1 (`--text-5xl`) por override literal** (S2, no escala). Es la distancia, **no** aún la métrica de entrega del factor: esa la da RF4 clasificando factor / override / quieto, para no contar el override dos veces.
- **CA4 (RF4d):** el reporte lista literales-de-forma por bloque; se ve cuánta forma responde al factor global y cuánta queda en literales.

## 6. Datos
Sin entidad nueva ni migración. foundation.css cambia expresión de tokens (mismos nombres/valores por defecto). render.json gana `styleVector`, `delivery`, `literalCount` por bloque. Reversible.

## 7. Dependencias
Ninguna dep nueva (bloqueado). El factor global es CSS puro; el vector usa el chromium ya instalado del render-gate. **Riesgo T1 (verificado):** 18-38 `calc()` propios en CSS de Arc leen el token ya escalado → el factor no los rompe; única excepción, mezcla literal+token (p.ej. `stats-band.module.css:40` `calc(56px + var(--space-8))`) → desproporción leve. Se lista, no se arregla en v0.

## 8. Seguridad
`superficie_expuesta: no`. El brand pack es dato autorado interno pero es frontera de confianza (sus valores van a `:root`). Mitigado: `parseTokens` (brand.ts:148-160) valida contra el allowlist y rechaza `;{}@`, `url(`, `expression(`. `--scaling`/`--radius-factor` quedan bajo el mismo guard; `"1.05"` pasa, una inyección no. Sin secretos nuevos, sin superficie pública nueva.

## 9. Fuera de alcance (v0)
Tokenizar los **785 literales de forma** (padding/gap/margin/width/height/border-radius) repartidos en los bloques — es **Fase 2**, acotada a la superficie del brief de los 10 bloques emitidos. v0 entrega el factor global + la medición que cuantifica cuánto falta; no se vende que v0 deje la forma completa.

## 10. Riesgos
- El factor global cambia ~la mitad de la forma; la otra mitad son literales (Fase 2). "Forma medidamente distinta" de v0 puede quedar a medias — por eso CA4 reporta el conteo, para decidir Fase 2 con dato.
- Mezcla literal+token en ~1 caso (T1) → desproporción menor; listado.
- **S2**: un pack que pisa un token factorizado con un literal (p.ej. `--text-5xl: 5.5rem`) pierde la palanca para ese token (deja de escalar). Es contrato, no bug; al medir distancia, ese token cuenta como movido por el override, no por el factor global.
- **S3**: `composition.density` cambia el perfil de ritmo y puede mover la **selección** de bloques en otros briefs. Para medir **forma pura** (CA3) el pack de control no debe fijar density; para medir identidad completa, sí, declarando que mueve selección. En pulse-completo la selección coincidió (11 slugs iguales, verificado).

## 11. Plan de pruebas
- **Unit:** `parseTokens` acepta `--scaling`/`--radius-factor` y rechaza un valor malicioso.
- **Snapshot acotado:** CA1 (invariante, 0 diffs). **Excepción autorizada** a `common/testing.md` ("sin snapshots nuevos salvo que se pidan"): el invariante es de FORMA y solo es observable en los estilos computados — no hay aserción de comportamiento que lo pruebe sin leerlos. El snapshot se **acota a las propiedades del invariante** (border-radius, padding, gap, font-size, margin, height, width), no al árbol entero, para que no se rompa por cambios ajenos. Autorizada por Karen (feedback: romper reglas de testing donde sea necesario y prudente).
- **Render (gate):** CA2, CA3, CA4. Captura Base vs control lado a lado.

## 12. Archivos (v0)
`templates/arc-scaffold/src/components/arc/foundation.css` (RF1; desde el alpha en la distro, el core usa `templates/base-scaffold/src/theme/tokens.css`), `src/brand.ts` + `scripts/compliance.ts` (RF2 b + denominador C1b), `scripts/token-probe.ts` (arnés), `scripts/form-distance.ts` (RF4c), `tests/token-invariant.test.ts` (CA1), `tests/brand-base-coverage.test.ts` (guarda b), `tests/form-distance.test.ts` + `tests/fixtures/brand-rotundo.json` (CA3). El pack de control real queda como autoría fuera de git; el fixture es su gemelo mínimo para CI.

## 13. Git / entrega (estándar nuevo de Karen)
QA y commits en local. Push/PR + `gh pr merge --auto --squash` SOLO con el criterio de terminado (CA1-4) verificado por Secondary y QA al 100%. CI es el gate del merge. Un implementador por spec aprobada, en su worktree; si algo no está en la spec, se detiene y reporta.
