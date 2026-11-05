// Lint de fuente de componente: detecta señales de que un componente de Relume NO renderiza bien
// en el scaffold actual (Vite + Tailwind v3 + preset v3). Es la mitad "gate" del patrón Relume:
// lo roto no entra al pool; el score nunca tiene que esquivarlo.
//
// Conservador a propósito: cada regla marca un patrón concreto y devuelve el texto que la disparó.
// Un falso negativo lo atrapa la curación humana del registry; un falso positivo esconde un
// componente bueno, que es peor. Por eso la regla de media es warning y no bloquea.

export interface LintResult {
  /** true si no hay issues bloqueantes. Los warnings no cambian ok. */
  ok: boolean;
  /** Señales que rompen el render en el scaffold: el componente no entra al registry. */
  issues: string[];
  /** Heurísticas que piden mirar el render a ojo (no bloquean). */
  warnings: string[];
}

interface Rule {
  id: string;
  /** Qué se busca y por qué rompe el scaffold. */
  why: string;
  pattern: RegExp;
}

// Tailwind v4-nativo. La librería actual de Relume está escrita para v4; el preset publicado y el
// scaffold son v3, donde estas construcciones no generan CSS (la clase queda muerta → layout roto).
const V4_RULES: readonly Rule[] = [
  {
    id: 'v4-fractional-size',
    why: 'size-N.M (ej. size-3.75) solo existe en la escala de v4; en v3 no emite CSS',
    pattern: /\bsize-\d+\.\d+\b/g,
  },
  {
    id: 'v4-color-var',
    why: 'var(--color-*) son las variables de @theme de v4; v3 no las define',
    pattern: /var\(--color-[\w-]*\)?/g,
  },
  {
    id: 'v4-theme-directive',
    why: '@theme es sintaxis de v4; el pipeline de PostCSS v3 la ignora',
    pattern: /@theme\b/g,
  },
  {
    id: 'v4-import',
    why: '@import "tailwindcss" es el entry de v4; v3 usa @tailwind base/components/utilities',
    pattern: /@import\s+["']tailwindcss["']/g,
  },
];

// Typos de clase vistos en fuentes reales (Testimonial39: `gid-cols-1`). Una clase con typo no
// emite CSS y el grid colapsa a una columna sin aviso.
const TYPO_RULES: readonly Rule[] = [
  {
    id: 'typo-grid',
    why: 'grid-cols/grid-rows mal escrito: la clase no existe y el grid no se aplica',
    pattern: /\b(gid|gird|grdi|gri)-(cols|rows)-[\w[\]]+/g,
  },
];

/** Extrae cada literal de className="..." (solo strings planos; los template literals y clsx()
 * se dejan en paz porque ahí los tokens se arman en runtime). */
function classLiterals(source: string): string[] {
  return [...source.matchAll(/className="([^"]*)"/g)].map((m) => m[1]);
}

/** Valores arbitrarios `[...]` pueden llevar `--` legítimo (var(--x)); se sustituyen por un
 * marcador (no se borran: `px-[5%]` quedaría como `px-` y parecería roto). */
const stripArbitrary = (token: string): string => token.replace(/\[[^\]]*\]/g, 'ARB');

// Guion roto evidente dentro de un className plano: token que termina en `-` (`grid-cols-`) o con
// `--` fuera de un valor arbitrario (`text--center`). Ambos son clases que nunca existen.
function brokenHyphenTokens(source: string): string[] {
  return classLiterals(source)
    .flatMap((literal) => literal.split(/\s+/))
    .filter((raw) => raw.length > 0)
    .filter((raw) => {
      const token = stripArbitrary(raw);
      return token.endsWith('-') || /[^-]--[^-]/.test(token);
    });
}

// Media sin contenedor de tamaño. `size-full` (w-full h-full) hereda del padre; si el padre es un
// <div> pelado (sin className) la imagen toma su tamaño intrínseco: un avatar sale gigante
// (Testimonial39). Es heurístico: un CTA con la misma forma renderiza bien porque el div ocupa el
// ancho del bloque, así que es warning y no issue.
const BARE_PARENT_IMG = /<div>\s*<img\b[^>]*className="[^"]*\bsize-full\b[^"]*"[^>]*>/g;

function runRules(source: string, rules: readonly Rule[]): string[] {
  return rules.flatMap((rule) =>
    [...new Set([...source.matchAll(rule.pattern)].map((m) => m[0]))].map(
      (hit) => `${rule.id}: "${hit}" — ${rule.why}`,
    ),
  );
}

/** Lint de una fuente .tsx. Puro: no toca disco ni red. */
export function lintComponent(source: string): LintResult {
  const issues = [
    ...runRules(source, V4_RULES),
    ...runRules(source, TYPO_RULES),
    ...brokenHyphenTokens(source).map(
      (t) => `typo-hyphen: "${t}" — token de clase con guion roto; no existe y no emite CSS`,
    ),
  ];
  const warnings = [...source.matchAll(BARE_PARENT_IMG)].map(
    (m) => `media-no-container: "${m[0].replace(/\s+/g, ' ').slice(0, 80)}…" — img size-full dentro de <div> sin clase: revisar tamaño a ojo`,
  );
  return { ok: issues.length === 0, issues, warnings };
}
