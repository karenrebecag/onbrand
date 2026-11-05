# Spec: Porter de los 1765 items React del vault a React + CSS modules sobre el contrato Arc

Slug: porter-1765 | Fecha: 2026-10-16 | Estado: APROBADO
Brief: docs/research/porter-1765.md (APROBADO 2026-10-16, commit 296ff91)
Briefs y specs que NO contradice: docs/spec/catalogo-blob-router.md, docs/adr/0001-dos-capas-layout-inner.md. Contradice a propósito UNA regla de docs/research/runner-e2e-arquitectura.md:110 (ver RF12 y ADR 0002).
Versiones: node=22, bun=1.3.14, react=19.2.8, vite=8.3.0, typescript=6.0.3 (instalado en el scaffold), tailwindcss=3.4.19

Decisiones de Karen ya tomadas; esta spec las implementa, no las reabre:
- Brief D1-D7 aprobados.
- [KAREN:chat 2026-10-16] Los items `fidelity-ok` entran al pool del router sin `verified:true`.
- [KAREN:chat 2026-10-16] Las bandas invertidas NO van a cuarentena: se resuelven con dark mode.
- [KAREN:chat 2026-10-16] Playwright se aprueba como devDep.
- [KAREN:chat 2026-10-16] Hace falta dark mode: tema por alcance (cualquier contenedor), no solo raíz.
- Alcance: ui-react (241) + sections-react (1524). ui-squircle, sections-webflow, buttons/motion-html y motion-gsap quedan fuera, sin bloquearlos.

## 1. Objetivo

Portar una vez, en lote y verificado sin revisión item a item, los 1765 items React del vault a un formato canónico: React + CSS modules que solo consumen el contrato de tokens Arc, con todo texto visible como slot de copy y las deps resueltas. El resultado alimenta el pool del router y es el volcado que más adelante se sube al Blob privado.

Hoy el porte corre en cada emit (`src/catalog/materialize.ts:26`). El runtime importa tooling (`materialize.ts:10`). 80 gate.ok tienen className dinámico sin estilo. El copy baked es inalcanzable. Las 95 bandas `bg-background-alternative` no tienen equivalente, porque el tema oscuro solo existe en `:root` (`foundation.css:82`).

Métrica de éxito (en el corte P4):
- Los 1765 items quedan cada uno en exactamente un estado, y el reporte suma 1765.
- Al menos 774 items (los gate.ok de hoy) llegan a `built` o más.
- Cada `fidelity-ok` tiene 0 colores literales fuera del contrato y 0 textos visibles fuera de `copy`.
- Hay una muestra estratificada del 5% lista para la calibración de Karen.

## 2. Requisitos funcionales

- RF1 (D1) El porter vive en `tools/porter/`, con pasadas puras de 400 líneas o menos, y un CLI `scripts/port.ts`. Las piezas compartidas siguen en `src/catalog` (schema, hash, port-imports). Nada bajo `src/` importa `tools/porter/**` ni `scripts/**`.
- RF2 (D1) `materialize` deja de transformar: copia el artefacto portado desde `out/ported/<slug>/` verificando `outputSha256`. Se corta el import de `scripts/tailwind-to-modules.ts`. Si falta el artefacto, falla con el slug y el comando para portarlo.
- RF3 (D2) Lote único con pasadas en orden fijo: `parse → deps → estilos → tema → texto → manifiesto → emit`. Solo `emit` escribe a disco.
  - Clave de caché por item: `sha256(archivos de origen) + sha256(versión del porter, mapa de tokens, config Tailwind)`. Un item con la misma clave no se reprocesa.
  - Artefactos en `out/ported/` (gitignored).
  - Manifiesto `catalog/ported.json` committeado, ordenado por `library, slug`.
- RF4 (D3) Parse y reescrituras con la TS Compiler API, desde `templates/arc-scaffold/node_modules/typescript`, con ediciones por rango de nodo. Ningún rename por `replace` global sobre el texto.
  - `port-imports` pasa a operar sobre el AST, conservando sus mapas (`KIT_TO_ARC`, `ICON_TO_LUCIDE`, `ICON_TO_BRAND`, `KIT_TO_LOCAL`).
