// Derivación de la superficie de un bloque Arc desde su CSS module PRÍSTINO (solo lectura; nunca
// reescribe source). Es una regla determinista que PROPONE: el
// valor que el core consume es el que una persona fija en catalog/index.json al verificar el
// render, y el lint avisa cuando los dos no coinciden (brief cohesion-superficie-agnostica, D1).
//
// Regla: la primera regla `.clase { ... }` del módulo es la raíz del bloque. Su `background`
// decide; un override `:global(:root[data-theme="dark"]) .clase` o, con alcance de ancestro,
// `:global([data-theme="dark"]) .clase { background: ... }` decide el
// tema oscuro; sin override, la superficie es la misma en ambos temas porque los tokens de Arc ya
// tienen valor claro y oscuro.

import type { Surface, SurfaceByTheme, Theme } from '../types';

const ROOT_RULE = /^\.([\w-]+)\s*\{([^}]*)\}/m;
const BACKGROUND = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/;
const BORDER_RADIUS = /(?:^|;)\s*border-radius\s*:/;

const background = (body: string): string | undefined => BACKGROUND.exec(body)?.[1]?.trim();

/** Clasifica un valor de `background` de la raíz. `isCard`: la raíz lleva border-radius, así que
 * es una tarjeta que vive DENTRO de la página (logo-marquee) y no tiñe la sección. Un color literal
 * (#hex, oklch, rgb) no se clasifica: su claridad no se puede juzgar sin resolver el tema. */
export function classifyBackground(value: string | undefined, isCard: boolean): Surface | undefined {
  if (value === undefined) return 'base';
  const v = value.toLowerCase();
  if (v.includes('url(')) return 'media';
  if (isCard) return 'base';
  if (v === 'transparent' || v === 'none' || v === 'var(--background)') return 'base';
  if (v.includes('var(--surface') || v.includes('gradient') || v.includes('color-mix')) return 'tinted';
  return undefined;
}

export interface ArcSurfaceDerivation {
  /** Clase raíz encontrada. */
  root: string;
  /** undefined = no derivable (color literal). */
  light: Surface | undefined;
  dark: Surface | undefined;
}

/** Deriva la superficie por tema del CSS module de un bloque. undefined si no hay regla raíz. */
export function deriveArcSurface(css: string): ArcSurfaceDerivation | undefined {
  const m = ROOT_RULE.exec(css);
  if (!m) return undefined;
  const [, root, body] = m;
  const isCard = BORDER_RADIUS.test(body);
  const light = classifyBackground(background(body), isCard);
  const darkRule = new RegExp(`:global\\((?::root)?\\[data-theme="dark"\\]\\)\\s*\\.${root}\\s*\\{([^}]*)\\}`).exec(css);
  const darkBackground = darkRule ? background(darkRule[1]) : undefined;
  const dark = darkBackground !== undefined ? classifyBackground(darkBackground, isCard) : light;
  return { root, light, dark };
}

/** Diferencias entre lo derivado y lo fijado en el registry, una línea por tema que difiera. */
export function surfaceMismatches(derived: ArcSurfaceDerivation, fixed: SurfaceByTheme): string[] {
  const themes: Theme[] = ['light', 'dark'];
  return themes.flatMap((t) => {
    const d = derived[t];
    if (d === undefined) return [`superficie[${t}]: no derivable del CSS (raíz .${derived.root}); registry dice ${fixed[t]}`];
    return d === fixed[t] ? [] : [`superficie[${t}]: derivada ${d} (raíz .${derived.root}), registry dice ${fixed[t]}`];
  });
}
