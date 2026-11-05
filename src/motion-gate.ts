// Gate estático del contrato de motion sobre el DOM (W6 del UIKit, spec wave-6-motion):
// un módulo de motion solo entra al registry si encuentra sus nodos por data-* declarados, toma sus valores
// de los tokens y respeta reduced-motion. Es estático a propósito: corre sobre el vault sin GSAP ni DOM.

export type MotionRule = 'shape' | 'auto-init' | 'hooks' | 'hook-prefix' | 'stagger-invalidate' | 'class-selector' | 'dynamic-selector' | 'class-state' | 'literal' | 'reduced-motion' | 'coupled' | 'css-not-imported';

export interface MotionFailure { rule: MotionRule; detail: string }
/** `cssFile`: nombre del .css hermano en disco. El registry publica solo el CSS que el módulo importa, así que
 * uno sin import no llega al workspace. */
export interface MotionSource { js: string; css?: string; cssFile?: string }
export interface MotionVerdict { pass: boolean; hooks: string[]; failures: MotionFailure[] }

const QUERY_CALL = /\b(?:querySelector(?:All)?|closest|matches)(?:<[^>()]*>)?\(\s*/g;
const STRING_LITERAL = /^(['"])((?:\\.|(?!\1).)*)\1|^`([^`$]*)`/;

/** Quita comentarios para que un `.foo` o un `0.3s` dentro de una explicación no cuente. */
const stripComments = (code: string): string =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');

const kebab = (camel: string): string => `data-${camel.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

export function declaredHooks(js: string): string[] | null {
  const m = /export\s+const\s+REQUIRED_HOOKS\s*=\s*\[([\s\S]*?)\]/.exec(js);
  if (!m) return null;
  return [...m[1].matchAll(/['"`](data-[\w-]+)['"`]/g)].map((x) => x[1]);
}

interface Selector { literal: string | null; at: number }

function selectors(js: string): Selector[] {
  return [...js.matchAll(QUERY_CALL)].map((m) => {
    const rest = js.slice(m.index + m[0].length);
    const lit = STRING_LITERAL.exec(rest);
    return { literal: lit ? (lit[2] ?? lit[3] ?? '') : null, at: m.index };
  });
}

/** Atributos data-* que el módulo usa: en selectores, en dataset y en get/has/set/removeAttribute. */
export function usedAttributes(js: string): string[] {
  const fromSelectors = selectors(js).flatMap((s) => [...(s.literal ?? '').matchAll(/\[(data-[\w-]+)/g)].map((x) => x[1]));
  const fromDataset = [...js.matchAll(/\.dataset\.([a-zA-Z]\w*)/g)].map((x) => kebab(x[1]));
  const fromAttr = [...js.matchAll(/(?:get|has|set|remove|toggle)Attribute\(\s*['"`](data-[\w-]+)/g)].map((x) => x[1]);
  return [...new Set([...fromSelectors, ...fromDataset, ...fromAttr])].sort();
}

const lineOf = (code: string, at: number): number => code.slice(0, at).split('\n').length;

function literalFailures(js: string, css: string): MotionFailure[] {
  const out: MotionFailure[] = [];
  // `ease: "none"` es el mapeo lineal de un scrub, no un valor de diseño.
  const jsLiterals: [RegExp, string][] = [
    [/\b(duration|delay|each)\s*:\s*(\d*\.?\d+)/g, 'número'],
    [/\bstagger\s*:\s*(\d*\.?\d+)/g, 'stagger'],
    [/\bease\s*:\s*(['"`])(?!none\1)([^'"`]+)\1/g, 'ease'],
    [/CustomEase\.create\(\s*[^,]+,\s*['"`]/g, 'CustomEase'],
  ];
  for (const [re, kind] of jsLiterals) {
    for (const m of js.matchAll(re)) {
      if ((kind === 'número' || kind === 'stagger') && Number(m[kind === 'número' ? 2 : 1]) === 0) continue;
      out.push({ rule: 'literal', detail: `js:${lineOf(js, m.index)} ${kind} literal \`${m[0]}\`` });
    }
  }
  // Toda la declaración, no el primer número: "transform 0s 0.3s" esconde el 0.3s detrás del 0.
  for (const m of css.matchAll(/\b(transition|animation)(?:-duration|-timing-function|-delay)?\s*:([^;}]*)/g)) {
    const values = [...m[2].matchAll(/(\d*\.?\d+)m?s\b|cubic-bezier\(|linear\(/g)].filter((v) => v[1] === undefined || Number(v[1]) !== 0);
    if (values.length) out.push({ rule: 'literal', detail: `css:${lineOf(css, m.index)} \`${m[0].trim()}\`` });
  }
  return out;
}

/** Medido en Chromium (gsap 3.15): un `stagger` bajo un ScrollTrigger con `invalidateOnRefresh` (tween, timeline
 * o from) solo vuelve a pintar el estado inicial del primer target en el refresh de carga; el resto se ve
 * antes de su entrada. Se arregla sin invalidar (valores estáticos) o con posiciones por target en un timeline. */
function staggerInvalidateFailures(js: string): MotionFailure[] {
  const staggers = [...js.matchAll(/\bstagger\s*:(?!\s*0\b)/g)];
  const invalidate = /\binvalidateOnRefresh\s*:\s*true/.exec(js);
  if (!staggers.length || !invalidate) return [];
  return [{ rule: 'stagger-invalidate', detail: `stagger en js:${staggers.map((m) => lineOf(js, m.index)).join(',')} con invalidateOnRefresh en js:${lineOf(js, invalidate.index)}: quita invalidateOnRefresh o usa posiciones por target` }];
}

export function gateMotion(source: MotionSource): MotionVerdict {
  const js = stripComments(source.js);
  const css = (source.css ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
  const failures: MotionFailure[] = [];

  if (source.cssFile && !new RegExp(`import\\s+['"]\\./${source.cssFile.replace(/\./g, '\\.')}['"]`).test(js)) {
    failures.push({ rule: 'css-not-imported', detail: `${source.cssFile} existe pero el módulo no lo importa: el registry no lo publica` });
  }

  const coupled = /getContext\(|\bTHREE\b|WebGL|\bbarba\b|new\s+Lenis|Locomotive|\bMatter\.|mapboxgl/.exec(js);
  if (coupled) failures.push({ rule: 'coupled', detail: `js:${lineOf(js, coupled.index)} \`${coupled[0]}\`: canvas/WebGL o page-level, fuera del carril` });

  const hooks = declaredHooks(js);
  if (!hooks) failures.push({ rule: 'shape', detail: 'falta `export const REQUIRED_HOOKS = [...]`' });
  if (!/export\s+function\s+init\w*\s*\(/.test(js)) failures.push({ rule: 'shape', detail: 'falta `export function init*(config): CleanupFn`' });

  const auto = /addEventListener\(\s*['"]DOMContentLoaded|document\.readyState|window\.\w+\s*=(?!=)/.exec(js);
  if (auto) failures.push({ rule: 'auto-init', detail: `js:${lineOf(js, auto.index)} \`${auto[0]}\`: el consumidor llama init, el módulo no se arranca solo` });

  // Un módulo CSS-only usa sus hooks en los selectores del CSS.
  const used = [...new Set([...usedAttributes(js), ...[...css.matchAll(/\[(data-[\w-]+)/g)].map((m) => m[1])])].sort();
  // Config prefijada con la raíz (convención W6, data-reveal-stagger): dos efectos en el mismo nodo no se leen la config.
  if (hooks && hooks.length) {
    for (const h of hooks.slice(1).filter((x) => !x.startsWith(`${hooks[0]}-`))) failures.push({ rule: 'hook-prefix', detail: `${h} no empieza con la raíz ${hooks[0]}-` });
  }
  if (hooks) {
    for (const a of used.filter((x) => !hooks.includes(x))) failures.push({ rule: 'hooks', detail: `${a} se usa y no está en REQUIRED_HOOKS` });
    for (const h of hooks.filter((x) => !used.includes(x))) failures.push({ rule: 'hooks', detail: `${h} está en REQUIRED_HOOKS y el módulo no lo usa` });
  }

  for (const s of selectors(js)) {
    if (s.literal === null) { failures.push({ rule: 'dynamic-selector', detail: `js:${lineOf(js, s.at)} selector no literal: no se puede verificar que sea data-*` }); continue; }
    if (/(^|[\s,>+~(])\.[a-zA-Z_]/.test(s.literal.replace(/\[[^\]]*\]/g, ''))) {
      failures.push({ rule: 'class-selector', detail: `js:${lineOf(js, s.at)} \`${s.literal}\`` });
    }
  }
  for (const m of js.matchAll(/classList\.(add|remove|toggle|contains)\(/g)) {
    failures.push({ rule: 'class-state', detail: `js:${lineOf(js, m.index)} \`classList.${m[1]}\`: el estado va en data-*` });
  }

  failures.push(...literalFailures(js, css), ...staggerInvalidateFailures(js));

  // La rama va donde vive la animación: un módulo CSS-only no anima en JS, su CSS sí.
  const jsAnimates = /\bgsap\b|\.animate\(|requestAnimationFrame/.test(js);
  const cssAnimates = /\b(transition|animation)(-[a-z-]+)?\s*:|@keyframes/.test(css);
  if ((jsAnimates || !cssAnimates) && !/prefers-reduced-motion|prefersReducedMotion\(/.test(js)) failures.push({ rule: 'reduced-motion', detail: 'sin rama de prefers-reduced-motion en el JS' });
  if (cssAnimates && !/@media[^{]*prefers-reduced-motion/.test(css)) failures.push({ rule: 'reduced-motion', detail: 'el CSS anima sin @media (prefers-reduced-motion)' });

  return { pass: failures.length === 0, hooks: hooks ?? [], failures };
}