- RF5 (D3) Los argumentos literales de `clsx`/`cn` (strings y objetos con claves string) se reescriben a clases del CSS module. Un argumento no estático manda el item a `quarantined` con motivo `dynamic-classname`.
- RF6 (D4) El mapa de tokens `tools/porter/token-map.relume.ts` se genera desde el preset de Relume 1.3.0 PURO, nunca desde `fixtures/relume-themed/tailwind.config.js`. Es una tabla revisada y versionada nombre → token Arc.
  - Los colores arbitrarios usan ΔEOK al token más cercano, con umbral `TOKEN_DELTA_MAX` en el mapa. Por encima del umbral, `quarantined` con motivo `color-unmapped`.
  - Espacio y tipografía se tokenizan solo con igualdad exacta de valor; lo demás queda literal y no cuenta como fallo.
- RF7 (dark mode, contrato) El tema Arc pasa a ser por alcance. En `templates/arc-scaffold/src/components/arc/foundation.css`:
  - Cada bloque `:root[data-theme="dark"]` pasa a `:root[data-theme="dark"], [data-theme="dark"]`.
  - Se añade `[data-theme="light"]` con los valores claros, para volver a claro dentro de un contenedor oscuro.
  - Las variantes de acento siguen el mismo patrón: `[data-theme="dark"][data-accent="x"]` y `[data-theme="dark"] [data-accent="x"]`.
  - `color-scheme` sigue al tema del contenedor.
  - Ningún token nuevo.
- RF8 (dark mode, pasada `tema`) Una sección cuyo contenedor raíz usa `bg-background-alternative` y/o `text-alternative` NO se traduce a colores: el porter añade `data-theme="dark"` a ese contenedor y elimina esas declaraciones de color. El resto de sus colores ya son tokens. El manifiesto marca `theme: "inverted"`.
  - La cohesión lo lee como `surface: dark` en el tema claro y `surface: base` en el oscuro. El campo `surface` existente lo propone el porter con `manifestOrigin: "derived"` y no pisa uno fijado a mano.
- RF9 (dark mode, página) `templates/arc-scaffold` arranca el tema de página desde `prefers-color-scheme`. Un script inline en `<head>` fija `data-theme` en `<html>` antes del primer pintado, con un override opcional en `localStorage` envuelto en try/catch. Sin toggle visible en esta spec.
- RF10 (D5) La pasada `texto` convierte toda hoja de texto visible en un slot con id estable `<slug>.<ruta-de-nodo>`, y el componente lee `props.copy?.[id] ?? default`. Cubre:
  - JSXText;
  - literales string en `Defaults`;
  - literales en `*-data.ts`;
  - `alt`, `aria-label`, `placeholder` y `title`.
  `inject-copy` se reutiliza sobre `copy`. Un texto que la pasada no puede extraer (por ejemplo, interpolación compleja) manda el item a `quarantined` con motivo `text-unextractable`.
- RF11 (D2) El manifiesto por item en `catalog/ported.json` registra:
  - `slug`, `library`, `outputSha256`, `state`, `reason?`;
  - `slots[]` (id, kind: heading|body|cta|alt|aria…, default, budget);
  - `tokens[]` usados, `deps[]` npm y `theme: "normal"|"inverted"`;
  - `selectorStats` (single-class, combo, descendant, attribute, @container, @keyframes). Es solo una métrica para el emisor Webflow futuro, no un gate.
- RF12 (pool) Estados: `ported → built → rendered → fidelity-ok → verified-sample`, más `quarantined` con motivo en cualquier paso.
  - El pool del router admite `verified:true` O `port.state ∈ {fidelity-ok, verified-sample}`. El campo `verified` existente no cambia y el lote nunca lo escribe.
  - El desempate prefiere `verified` > `verified-sample` > `fidelity-ok`.
  - Contradice runner-e2e:110, así que se registra en `docs/adr/0002-pool-fidelity-ok.md`, que firma Karen.
