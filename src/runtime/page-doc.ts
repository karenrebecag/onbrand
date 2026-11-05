// Estado de página (PageContract, ADR 0008) visto desde L6. Como en v0, donde `app/layout.tsx` del repo lleva
// lang/title/description y sobrevive a cada follow-up porque el agente edita sobre el commit anterior, aquí
// el estado vive en `page.json.page`, viaja en el commit de cada versión y el runner lo proyecta a
// `index.html`. L6 solo interpreta los campos del documento; el resto del contrato (secciones, hechos,
// imágenes, marca) es de L5/L2 y se guarda tal cual.
import { isBrandId } from '../brand-registry';
import type { SectionMotion } from '../motion-budget';

export const PAGE_LANGS = ['es', 'en', 'pt'] as const;
export type PageLang = (typeof PAGE_LANGS)[number];

export interface PageDoc {
  lang?: PageLang;
  title?: string;
  description?: string;
  /** Id del brand pack (registry o carpeta brand-pack-<id>); la marca de la página, no del server. */
  brand?: string;
  [field: string]: unknown;
}

const TITLE_MAX = 120;
const DESCRIPTION_MAX = 300;
export const DOCUMENT_FILE = 'index.html';

export function pageDocErrors(doc: unknown): string[] {
  if (doc === undefined) return [];
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return ['page: debe ser un objeto'];
  const d = doc as Record<string, unknown>;
  const errors: string[] = [];
  if (d.lang !== undefined && !PAGE_LANGS.includes(d.lang as PageLang)) errors.push(`page.lang: se espera ${PAGE_LANGS.join('|')}, llegó ${String(d.lang)}`);
  if (d.title !== undefined && (typeof d.title !== 'string' || !d.title.trim() || d.title.length > TITLE_MAX)) errors.push(`page.title: texto de 1 a ${TITLE_MAX} caracteres`);
  if (d.description !== undefined && (typeof d.description !== 'string' || d.description.length > DESCRIPTION_MAX)) errors.push(`page.description: texto de hasta ${DESCRIPTION_MAX} caracteres`);
  if (d.brand !== undefined && !isBrandId(d.brand)) errors.push(`page.brand: id de marca en kebab-case, llegó ${String(d.brand)}`);
  if (d.sections !== undefined && !Array.isArray(d.sections)) errors.push('page.sections: debe ser una lista');
  // El resto de SectionContract es de L5; estos dos los escribe el runner en el TSX del wrapper.
  (Array.isArray(d.sections) ? d.sections : []).forEach((s: unknown, i) => {
    const c = (typeof s === 'object' && s !== null ? s : {}) as Record<string, unknown>;
    if (c.surface !== undefined && !SURFACES.includes(c.surface as Surface)) errors.push(`page.sections[${i}].surface: se espera ${SURFACES.join('|')}`);
    if (c.motion !== undefined && !MOTIONS.includes(c.motion as SectionMotion)) errors.push(`page.sections[${i}].motion: se espera ${MOTIONS.join('|')}`);
  });
  return errors;
}

export const SURFACES = ['base', 'muted', 'raised', 'inverse'] as const;
export type Surface = (typeof SURFACES)[number];
export const MOTIONS: readonly SectionMotion[] = ['none', 'entrance'];

export interface SectionContract {
  role?: string;
  surface?: Surface;
  motion?: SectionMotion;
  [field: string]: unknown;
}

/** El SectionContract de cada sección, en el orden de `roles`: la primera entrada libre con el mismo rol.
 * Por rol y no por índice, porque un follow-up puede quitar o mover secciones sin reescribir el plan. */
export function sectionContracts(doc: PageDoc | undefined, roles: readonly string[]): (SectionContract | undefined)[] {
  const pool = Array.isArray(doc?.sections) ? [...(doc.sections as SectionContract[])] : [];
  return roles.map((role) => {
    const i = pool.findIndex((c) => c?.role === role);
    return i < 0 ? undefined : pool.splice(i, 1)[0];
  });
}

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** index.html con lang/title/description de la página. Sin un campo, queda lo que trae el scaffold. */
export function projectDocument(html: string, doc: PageDoc): string {
  let out = html;
  if (doc.lang) out = out.replace(/<html\b([^>]*?)\slang="[^"]*"/, `<html$1 lang="${doc.lang}"`);
  if (doc.title) out = out.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(doc.title)}</title>`);
  if (doc.description !== undefined) {
    const meta = `<meta name="description" content="${escapeHtml(doc.description)}" />`;
    out = /<meta\s+name="description"[^>]*>/.test(out) ? out.replace(/<meta\s+name="description"[^>]*>/, meta) : out.replace(/(\s*)<title>/, `$1${meta}$1<title>`);
  }
  return out;
}
