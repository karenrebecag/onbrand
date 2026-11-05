# ADR 0009: contrato de bloque, la página decide lo que el port tenía congelado

Estado: APROBADO por Karen | Fecha: 2026-10-23
Decisión de Karen (2026-10-23, en sesión con ArqWebTransformer): «ya tienen mi aprobación, si alguien la necesita explicita, que me la pida».
Origen: RE contra v0 (`~/Desktop/web-transformer-sesiones/re-v0/`, problema B de `PROPUESTA.md`). Dueña: Arq.

## Contexto

En v0 el mismo agente escribe los datos y la grilla en el mismo turno: `const plans = [...]` (3) en
`components/sections/pricing.tsx:9` y `.pricing-grid { repeat(3) }` en `globals.scss` (j049). Nosotros
separamos quién pone los datos (composer) de quién pone la forma (port), y el port congela como constantes
cosas que dependen de los datos o de la página. Inventario sobre los 38 bloques del pool (27 Arc, 11 Relume):

- columnas fijas `repeat(N)` sobre una colección: 22; solo `stats-band` las calcula desde sus datos (`--count`);
- `text-align: center` fijo: 15; la política `sectionHeaderAlign` del DS solo la obedecen las secciones árbol;
- modo oscuro anclado a `:root[data-theme="dark"]`: 8, más `foundation.css` y la constante `ARC_DARK` del porter;
- reveal de entrada propio: 9 (Arc).

Síntoma medido: pricing-10 y layout-122 con 3 items salen 2+1 a 1440.

## Decisión

La maquetación interna del bloque (cabecera, tarjeta, orden, proporciones) sigue siendo del bloque. Pasan a ser
contrato, resuelto en el punto de uso:

1. **Columnas de colección = f(número de items).** El contenedor que itera datos y tiene un `repeat(N)` fijo
   desde tablet lee `--cols-md` / `--cols-lg`, calculadas en el render con `collectionColumns` (filas completas;
   tope 2 en tablet y 4 en escritorio, el de `stats-band`). Una colección dentro de una columna de un layout
   partido conserva el tope del original en escritorio. El valor original queda como fallback del `var()`.
2. **Alineación de la cabecera de sección**: una cabecera centrada lo está por el texto y por la caja
   (`margin: auto` + `max-width`), así que no basta una variable. El wrapper lleva `data-wt-align` (política del
   DS `sectionHeaderAlign`, igual que v0, que alinea todo a start) y la cabecera gana una regla para `start` que
   mueve texto y caja. Sin atributo queda el original. El interior del bloque no se toca.
3. **Alcance del tema oscuro**: cualquier ancestro (`:global([data-theme="dark"])`), no solo `:root`, para que
   una sección `inverse` del contrato de página (ADR 0008) pueda ser oscura.
4. **Reveal**: queda fuera de este ADR hasta que exista el presupuesto de motion de la página (ADR 0008 + Front).

Se implementa como un pase sobre tsx+css (`src/catalog/block-contract.ts`), idempotente:
- lo corre el porter al final de `scripts/tailwind-to-modules.ts`, así un port nuevo nace con el contrato;
- `bun scripts/block-contract.ts` lo aplica en sitio a los ports de Relume del scaffold, sin re-portarlos;
- los bloques Arc viven en el vault (ADR 0005): el mismo pase se aplica allí y llega por `catalog.ts refetch`.
  Ese paso pide escritura en `Knowledge/Frontend/Components/ui-react` fuera del alcance del ADR 0006, así que
  queda pendiente del OK de Karen.

Quién pone el valor: (1) el propio bloque desde sus datos; (2) el runner escribe `data-wt-align` desde la política del DS y (3) `data-theme` en
el wrapper de sección desde el contrato de página (ADR 0008). Sin ese dato, el fallback deja el
comportamiento de hoy. Quién lo mide: los sensores de QA (fila incompleta, alineación contra el plan, sección
inversa legible).

## Consecuencias

- E-B medido (pricing-10 + layout-122 con 3 items, build de Vite, Chrome): a 1440, filas incompletas 2 → 0
  (2+1 → 3); a 375, sin cambio (1+1+1); desborde 0. Capturas en `~/v0-fe-capture/eb-{before,after}-1440.jpeg`.
- Aplicado a 9 de 11 unidades Relume del scaffold: 4 colecciones (pricing-10, layout-122, layout-253 anidada,
  testimonial-3), 3 cabeceras, 5 cáscaras con tema por ancestro.
- Los ports existentes conservan su revisión a mano: el pase solo toca las tres cosas de arriba.

## Alternativas descartadas

- **Re-portar desde el vault con un porter nuevo.** Perdería la revisión a mano de cada port (lote 2).
- **Recortar items para que entren** (los `slice` de `src/adapters/arc.ts`). Esconde contenido y engaña al gate.
- **Elegir otro bloque según la cantidad de items.** No escala: el problema está en 22 de 38 bloques.