- RF13 (D6, gate barato) `renderToStaticMarkup` por item, sin navegador. Falla si lanza o si devuelve vacío. Pasa a `rendered-static`, un sub-paso registrado dentro de `built`.
- RF14 (D6, build) Build por lotes de N items (default 100) en una copia temporal del scaffold con una ruta por item. Un `bun install` por copia, no por item. Un item que rompe el build del lote se aísla por bisección y pasa a `quarantined` con motivo `build`.
- RF15 (D6, fidelidad) Playwright (Chromium) renderiza original y portado a 375 y 1280 px. Los anchos son fijos y nunca caen en los bordes 768/992/1280 del preset.
  - `fidelity-ok` exige tres cosas:
    - cajas de los nodos emparejados por ruta DOM dentro de `FIDELITY_BOX_TOLERANCE` (en px y %);
    - todos los slots del manifiesto presentes;
    - ningún overflow horizontal.
  - El render oscuro y el de banda invertida no tienen original. Su gate es: las mismas cajas que el render claro del portado, más contraste WCAG AA (4.5:1 en texto, 3:1 en texto grande) calculado sobre los colores resueltos.
  - Sin pixel diff original contra portado.
- RF16 (D6, regresión) Pixel diff solo portado contra su versión anterior, con baselines generadas en la misma máquina. Es un aviso en el reporte, no un gate.
- RF17 (D6, muestra) Muestra humana del 5%, estratificada por categoría Relume/Arc y por estado. Sale como `catalog/port-sample.md` con una página HTML local de capturas lado a lado. Karen marca ok/no-ok, y el reporte calcula el acuerdo con el gate automático para ajustar `FIDELITY_BOX_TOLERANCE` y `TOKEN_DELTA_MAX`.
- RF18 Reporte `catalog/port-report.md` + `.json`: conteo por estado y por motivo de cuarentena (la suma da 1765), tiempos por pasada y lista de deps npm ausentes por item.

## 3. Requisitos no funcionales

- RNF1 Determinismo: dos corridas con la misma clave de caché dan `catalog/ported.json` y `out/ported/` byte a byte idénticos.
- RNF2 Vault READ-ONLY. Los tests usan `tests/fixtures/vault` vía `WT_VAULT_ROOT`.
- RNF3 Sin red en tests ni en el lote. Playwright usa los navegadores ya cacheados en la máquina.
- RNF4 Archivos nuevos de 400 líneas o menos; comentarios solo con el porqué; HACK con disparador de mejora.
- RNF5 Compatibilidad: no cambian de firma `selectPage`, `composePage`, `cohesionScore`, `routeCandidates` ni `LibraryAdapter`, y los tests actuales siguen verdes.
- RNF6 Sin deps nuevas salvo Playwright (devDep aprobada). La instala Karen (sección 6).
- RNF7 La verificación corre solo en local; el repo no tiene remote ni CI. Crear CI queda fuera.
- RNF8 Sin aserciones de reloj. Los tiempos se imprimen en el reporte.

## 4. Criterios de aceptación

