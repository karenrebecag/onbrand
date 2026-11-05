// Capa de imágenes (pasada 2): los bloques Relume/Arc traen el placeholder gris de Relume en sus
// Defaults. Al emitir, se recorre el árbol de props y cada `src` placeholder se reemplaza por una
// imagen real DETERMINISTA, clasificada por el `alt` hermano: logo (monograma SVG), avatar de persona
// (iniciales SVG) o foto (servicio por seed). Avatares y logos son SVG embebidos (sin red); las fotos
// usan un seed estable para que la misma página rinda igual siempre.

const PLACEHOLDER = /placeholder-image\.svg(\?|$)|\/placeholder\b/i;
// Cualquier asset del CDN de Relume es demo (kit-icon.svg da 403, webflow-logo.svg es la marca de otro).
const RELUME_CDN = /^https:\/\/d22po4pjz3o32e\.cloudfront\.net\//;

/** `stock` = el pipeline emit: una foto sin dato sale de picsum por seed. `omit` = el builder, como v0
 * (RE-imagen-sin-dato): nunca stock ni placeholder; sin foto el slot queda vacío y no se pinta. */
export interface FillOptions {
  photo: 'stock' | 'omit';
}
const STOCK: FillOptions = { photo: 'stock' };

/** Hash estable (djb2) de un string a entero positivo. */
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

const PALETTE = [
  ['#6366f1', '#8b5cf6'], ['#0ea5e9', '#2563eb'], ['#10b981', '#059669'], ['#f59e0b', '#ef4444'],
  ['#ec4899', '#8b5cf6'], ['#14b8a6', '#0ea5e9'], ['#f97316', '#db2777'], ['#22c55e', '#14b8a6'],
];

const initials = (text: string): string =>
  text.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '•';

const svgDataUri = (svg: string): string => `data:image/svg+xml,${encodeURIComponent(svg.replace(/\s+/g, ' ').trim())}`;

/** Avatar de iniciales sobre un degradado estable por nombre. */
export function avatarFor(name: string): string {
  const [a, b] = PALETTE[hash(name) % PALETTE.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
    <rect width="200" height="200" fill="url(#g)"/>
    <text x="100" y="100" dy="0.35em" text-anchor="middle" font-family="system-ui,sans-serif" font-size="78" font-weight="600" fill="#fff">${initials(name)}</text>
  </svg>`;
  return svgDataUri(svg);
}

/** Monograma de logo: cuadro redondeado neutro con la inicial de la marca. */
export function logoFor(brand: string): string {
  const name = brand.replace(/^logo\s+(de\s+)?/i, '').trim();
  const [a, b] = PALETTE[hash(name) % PALETTE.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="96" viewBox="0 0 240 96">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
    <rect x="16" y="24" width="48" height="48" rx="12" fill="url(#g)"/>
    <text x="40" y="48" dy="0.35em" text-anchor="middle" font-family="system-ui,sans-serif" font-size="24" font-weight="700" fill="#fff">${initials(name)}</text>
    <text x="76" y="48" dy="0.35em" font-family="system-ui,sans-serif" font-size="22" font-weight="600" fill="#52525b">${name.slice(0, 16)}</text>
  </svg>`;
  return svgDataUri(svg);
}

/** Foto real determinista por seed (sin API key). */
export const photoFor = (seed: string, w = 1200, h = 900): string =>
  `https://picsum.photos/seed/${encodeURIComponent(seed)}/${w}/${h}`;

const isPersonName = (alt: string): boolean => /^[A-ZÁÉÍÓÚÑ][\wáéíóúñ]+(\s+[A-ZÁÉÍÓÚÑ][\wáéíóúñ]+){1,2}$/.test(alt.trim());

/** Reemplaza un src placeholder por una imagen real según el `alt` hermano y la clave del nodo. */
function pickReplacement(key: string, alt: string, seed: string, opts: FillOptions): string {
  if (/logo/i.test(key) || /^logo\b/i.test(alt)) return logoFor(alt || seed);
  if (/avatar|headshot|portrait/i.test(key) || isPersonName(alt)) return avatarFor(alt || seed);
  return opts.photo === 'stock' ? photoFor(`${seed}-${alt || key}`) : '';
}

const needsFill = (src: string, opts: FillOptions): boolean => PLACEHOLDER.test(src) || (opts.photo === 'omit' && RELUME_CDN.test(src));

/** Recorre props (inmutable) y rellena todo `src` placeholder. `key` es la clave que contiene el
 * objeto-imagen, para distinguir avatar/logo/foto. */
export function fillImages<T>(value: T, seed: string, key = '', opts: FillOptions = STOCK): T {
  if (Array.isArray(value)) return value.map((v, i) => fillImages(v, `${seed}-${i}`, key, opts)) as unknown as T;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.src === 'string' && needsFill(obj.src, opts)) {
      const alt = typeof obj.alt === 'string' ? obj.alt : '';
      return { ...obj, src: pickReplacement(key, alt, seed, opts) } as unknown as T;
    }
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fillImages(v, `${seed}-${k}`, k, opts)])) as unknown as T;
  }
  return value;
}
