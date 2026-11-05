// Sensores de marca (P1, desbloqueado por #158: la marca viaja por petición y queda en page.brand). Afirman que la
// página aplica el pack que pidió: acento, tipografías y fondo. Solo se afirman con marca pedida; v0 no tiene
// este contrato, así que su calibración es no marcar nada sin pack.

import type { Owner, PageMeasure } from './page-sensors';
import { fold } from './plan-sensors';

export type BrandField = 'brand.accent' | 'brand.typeface' | 'brand.background' | 'brand.declared' | 'brand.highlight-area' | 'brand.logo';

export interface BrandDefect { field: BrandField; owner: Owner; section: string; expected: string; actual: string; message: string }

/** Lo que el sensor lee del brand.json del pack (src/brand.ts BrandPack). */
export interface BrandExpect {
  name: string;
  accent: string | { base: string };
  fonts?: { display?: string; body?: string };
  surface?: { background?: string };
  tokens?: Record<string, string>;
  /** brand.json logoKind ('mark' si el pack no lo declara). Ausente solo sin pack: entonces decide la proporción medida. */
  logoKind?: 'wordmark' | 'mark';
}

const hex = (h: string): number[] | null => {
  const m = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(h.trim());
  return m ? m.slice(1).map((x) => parseInt(x, 16)) : null;
};
const rgb = (c: string): number[] => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
const distance = (a: number[], b: number[]): number => Math.max(...a.map((v, i) => Math.abs(v - (b[i] ?? 0))));
// Un acento de marca se reconoce aunque el DS lo pase por oklch: unos pocos puntos por canal de redondeo.
const MAX_ACCENT_DELTA = 12;
const MAX_BACKGROUND_DELTA = 4;
// Un punto, una barra, un indicador o un badge con el color de identidad es uso de detalle; un botón (80×32 = 2560) o
// un bloque ya no.
const MAX_HIGHLIGHT_DETAIL_AREA = 2500;

// Con pack manda su logoKind: brandExpectOf lo rellena con 'mark' si falta, como el contrato (brand-pack parseLogoKind,
// brandpack-v2.schema.json), así un wordmark apilado (cuadrado) también repite el nombre y un símbolo ancho no. Sin pack
// (identidad efímera, que no declara logo) un logo ancho (proporción >= 2,5, QA gen7) se toma por wordmark.
export const WORDMARK_RATIO = 2.5;

const isWordmark = (pack: BrandExpect, ratio: number | undefined): boolean =>
  // Una medida vieja sin ratio solo traía logos anchos (el navegador filtraba por proporción).
  pack.logoKind ? pack.logoKind === 'wordmark' : (ratio ?? WORDMARK_RATIO) >= WORDMARK_RATIO;

function logoDefects(m: PageMeasure, pack: BrandExpect): BrandDefect[] {
  const name = fold(pack.name);
  return m.sections.flatMap((s) => (s.logos ?? []).filter((l) => fold(l.text) === name && isWordmark(pack, l.ratio)).slice(0, 1)
    .map((l) => ({ field: 'brand.logo' as const, owner: 'B' as const, section: s.key, expected: 'el logo solo', actual: `logo + "${l.text}"`, message: `${s.role}: el logo de ${pack.name} ya trae el nombre y al lado se repite el texto "${l.text}"` })));
}

export function brandSensors(m: PageMeasure, pack: BrandExpect): BrandDefect[] {
  const out: BrandDefect[] = [...logoDefects(m, pack)];
  const d = (field: BrandField, expected: string, actual: string, message: string) => out.push({ field, owner: 'A', section: '-', expected, actual, message });

  if (typeof pack.accent === 'string') {
    if (m.accent?.attr !== pack.accent) d('brand.accent', pack.accent, m.accent?.attr ?? '(sin data-accent)', `${pack.name} pide el acento ${pack.accent} y el documento trae ${m.accent?.attr ?? 'ninguno'}`);
  } else {
    const want = hex(pack.accent.base);
    const got = m.accent?.rgb ? rgb(m.accent.rgb) : null;
    // Un base que no es hex (oklch en el pack) no se puede comparar fuera del navegador: no se afirma.
    if (want && (!got || distance(want, got) > MAX_ACCENT_DELTA)) d('brand.accent', pack.accent.base, m.accent?.rgb ?? '(sin --accent)', `${pack.name} pide el acento ${pack.accent.base} y la página resuelve ${m.accent?.rgb ?? 'ninguno'} (data-accent="${m.accent?.attr ?? ''}")`);
  }

  for (const family of [pack.fonts?.display, pack.fonts?.body].filter((f): f is string => !!f)) {
    const used = m.fonts.find((f) => fold(f.family).startsWith(fold(family)));
    if (!used || !used.loaded || used.count === 0) d('brand.typeface', family, used ? `${used.family} sin cargar` : m.fonts.filter((f) => !f.generic).map((f) => f.family).join(', ') || '(ninguna)', `${pack.name} usa ${family} y la página ${used ? 'no la carga' : `pinta con ${m.fonts.filter((f) => !f.generic).map((f) => f.family).join(', ')}`}`);
  }

  const bg = pack.surface?.background ? hex(pack.surface.background) : null;
  const page = m.sections.find((s) => s.surface)?.surface?.page;
  if (bg && page && distance(bg, rgb(page)) > MAX_BACKGROUND_DELTA) d('brand.background', pack.surface!.background!, page, `${pack.name} pide el fondo ${pack.surface!.background} y la página pinta ${page}`);
  // Una marca que separa su color de identidad del interactivo (--brand-highlight distinto de --accent) lo reserva para
  // detalles: ningún CTA ni área grande lo pinta.
  const highlight = pack.tokens?.['--brand-highlight'] ? hex(pack.tokens['--brand-highlight']) : null;
  const accentHex = typeof pack.accent === 'string' ? null : hex(pack.accent.base);
  if (highlight && accentHex && distance(highlight, accentHex) > MAX_ACCENT_DELTA) {
    for (const a of m.highlightAreas ?? []) {
      if (a.area <= MAX_HIGHLIGHT_DETAIL_AREA || distance(highlight, rgb(a.bg)) > MAX_ACCENT_DELTA) continue;
      out.push({ field: 'brand.highlight-area', owner: 'A', section: a.section, expected: `${pack.tokens!['--brand-highlight']} solo en detalles (≤${MAX_HIGHLIGHT_DETAIL_AREA}px²)`, actual: `${a.tag} "${a.text}" ${a.area}px² en ${a.bg}`, message: `${pack.name} reserva ${pack.tokens!['--brand-highlight']} para detalles y ${a.tag} "${a.text}" lo pinta en ${a.area}px²` });
    }
  }
  return out;
}
