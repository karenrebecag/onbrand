// Generador determinista: implementa CopyGenerator sin red. Lee del inputJson lo mismo que leería el
// LLM (company description, additional instructions, secciones con campos presupuestados), saca los
// hechos del brief y escribe cada campo con las plantillas del idioma, ajustado al presupuesto jq del
// campo. La coherencia de página mínima es no repetir titulares entre secciones.

import { fitToBudget, parseBudget } from './budget';
import { extractFacts, type Facts } from './facts';
import type { CopyGenerator, Lang, PageContentInput, PageContentOutput, SectionInput, SectionOutput } from './generator';
import { getPath, roleCounts } from './role-fields';
import { budgetFor, type Semantic } from './slot-model';
import type { Role } from '../types';
import type { RoleTemplate, TemplateCtx, Templates } from './templates';
import { GENERIC_BENEFITS_EN, TEMPLATES_EN } from './templates-en';
import { GENERIC_BENEFITS_ES, TEMPLATES_ES } from './templates-es';

const LANG_BY_NAME: Readonly<Record<string, Lang>> = { spanish: 'es', english: 'en' };

const TEMPLATES: Readonly<Record<Lang, Templates>> = { es: TEMPLATES_ES, en: TEMPLATES_EN };
const GENERIC: Readonly<Record<Lang, string[]>> = { es: GENERIC_BENEFITS_ES, en: GENERIC_BENEFITS_EN };

/** El rol del copy que llena una sección: `banner` escribe sobre el bolsón `cta`. */
const copyKeyOf = (category: string): Exclude<Role, 'banner'> => (category === 'banner' ? 'cta' : (category as Exclude<Role, 'banner'>));

/** Tamaños de lista desde las rutas de los campos pedidos: el índice mayor + 1 por lista. */
function countsFromFields(section: SectionInput): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const field of section['input text fields']) {
    const path = field['css classes'].split(' ')[1] ?? '';
    for (const m of path.matchAll(/(\w+)\[(\d+)\]/g)) counts[m[1]] = Math.max(counts[m[1]] ?? 0, Number(m[2]) + 1);
  }
  // Las claves del copy agnóstico se traducen a las claves Relume que roleCounts entiende.
  return {
    ...counts,
    features: counts.items ?? counts.features,
    questions: counts.items ?? counts.questions,
    testimonials: counts.items ?? counts.testimonials,
    sections: counts.steps,
    navLinks: counts.links,
    columnLinks: counts.columns,
  };
}

function writeSection(section: SectionInput, facts: Facts, lang: Lang, pick: TemplateCtx['pick']): SectionOutput {
  const key = copyKeyOf(section.category);
  const template: RoleTemplate | undefined = TEMPLATES[lang][key];
  if (!template) return { section_id: section.section_id, real_text_fields: [] };
  const generic = GENERIC[lang];
  const ctx: TemplateCtx = {
    f: facts,
    c: roleCounts(countsFromFields(section)),
    lang,
    pick,
    benefit: (i) => facts.benefits[i] ?? generic[(i - facts.benefits.length) % generic.length],
  };
  const tree = { [key]: template(ctx) };
  const real_text_fields = section['input text fields'].flatMap((field) => {
    const [semantic, path] = field['css classes'].split(' ');
    const value = path ? getPath(tree, path) : undefined;
    if (typeof value !== 'string') return [];
    const budget = parseBudget(field['max length']);
    // El piso por semántica aplica también aquí: "1 word" de un "Button" no amputa el CTA.
    const fitted = budget ? fitToBudget(value, budgetFor(semantic as Semantic, { [semantic]: budget })) : value;
    return [{ id: field.id, text: fitted }];
  });
  return { section_id: section.section_id, real_text_fields };
}

function parseInput(inputJson: string): PageContentInput {
  const raw: unknown = JSON.parse(inputJson);
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { sections?: unknown }).sections)) {
    throw new Error('page-content: inputJson sin "sections"');
  }
  return raw as PageContentInput;
}

/** Un `pick` por página: devuelve el primer titular no usado (normalizado) y lo registra. */
export function headlinePicker(): TemplateCtx['pick'] {
  const used = new Set<string>();
  const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return (candidates) => {
    const chosen = candidates.find((c) => !used.has(norm(c))) ?? candidates[0] ?? '';
    used.add(norm(chosen));
    return chosen;
  };
}

export const deterministicGenerator: CopyGenerator = {
  id: 'deterministic',
  async generate(req): Promise<PageContentOutput> {
    const input = parseInput(req.inputJson);
    const lang = LANG_BY_NAME[req.language.toLowerCase()] ?? 'es';
    const facts = extractFacts(input['company description'] ?? input['page name'], input['page additional instructions'], lang);
    const pick = headlinePicker();
    return { sections: input.sections.map((s) => writeSection(s, facts, lang, pick)) };
  },
};
