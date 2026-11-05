// Lado Relume del ingest automático: escanea `sections-react/<categoría>/<item>` del vault
// (READ-ONLY), mapea categoría -> rol del core, DERIVA tags, layoutStyle, superficie y geometría del
// source (el registry.json del vault no trae los tags del MCP), y corre el gate: lint v3, export,
// props, deps (@kit/ui y react-icons marcados, paquetes ausentes en el scaffold) y residuos del
// transformer Tailwind -> CSS modules. Nada se vendoriza: el source solo se LEE.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { Role } from '../types';
import { lintComponent } from '../lint';
import { relumeGeometry, relumeSurface } from '../registry';
import { sha256 } from './hash';
import { deriveRelumeManifest, exportOf, propsOf, type RelumeSibling } from './manifest-relume';
import { KIT_TO_ARC, kitImports, portImports } from './port-imports';
import type { CatalogEntry, CatalogGate } from './schema';

// KIT_TO_ARC y kitImports viven en port-imports (el codemod los usa); se re-exportan para el ingest.
export { KIT_TO_ARC, kitImports };

export interface RelumeScanItem {
  category: string;
  /** Carpeta del item (`cta-13`). */
  item: string;
  /** Slug del MCP (cola de `source_slug`: `section_cta13`), la identidad que ya usa el índice. */
  slug: string;
  name: string;
  /** Archivo principal relativo al vault. */
  file: string;
  preview?: string;
  npmDeps: string[];
  tsx: string;
}

const SECTIONS = 'sections-react';

/** Escanea todas las categorías en orden fijo. Un item sin `<item>.tsx` o sin registry se omite. */
export function scanRelume(vaultRoot: string): RelumeScanItem[] {
  const root = join(vaultRoot, SECTIONS);
  return readdirSync(root).sort().flatMap((category) => {
    const catDir = join(root, category);
    if (!statSync(catDir).isDirectory()) return [];
    return readdirSync(catDir).sort().flatMap((item) => {
      const regPath = join(catDir, item, 'registry.json');
      const tsxPath = join(catDir, item, `${item}.tsx`);
      if (!existsSync(regPath) || !existsSync(tsxPath)) return [];
      const reg = JSON.parse(readFileSync(regPath, 'utf8')) as { title?: unknown; dependencies?: unknown; source_slug?: unknown; preview?: unknown };
      const sourceSlug = typeof reg.source_slug === 'string' ? reg.source_slug : `${category}/${item}`;
      return [{
        category,
        item,
        slug: sourceSlug.split('/').pop() as string,
        name: typeof reg.title === 'string' && reg.title ? reg.title : item,
        file: posix.join(SECTIONS, category, item, `${item}.tsx`),
        ...(typeof reg.preview === 'string' && reg.preview ? { preview: reg.preview } : {}),
        npmDeps: Array.isArray(reg.dependencies) ? reg.dependencies.filter((d): d is string => typeof d === 'string') : [],
        tsx: readFileSync(tsxPath, 'utf8'),
      }];
    });
  });
}

/** Categoría -> rol (las de ROLE_SPEC más sus variantes off-grid/grid-cards/-2). Las demás
 * (blog, forms, team, timelines, uncommon...) no tienen rol en el core y van a la cola. */
export const RELUME_CATEGORY_ROLE: ReadonlyArray<[RegExp, Role]> = [
  [/^hero-header-sections/, 'hero'],
  [/^feature-sections/, 'features'],
  [/^cta-sections/, 'cta'],
  [/^testimonial-sections/, 'testimonials'],
  [/^pricing-sections/, 'pricing'],
  [/^faq-sections/, 'faq'],
  [/^logo-sections/, 'logos'],
  [/^stats-sections/, 'stats'],
  [/^navbars/, 'navbar'],
  [/^footers/, 'footer'],
  [/^banners/, 'banner'],
];

export const roleOfCategory = (category: string): Role | undefined =>
  RELUME_CATEGORY_ROLE.find(([re]) => re.test(category))?.[1];

/** Tag de categoría que ROLE_SPEC desea (desiredTags), para que el ranking vea lo mismo que con
 * los tags del MCP. */
const CATEGORY_TAG: ReadonlyArray<[RegExp, string]> = [
  [/^stats-sections/, 'Stats Section'], [/^logo-sections/, 'Logos'], [/^navbars/, 'Navbar'],
  [/^footers/, 'Footer'], [/^banners/, 'Announcement Banner'], [/^faq-sections/, 'FAQ'],
];

