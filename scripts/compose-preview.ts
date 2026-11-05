// Runner de cierre: brief + candidatos REALES del MCP (con preview) -> marco + ≤3 strips -> page.html.
// Los candidatos se pulen en vivo con search_components; aquí se embeben los del brief de muestra
// (SaaS, agendar demo). Marco = navbar + footer (banner solo si el brief anuncia algo).
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { composePage } from '../src/select';
import { renderPage } from '../src/render';
import { RELUME_RHYTHM, relumeCandidate } from '../src/registry';
import type { Brief, Candidate } from '../src/types';

const CDN = 'https://cdn.prod.website-files.com/61789b489343c8242282a0ae/';
const C = (slug: string, tags: string[], layoutStyle: string[], category: string, preview: string): Candidate =>
  relumeCandidate({ slug, name: slug, category, tags, layoutStyle, preview: CDN + preview });

const brief: Brief = { summary: 'SaaS de gestión de proyectos', goal: 'agendar una demo', tone: 'clean' };

const candidatesByRole: Record<string, Candidate[]> = {
  navbar: [
    C('navbar2_component', ['Logo Left', 'Menu Center', 'Navbar'], [], 'navbars', '618f4557b45ed056f448a6d1_618505a3f548a132c19cf758_navbar2_component.png'),
    C('navbar3_component', ['Logo Center', 'Menu Left', 'Navbar'], [], 'navbars', '618f45583462013782cd8db2_618505a5cb8af857a9d4ed04_navbar3_component.png'),
    C('navbar13_component', ['Menu Center', 'Logo Left', 'Navbar'], [], 'navbars', '633bbc217e5a902a52117b49_631823616389054d9d97cf01_navbar13-image.png'),
    C('navbar14_component', ['Menu Right', 'Logo Left', 'Navbar'], [], 'navbars', '633bbc2181024a7bd0ad76e6_6318236ac3c03e82df7cfb73_navbar14-image.png'),
  ],
  hero: [
    C('section_header19', ['2 Columns', 'Image/Video Left', 'Text Align Left', 'Buttons', 'Image'], ['standard'], 'hero-header-sections', '618f3e724a3b045d72e8d042_6185056b3f2e023162e434cd_section-header19.png'),
    C('section_header37', ['2 Columns', 'Image/Video Left', 'Text Align Left', 'Buttons', 'Image'], ['edge_to_edge'], 'hero-header-sections', '618f3e8af2b58a8b870dbafb_61850586a5a78599d7ec92c6_section-header37.png'),
    C('section_header131', ['Image/Video Bottom', '2 Columns', 'Text Align Left', 'Buttons', 'Image', 'Multiple Images'], ['overlapping'], 'hero-header-sections', '65bb1fb88049d4f4ebd9173d_section_header131.png'),
    C('section_header111', ['2 Columns', 'Text Align Left', 'Buttons', 'Background Image'], ['off_grid', 'background'], 'hero-header-sections', '65b8500871c7ac1d69c802d9_1N11UNGC10IKOxSiAN-i9Df09MUKPINlCY4K2CslNSQ.png'),
  ],
  features: [
    C('section_layout273', ['3 Columns', 'Text Align Left', 'Buttons', 'Background Image', 'Icons'], ['background'], 'feature-sections', '618f41b907059cf18eb35091_61850344a5e0b42f737255c9_section-layout273.png'),
    C('section_layout237', ['3 Columns', 'Text Align Center', 'Buttons', 'Icons'], ['standard'], 'feature-sections', '618f418a27949bea94cc5fa8_6185030dd57818009d8fd9a7_section-layout237.png'),
    C('section_layout230', ['3 Columns', 'Text Align Center', 'Multiple Images', 'Buttons', 'Image'], ['standard'], 'feature-sections', '618f4182a84d921db04e9fb3_61850301eb3eeba034dc6820_section-layout230.png'),
    C('section_layout242', ['3 Columns', 'Text Align Left', 'Icons', 'Buttons'], ['standard'], 'feature-sections', '618f4191c5693a22e765a877_61850314bcf5767ac566677f_section-layout242.png'),
  ],
  cta: [
    C('section_cta40', ['Text Align Left', 'Image/Video Right', '1 Column', 'Cards', 'Image', 'Form'], ['card'], 'cta-sections', '638defe6ba38efbb8ee13284_section_cta40.png'),
    C('section_cta64', ['1 Column', 'Image/Video Bottom', 'Text Align Left', 'Image'], ['edge_to_edge'], 'cta-sections', '68676dce98efd12dd971d9c2_section_cta64.png'),
    C('section_cta24', ['1 Column', 'Text Align Left', 'Image/Video Center', 'Form', 'Image'], ['standard'], 'cta-sections', '618f3e350814f7beea4da8c0_618502cbd81cfd6d5ab50be9_section-cta24.png'),
    C('section_cta32', ['1 Column', 'Text Align Center', 'Form', 'Image'], ['standard'], 'cta-sections', '618f3e3fe6b7ae86633dbc2f_618502d7f548a1b3c89ceb85_section-cta32.png'),
  ],
  footer: [
    C('footer1_component', ['4 Columns', 'Text Align Left', 'Newsletter Sign Up', 'Footer'], [], 'footers', '64ded51927d2548ed81f82bc_HUIll1B-k_jzVyH2E26fFEzHXpZBthUCUP-MmYK7zg0.png'),
    C('footer2_component', ['5+ Columns', 'Text Align Left', 'Newsletter Sign Up', 'Footer'], [], 'footers', '64ded51a52f213ebd725be38_nj00mmsy62OQJ1usF2Vmkhf3nantT-Vy2x79yFaTTTU.png'),
    C('footer16_component', ['4 Columns', 'Text Align Left', 'Newsletter Sign Up', 'Footer'], [], 'footers', '66fa35f7edfc575e36005737_footer16_component.png'),
    C('footer10_component', ['5+ Columns', 'Text Align Left', 'Newsletter Sign Up', 'Cards', 'Footer'], [], 'footers', '64ded5284b46b2043e908566_8cmWKtWB3fkOkiQPmu0GjRYLEqvgJyPA1J8VSa5xGKU.png'),
  ],
};

const page = composePage(brief, candidatesByRole, RELUME_RHYTHM);
const html = renderPage(brief, page);
const out = resolve(import.meta.dir, '..', 'out', 'page.html');
writeFileSync(out, html + '\n');
console.log(`página: ${out}`);
const frame = Object.entries(page.frame).map(([r, s]) => `${r}=${s!.pick.slug}`).join(', ');
console.log(`marco: ${frame}`);
console.log(`strips: ${page.strips.map((s) => `${s.role}=${s.pick.slug}`).join(', ')}`);
