// foreign-text (pedido de QA 2026-10-22, run 817da32c): texto visible que no viene de page.json. El
// residuo ya lo mide como proporción; esto lo nombra fragmento por fragmento y lo separa en dos
// clases. `ui` es texto fijo en el código del componente (Subscribe, Cancel): es legítimo como chrome,
// pero sigue contando si su idioma no es el del brief, para que el trabajo de i18n quede medido.
// `demo` es todo lo demás: copy que no salió del brief y que el composer no puede reemplazar.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { normalize, propLeaves, STRING_LITERAL, type RenderInputBlock, type VisibleBlock } from './render-gate';

export type Lang = 'en' | 'es' | 'pt';
/** Idioma en que está escrito el código del DS: un literal fijo sin señal propia se asume en él. */
export const SOURCE_LANG: Lang = 'en';

export interface ForeignFinding {
  slug: string;
  role: string;
  text: string;
  kind: 'ui' | 'demo';
  lang?: Lang;
}

export interface ForeignSummary {
  lang?: Lang;
  count: number;
  chars: number;
  ui: number;
  demo: number;
}

// Palabras funcionales: aparecen en casi toda frase y casi no se cruzan entre los tres idiomas. Las
// que comparten dos idiomas (que, por, para, no) quedan fuera para no empatar.
const STOPWORDS: Record<Lang, ReadonlySet<string>> = {
  en: new Set(['the', 'and', 'of', 'to', 'is', 'are', 'on', 'for', 'with', 'your', 'you', 'we', 'our', 'this', 'that', 'from', 'by', 'it', 'be', 'or', 'was', 'an', 'all', 'more', 'get', 'every', 'one', 'how', 'what', 'into', 'than', 'only']),
  es: new Set(['el', 'la', 'los', 'las', 'del', 'y', 'un', 'una', 'es', 'son', 'con', 'tu', 'tus', 'su', 'sus', 'nuestro', 'nuestra', 'se', 'al', 'lo', 'como', 'más', 'sin', 'cada', 'hasta', 'desde', 'muy', 'también', 'está', 'están']),
  pt: new Set(['os', 'do', 'da', 'dos', 'das', 'em', 'um', 'uma', 'é', 'são', 'com', 'seu', 'sua', 'não', 'mais', 'ao', 'na', 'nas', 'nos', 'você', 'cada', 'até', 'também', 'está', 'muito']),
};
const LETTERS = /\p{L}{2,}/u;

/** Idioma por palabras funcionales, o undefined si no hay señal o empata. */
export function detectLang(text: string): Lang | undefined {
  const words = normalize(text).split(/[^\p{L}]+/u).filter(Boolean);
  // ñ ¿ ¡ son solo del español y ã õ ç solo del portugués: valen una palabra funcional cada uno.
  const marks: Record<Lang, number> = { en: 0, es: /[ñ¿¡]/.test(text) ? 1 : 0, pt: /[ãõç]/.test(text) ? 1 : 0 };
  const ranked = (Object.keys(STOPWORDS) as Lang[])
    .map((l) => [l, words.filter((w) => STOPWORDS[l].has(w)).length + marks[l]] as const)
    .sort((a, z) => z[1] - a[1]);
  if (ranked[0][1] === 0 || ranked[0][1] === ranked[1][1]) return undefined;
  return ranked[0][0];
}

/** Texto visible fijo en el código de los componentes (no en *-data): JSX text, placeholder y
 * literales que empiezan en mayúscula o tienen espacio. Los demás literales son estados o clases. */
export function uiLiterals(root: string): Set<string> {
  const out = new Set<string>();
  const add = (s: string): void => { if (LETTERS.test(s) && s.trim().length >= 3) out.add(normalize(s)); };
  const walk = (d: string): void => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) { if (f !== 'node_modules') walk(p); continue; }
      if (!/\.tsx?$/.test(f) || /-data\.tsx?$/.test(f) || /\.test\./.test(f)) continue;
      const src = readFileSync(p, 'utf8');
      for (const m of src.matchAll(/>\s*([^<>{}\n]*\p{L}[^<>{}\n]*?)\s*</gu)) if (!/[=;()&|]/.test(m[1])) add(m[1]);
      for (const m of src.matchAll(STRING_LITERAL)) {
        const lit = m[1] ?? m[2];
        if (lit !== undefined && (/^\p{Lu}/u.test(lit) || lit.includes(' '))) add(lit);
      }
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CUT = '\u0000';

/** Fragmentos de un bloque que no salieron de sus props, cada uno clasificado. */
export function blockForeign(seen: VisibleBlock, emitted: RenderInputBlock | undefined, ui: ReadonlySet<string>, briefLang: Lang | undefined): ForeignFinding[] {
  const leaves = [...new Set(propLeaves([emitted?.props, emitted?.inner?.props]).map(normalize))].sort((a, z) => z.length - a.length);
  let rest = normalize([seen.text, ...(seen.placeholders ?? [])].join(` ${CUT} `));
  for (const leaf of leaves) rest = rest.split(leaf).join(CUT);
  const slug = emitted?.slug ?? seen.slug ?? '?';
  const role = emitted?.role ?? seen.role ?? '?';
  const out: ForeignFinding[] = [];
  const literals = [...ui].sort((a, z) => z.length - a.length);
  for (let frag of rest.split(CUT)) {
    if (!LETTERS.test(frag)) continue;
    for (const lit of literals) {
      const re = new RegExp(`(^|[^\\p{L}])${escape(lit)}(?=$|[^\\p{L}])`, 'gu');
      const cut = frag.replace(re, `$1${CUT}`);
      if (cut === frag) continue;
      frag = cut;
      const lang = detectLang(lit) ?? SOURCE_LANG;
      if (briefLang && lang !== briefLang) out.push({ slug, role, text: lit, kind: 'ui', lang });
    }
    for (const left of frag.split(CUT)) {
      const text = left.trim();
      if (!LETTERS.test(text)) continue;
      const lang = detectLang(text);
      out.push({ slug, role, text: text.slice(0, 160), kind: 'demo', ...(lang ? { lang } : {}) });
    }
  }
  return out;
}

/** Hallazgos de la página. El idioma del brief es el que se pide, o el de los propios props emitidos. */
export function pageForeign(seen: VisibleBlock[], emitted: RenderInputBlock[], ui: ReadonlySet<string>, lang?: Lang): { summary: ForeignSummary; findings: ForeignFinding[] } {
  const briefLang = lang ?? detectLang(propLeaves(emitted.map((b) => [b.props, b.inner?.props])).join(' '));
  const bySlug = new Map(emitted.map((b) => [b.slug, b]));
  const findings = seen.flatMap((s) => blockForeign(s, s.slug ? bySlug.get(s.slug) : undefined, ui, briefLang));
  return {
    summary: {
      ...(briefLang ? { lang: briefLang } : {}),
      count: findings.length,
      chars: findings.reduce((a, f) => a + f.text.replace(/\s+/g, '').length, 0),
      ui: findings.filter((f) => f.kind === 'ui').length,
      demo: findings.filter((f) => f.kind === 'demo').length,
    },
    findings,
  };
}