const BG_MEDIA = /<div className="absolute inset-0[^"]*">\s*<(img|video|VideoIframe)\b/;
const HAS_BUTTON = /<Button\b/;
const HAS_ICON = /\bicon(s)?\s*[:?]\s*ImageProps|<img[^>]*\{(\w+\.)?icon\.src\}/;
/** Solo una LISTA de logos es una sección de logos; el logo de marca suelto de un navbar/banner no. */
const HAS_LOGO = /\blogos\s*[:?]\s*ImageProps\[\]/;

/** Tags del vocabulario del MCP derivados del source. Determinista; lo que no se detecta no se
 * inventa (un item sin señal de columnas queda "1 Column"). */
export function deriveRelumeTags(tsx: string, category: string): string[] {
  const tags: string[] = [];
  const cols = /\b(?:md|lg):grid-cols-(\d)\b/.exec(tsx)?.[1];
  tags.push(cols && Number(cols) > 1 ? `${cols} Columns` : '1 Column');
  const bg = BG_MEDIA.exec(tsx);
  if (bg) tags.push(bg[1] === 'img' ? 'Background Image' : 'Background Video');
  if (/<img\b/.test(tsx)) tags.push('Image');
  if (/VideoIframe|<video\b/.test(tsx)) tags.push('Video');
  if (HAS_BUTTON.test(tsx)) tags.push('Buttons');
  if (/<form\b/.test(tsx)) tags.push('Form');
  if (/type="email"/.test(tsx)) tags.push('Email Capture');
  if (HAS_ICON.test(tsx)) tags.push('Icons');
  if (HAS_LOGO.test(tsx)) tags.push('Logos');
  if (/BiSolidStar/.test(tsx)) tags.push('Star Rating');
  if (/embla|useCarousel|<Carousel/.test(tsx)) tags.push('Slider');
  if (/<Accordion\b/.test(tsx)) tags.push('Accordion');
  if (/<Tabs\b/.test(tsx)) tags.push('Tabs');
  if (/border border-border-primary/.test(tsx)) tags.push('Cards');
  tags.push(/\btext-center\b/.test(tsx) ? 'Text Align Center' : 'Text Align Left');
  const catTag = CATEGORY_TAG.find(([re]) => re.test(category))?.[1];
  if (catTag && !tags.includes(catTag)) tags.push(catTag);
  return [...new Set(tags)];
}

/** layoutStyle en el vocabulario que `relumeSurface`/`relumeGeometry` ya traducen. */
export function deriveLayoutStyle(tags: string[], tsx: string, category: string): string[] {
  const styles: string[] = [];
  if (tags.some((t) => /^Background/.test(t))) styles.push('background');
  if (/off-grid/.test(category)) styles.push('off_grid');
  else if (/overlapping/.test(category) || /\s-m[tblr]-\d/.test(tsx)) styles.push('overlapping');
  else if (tags.includes('Cards')) styles.push('card');
  else if (!/\bcontainer\b/.test(tsx)) styles.push('edge_to_edge');
  return styles;
}

const packageOf = (spec: string): string => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

/** Paquetes importados que no son react ni @kit/ui, con el subpath (react-icons/rx). Cubre los
 * imports de varias líneas (`import {\n  A,\n} from "x"`), que son 300+ en el vault. */
