# Identidad sin marca

Si `src/identity.css` está vacío, la página no tiene marca y la declaras tú antes de escribir secciones, en un bloque
`:root, [data-theme] { … }` dentro de `identity.css`:

- `--accent`, `--accent-strong`, `--accent-subtle` y `--accent-foreground`, con contraste AA entre `--accent` y
  `--accent-foreground` (4.5:1).
- `--font-display` y `--font-body` si el negocio pide otra voz que la del sistema (solo fuentes del sistema o de
  `@import` de un CDN de fuentes; no instales paquetes).
- `--radius-factor` (0 a 2) si la marca es más recta o más redonda.

Con cabecera `/* brand-pack: … */`, `identity.css` es de la marca elegida y no se toca.
