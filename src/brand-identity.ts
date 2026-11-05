// Baja un BrandPack ya parseado a su capa de identidad (atributos de <html>, declaraciones :root y la hoja identity.css)
// y el <link> de fuentes. No parsea ni lee disco: depende solo de brand-fonts (hoja) y de los tipos de brand-pack
// (import type), así parseBrandPackV2 puede llamar a resolveIdentity sin cerrar un ciclo (docs/estandares.md A4).

import { familyOf, FONT_LIST, googleFontsHref } from './brand-fonts';
import type { BrandPack, BrandSurface } from './brand-pack';

export interface Identity { htmlAttrs: Record<string, string>; fontImport?: string; rootDeclarations: string[]; darkDeclarations: string[] }

const SURFACE_VARS: Record<keyof BrandSurface, string> = {
  background: '--background',
  surface: '--surface',
  foreground: '--foreground',
  textSecondary: '--text-secondary',
};

/** Baja un BrandPack a su capa de identidad (atributos de <html> + declaraciones :root). */
export function resolveIdentity(brand: BrandPack): Identity {
  const htmlAttrs: Record<string, string> = {};
  // Pares ordenados [token, valor] de la identidad en `:root`; de aquí salen tanto el bloque claro
  // como el oscuro (los invariantes de tema se reemiten en oscuro para ganar al contrato, theme/tokens.css).
  const rootPairs: [string, string][] = [];

  if (typeof brand.accent === 'string') {
    htmlAttrs['data-accent'] = brand.accent;
  } else {
    rootPairs.push(['--accent', brand.accent.base]);
    rootPairs.push(['--accent-strong', brand.accent.strong]);
    rootPairs.push(['--accent-subtle', brand.accent.subtle]);
    if (brand.accent.foreground) rootPairs.push(['--accent-foreground', brand.accent.foreground]);
  }

  if (brand.surface) {
    for (const [key, cssVar] of Object.entries(SURFACE_VARS) as [keyof BrandSurface, string][]) {
      const value = brand.surface[key];
      if (value) rootPairs.push([cssVar, value]);
    }
  }

  if (brand.fonts?.display) rootPairs.push(['--font-geist', quoteFont(brand.fonts.display)]);
  if (brand.fonts?.body) rootPairs.push(['--font-inter', quoteFont(brand.fonts.body)]);

  // Token map: el canal general va al final, así puede sobrescribir incluso accent/surface/fonts (RF2).
  if (brand.tokens) {
    for (const [key, value] of Object.entries(brand.tokens)) rootPairs.push([key, value]);
  }

  const rootDeclarations = rootPairs.map(([k, v]) => `${k}: ${v};`);

  // Bloque oscuro: el default dark del contrato (`[data-theme="dark"]` de theme/tokens.css) redeclara el accent
  // en cada zona, así que la marca se volvería gris en oscuro. Se reemite la identidad bajo el mismo
  // selector para que la marca gane por orden; los tokens que SÍ cambian por tema
  // (superficie/borde/texto) toman su valor oscuro de `tokensDark`, que sobreescribe al final.
  const dark = new Map(rootPairs);
  if (brand.tokensDark) for (const [k, v] of Object.entries(brand.tokensDark)) dark.set(k, v);
  const darkDeclarations = brand.tokensDark || rootPairs.length ? [...dark].map(([k, v]) => `${k}: ${v};`) : [];

  return { htmlAttrs, ...(brand.fonts?.import ? { fontImport: brand.fonts.import } : {}), rootDeclarations, darkDeclarations };
}

const quoteFont = (name: string): string => (/\s/.test(name) ? `'${name}'` : name);

export const isLoadableFont = (family: string): boolean => FONT_LIST.some((f) => f.family.toLowerCase() === familyOf(family).toLowerCase());

/** El <link> de Google Fonts para las familias del pack que el scaffold no trae instaladas. identity.css solo nombra la
 * familia (--font-geist: Fraunces): sin este link la página cae a sans. null si no hace falta o si el pack carga las
 * suyas por fonts.import. */
export function brandFontsHref(brand: BrandPack): string | null {
  if (brand.fonts?.import) return null;
  return googleFontsHref([brand.fonts?.display, brand.fonts?.body].filter((f): f is string => !!f).map(familyOf));
}

/** CSS listo para identity.css: @import de fuentes + override con el mismo alcance que foundation.css
 * (`:root, [data-theme]` y `[data-theme="dark"]`), para que la marca también gane dentro de una zona.
 * '' si la marca es solo un preset. */
export function identityCss(brand: BrandPack): string {
  const id = resolveIdentity(brand);
  const parts: string[] = [];
  if (id.fontImport) parts.push(`@import url('${id.fontImport}');`);
  if (id.rootDeclarations.length) parts.push(`:root,\n[data-theme] {\n  ${id.rootDeclarations.join('\n  ')}\n}`);
  if (id.darkDeclarations.length) parts.push(`[data-theme="dark"] {\n  ${id.darkDeclarations.join('\n  ')}\n}`);
  return `${parts.join('\n')}\n`;
}
