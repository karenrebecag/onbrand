// Render-gate, parte pura (spec variabilidad-y-observabilidad, RFO3): dado el texto visible de cada
// bloque en el navegador y los props que se emitieron, mide cuánto de lo que se ve NO salió del brief
// (residuo = demo del DS invariante al brief) y decide si la página pasa. La medición en navegador
// vive en scripts/render-gate.ts; aquí no hay DOM ni red, para poder probarlo sin chromium.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isSlotValue } from './catalog/slot-value';

/** Un bloque tal como lo emitió `emit` en render-input.json. */
export interface RenderInputBlock {
  role: string;
  slug: string;
  props: Record<string, unknown>;
  inner?: { slug: string; props: Record<string, unknown> };
}

/** Lo que el navegador ve de un bloque (envoltorio data-wt-*). */
export interface VisibleBlock {
  slug: string | null;
  role: string | null;
  text: string;
  height: number;
  opacity: string;
  images: number;
  brokenImages: number;
  /** Placeholders de campos visibles: se ven aunque no sean nodos de texto. Solo los usa foreign-text,
   * para no mover el residuo que ya calibra el umbral. */
  placeholders?: string[];
}

export interface BlockVerdict {
  slug: string;
  role: string;
  inner?: string;
  visible: boolean;
  visibleChars: number;
  propsChars: number;
  residueChars: number;
  residueRatio: number;
  images: number;
  brokenImages: number;
  /** Hojas del brief que coinciden con un literal de la demo: no se sabe si vinieron del brief. */
  ambiguous: number;
  residueSample: string;
}

export interface PageVerdict {
  blocks: number;
  /** Bloques del DOM que no se pudieron emparejar con uno emitido por slug. */
  unmatched: string[];
  threshold: number;
  visibleChars: number;
  residueChars: number;
  residueRatio: number;
  residueRatioMax: number;
  brokenImages: number;
  failing: string[];
  pass: boolean;
}

// El marco (navbar/footer/banner) trae logos, legales y redes que no salen del brief: su residuo es
// esperable y no reprueba la página.
export const FRAME_ROLES: ReadonlySet<string> = new Set(['navbar', 'footer', 'banner']);
export const DEFAULT_THRESHOLD = 0.5;
/** Archivo que emit escribe junto a la app con los props de cada bloque. */
export const RENDER_INPUT = 'render-input.json';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const normalize = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const chars = (s: string): number => s.replace(/\s+/g, '').length;

/** Texto que los props ponen en pantalla. Un slot lleno (`$component`) aporta sus props y su texto,
 * con números incluidos (un AnimatedCounter pinta su `value`); el slug del componente no se ve. */
export function propLeaves(value: unknown, inSlot = false, out: string[] = []): string[] {
  if (typeof value === 'string') { if (value.trim()) out.push(value); return out; }
  if (typeof value === 'number' && inSlot && Number.isFinite(value)) { out.push(String(value)); return out; }
  if (isSlotValue(value)) {
    propLeaves(value.props, true, out);
    if (value.children) propLeaves(value.children, true, out);
    return out;
  }
  if (Array.isArray(value)) value.forEach((v) => propLeaves(v, inSlot, out));
  else if (isRecord(value)) Object.values(value).forEach((v) => propLeaves(v, inSlot, out));
  return out;
}

/** Valida render-input.json en el límite: es salida del emit, pero se lee de disco. */
export function parseRenderInput(raw: unknown): RenderInputBlock[] {
  if (!Array.isArray(raw)) throw new Error('render-input: se esperaba un arreglo de bloques');
  return raw.map((b, i) => {
    if (!isRecord(b) || typeof b.role !== 'string' || typeof b.slug !== 'string' || !isRecord(b.props)) {
      throw new Error(`render-input[${i}]: role, slug y props son obligatorios`);
    }
    const inner = b.inner;
    if (inner !== undefined && (!isRecord(inner) || typeof inner.slug !== 'string' || !isRecord(inner.props))) {
      throw new Error(`render-input[${i}].inner: slug y props son obligatorios`);
    }
    return { role: b.role, slug: b.slug, props: b.props, ...(inner ? { inner: { slug: inner.slug as string, props: inner.props as Record<string, unknown> } } : {}) };
  });
}