- CA1 (RF1) Dado el repo, cuando corre `tests/porter-boundary.test.ts`, entonces falla si algún archivo bajo `src/` importa `tools/porter` o `scripts/`.
- CA2 (RF2) Dado un slug portado, cuando `materialize` lo copia, entonces verifica `outputSha256`. Con un hash alterado falla con el slug y no escribe.
- CA3 (RF3, RNF1) Dadas dos corridas de `scripts/port.ts` sobre las fixtures, entonces `ported.json` es idéntico byte a byte, y la segunda corrida reporta 0 items reprocesados.
- CA4 (RF4) Dado un fixture con un icono `FaArrowRight` y un string `"FaArrowRight"` en un comentario, cuando corre `deps`, entonces cambia el import y el uso JSX, y deja el comentario intacto.
- CA5 (RF5) Dado `className={clsx("flex gap-4", { "bg-background-alternative": dark })}`, cuando corre `estilos`, entonces queda `clsx(styles.a, { [styles.b]: dark })`. Con `clsx(variable)` el item pasa a `quarantined/dynamic-classname`.
- CA6 (RF6) Dado `text-text-primary` y `border-border-primary`, entonces salen `var(--foreground)` y `var(--border)`. Dado `[#ff00ff]` fuera de umbral, el item pasa a `quarantined/color-unmapped`. El mapa no contiene `#ff6600`.
- CA7 (RF7) Dado `<section data-theme="dark">` dentro de `<html data-theme="light">`, cuando se renderiza, entonces `getComputedStyle(section).backgroundColor` y su `--foreground` son los del tema oscuro, y un hijo con `data-theme="light"` vuelve a los claros.
- CA8 (RF8) Dado un fixture con `bg-background-alternative text-text-alternative` en la raíz, cuando corre `tema`, entonces la raíz lleva `data-theme="dark"`, no quedan esas declaraciones, y el manifiesto marca `theme:"inverted"`.
- CA9 (RF9) Dado `prefers-color-scheme: dark` emulado en Playwright, cuando carga el scaffold, entonces `<html>` tiene `data-theme="dark"` en el primer frame y no hay cambio de tema después de cargar.
- CA10 (RF10) Dado `feature-bento` (con su `*-data.ts`), cuando corre `texto`, entonces "Q3 launch plan" y "New signup" son slots con id estable, y el render con `copy` inyectado ya no los muestra.
- CA11 (RF12) Dado un item con `verified:false` y `port.state:"fidelity-ok"`, entonces aparece en el pool del rol. Con `port.state:"built"` no aparece. `verified` nunca cambia en el lote.
- CA12 (RF14) Dado un lote de 100 con un item roto, entonces 99 quedan en `built` y el roto en `quarantined/build`.
- CA13 (RF15) Dado un portado con un nodo desplazado más allá de la tolerancia, entonces no llega a `fidelity-ok`. Dado un texto oscuro con contraste 3:1 sobre su fondo, entonces queda en `quarantined/contrast`.
- CA14 (RF17, RF18) Dado el lote completo, entonces `port-report.json` suma 1765 y `port-sample.md` tiene el 5% (redondeado hacia arriba) estratificado.

## 5. Datos

`catalog/ported.json`:
```
{ porterVersion, tokenMap: { file, sha256 }, generatedFrom: { vaultRootLabel },
  items: [{ slug, library, cacheKey, outputSha256?, state, reason?,
            slots: [{ id, kind, default, budget? }], tokens: string[], deps: string[],
            theme: "normal"|"inverted", selectorStats: {...} }] }
```
- `vaultRootLabel` es una etiqueta, no la ruta absoluta.
- `catalog/index.json` gana `port?: { state, reason? }` por entrada, con la misma validación de rutas RF14 de la spec del catálogo.

## 6. Dependencias

- Vault READ-ONLY: si falta un item, va a `quarantined/missing-source`.
- TypeScript 6.0.3 y Tailwind 3.4.19 leídos de `templates/arc-scaffold/node_modules` y `fixtures/relume-themed/node_modules`, por los HACK declarados. El disparador de mejora es la evolución D1-D del brief (`package.json` propio del porter), que decide Karen.
- **Playwright (devDep aprobada).** La instala Karen en la raíz: `! cd ~/Desktop/SoftwareDevProjects/web-transformer && bun add -d playwright@1 && bunx playwright install chromium`. Hasta entonces el lote llega a `built` + render estático, y P4 no arranca.
- Deps npm ausentes (react-hook-form, zod, luxon, embla-autoplay, tailwind-merge): esos items van a `quarantined/npm-missing` con la dep nombrada. Instalarlas es decisión aparte.

## 7. Seguridad

`superficie_expuesta: no`. Sin endpoint, auth, upload ni pago.
- El render de verificación ejecuta código del vault en Chromium local, sin red: se bloquean las peticiones salientes en el `page.route`, salvo `localhost`.
- Las rutas del manifiesto se validan dentro del repo y del vault, igual que RF14 de la spec del catálogo.
- El script de tema en `<head>` solo lee `localStorage` y `matchMedia`, sin datos externos.
- No hay secretos nuevos.

