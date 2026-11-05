import { describe, expect, test } from 'bun:test';
import { briefIntent, planFrame, planSections } from '../src/plan';
import { rankCandidates, intensity, columns } from '../src/rank';
import { cohesionScore, wantsBand } from '../src/cohesion';
import { composePage, selectPage } from '../src/select';
import { RELUME_RHYTHM, relumeCandidate } from '../src/registry';
import type { Brief, Candidate, RoleSpec, Surface } from '../src/types';

// Candidato Relume: tags + layoutStyle del MCP, traducidos por el lado Relume (registry.ts). Los
// tests que vienen de ahí conservan lo que afirmaban antes de que el core fuera agnóstico.
const c = (slug: string, tags: string[], layoutStyle: string[], category = 'x'): Candidate =>
  relumeCandidate({ slug, name: slug, category, tags, layoutStyle });

// Candidato en vocabulario del core, sin pasar por ninguna librería.
const k = (slug: string, surface: Surface, geometry = 'standard', tags: string[] = []): Candidate =>
  ({ slug, name: slug, category: 'x', tags, surface: { light: surface, dark: surface }, geometry });

describe('plan — qué strips pide la página (≤3)', () => {
  test('sin señales: esqueleto hero + features + cta', () => {
    expect(planSections({ summary: 'una web' }).map((s) => s.role)).toEqual(['hero', 'features', 'cta']);
  });

  test('con señales: infiere roles pero nunca más de 3, hero abre y cta cierra', () => {
    const roles = planSections({ summary: 'SaaS con pricing, faq y testimonios' }).map((s) => s.role);
    expect(roles.length).toBeLessThanOrEqual(3);
    expect(roles[0]).toBe('hero');
    expect(roles.at(-1)).toBe('cta');
  });

  test('sections explícitas se respetan (recortadas a 3)', () => {
    const roles = planSections({ summary: 'x', sections: ['hero', 'stats', 'pricing', 'cta'] }).map((s) => s.role);
    expect(roles.length).toBe(3);
    expect(roles[0]).toBe('hero');
  });
});

describe('plan — intención del brief cambia qué desea cada rol', () => {
  test('demo (default): hero desea buttons, cta castiga Form', () => {
    const brief = { summary: 'app para agendar una demo' };
    expect(briefIntent(brief)).toBe('demo');
    const specs = planSections({ ...brief, sections: ['hero', 'cta'] });
    expect(specs.find((s) => s.role === 'hero')?.desiredTags).toEqual(['2 Columns', 'Buttons', 'Image']);
    expect(specs.find((s) => s.role === 'cta')?.undesiredTags).toContain('Form');
  });

  test('waitlist: hero desea captura de email y el cta deja de castigar Form', () => {
    const brief = { summary: 'súmate a la lista de espera para el early access' };
    expect(briefIntent(brief)).toBe('waitlist');
    const specs = planSections({ ...brief, sections: ['hero', 'cta'] });
    expect(specs.find((s) => s.role === 'hero')?.desiredTags).toEqual(['Email Capture', 'Form', '1 Column']);
    expect(specs.find((s) => s.role === 'cta')?.undesiredTags).toEqual([]);
  });
});

describe('rank — señales estructuradas por candidato', () => {
  const brief: Brief = { summary: 'x', tone: 'clean' };
  const spec: RoleSpec = { role: 'hero', category: 'hero-header-sections', desiredTags: ['2 Columns', 'Buttons', 'Image'] };

  test('tono clean premia liviandad: standard gana a background con los mismos tags', () => {
    const light = c('h_std', ['2 Columns', 'Buttons', 'Image'], ['standard']);
    const heavy = c('h_bg', ['2 Columns', 'Buttons', 'Image'], ['off_grid', 'background']);
    const ranked = rankCandidates(brief, spec, [heavy, light]);
    expect(ranked[0].candidate.slug).toBe('h_std');
  });

  test('tono bold invierte: el fondo pesado gana', () => {
    const light = c('h_std', ['Buttons'], ['standard']);
    const heavy = c('h_bg', ['Buttons'], ['background']);
    const ranked = rankCandidates({ ...brief, tone: 'bold' }, spec, [light, heavy]);
    expect(ranked[0].candidate.slug).toBe('h_bg');
  });

  test('helpers: intensity toma la superficie (background = 3); columns lee los tags', () => {
    expect(intensity(c('x', [], ['off_grid', 'background']), 'light')).toBe(3);
    expect(columns(c('x', ['3 Columns', 'Icons'], ['standard']))).toBe(3);
    expect(columns(c('x', ['Icons'], ['standard']))).toBe(0);
  });
});

