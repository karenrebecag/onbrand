# Spec — hero-signup con prueba social opcional (fork en el vault, opción C)

**Estado:** BORRADOR — redactada por WebTransformerSecondary 2026-10-21 contra main `8efcae7`; pendiente de choque por orqWebTransformer. APROBADA la escribe solo Karen.
**Research:** `docs/research/hero-signup-proof-opcional.md` (rama `research/hero-signup-optional-proof`, commit `88c7c3a`, ESCALADO: ADR + licencia). Karen resolvió el escalado 2026-10-21: opción **C** (captura de email sin cifra fake) y licencia Pro confirmada (sí puede forkear el ejemplar de su vault).
**ADR:** `docs/adr/0005-fork-hero-signup-proof-opcional.md` (BORRADOR, firma de Karen).
**Medición de base (Secondary, nimbus-waitlist, bp-base, main `8efcae7` + PR #28):** hero-signup residuo de render 0.24 con 0 imágenes rotas; todo el residuo es la línea "1,283 finance teams are on the list" (count/proof). #28 ya quitó `people` (faces) y `shortButtonLabel`.

## 1. Objetivo
Que un waitlist sin cifra real no muestre prueba social inventada: sin `count`, `hero-signup` no renderiza el cluster de prueba social (línea `proof`, avatares `people`, roll-up de posición) y la confirmación no fabrica una posición. Con `count`, idéntico a hoy. La captura de email (form, validación, `onSubscribe`, reduced-motion, done-state) queda intacta. Métrica: residuo de render de hero-signup en nimbus 0.24 → ≤ 0.05 con el pipeline real (`scripts/run.ts`).

## 2. Decisiones que implementa
- **D1 (brief, contrato):** `count?` sin default numérico + guarda `count != null` sobre TODO el cluster. No un flag `socialProof?`: inventa superficie que Arc no documenta. Idioma de la casa: `newsletter-signup` (`readers?: … | null` + `{readers && …}`).
- **D2 (brief, `!= null` y no `&&`):** una waitlist en 0 es legítima; `count && …` imprimiría "0". `count={0}` muestra el cluster con 0.
- **D3 (brief, alcance done-state):** hoy la confirmación siempre dice "You're #N" (L302) y el status aria-live "You're number N" (L166). Sin `count` y sin número real de `onSubscribe`, el fork muestra confirmación SIN posición. La guarda re-estrecha el aritmético en L100, L161, L329 y L330, no solo el `motion.div` L321.
- **D4 (Karen, dónde vive el cambio):** el cambio se hace SOLO en el vault (`Knowledge/Frontend/Components/ui-react/blocks/hero-signup/`, repo git) y llega al scaffold por el pipeline (sha → copia). Nada a mano en `templates/arc-scaffold`.
- **D5 (hallazgo de esta spec, VERIFICADO):** el pipeline de hoy NO puede re-portar un item ya vendorizado:
  - `scripts/catalog-import.ts` no toca `origin` (cero `sha256`/`origin` en el archivo; cabecera L4: solo `manifest`, `manifestOrigin`, `registryDependencies`). El brief §2 dice que "recomputa el sha": **FALSO**.
  - `scripts/catalog-ingest.ts` L7 no toca entradas curadas (sin `gate`); `hero-signup` es curada (`verified: true`, sin `gate`).
  - `src/catalog/fetch.ts` L3 nunca copia encima de un archivo existente (`skipped`) y L111 falla si el sha del vault no coincide con el índice.
  Sin un paso nuevo, el re-port exige editar `catalog/index.json` y borrar archivos del scaffold a mano, que es lo que D4 prohíbe. Esta spec añade `refetch` (RF6).

## 3. Requisitos funcionales
- **RF1 (vault, contrato):** en `files/registry/blocks/hero-signup/hero-signup.tsx` del vault, `count` queda sin default en la desestructuración (hoy L86 `count = heroSignupCopy.count`). JSDoc de `count` (L38): "People already on the list. Omit it to hide the social proof." `people` y `proof` conservan sus defaults (brief D1): sin `count` nunca se renderizan porque RF2 envuelve todo el cluster.
- **RF2 (vault, cluster):** el `motion.div className={styles.proof}` (L321-331) se renderiza solo si `count != null`; dentro, `Roll value={count + (joined ? 1 : 0)}` (L329) y el srOnly `format(count + …)` (L330) operan sobre el `count` ya estrechado. Guarda `!= null`, nunca `&&` (D2).
- **RF3 (vault, posición):** `position: number | null`. L100 `useState<number | null>(count == null ? null : count + 1)`. L161 `place = typeof result === "number" ? result : count == null ? null : count + 1`. L166 status: con `place` "You're number N on the list. …"; sin él "You're on the list. …" (misma cola de email/preview). L302 done pill: con `position` "You're #<Roll> on the list"; sin él "You're on the list". `joined` no cambia (el +1 del cluster ya está detrás de RF2).
- **RF4 (vault, datos):** `heroSignupCopy.count` (hero-signup-data.ts L22) se elimina. Un default numérico que nadie lee es la cifra fake esperando volver.
- **RF5 (vault, manifiesto):** `doc.md` L96: `count` default `–`, descripción "People already on the list. Omit it to hide the social proof."; L70 del ejemplo de uso se queda con `count={2140}` (uso con cifra real). Después, `bun scripts/catalog-import.ts arc hero-signup` deja `manifest.props.count.default` vacío (hoy `'1283'`). `registry.json` del vault embebe `content` de cada archivo (103k): se actualiza a mano para que el vault sea coherente, pero NO lo consume el pipeline (fetch lee `files/`; manifest lee `doc.md` y de `registry.json` solo `registryDependencies`, manifest-arc.ts L104).
- **RF6 (repo, re-port):** nuevo comando `bun scripts/catalog.ts refetch <slug> [--dry]` (`src/catalog/fetch.ts`: `planRefetch`/`refetchItem`, reutilizando `resolveItems`, `declaredNpmDeps`, `scaffoldPathFor`): (a) recomputa `origin.sha256` desde el archivo principal del vault; (b) reemplaza en el scaffold SOLO los archivos propios del item (ruta de vault `registry/<kind>/<slug>/*`); los de `lib/` y de las deps (`gradient-mesh`, etc.) siguen con la semántica de `fetch` (`skipped` si existen, copia si faltan); (c) escribe el índice con el sha nuevo y `source`. `--dry` imprime el plan igual que `fetch`. Falla antes de tocar nada por las mismas causas que `planFetch` (item ausente, dep npm ausente). Es la única vía sancionada para que un cambio del vault llegue al scaffold.
- **RF7 (repo, índice):** `notes` de `hero-signup` registra el fork: "Fork local (ADR 0005): count opcional, sin cifra no hay prueba social. Diverge de uiarc.dev a propósito." `verified` se conserva `true` únicamente porque Karen ve el render nuevo en el PR (capturas antes/después); el OK visual ES el "render visto" del contrato (schema.ts L66-67, L82). Sin OK visual, no se mergea.
- **RF8 (adaptador):** `arcProps('hero-signup')` no pasa `count` (hoy tampoco). PR #28 (`people: []`, `shortButtonLabel`) va primero; esta spec encima. Si #28 no entra, `people` sin `count` igual no se ve (RF2), pero la medición de base cambia.

## 4. Requisitos no funcionales
- **RNF1:** vault = fuente de verdad del fork; scaffold = copia reproducible por `refetch`. `diff` vault↔scaffold vacío tras el re-port.
- **RNF2:** sin deps nuevas en root ni en el scaffold.
- **RNF3:** el bloque sigue siendo prístino respecto al VAULT (brief runner-e2e D1): "prístino" pasa a significar idéntico al vault de Karen, no a uiarc.dev (lo fija el ADR 0005).
- **RNF4:** accesibilidad intacta: el status aria-live (L166/L331) nunca anuncia una posición que no existe; `srOnly` del cluster desaparece con el cluster.

## 5. Criterios de aceptación
- **CA1 (RF1-RF4, sin count, pipeline real):** `bun scripts/run.ts` sobre nimbus-waitlist con bp-base → la app construida no contiene `styles.proof`, ni "on the list" fuera del done-state, ni `<img class=…face>`; input de email, validación en vivo, submit y done-state presentes. Residuo de render de hero-signup ≤ 0.05 (antes 0.24), 0 imágenes rotas. Capturas 1282 y 375 antes/después en `docs/spec/assets/`.
- **CA2 (regresión con count):** `count={2140}` → línea proof "2,140 …", faces si hay `people`, al unirse 2,141 y pill "#2,141": igual que hoy.
- **CA3 (D2):** `count={0}` → cluster visible con "0", no oculto.
- **CA4 (D3):** sin `count`: `onSubscribe` que devuelve 57 → pill "You're #57 on the list" y status "You're number 57…"; `onSubscribe` void o ausente → pill y status "You're on the list" sin número ni "#".
- **CA5 (RF6, vault↔scaffold):** tras `refetch hero-signup`, `diff` vault↔scaffold de `blocks/hero-signup/*` vacío; `origin.sha256` del índice == sha256 del vault; `bun scripts/catalog.ts fetch hero-signup --dry` no falla; `git diff --stat` del scaffold toca SOLO `blocks/hero-signup/*` (`lib/media.ts` y `gradient-mesh/*` intactos).
- **CA6 (RF6, test):** con el fixture de `tests/catalog-fetch.test.ts`: modificar el tsx del vault fixture tras un `fetch` → `fetch` falla por sha (hoy, CA8) y `refetch` reemplaza el tsx del bloque, NO toca `switch`/`lib/media.ts` ya existentes, reescribe `origin.sha256` y deja `fetch --dry` verde.
- **CA7 (RF5):** `manifest.props.count.default` vacío tras el import; `manifestOrigin: 'parsed'` se conserva.
- **CA8 (regresión):** `bun test adapter-arc router catalog catalog-fetch catalog-manifest` verde; `router.test.ts` CA10+CA14 (nimbus excluye hero-section, gana hero-signup) intacto; `catalog.test.ts` L24 (orden del pool hero) intacto.
- **CA9 (trazabilidad):** commit en el repo Knowledge con el cambio del vault; el ADR 0005 y el PR citan ese commit; `notes` del índice cita el ADR.

## 6. Datos
Sin entidad nueva en el repo. Cambia el valor de `origin.sha256` y `notes` de UNA entrada del índice. El contrato de `HeroSignupProps` cambia solo en semántica de `count` (ya era `?: number`): ausente = sin prueba social. Reversible: `git revert` en el vault + `refetch`.

## 7. Dependencias
Ninguna nueva. PR #28 antes (RF8). Vault Knowledge es repo git (HEAD `dfccf47` al redactar), así que el cambio del vault se commitea allí; ese commit es el origen del fork.

## 8. Seguridad
`superficie_expuesta: no`. Sin endpoint, red ni secretos nuevos. `refetch` lee el vault (READ-ONLY) y escribe solo dentro de `templates/arc-scaffold/src/components/arc/blocks/<slug>/` y `catalog/index.json`, con las mismas validaciones de ruta que `fetch` (`scaffoldPathFor` lanza fuera del mapa). Sin familias `offensive-*`.

## 9. Plan de pruebas
- **CI (bun test, 1 test de lógica):** CA6 en `tests/catalog-fetch.test.ts`.
- **Fuera de CI, obligatorio en el PR:** CA1-CA4 no caben en `bun test` (root sin renderer React: `devDependencies` = `playwright` solo; instalar deps está bloqueado). Se verifican con una sonda playwright de Secondary sobre un build vite del scaffold con cuatro instancias (`count` ausente / `0` / `2140` / ausente + `onSubscribe` que devuelve 57) y con el pipeline real para CA1; evidencia = capturas + aserciones de DOM en el PR. Las capturas 375px incluidas (el hero ya tiene el botón corto de #28).
- **Regresión:** CA8.

## 10. Fuera de alcance
- Cualquier otro bloque Arc. Esta es la primera divergencia y el ADR fija el procedimiento, no un lote.
- Un `proof` inyectable por props (función; JSON.stringify en emit.ts L64 no la transporta). No se cambia el emit.
- Traducir la línea `proof` al español: sin `count` no existe; con `count` real será otra spec (copy del brief).
- Retirar `verified` como contrato o automatizar `render.ok` (tesis aparte).
- Sincronización futura con upstream Arc (si uiarc.dev cambia hero-signup, el fork se re-aplica a mano; lo registra `notes` y el ADR).

## 11. Riesgos
- `refetch` abre una puerta para pisar el scaffold por descuido: queda acotado a `blocks/<slug>/*` del item pedido y nunca a `lib/` ni a deps (RF6b); el test CA6 lo fija.
- `registry.json` del vault con `content` desactualizado si RF5 se olvida: no rompe el pipeline (no lo lee), pero deja el vault incoherente. CA9 lo cubre por revisión, no por test.
- El OK visual sostiene `verified: true` (RF7). Si Karen no lo ve, la entrada debería bajar a `verified: false` hasta que lo vea; el PR no se mergea en ese estado.
- `catalog-import --check-remote` sigue comparando keywords con uiarc.dev: no detecta la divergencia de fuente (solo keywords). Aceptado; lo anota el ADR.

## 12. Archivos
**Vault (repo Knowledge, 1 commit):** `ui-react/blocks/hero-signup/files/registry/blocks/hero-signup/hero-signup.tsx`, `…/hero-signup-data.ts`, `ui-react/blocks/hero-signup/doc.md`, `ui-react/blocks/hero-signup/registry.json` (content espejo).
**Repo web-transformer (≤5):** `src/catalog/fetch.ts` (planRefetch/refetchItem), `scripts/catalog.ts` (comando refetch), `tests/catalog-fetch.test.ts` (CA6), `catalog/index.json` (sha + notes + manifest, escrito por refetch e import, no a mano), `templates/arc-scaffold/src/components/arc/blocks/hero-signup/{hero-signup.tsx,hero-signup-data.ts}` (escritos por refetch, no a mano). Más `docs/spec/assets/` (capturas) y `docs/adr/0005…` + README.

## 13. Git / entrega
Orden: (1) PR #28 mergeado; (2) commit en Knowledge; (3) en `feat/hero-signup-optional-proof`: RF6 + CA6 primero (código), luego `refetch hero-signup` + `catalog-import arc hero-signup` (commit aparte: "chore(catalog): re-port hero-signup desde el vault (ADR 0005)"), luego capturas. QA local 100% + Secondary verifica CA1-CA9 → push + PR **sin auto-merge** (toca un bloque verified y la selección del hero de nimbus; Karen lee y da el OK visual). CI es el gate del merge; la firma del ADR 0005 y la APROBADA de esta spec son de Karen.
