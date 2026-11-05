---
name: base
description: DS base del core de onbrand para landing pages (React + CSS sobre tokens del contrato). Úsalo para toda página de este workspace; es la única fuente de UI, por encima de Tailwind, shadcn/ui o componentes a mano.
disable-model-invocation: true
metadata:
  v0.kind: design-system
  v0.design-system:
    appearance:
      light:
        background: "#ffffff"
        foreground: "#171717"
      dark:
        background: "#121212"
        foreground: "#f2f2f2"
---

# DS base

El DS base es la fuente de UI de esta página: primitivas de layout, diez átomos y once bloques de sección en
`src/components/`, tokens de `src/theme/tokens.css` y CSS propio por sección sobre esos tokens. Es neutro a propósito:
la identidad la pone la marca (`src/identity.css`), no el DS.

## El starter ya está montado

No lo recrees ni lo dupliques:

- `src/main.tsx`: monta `App` en `#root`.
- `src/index.css`: `theme/tokens.css` (claro y oscuro) e `identity.css`, más el reset, el fondo y el color base.
- `src/identity.css`: tokens de la marca. Con cabecera `/* brand-pack: … */` no se edita; vacía, la declaras tú (regla 9).
- `src/components/`: el DS, con el alias `@/` = `src/`. No se edita.
- `src/App.tsx`: vacío; aquí se monta la página, cada sección dentro de `<WtSection slug>` de `@/wt-section`.

Para construir: un archivo por sección en `src/sections/` con su `.module.css` al lado, componentes importados de
`@/components/...` e iconos del set de `references/assets/icons.md`.

## Reglas de siempre

1. **Componentes**: el import exacto de su referencia. Empieza en `references/components/index.md`. Si la tabla tiene
   un componente para lo que vas a pintar, se importa: nunca un equivalente a mano en `src/sections`.
2. **Bloques**: si el rol de la sección tiene bloque (navbar, hero, features, logos, stats, steps, testimonials,
   pricing, faq, cta, footer), lo importas de `@/components/blocks/<rol>` y le pasas el contenido del brief por props,
   más `id` y `slug` de la sección. El bloque ya trae su `Section`: no lo envuelvas en otro. Escribe la sección a mano solo si el brief pide algo que el
   bloque no puede mostrar, y entonces usa layout y átomos.
3. **Iconos**: solo los nombres de `references/assets/icons.md`, con `<Icon name="…" />` de `@/components/ui/icon`.
4. **Color**: solo `var(--token)`. Ver `references/foundations/colors.md`.
5. **Espacio y tipo**: solo `--space-*`, `--radius-*` y la escala `--text-*`. Ver
   `references/foundations/typography.md` y `references/foundations/spacing-layout.md`.
6. **Layout y responsive**: primitivas de `references/components/layout.md` y `@media` a 768 y 1024 px. Lee
   `references/foundations/responsiveness.md` antes de maquetar.
7. **Tema**: la zona oscura de una sección es `Section surface="inverse"`. Ver `references/foundations/theming.md`.
8. **Enlaces**: un botón con destino es `Button` con `href`, que pinta un `<a>`. Nunca `window.open` en un `onClick`.
   Una sola acción principal por sección (en precios, una por plan).
9. **Identidad sin marca**: si `src/identity.css` está vacío, decide y declara la marca antes de escribir. Ver
   `references/foundations/identity.md`.
10. **Motion**: el DS base no trae animaciones. No las escribas.
11. **Imágenes**: cuando el prompt dice que hay paso de imagen, cada slot de imagen es `Image` de
   `@/components/layout/layout` con `src="/images/<slug>-<n>.jpg"`, un `alt` corto y un `data-alt` descriptivo que es
   el prompt de la imagen: sujeto, contexto, encuadre y luz, en el idioma de la página.

## Orden de lectura

1. **Panorama**: `references/components/index.md` y `references/components/layout.md`.
2. **Fundamentos**: todos los archivos de `references/foundations/`.
3. **Dirección**: si existe `references/direction.md`, léelo; fija la forma y la superficie de cada sección.
4. **Plan**: lista los bloques y componentes de cada sección, con `index.md` como inventario. Solo esos.
5. **Cada componente, antes de usarlo**: su entrada en el archivo de su categoría y su código (la ruta `Código:`).
   Confirma ahí el nombre del export y sus props.

Si el typecheck marca un import o una prop, vuelve al código del componente: es la fuente de verdad, nunca adivines.

## Reglas duras

- Nunca inventes componentes, props, variantes, tokens ni iconos.
- Nunca edites `src/components/` ni restiles sus internos: si un componente no hace lo que necesitas, escribe el
  marcado en tu sección.
- Nunca mezcles otra librería de componentes ni CSS utilitario (Tailwind), ni instales dependencias.
- `references/` es documentación: nunca importes nada desde la carpeta del skill.
- Una sección escrita a mano es `<Section id role slug>` de `@/components/layout/layout`: nunca un `<section>` propio
  ni un contenedor con `max-width` o `margin-inline`.

## Revisión final

- La página se lee en el tema claro y en su zona oscura: texto y controles con tokens, no con literales.
- Verifica con la tool browser a 1440 y a 375 px, página entera (`{"viewport": 1440, "full": true}` y `{"viewport": 375, "full": true}`): son los dos anchos que acepta. A 375 todo va en una columna y sin desborde horizontal.
- Todo lo interactivo sale de componentes del DS, con label o `aria-label` donde el componente lo pide.
- Después del build, relee el copy de todas las secciones juntas: ningún titular, frase ni cifra se repite entre
  secciones.