// Una alternativa por tipo de comilla y sin backreference: `(['"`])…(?!\1)` retrocede en JSC hasta
// ~1 s por archivo de datos y el gate pasaba 11 s solo leyendo literales.
export const STRING_LITERAL = /"((?:\\.|[^"\\\n])*)"|'((?:\\.|[^'\\\n])*)'|`((?:\\.|[^`\\\n])*)`/g;

/** Literales string de los *-data.ts(x) del scaffold emitido: la demo cableada del DS. */
export function demoLiterals(root: string): Set<string> {
  const out = new Set<string>();
  const walk = (d: string): void => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) { if (f !== 'node_modules') walk(p); continue; }
      if (!/-data\.tsx?$/.test(f)) continue;
      for (const m of readFileSync(p, 'utf8').matchAll(STRING_LITERAL)) {
        const lit = m[1] ?? m[2] ?? m[3];
        if (lit.length >= 3) out.add(normalize(lit));
      }
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

/** Residuo de un bloque: se resta del texto visible cada hoja de sus props (las más largas primero,
 * para que una hoja corta no parta una larga) y lo que queda es lo que no vino del brief. */
export function blockVerdict(seen: VisibleBlock, emitted: RenderInputBlock | undefined, demo: ReadonlySet<string>): BlockVerdict {
  const leaves = [...new Set(propLeaves([emitted?.props, emitted?.inner?.props]).map(normalize))].sort((a, z) => z.length - a.length);
  let rest = normalize(seen.text);
  const visibleChars = chars(rest);
  for (const leaf of leaves) rest = rest.split(leaf).join(' ');
  const residueChars = chars(rest);
  return {
    slug: emitted?.slug ?? seen.slug ?? '?',
    role: emitted?.role ?? seen.role ?? '?',
    ...(emitted?.inner ? { inner: emitted.inner.slug } : {}),
    visible: seen.height > 0 && seen.opacity !== '0',
    visibleChars,
    propsChars: chars(leaves.join('')),
    residueChars,
    residueRatio: visibleChars ? Number((residueChars / visibleChars).toFixed(3)) : 0,
    images: seen.images,
    brokenImages: seen.brokenImages,
    ambiguous: leaves.filter((l) => demo.has(l)).length,
    residueSample: rest.trim().slice(0, 160),
  };
}

/** Veredicto de la página. Un bloque de contenido falla si supera el umbral de residuo, tiene una
 * imagen rota o no se ve; un bloque del DOM sin pareja emitida reprueba (el sensor no sabe qué medir). */
export function pageVerdict(seen: VisibleBlock[], emitted: RenderInputBlock[], demo: ReadonlySet<string>, threshold = DEFAULT_THRESHOLD): { page: PageVerdict; blocks: BlockVerdict[] } {
  const bySlug = new Map(emitted.map((b) => [b.slug, b]));
  const unmatched = seen.filter((s) => !s.slug || !bySlug.has(s.slug)).map((s) => s.slug ?? '?');
  const blocks = seen.map((s) => blockVerdict(s, s.slug ? bySlug.get(s.slug) : undefined, demo));
  const content = blocks.filter((b) => !FRAME_ROLES.has(b.role));
  const sum = (k: 'visibleChars' | 'residueChars' | 'brokenImages'): number => content.reduce((a, b) => a + b[k], 0);
  const failing = content.filter((b) => b.residueRatio > threshold || b.brokenImages > 0 || !b.visible).map((b) => b.slug);
  const visibleChars = sum('visibleChars');
  return {
    page: {
      blocks: blocks.length,
      unmatched,
      threshold,
      visibleChars,
      residueChars: sum('residueChars'),
      residueRatio: visibleChars ? Number((sum('residueChars') / visibleChars).toFixed(3)) : 0,
      residueRatioMax: Math.max(0, ...content.map((b) => b.residueRatio)),
      brokenImages: sum('brokenImages'),
      failing,
      pass: unmatched.length === 0 && seen.length === emitted.length && failing.length === 0,
    },
    blocks,
  };
}
