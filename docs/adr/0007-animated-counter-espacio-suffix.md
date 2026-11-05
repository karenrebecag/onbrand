# ADR 0007: animated-counter respeta el espacio de prefix y suffix

Estado: APROBADO, firmado por QA con autorización explícita de Karen (2026-10-22: 'Firma a aprobado lo que sea necesario') | Fecha: 2026-10-22
Origen: RE de orqWebTransformer sobre el pricing de f112389f ("$8per seat / month"). `verified` de
animated-counter sigue en `false` (ingest automático): este ADR no lo cambia.

## Contexto

El emit es correcto: `<AnimatedCounter value={8} prefix="$" suffix=" per seat / month" />`, con el
suffix trayendo su espacio inicial. En `animated-counter.module.css`, `.value` es `inline-flex` y cada
prefix/suffix va en un `.symbol` `inline-block`. Un item flex se trata como bloque y el espacio inicial de
su texto se colapsa, así que el suffix queda pegado a los dígitos: "$8per seat / month". Pasa en todo
counter con prefix o suffix que empiece o termine en espacio, en cualquier página.

## Decisión

`.symbol { white-space: pre; }` en el componente, en el vault
(`ui-react/components/animated-counter/files/registry/components/animated-counter/animated-counter.module.css`)
y al scaffold por `catalog.ts refetch animated-counter` (ADR 0005 §1). Es la primera divergencia de un
item Arc solo de CSS.

- `.value` ya es `nowrap`; `pre` en `.symbol` no introduce saltos.
- "$8" sigue pegado porque el prefix no trae espacio: se respeta lo que pasa el contenido, no se añade.

## Consecuencias

- "$8 per seat / month" en todo pricing con suffix; la captura antes/después va en el PR del refetch.
- `refetch` calcula el sha sobre el `.tsx` principal: un cambio solo de CSS no mueve `origin.sha256`
  (sale igual, `2542f8bc…`). El cambio queda registrado en el diff del scaffold y en `notes` del índice.
  Si hace falta detectar deriva de CSS, el sha tendrá que cubrir todos los archivos del item (cambio
  aparte, fuera de este ADR).

## Alternativas descartadas

- **Espacio no separable (` `) en el suffix desde el composer.** Arregla un caso y deja el
  componente roto para cualquier otro contenido.
- **Quitar el `inline-block` de `.symbol`.** El clip horizontal del suffix (overflow-x) lo necesita.