## 8. Plan de pruebas

Unit (bun test, fixtures en `tests/fixtures/vault`), un archivo por pasada:
- `tests/porter-boundary.test.ts` (CA1)
- `tests/porter-cache.test.ts` (CA3)
- `tests/porter-deps.test.ts` (CA4)
- `tests/porter-styles.test.ts` (CA5, CA6)
- `tests/porter-theme.test.ts` (CA8)
- `tests/porter-text.test.ts` (CA10)
- `tests/porter-pool.test.ts` (CA11)
- `tests/materialize.test.ts` (CA2)

Navegador (Playwright, local): `tests/e2e/theme-scope.spec.ts` (CA7, CA9) y `tests/e2e/fidelity.spec.ts` sobre 3 fixtures (CA13). El lote completo no es un test: es el comando de P3/P4 y su reporte (CA12, CA14).

Antes de P1 se corren las pruebas de las ASSUMPTION del brief §9, como scripts de medición:
- residuo real de `@kit` después de `portImports`;
- tiempo de la TS API sobre los 1765;
- argumentos de `clsx` estáticos;
- costo de render por item;
- estabilidad del emparejado por ruta DOM.

Sus cifras van al reporte y pueden ajustar N y las tolerancias, sin reabrir la spec.

## 9. Fases (3-5 archivos por cambio, cada una mergeable y verde)

| Fase | Entrega | Archivos principales | Verde = |
|---|---|---|---|
| P0 | Esqueleto, caché, manifiesto, parse; frontera runtime/tooling | `tools/porter/{pipeline,cache,parse}.ts`, `scripts/port.ts`, `tests/porter-boundary.test.ts` + `porter-cache.test.ts`; `src/catalog/materialize.ts` deja de importar `scripts/` | CA1, CA2, CA3; 1765 parseados o en cuarentena con motivo |
| P0b | Dark mode por alcance en el contrato + script de tema | `foundation.css`, `templates/arc-scaffold/index.html`, `tests/e2e/theme-scope.spec.ts` (o test con happy-dom si Playwright aún no está) | CA7, CA9 |
| P1 | deps (AST) + estilos + mapa de tokens + clsx/cn + pasada tema | `tools/porter/{deps,styles,theme}.ts`, `tools/porter/token-map.relume.ts`, tests de cada pasada | CA4, CA5, CA6, CA8; los 774 gate.ok no bajan |
| P2 | texto → slot + manifiesto + pool por `port.state` + ADR 0002 | `tools/porter/{text,manifest}.ts`, `src/catalog/schema.ts` (`port`), `src/adapters/arc.ts` (pool), `docs/adr/0002-pool-fidelity-ok.md` | CA10, CA11 |
| P3 | Build por lotes + render estático + reporte | `tools/porter/{build,report}.ts`, `scripts/port.ts` | CA12; reporte suma 1765 |
| P4 | Fidelidad + contraste + regresión + muestra 5% | `tools/porter/{fidelity,sample}.ts`, `tests/e2e/fidelity.spec.ts` | CA13, CA14. **CORTE: Karen calibra con la muestra** |
| P5 | `materialize` sobre artefactos + manifiesto subible | después del corte; spec aparte con la subida al Blob | fuera de esta spec |

Orden: P0 → P0b → P1 → P2 → P3 → P4. P0b es independiente y puede ir en paralelo con P1. P4 requiere Playwright instalado.

## 10. Decisiones de Karen

- [KAREN:chat 2026-10-16] Pool con `fidelity-ok`: sí, implementado en RF12 + ADR 0002 (la firma Karen).
- [KAREN:chat 2026-10-16] Bandas invertidas: con dark mode, sin cuarentena (RF7, RF8).
- [KAREN:chat 2026-10-16] Playwright: sí, como devDep (sección 6).
- [KAREN:chat 2026-10-16] Dark mode: tema por alcance + página por `prefers-color-scheme` (RF7, RF9).
- Pendiente, no bloquea hasta P5: CI (RNF7, local por ahora).