describe('cohesion — criterio entre strips (perfil banded, Relume)', () => {
  const brief: Brief = { summary: 'x', tone: 'clean' };

  test('penaliza dos fondos oscuros adyacentes', () => {
    const combo = [c('a', [], ['background']), c('b', [], ['background'])];
    expect(cohesionScore(combo, brief, RELUME_RHYTHM).score).toBeLessThan(0);
  });

  test('premia variedad de columnas y geometrías + apertura clara', () => {
    const combo = [
      c('hero', ['2 Columns'], ['standard']),
      c('feat', ['3 Columns'], ['overlapping']),
      c('cta', ['1 Column'], ['edge_to_edge']),
    ];
    const r = cohesionScore(combo, brief, RELUME_RHYTHM);
    expect(r.score).toBeGreaterThan(0);
    expect(r.reasons.some((x) => x.includes('apertura clara'))).toBe(true);
  });
});

describe('cohesion — perfiles de ritmo (brief cohesion-superficie-agnostica)', () => {
  const brief: Brief = { summary: 'x', tone: 'clean' };
  const flatFive = ['hero', 'logos', 'features', 'stats', 'cta'].map((s, i) => k(s, 'base', `g${i}`));

  test('neutral (default): una página larga sin bandas NO recibe flatPenalty ni reserva banda', () => {
    const r = cohesionScore(flatFive, brief);
    expect(r.reasons.some((x) => x.startsWith('plana'))).toBe(false);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(wantsBand('neutral')).toBe(false);
    expect(wantsBand('banded')).toBe(true);
  });

  test('quiet: dos vecinas con la misma geometría restan; superficies todas base no penalizan', () => {
    const varied = cohesionScore(flatFive, brief, 'quiet');
    expect(varied.reasons.some((x) => x.startsWith('plana') || x.startsWith('geometría repetida'))).toBe(false);
    expect(varied.score).toBeGreaterThanOrEqual(0);

    const repeated = cohesionScore([k('a', 'base', 'grid'), k('b', 'base', 'grid'), k('c', 'base', 'split')], brief, 'quiet');
    expect(repeated.reasons.some((x) => x.startsWith('geometría repetida (a/b: grid)'))).toBe(true);
    expect(repeated.score).toBeLessThan(varied.score);
  });

  test('quiet: más de un backdrop es exceso; banded tolera dos bandas', () => {
    const two = [k('a', 'base', 'g1'), k('b', 'dark', 'g2'), k('c', 'base', 'g3'), k('d', 'dark', 'g4')];
    expect(cohesionScore(two, brief, 'quiet').reasons.some((x) => x.startsWith('exceso de bandas'))).toBe(true);
    expect(cohesionScore(two, brief, 'banded').reasons.some((x) => x.startsWith('banda(s) 2'))).toBe(true);
  });

  test('ambos temas: una superficie que solo es oscura en dark penaliza en dark y el score es el promedio', () => {
    const darkOnly = (slug: string): Candidate =>
      ({ slug, name: slug, category: 'x', tags: [], surface: { light: 'base', dark: 'dark' }, geometry: slug });
    const r = cohesionScore([darkOnly('a'), darkOnly('b')], brief);
    expect(r.reasons).toContain('[dark] fondos oscuros adyacentes (a/b) -6');
    expect(r.reasons.some((x) => x.startsWith('[light] apertura clara'))).toBe(true);
    // light: apertura +2, variedad geometría +1 = 3; dark: -6 + 1 = -5; promedio -1
    expect(r.score).toBe(-1);
  });
});

