// Contraste WCAG entre colores CSS que se pueden leer fuera del navegador (hex, rgb() y oklch()). Lo usa checkIdentity
// para que una identidad declarada por el agente no deje CTAs ni texto ilegibles, también dentro de una zona oscura.

export const MIN_CONTRAST = 4.5;

export type Rgb = [number, number, number];

const HEX = /^#([\da-f]{3}|[\da-f]{6})$/i;
const ALPHA = String.raw`(?:\s*[/,]\s*([\d.]+%?))?`;
const RGB = new RegExp(String.raw`^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})${ALPHA}\s*\)$`, 'i');
const OKLCH = new RegExp(String.raw`^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?${ALPHA}\s*\)$`, 'i');

const alphaOf = (raw: string | undefined): number => {
  if (raw === undefined) return 1;
  const n = raw.endsWith('%') ? Number(raw.slice(0, -1)) / 100 : Number(raw);
  return Math.min(Math.max(n, 0), 1);
};

// OKLab -> sRGB de Björn Ottosson (https://bottosson.github.io/posts/oklab/, "Converting from linear sRGB to OKLab").
// HACK: fuera de gamut se recorta por canal, no se mapea al borde del gamut. Mapear con CSS Color 4 §13 si un preset o
// una marca usa un oklch con croma fuera de sRGB y el contraste medido difiere del navegador.
function oklabToRgb(l: number, a: number, b: number): Rgb {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_, -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_, -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_];
  return lin.map((v) => {
    const g = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(Math.max(g, 0), 1) * 255);
  }) as Rgb;
}

const oklchToRgb = (l: number, c: number, h: number): Rgb => oklabToRgb(l, c * Math.cos((h * Math.PI) / 180), c * Math.sin((h * Math.PI) / 180));

// sRGB -> OKLab, misma fuente que oklabToRgb ("Converting from linear sRGB to OKLab").
function rgbToOklab(rgb: Rgb): [number, number, number] {
  const [r, g, b] = rgb.map((c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** `color-mix(in oklab, a, b p)` con `p` = peso de `b` (CSS Color 5 §2): la banda de sección del contrato se declara así. */
export function mixOklab(a: Rgb, b: Rgb, p: number): Rgb {
  const [A, B] = [rgbToOklab(a), rgbToOklab(b)];
  return oklabToRgb(A[0] * (1 - p) + B[0] * p, A[1] * (1 - p) + B[1] * p, A[2] * (1 - p) + B[2] * p);
}

/** Color y opacidad de un valor CSS: hex de 3 o 6 dígitos, rgb()/rgba() en sintaxis vieja o nueva, u oklch(); null para
 * color-mix, var() o nombres. */
export function parseColorAlpha(value: string | undefined): { rgb: Rgb; alpha: number } | null {
  const v = value?.trim() ?? '';
  const hex = HEX.exec(v);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    return { rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb, alpha: 1 };
  }
  const rgb = RGB.exec(v);
  if (rgb) {
    const c = rgb.slice(1, 4).map(Number);
    return c.every((n) => n <= 255) ? { rgb: c as Rgb, alpha: alphaOf(rgb[4]) } : null;
  }
  const ok = OKLCH.exec(v);
  if (!ok) return null;
  const l = ok[1].endsWith('%') ? Number(ok[1].slice(0, -1)) / 100 : Number(ok[1]);
  return { rgb: oklchToRgb(l, Number(ok[2]), Number(ok[3])), alpha: alphaOf(ok[4]) };
}

/** El color tal como se ve: con opacidad se compone sobre `backdrop` (el fondo de la zona). Un color translúcido sin fondo
 * conocido da null, porque medirlo como opaco daba contrastes que la página no tiene (un --accent-subtle /.13 medido
 * como si fuera el acento lleno). */
export function parseColor(value: string | undefined, backdrop?: Rgb): Rgb | null {
  const c = parseColorAlpha(value);
  if (!c) return null;
  if (c.alpha === 1) return c.rgb;
  if (!backdrop) return null;
  return c.rgb.map((v, i) => Math.round(v * c.alpha + backdrop[i] * (1 - c.alpha))) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number): number => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export const toHex = (c: Rgb): string => `#${c.map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`;

/**
 * El tono más cercano a `seed` que llega a MIN_CONTRAST con `foreground`: lo oscurece si el texto es claro y lo aclara si
 * es oscuro, en pasos de 2 %, como Stitch deriva la primaria de la semilla. null si ni el extremo alcanza.
 */
export function readableTone(seed: Rgb, foreground: Rgb): string | null {
  const toward: Rgb = luminance(foreground) > 0.5 ? [0, 0, 0] : [255, 255, 255];
  for (let t = 0; t <= 1; t += 0.02) {
    const c = seed.map((v, i) => v + (toward[i] - v) * t) as Rgb;
    if (contrast(c, foreground) >= MIN_CONTRAST) return toHex(c);
  }
  return null;
}
