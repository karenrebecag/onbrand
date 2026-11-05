# Color

Solo `var(--token)`; nunca un hex ni un `rgb()` en una sección.

- Fondo y texto: `--background`, `--foreground`, `--text-secondary`, `--text-muted`.
- Superficies: `--surface`, `--surface-raised`, `--surface-muted`, `--surface-band`.
- Bordes: `--border-subtle`, `--border`, `--border-strong`.
- Interactivo: `--accent` (botón primario y selección), `--accent-strong` (hover y texto de acento), `--accent-subtle`
  (fondos suaves), `--accent-foreground` (texto sobre `--accent`). `--brand-highlight` es el color de identidad para
  detalles; por defecto, el mismo acento.
- Estados: `--success`, `--warning`, `--danger`, `--info`. Tonos de categoría: `--tone-*`. Series de gráficos:
  `--series-1` a `--series-4`.
