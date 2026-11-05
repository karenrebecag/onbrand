// Pasada de copy de página (el `generateCopy` de Relume, page-content.js:141): arma el inputJson con
// los bloques elegidos, llama al generador y aplica la respuesta campo a campo con text-fit. Devuelve el
// RoleCopy que el resto del pipeline ya sabe colocar (propsFor / injectCopy), más el input para
// inspección. Los presupuestos y tamaños de lista salen del Defaults del bloque elegido para cada rol.

import type { CatalogEntry } from '../catalog/schema';
import { briefBrands, type RoleCopy } from '../copy';
import type { Brief, Role } from '../types';
import { CANON_DEFAULTS, describeBudget, fitToBudget } from './budget';
import { placeholderText } from './defaults';
import { extractFacts } from './facts';
import { deterministicGenerator } from './deterministic';
import { LANGUAGE_NAME, type CopyGenerator, type Lang, type PageContentInput, type PageContentRequest, type SectionInput } from './generator';
import { assembleRoleCopy, roleCounts, roleFields, type RoleField } from './role-fields';
import { blockSlotModel, budgetFor, type BlockSlotModel } from './slot-model';

/** Un bloque elegido para un rol; `inner` es el bloque que de verdad renderiza el copy en un layout. */
export interface ChosenBlock {
  role: Role;
  entry: CatalogEntry;
  inner?: CatalogEntry;
}

export interface GeneratePageCopyOptions {
  brief: Brief;
  blocks: ChosenBlock[];
  lang?: Lang;
  generator?: CopyGenerator;
  pageName?: string;
}

export interface GeneratedCopy {
  copy: RoleCopy;
  input: PageContentInput;
  request: PageContentRequest;
  generator: string;
}

const OUTLINE: Readonly<Record<Lang, Partial<Record<Role, string>>>> = {
  es: {
    navbar: 'Barra de navegación con el nombre del producto y el CTA principal.',
    banner: 'Anuncio breve sobre la cabecera.',
    hero: 'Propuesta de valor principal y llamada a la acción.',
    logos: 'Marcas o equipos que ya usan el producto.',
    features: 'Beneficios principales del producto.',
    steps: 'Cómo funciona, paso a paso.',
    stats: 'Métricas y resultados.',
    testimonials: 'Lo que dicen los clientes.',
    pricing: 'Planes y precios.',
    faq: 'Preguntas frecuentes y cierre de dudas.',
    cta: 'Cierre con la llamada a la acción del objetivo.',
    footer: 'Pie con enlaces y legales.',
  },
  en: {
    navbar: 'Navigation bar with the product name and the main CTA.',
    banner: 'Short announcement above the header.',
    hero: 'Main value proposition and call to action.',
    logos: 'Brands or teams already using the product.',
    features: 'Main product benefits.',
    steps: 'How it works, step by step.',
    stats: 'Metrics and results.',
    testimonials: 'What customers say.',
    pricing: 'Plans and pricing.',
    faq: 'Frequently asked questions and a closing contact.',
    cta: 'Closing call to action for the goal.',
    footer: 'Footer with links and legal.',
  },
};

interface PlannedSection {
  section: SectionInput;
  fields: RoleField[];
  model: BlockSlotModel;
}

/** Una sección del inputJson desde su bloque: campos del rol con presupuesto del Defaults del bloque
 * (o canon) y placeholder al estilo Relume. */
function planSection(block: ChosenBlock, index: number, lang: Lang): PlannedSection {
  const model = blockSlotModel(block.inner ?? block.entry);
  const fields = roleFields(block.role, roleCounts(model.counts));
  const section: SectionInput = {
    section_id: `section_${index}`,
    category: block.role,
    outline: OUTLINE[lang][block.role] ?? '',
    'input text fields': fields.map((f, i) => {
      const slot = model.fields.find((s) => s.semantic === f.semantic);
      return {
        id: i + 1,
        'css classes': `${f.semantic} ${f.path}`,
        'max length': describeBudget(budgetFor(f.semantic, model.budgets)),
        'placeholder text': placeholderText(slot?.original ?? CANON_DEFAULTS[f.semantic] ?? ''),
      };
    }),
  };
  return { section, fields, model };
}

/** Un rol se escribe una vez aunque aparezca en varios bloques (el primero manda). */
const uniqueByRole = (blocks: ChosenBlock[]): ChosenBlock[] => {
  const seen = new Set<Role>();
  return blocks.filter((b) => (seen.has(b.role) ? false : (seen.add(b.role), true)));
};

export async function generatePageCopy(opts: GeneratePageCopyOptions): Promise<GeneratedCopy> {
  const lang = opts.lang ?? 'es';
  const generator = opts.generator ?? deterministicGenerator;
  const brands = briefBrands(opts.brief);
  // Sin marcas reales el rol logos no se pide: el copy sale sin la clave y emit lo omite (sin copy).
  const blocks = uniqueByRole(opts.blocks).filter((b) => b.role !== 'logos' || brands);
  const planned = blocks.map((b, i) => planSection(b, i, lang));
  const pageName = opts.pageName ?? (lang === 'es' ? 'Inicio' : 'Home');
  const input: PageContentInput = {
    // project name: el nombre del producto del brief (lo que Relume saca con brief-to-project-title).
    'project name': extractFacts(opts.brief.summary, opts.brief.goal, lang).name,
    'company description': opts.brief.summary,
    'all pages': [pageName],
    'page name': pageName,
    'page sections': blocks.map((b) => b.role),
    ...(opts.brief.goal ? { 'page additional instructions': opts.brief.goal } : {}),
    sections: planned.map((p) => p.section),
  };
  const request: PageContentRequest = {
    inputJson: JSON.stringify(input),
    language: LANGUAGE_NAME[lang],
    ...(lang === 'en' ? {} : { languageLOTE: LANGUAGE_NAME[lang] }),
  };
  const output = await generator.generate(request);
  // Aplicación campo a campo (OQ): id -> campo del rol; cada texto pasa por text-fit al presupuesto.
  const texts = planned.flatMap((p) => {
    const result = output.sections.find((s) => s.section_id === p.section.section_id);
    if (!result) return [];
    return result.real_text_fields.flatMap(({ id, text }) => {
      const field = p.fields[id - 1];
      if (!field) return [];
      return [{ path: field.path, text: fitToBudget(text, budgetFor(field.semantic, p.model.budgets)) }];
    });
  });
  const assembled = assembleRoleCopy(texts, lang);
  const copy: RoleCopy = brands && assembled.logos ? { ...assembled, logos: { ...assembled.logos, brands } } : assembled;
  return { copy, input, request, generator: generator.id };
}