describe('selectPage — optimización conjunta', () => {
  test('elige la combinación que cohesiona, no el mejor por strip de forma greedy', () => {
    // Tono bold: el hero de fondo pesado es el MEJOR individual (9 vs 6). Pero features solo tiene
    // opción background; apilar dos fondos cuesta -6. El óptimo conjunto sacrifica el hero y toma el
    // edge_to_edge. Greedy habría tomado hero_bg.
    const brief: Brief = { summary: 'landing', tone: 'bold', sections: ['hero', 'features'] };
    const candidatesByRole = {
      hero: [
        c('hero_bg', ['2 Columns', 'Buttons', 'Image'], ['background']),
        c('hero_edge', ['2 Columns', 'Buttons', 'Image'], ['edge_to_edge']),
      ],
      features: [c('feat_bg', ['3 Columns', 'Icons'], ['background'])],
    };
    const page = selectPage(brief, candidatesByRole, RELUME_RHYTHM);
    expect(page.selections.map((s) => s.pick.slug)).toEqual(['hero_edge', 'feat_bg']);
    expect(page.profile).toBe('banded');
  });

  test('un rol sin candidatos se omite (no inventa strip vacío)', () => {
    const page = selectPage({ summary: 'x', sections: ['hero', 'features', 'cta'] }, {
      hero: [c('h', ['Buttons'], ['standard'])],
      cta: [c('cta', ['Buttons'], ['standard'])],
    });
    expect(page.selections.map((s) => s.role)).toEqual(['hero', 'cta']);
  });
});

