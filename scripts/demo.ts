// Demo del core con candidatos REALES del MCP Relume (brief: SaaS de gestión de proyectos, agendar
// demo). Los candidatos se embeben tal como los devolvió search_components; el core elige y explica.
// El runner real reemplazará estos literales por llamadas vivas al MCP.
import { selectPage } from '../src/select';
import { RELUME_RHYTHM, relumeCandidate } from '../src/registry';
import type { Brief, Candidate } from '../src/types';

const C = (slug: string, tags: string[], layoutStyle: string[], category: string): Candidate =>
  relumeCandidate({ slug, name: slug, category, tags, layoutStyle });

const brief: Brief = { summary: 'SaaS de gestión de proyectos', goal: 'agendar una demo', tone: 'clean' };

const candidatesByRole: Record<string, Candidate[]> = {
  hero: [
    C('section_header19', ['2 Columns', 'Image/Video Left', 'Text Align Left', 'Buttons', 'Image'], ['standard'], 'hero-header-sections'),
    C('section_header37', ['2 Columns', 'Image/Video Left', 'Text Align Left', 'Buttons', 'Image'], ['edge_to_edge'], 'hero-header-sections'),
    C('section_header131', ['Image/Video Bottom', '2 Columns', 'Text Align Left', 'Buttons', 'Image', 'Multiple Images'], ['overlapping'], 'hero-header-sections'),
    C('section_header111', ['2 Columns', 'Text Align Left', 'Buttons', 'Background Image'], ['off_grid', 'background'], 'hero-header-sections'),
  ],
  features: [
    C('section_layout273', ['3 Columns', 'Text Align Left', 'Buttons', 'Background Image', 'Icons'], ['background'], 'feature-sections'),
    C('section_layout237', ['3 Columns', 'Text Align Center', 'Buttons', 'Icons'], ['standard'], 'feature-sections'),
    C('section_layout230', ['3 Columns', 'Text Align Center', 'Multiple Images', 'Buttons', 'Image'], ['standard'], 'feature-sections'),
    C('section_layout242', ['3 Columns', 'Text Align Left', 'Icons', 'Buttons'], ['standard'], 'feature-sections'),
  ],
  cta: [
    C('section_cta40', ['Text Align Left', 'Image/Video Right', '1 Column', 'Cards', 'Image', 'Form'], ['card'], 'cta-sections'),
    C('section_cta64', ['1 Column', 'Image/Video Bottom', 'Text Align Left', 'Image'], ['edge_to_edge'], 'cta-sections'),
    C('section_cta24', ['1 Column', 'Text Align Left', 'Image/Video Center', 'Form', 'Image'], ['standard'], 'cta-sections'),
    C('section_cta32', ['1 Column', 'Text Align Center', 'Form', 'Image'], ['standard'], 'cta-sections'),
  ],
};

const page = selectPage(brief, candidatesByRole, RELUME_RHYTHM);
console.log(`brief: ${brief.summary} — ${brief.goal} (tono ${brief.tone})`);
console.log(`total=${page.total}  cohesión (perfil ${page.profile}): ${page.cohesionReasons.join('; ') || '—'}\n`);
for (const s of page.selections) {
  console.log(`[${s.role}] ${s.pick.slug}  score=${s.score}  (${s.pick.geometry} · ${s.pick.surface.light})`);
  console.log(`   porqué: ${s.reasons.join(' · ')}`);
  console.log(`   alternativas: ${s.alternates.map((a) => a.slug).join(', ')}`);
}
