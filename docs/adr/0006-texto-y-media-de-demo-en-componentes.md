# ADR 0006: Divergencia de lote — texto visible fijo a props y fuera la media de demo

Estado: APROBADO, firmado por QA con autorización explícita de Karen (2026-10-22: 'Firma a aprobado lo que sea necesario'; Karen lo confirmó en la sesión de Arq: "confirmado") | Fecha: 2026-10-22
Delegación: Karen a QAWebTransformer, 2026-10-22: "toma las decisiones por mí". QA decide este ADR con
la propuesta de ArqWebTransformer. `verified: true` de cada item afectado depende del OK visual de Karen
sobre las capturas antes/después; ningún agente lo escribe sin él.
Evidencia: run 817da32c (brief en español) medido con el render-gate (#88 foreign-text, #90 imágenes
rotas, #93 revisión de render); RE de Front `~/v0-fe-capture/calidad-re/RE-imagen-producto.md` §3 y
`RE-verificacion-visual.md`; gates de #82 (`catalog/gates/render.json`).

## Contexto

El composer solo puede llenar lo que el schema ve: props string o JSON. Tres clases de contenido de los
componentes quedan fuera de su alcance y aparecen en la página tal cual vienen del ejemplar:

1. **Texto visible fijo en el JSX** o como default función. En 817da32c: "finance teams are on the list"
   (`proof` de hero-signup es una función, no serializable), "Subscribe" (site-footer, sin prop),
   "pause" (logo-marquee). Con un brief en español, foreign-text los mide como `ui lang=en`. El RE corto
   de foreign-text contó 35 de 56 archivos del scaffold con literales visibles (301 en total).
2. **Media de demo en defaults.** hero-signup pinta 5 caras (`heroSignupCopy.people` vía `lib/media` →
   `/media/people/*.jpg`) cuando llega `count` sin `people`, y en el workspace dan 404. Hay 11 archivos
   más de Arc que importan `lib/media`. En los Relume portados, los defaults apuntan al CDN de Relume
   (`d22po4pjz3o32e.cloudfront.net`): `kit-icon.svg` da 403 (layout253_block, único FAIL de los 10 de #82)
   y `placeholder-image.svg` es demo aunque cargue (testimonial3_block).
3. **Desborde horizontal de componente.** faq-section variante columns desborda 26 px a 375 (la
   categoría "Seguridad y datos 2" y el link "Escríbenos"); el `<section>` de logo-marquee mide 2 px más
   que el viewport a 1440 y a 375. Son scroll horizontal real medido por la revisión de render.

El ADR 0005 dejó la regla: una divergencia de un item Arc vive en el vault, llega al scaffold por
`catalog.ts refetch` y lleva su ADR; ese ADR no autorizaba un lote. Esto es un lote.

## Decisión

1. **Regla de texto.** Todo texto visible fijo en el JSX, o servido por un default función, pasa a ser un
   prop `string` con default. El default conserva el texto actual (paridad visual sin brief); el schema
   lo ve y el composer lo rellena. Un texto que hoy depende de un valor (`proof(count)`) se parte en
   prefijo/sufijo string alrededor del valor, nunca en una función.
2. **Regla de media.** Ningún default trae media de demo. Sin dato, el elemento no se pinta: `people`
   sin default → sin caras; una imagen sin `src` → sin `<img>` (o el slot vacío que el componente ya
   soporte). Se elimina el import de `lib/media` de los defaults afectados.
3. **Desbordes.** faq-section y logo-marquee se corrigen en el componente hasta `overflowPx = 0` a 1440 y
   375 con el contenido de 817da32c. Sin tolerancia (decisión de QA: 2 px es scroll real).
4. **Alcance cerrado.** Arc del flujo por defecto: hero-signup, site-header, site-footer, stats-band,
   cta-section, faq-section, logo-marquee. Relume con media de demo: layout253_block y
   testimonial3_block. El resto de los 35 archivos con literales queda fuera hasta otro ADR o una
   ampliación explícita de este.
5. **Dónde vive cada cambio.**
   - Arc: en el vault de Karen (`~/Desktop/SoftwareDevProjects/Knowledge/Frontend/Components/ui-react/blocks/<slug>/`),
     commit en ese repo citando este ADR, y `bun scripts/catalog.ts refetch <slug>` en web-transformer.
     Nunca a mano en `templates/arc-scaffold` (0005 §1).
   - Relume: el item vendorizado es nuestro port (`templates/arc-scaffold/src/components/relume/…`,
     `source` en el índice), no una copia del vault. La regla de media se aplica en el port y, si el
     porter la puede aplicar en general (cualquier `cloudfront.net` de Relume en un default), en el
     porter y no por slug.
6. **Verificación por item.** Antes/después a 1440 y 375 con el contenido de 817da32c; render-gate
   (`foreign-text` sin `ui` en inglés con brief en español para los textos portados, `brokenImages = 0`,
   `overflowPx = 0`); `catalog/gates/render.json` re-medido. `verified: true` solo con OK visual de Karen;
   sin él, el item baja a `verified: false`. `notes` registra "Divergencia de lote (ADR 0006)".

## Consecuencias

- Las páginas en español dejan de mostrar chrome en inglés en el flujo por defecto, y lo que quede lo
  mide foreign-text como deuda de i18n con nombre.
- Ninguna página nueva pinta caras o placeholders de demo: lo que no trae dato no aparece.
- La divergencia con uiarc.dev crece en 7 bloques Arc. Si Arc publica versiones nuevas, el lote se
  re-aplica sobre la copia del vault citando este ADR (mismo costo que 0005, por bloque).
- La revisión de render deja de reportar faq y logos en 817da32c; el reintento por sección (#96) queda
  para defectos de contenido, no de componente.

## Alternativas descartadas

- **Editar el scaffold directamente.** Deja `origin.sha256` y `verified` mintiendo y el próximo `refetch`
  lo pisa (0005, rechazada por Karen).
- **Tabla por slug en el runner** (p. ej. pasar `people: []` a hero-signup). Arregla un caso y esconde la
  regla; QA lo rechazó por la orientación de escala.
- **Tolerancia de 2 px en el sensor de desborde.** Esconde scroll real (decisión de QA).
- **Lote sobre los 35 archivos de una vez.** Más superficie de divergencia sin evidencia de que entren en
  páginas reales; se amplía con datos.