describe('fixes del QA (Acme Pulse)', () => {
  test('la superficie Relume se deriva de los tags cuando no hay layoutStyle (Background Image)', () => {
    expect(intensity(c('t', ['Background Image'], []), 'light')).toBe(3);
    expect(intensity(c('t', ['3 Columns'], []), 'light')).toBe(0);
  });

  test('CTA: un form de newsletter pierde contra un CTA de botón (penaliza contra-intención)', () => {
    const spec: RoleSpec = {
      role: 'cta',
      category: 'cta-sections',
      desiredTags: ['Buttons', '1 Column'],
      undesiredTags: ['Form', 'Newsletter Sign Up'],
    };
    const form = c('cta_form', ['1 Column', 'Form'], ['standard']);
    const btn = c('cta_btn', ['1 Column', 'Buttons'], ['standard']);
    const ranked = rankCandidates({ summary: 'x', tone: 'clean' }, spec, [form, btn]);
    expect(ranked[0].candidate.slug).toBe('cta_btn');
  });

  test('banded: cohesión premia ritmo y castiga la página larga totalmente plana (todo blanco)', () => {
    const brief: Brief = { summary: 'x', tone: 'clean' };
    const flat = Array.from({ length: 5 }, (_, i) => c('s' + i, [], ['standard']));
    const withBand = [
      c('a', [], ['standard']),
      c('b', ['Background Image'], []),
      c('d', [], ['standard']),
      c('e', [], ['standard']),
      c('f', [], ['standard']),
    ];
    const flatResult = cohesionScore(flat, brief, RELUME_RHYTHM);
    expect(flatResult.reasons.some((r) => r.startsWith('plana sin banda real'))).toBe(true);
    expect(cohesionScore(withBand, brief, RELUME_RHYTHM).score).toBeGreaterThan(flatResult.score);
  });

  test('plan: maxStrips sube el tope de 3; steps NO va a timelines (es variante de feature-sections)', () => {
    const roles = planSections({
      summary: 'landing',
      sections: ['hero', 'logos', 'features', 'steps', 'stats', 'testimonials', 'cta'],
      maxStrips: 8,
    }).map((s) => s.role);
    expect(roles).toEqual(['hero', 'logos', 'features', 'steps', 'stats', 'testimonials', 'cta']);
    const steps = planSections({ summary: 'cómo funciona Acme', maxStrips: 8 }).find((s) => s.role === 'steps');
    expect(steps?.category).toBe('feature-sections');
  });

  test('plan: orden NARRATIVO canónico, no el orden de detección (features antes de stats)', () => {
    const roles = planSections({ summary: 'con stats y features y testimonios', maxStrips: 8 }).map((s) => s.role);
    expect(roles.indexOf('features')).toBeLessThan(roles.indexOf('stats'));
    expect(roles.indexOf('stats')).toBeLessThan(roles.indexOf('testimonials'));
    expect(roles[0]).toBe('hero');
    expect(roles.at(-1)).toBe('cta');
  });

  test('plan: testimonios en español matchea (antes solo "testimonial")', () => {
    const roles = planSections({ summary: 'landing con testimonios de clientes', maxStrips: 8 }).map((s) => s.role);
    expect(roles).toContain('testimonials');
  });

  test('D1 (banded): la cohesión SÍ mete una banda real cuando existe, pese a que clean la hunde por score', () => {
    const brief: Brief = { summary: 'landing', tone: 'clean', sections: ['hero', 'features', 'stats', 'testimonials', 'cta'], maxStrips: 8 };
    const light = (slug: string) => c(slug, ['3 Columns'], ['standard']);
    const candidatesByRole: Record<string, Candidate[]> = {
      hero: [c('hero1', ['2 Columns', 'Buttons', 'Image'], ['standard'])],
      features: [light('feat1'), light('feat2')],
      // stats tiene una banda real (Background Image) ADEMÁS de opciones claras
      stats: [light('stats_light'), c('stats_band', ['Stats Section', 'Background Image'], ['background'])],
      testimonials: [light('test1')],
      cta: [c('cta1', ['Buttons', '1 Column'], ['standard'])],
    };
    const page = selectPage(brief, candidatesByRole, RELUME_RHYTHM);
    const heavies = page.selections.filter((s) => s.pick.surface.light === 'media');
    expect(heavies.length).toBeGreaterThanOrEqual(1);
    expect(page.selections.find((s) => s.role === 'stats')?.pick.slug).toBe('stats_band');
  });

  test('C3: el ritmo solo cuenta transiciones de BANDA; edge_to_edge vs standard no puntúa', () => {
    const brief: Brief = { summary: 'x', tone: 'clean' };
    const edgeOnly = cohesionScore([c('a', [], ['standard']), c('b', [], ['edge_to_edge'])], brief, RELUME_RHYTHM);
    const withBand = cohesionScore([c('a', [], ['standard']), c('b', ['Background Image'], [])], brief, RELUME_RHYTHM);
    expect(edgeOnly.reasons.some((r) => r.startsWith('ritmo'))).toBe(false);
    expect(withBand.reasons.some((r) => r.startsWith('ritmo'))).toBe(true);
  });

  test('C4: dedupe de slug — features y steps comparten pool y no repiten el mismo componente', () => {
    const shared = c('feat_shared', ['3 Columns', 'Icons', '2 Columns', 'Text Only'], ['standard']);
    const alt = c('feat_alt', ['3 Columns'], ['standard']);
    const page = selectPage({ summary: 'x', tone: 'clean', sections: ['hero', 'features', 'steps'], maxStrips: 8 }, {
      hero: [c('h', ['2 Columns', 'Buttons', 'Image'], ['standard'])],
      features: [shared, alt],
      steps: [shared, alt],
    });
    const slugs = page.selections.filter((s) => s.role === 'features' || s.role === 'steps').map((s) => s.pick.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe('D2a — invariante de banda por tema (cohesion-ritmo)', () => {
  const brief: Brief = { summary: 'x', tone: 'clean' };
  const kt = (slug: string, light: Surface, dark: Surface, geometry = slug): Candidate =>
    ({ slug, name: slug, category: 'x', tags: [], surface: { light, dark }, geometry });

  test('CA3: pool todo base + banded pedido → ningún tema recibe flatPenalty (degrada a neutral)', () => {
    const flat = ['hero', 'logos', 'features', 'stats', 'cta'].map((s, i) => kt(s, 'base', 'base', `g${i}`));
    const degraded = cohesionScore(flat, brief, 'banded', { light: false, dark: false });
    expect(degraded.reasons.some((x) => x.includes('plana sin banda real'))).toBe(false);
    // sin el dato de disponibilidad, banded SÍ aplica la penalización inalcanzable (invariante no vive aquí)
    const naive = cohesionScore(flat, brief, 'banded');
    expect(naive.reasons.some((x) => x.includes('plana sin banda real'))).toBe(true);
    expect(degraded.score).toBeGreaterThan(naive.score);
  });

  test('CA3: banda solo en light → light conserva el crédito, dark no recibe -5', () => {
    const combo = [kt('a', 'media', 'base'), kt('b', 'base', 'base', 'g2'), kt('c', 'base', 'base', 'g3'), kt('d', 'base', 'base', 'g4')];
    const r = cohesionScore(combo, brief, 'banded', { light: true, dark: false });
    expect(r.reasons.some((x) => x.includes('[light] banda(s) 1'))).toBe(true);
    expect(r.reasons.some((x) => x.includes('plana sin banda real'))).toBe(false);
  });

  test('CA3 (integración): selectPage degrada por tema y expone el perfil efectivo', () => {
    const brief2: Brief = { summary: 'landing', tone: 'clean', sections: ['hero', 'features', 'stats', 'cta'], maxStrips: 8 };
    const byRole: Record<string, Candidate[]> = {
      hero: [kt('hero1', 'base', 'base', 'standard')],
      features: [kt('feat1', 'base', 'base', 'grid')],
      stats: [kt('stats1', 'base', 'base', 'centered')],
      cta: [kt('cta1', 'base', 'base', 'edge')],
    };
    const page = selectPage(brief2, byRole, 'banded');
    expect(page.effective).toEqual({ light: 'neutral', dark: 'neutral' });
    expect(page.profile).toBe('neutral');
    expect(page.cohesionReasons.some((x) => x.includes('pool sin bandas → neutral'))).toBe(true);
  });

  test('CA5: banded sobre pool sin bandas elige la MISMA combinación que neutral + razón de degradación', () => {
    const brief2: Brief = { summary: 'landing', tone: 'clean', sections: ['hero', 'features', 'stats', 'cta'], maxStrips: 8 };
    const byRole: Record<string, Candidate[]> = {
      hero: [kt('hero1', 'base', 'base', 'standard'), kt('hero2', 'base', 'base', 'split')],
      features: [kt('feat1', 'base', 'base', 'grid'), kt('feat2', 'base', 'base', 'bento')],
      stats: [kt('stats1', 'base', 'base', 'centered')],
      cta: [kt('cta1', 'base', 'base', 'edge')],
    };
    const asBanded = selectPage(brief2, byRole, 'banded');
    const asNeutral = selectPage(brief2, byRole, 'neutral');
    expect(asBanded.selections.map((s) => s.pick.slug)).toEqual(asNeutral.selections.map((s) => s.pick.slug));
    expect(asBanded.cohesionReasons.some((x) => x.includes('→ neutral'))).toBe(true);
  });

  test('CA6: Relume con banda real (media en ambos temas) no degrada — profile sigue banded', () => {
    const brief2: Brief = { summary: 'landing', tone: 'clean', sections: ['hero', 'features', 'stats', 'cta'], maxStrips: 8 };
    const byRole: Record<string, Candidate[]> = {
      hero: [c('hero1', ['2 Columns', 'Buttons', 'Image'], ['standard'])],
      features: [c('feat1', ['3 Columns'], ['standard'])],
      stats: [c('stats_band', ['Background Image'], [])],
      cta: [c('cta1', ['Buttons', '1 Column'], ['standard'])],
    };
    const page = selectPage(brief2, byRole, RELUME_RHYTHM);
    expect(page.profile).toBe('banded');
    expect(page.effective).toEqual({ light: 'banded', dark: 'banded' });
    expect(page.cohesionReasons.some((x) => x.includes('→ neutral') || x.includes('sin banda'))).toBe(false);
  });
});

describe('marco (chrome) — navbar/footer/banner alrededor de los strips', () => {
  test('banner solo si el brief anuncia algo; navbar y footer siempre', () => {
    expect(planFrame({ summary: 'web corporativa' }).map((s) => s.role)).toEqual(['navbar', 'footer']);
    expect(planFrame({ summary: 'lanzamiento de la beta' }).map((s) => s.role)).toEqual(['banner', 'navbar', 'footer']);
  });

  test('composePage envuelve el contenido con navbar + footer (sin banner si no hay anuncio)', () => {
    const page = composePage({ summary: 'SaaS', goal: 'demo', sections: ['hero'] }, {
      navbar: [c('nav13', ['Logo Left', 'Navbar'], []), c('nav3', ['Logo Center', 'Navbar'], [])],
      hero: [c('hero1', ['2 Columns', 'Buttons', 'Image'], ['standard'])],
      footer: [c('foot1', ['4 Columns', 'Footer'], []), c('foot2', ['Footer'], [])],
    });
    expect(page.frame.navbar?.pick.slug).toBe('nav13');
    expect(page.frame.footer?.pick.slug).toBe('foot1');
    expect(page.frame.banner).toBeUndefined();
    expect(page.strips.map((s) => s.role)).toEqual(['hero']);
  });
});