export function foreignImports(tsx: string): string[] {
  const specs = [...tsx.matchAll(/^import\b[\s\S]*?\bfrom\s+["']([^"'.][^"']*)["'];?$/gm)].map((m) => m[1]);
  return [...new Set(specs.filter((s) => packageOf(s) !== 'react' && packageOf(s) !== '@kit/ui'))].sort();
}

export interface TransformerResidue {
  arbitrary: string[];
  colors: string[];
  unresolved: string[];
  /** Imports que el transformer dejó como TODO (ya cubiertos por kit/foreign; aquí solo el conteo). */
  imports: number;
}

export interface RelumeGateContext {
  declaredNpm: ReadonlySet<string>;
  /** Slugs de components Arc presentes en el vault (para decir si un @kit/ui tiene equivalente). */
  arcComponents: ReadonlySet<string>;
  /** Componentes Arc que solo exportan por default: el porte los importa sin llaves. */
  defaultExports?: ReadonlySet<string>;
  residue: TransformerResidue;
}

/** Gate automático de una sección Relume. Lo bloqueante: lint v3, sin export, @kit/ui o paquetes
 * ajenos (hay que portar el uso), clases sin resolver. Props ausentes = propless (sin vía de copy). */
export function gateRelume(item: RelumeScanItem, ctx: RelumeGateContext): CatalogGate {
  const reasons: string[] = [];
  const lint = lintComponent(item.tsx);
  if (!lint.ok) reasons.push(`lint: ${lint.issues.join('; ')}`);
  if (!exportOf(item.tsx)) reasons.push('sin export principal reconocible (export const X = (props)');
  if (!propsOf(item.tsx).length) reasons.push('propless: sin `type Props` en el source, sin vía de copy');
  // El codemod portea @kit/ui -> Arc y react-icons -> lucide/brand; solo lo que no mapea bloquea.
  const port = portImports(item.tsx, { arcComponents: ctx.arcComponents, ...(ctx.defaultExports ? { defaultExports: ctx.defaultExports } : {}) });
  if (port.kitResidual.length) reasons.push(`@kit/ui no portable (sin equivalente Arc o dep del component ausente): ${port.kitResidual.join(', ')}`);
  if (port.iconResidual.length) reasons.push(`react-icons sin mapa a lucide/brand: ${port.iconResidual.join(', ')}`);
  // El npm ausente se mide sobre el source YA portado: lo que el codemod reescribió (framer-motion ->
  // motion/react, los iconos) ya no cuenta como paquete ajeno.
  const foreign = foreignImports(port.tsx);
  const npm = [...new Set(foreign.filter((f) => !f.startsWith('react-icons')).map(packageOf))].filter((p) => !ctx.declaredNpm.has(p));
  if (npm.length) reasons.push(`dep npm ausente en el scaffold: ${npm.join(', ')}`);
  const unresolved = [...new Set(ctx.residue.unresolved)].filter((c) => !BUILDER_CLASS.test(c));
  if (unresolved.length) reasons.push(`transformer: clases sin resolver: ${unresolved.join(', ')}`);
  return { ok: reasons.length === 0, reasons };
}

/** `rb-N` son marcas del builder de Relume sin CSS detrás: clase muerta, no rompe el render. Se
 * cuentan en notes y no bloquean el gate (los lotes las quitaron a mano al portar). */
export const BUILDER_CLASS = /^rb-\d+$/;

/** Hermano con la categoría de origen, para acotar `related` sin releer el vault. */
export interface IngestSibling extends RelumeSibling {
  category: string;
}

export interface RelumeEntryInput {
  item: RelumeScanItem;
  role: Role;
  tags: string[];
  layoutStyle: string[];
  exportName: string;
  gate: CatalogGate;
  residue: TransformerResidue;
  siblings: readonly IngestSibling[];
}

const RELATED_CAP = 12;

/** Entrada del índice para una sección ingestada: block con props (o propless, emittable:false),
 * verified:false, source:null; manifiesto derivado con los tags derivados; residuos no bloqueantes
 * del transformer (arbitrarios, colores a token Arc) en notes para la revisión. */
export function buildRelumeEntry(i: RelumeEntryInput): CatalogEntry {
  const input = { slug: i.item.slug, name: i.item.name, role: i.role, category: i.item.category, tags: i.tags, ...(i.item.preview ? { preview: i.item.preview } : {}) };
  const derived = deriveRelumeManifest(input, i.item.tsx, i.siblings);
  // related = TODOS los hermanos del rol: con 480 features son 230k aristas que inflan el índice a
  // 10 MB sin decir nada. Se acota a la misma categoría, en orden fijo, con tope.
  const related = i.siblings
    .filter((s) => s.slug !== i.item.slug && s.category === i.item.category)
    .map((s) => s.slug)
    .sort()
    .slice(0, RELATED_CAP);
  const manifest = { ...derived, related };
  const propless = manifest.injection.kind !== 'props';
  const uniq = (xs: string[]): string[] => [...new Set(xs)];
  const builder = uniq(i.residue.unresolved).filter((c) => BUILDER_CLASS.test(c)).length;
  const residue = `transformer: ${uniq(i.residue.arbitrary).length} arbitrarios, ${uniq(i.residue.colors).length} clases de color a token Arc, ${builder} clases rb-* del builder (muertas)`;
  return {
    library: 'relume',
    kind: 'block',
    slug: i.item.slug,
    name: i.item.name,
    role: i.role,
    category: i.item.category,
    tags: [...i.tags],
    surface: relumeSurface(i.tags, i.layoutStyle),
    geometry: relumeGeometry(i.layoutStyle),
    ...(propless ? { emittable: false } : {}),
    verified: false,
    source: null,
    origin: { kind: 'vault', path: i.item.file, sha256: sha256(i.item.tsx) },
    export: i.exportName,
    importPath: `@/components/relume/${i.item.category}/${i.item.item}/${i.item.item}`,
    manifest,
    manifestOrigin: 'derived',
    gate: i.gate,
    notes: `Ingest automático: tags, layoutStyle, superficie y geometría derivados del source (el vault no trae los tags del MCP); ${residue}.${propless ? ' Propless para copy (emittable:false).' : ''}`,
  };
}
