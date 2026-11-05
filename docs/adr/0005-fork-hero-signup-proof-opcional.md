# ADR 0005: Primera divergencia de contrato vs Arc — `hero-signup` forkeado en el vault con prueba social opcional

Estado: ACEPTADO (Karen, 2026-10-21: "como Relume", fill-or-omit, nunca default horneado) | Fecha: 2026-10-21
Origen: brief `docs/research/hero-signup-proof-opcional.md` (commit `88c7c3a`, ESCALADO) y spec `docs/spec/hero-signup-proof-opcional.md`. Decisión de Karen 2026-10-21 (chat): opción C y licencia Pro confirmada para forkear el ejemplar de su vault. Matiza el bloque D1 de `docs/research/runner-e2e-arquitectura.md` (vendor prístino).

## Contexto

`hero-signup` es el hero de nimbus-waitlist (router CA10/CA14). Su fuente en el scaffold es byte-idéntica
a la del vault (sha `e7092cba…`) y el índice la marca `verified: true`. El bloque siempre renderiza una
línea de prueba social con `count` (default 1283 desde `heroSignupCopy`) y, al confirmar, una posición
"You're #N on the list" (`count + 1`). Un brief de waitlist real no trae cifra: el runner emite "1,283
finance teams are on the list" en una página que no tiene 1.283 personas. El residuo de render medido
es 0.24, todo él esa línea.

No hay forma de apagarla sin tocar el bloque: `proof` es una función y el emit serializa props con
`JSON.stringify` (`src/emit.ts:64`); `count` tiene default, así que omitirlo no lo oculta. Las
alternativas sin fork (router: `whenNotToUse` para briefs sin cifra, o `hero-section` como hero de
waitlist) pierden la captura de email, que es el valor del bloque.

Hasta hoy la regla era: el scaffold vendoriza lo que hay en el vault sin editar (brief runner-e2e D1,
"vendor prístino"), y `verified` significa que una persona vio el render de ESA fuente. Forkear rompe la
paridad vault↔uiarc.dev para este item y cambia `origin.sha256`. Además el item es Arc **Pro** ("never
reconstruct their source" en el MCP). Son dos decisiones que no toma un agente.

## Opciones

- **C — Fork en el vault: `count?` sin default, cluster detrás de `count != null` (elegida por Karen).**
  Cambio mínimo, replica el idioma del bloque hermano `newsletter-signup` (`readers?: … | null` +
  `{readers && …}`). Sin cifra no hay prueba social; con cifra, idéntico a hoy. Exige este ADR.
- **R — Router.** Excluir `hero-signup` cuando el brief no trae cifra, o usar `hero-section`. No toca
  vendor, pero el waitlist pierde el form de email. Rechazada por Karen.
- **Flag `socialProof?: boolean`.** Inventa superficie de contrato que Arc no documenta y amplía la
  divergencia. Rechazada (brief D1).
- **Editar el scaffold directamente.** Deja el vault y el índice mintiendo (sha, `source`), y el próximo
  `fetch` falla o pisa el fix. Rechazada: el vault manda (decisión de Karen).

## Decisión

1. **Dónde vive un fork.** Toda divergencia de un item Arc se hace en el vault de Karen
   (`Knowledge/Frontend/Components`, repo git), se commitea allí, y llega al scaffold por el pipeline
   (`refetch` → sha nuevo → copia). Nunca se edita `templates/arc-scaffold` a mano. "Vendor prístino"
   (runner-e2e D1) pasa a significar **idéntico al vault**, no idéntico a uiarc.dev.
2. **Cada divergencia lleva ADR.** Un fork de un item `verified` es una divergencia de ejemplar: nace
   BORRADOR, lo firma Karen. Este ADR cubre solo `hero-signup`; no autoriza un lote.
3. **Contrato de `hero-signup`.** `count?: number` sin default; el cluster de prueba social (línea
   `proof`, avatares `people`, roll-up) se renderiza solo con `count != null` (`0` es legítimo y se
   muestra). La posición (`useState`, `place`, status aria-live, pill de confirmación) existe solo si
   hay `count` o si `onSubscribe` devuelve un número real; si no, la confirmación dice "You're on the
   list" sin número. `heroSignupCopy.count` se elimina. `people` y `proof` conservan sus defaults.
4. **`verified` se conserva solo con render visto.** La entrada sigue `verified: true` porque Karen ve
   el render nuevo (capturas antes/después en el PR) antes de mergear. Sin ese OK visual, la entrada
   baja a `verified: false` hasta que lo vea. `origin.sha256` cambia al sha del vault forkeado; `notes`
   registra "Fork local (ADR 0005)".
5. **Licencia.** El fork es sobre una copia ya en el vault de Karen, bajo su plan Pro. Karen confirmó
   2026-10-21 que encaja con su licencia. Es decisión suya y queda registrada aquí; ningún agente la
   reevalúa ni la vuelve a preguntar.
6. **Herramienta.** El repo gana `bun scripts/catalog.ts refetch <slug>` (spec RF6): recomputa el sha,
   reemplaza solo `blocks/<slug>/*` del item en el scaffold y escribe el índice. Es la única vía para
   re-portar un item ya vendorizado. `fetch` sigue sin pisar nada.

## Consecuencias

- Nimbus (y cualquier waitlist sin cifra) deja de mostrar prueba social inventada; con cifra real el
  bloque no cambia. La captura de email queda intacta.
- `hero-signup` diverge de uiarc.dev a propósito. Si Arc publica una versión nueva del bloque, el fork se
  re-aplica a mano sobre la copia del vault (commit en Knowledge + `refetch`), y este ADR se cita en ese
  commit. `catalog-import --check-remote` compara solo keywords y no detecta la divergencia de fuente.
- El pipeline deja de ser "copiar una vez": `refetch` convierte un cambio del vault en una
  transformación reproducible (sha + copia), sin ediciones perdidas en el scaffold.
- Precedente: la próxima divergencia (otro bloque, otro prop) sigue este mismo camino y su propio ADR.
  No hay fast-track.

## Alternativas descartadas

- **Mantener `verified: true` sin que Karen vea el render.** Diluye el contrato (ADR 0002 lo protege).
  Descartada: el OK visual es condición del merge.
- **Reconstruir el bloque desde cero para no "tocar" fuente Pro.** Sería reconstruir fuente Pro, que es
  exactamente lo que el MCP prohíbe; el fork de la copia licenciada es el camino limpio.
- **Portar la lógica de `count` opcional al adaptador (`arcProps`).** No puede: la función `proof` y el
  default numérico viven en el bloque; el adaptador solo pasa JSON.
