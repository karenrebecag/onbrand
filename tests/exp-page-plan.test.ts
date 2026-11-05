import { describe, expect, test } from 'bun:test';
import { formOfIntent, pagePlanDistance, parsePagePlan, patternForIntent, sectionPlanDistance, summarizePlans, type SectionPlan } from '../src/exp/page-plan';

const sec = (over: Partial<SectionPlan> = {}): SectionPlan => ({ role: 'features', objective: 'Mostrar que el agente recupera carritos abandonados', proof: 'feature-detail', avoid: ['respuesta en segundos'], density: 'normal', surface: 'base', emphasis: 'medium', motion: 'none', ...over });

describe('plan de página offline', () => {
  test('el validador exige las secciones pedidas y los enums; no devuelve plan parcial', () => {
    // Experimento con lista cerrada (como --role-set): vocabulario = requeridas.
    const ok = parsePagePlan({ lang: 'es', arc: 'hero → prueba → cierre', sections: [sec({ role: 'hero' }), sec(), sec({ role: 'cta' })] }, ['hero', 'features', 'cta'], ['hero', 'features', 'cta']);
    expect(ok.plan?.sections).toHaveLength(3);
    const bad = parsePagePlan({ lang: 'es', arc: 'x', sections: [sec({ role: 'hero' }), sec({ proof: 'video' as never })] }, ['hero', 'features', 'cta'], ['hero', 'features', 'cta']);
    expect(bad.plan).toBeUndefined();
    expect(bad.errors.join(' ')).toContain('proof');
    expect(bad.errors.join(' ')).toContain('faltan secciones: cta');
  });

  test('la distancia es 0 entre planes iguales, ignora mayúsculas y crece con cada campo distinto', () => {
    expect(sectionPlanDistance(sec(), sec({ objective: 'MOSTRAR que el agente recupera carritos abandonados' }))).toBe(0);
    const oneField = sectionPlanDistance(sec(), sec({ surface: 'inverse' }));
    const twoFields = sectionPlanDistance(sec(), sec({ surface: 'inverse', density: 'dense' }));
    expect(oneField).toBeCloseTo(1 / 6);
    expect(twoFields).toBeGreaterThan(oneField);
    const a = { lang: 'es' as const, arc: '', sections: [sec(), sec({ role: 'cta' })] };
    const b = { lang: 'es' as const, arc: '', sections: [sec({ surface: 'inverse' }), sec({ role: 'cta' })] };
    expect(pagePlanDistance(a, b)).toBeCloseTo(1 / 12);
  });

  test('separación por rol: ruido dentro del negocio contra distancia entre negocios', () => {
    const runs = [
      { business: 'a', rep: 1, plan: { lang: 'es' as const, arc: '', sections: [sec()] } },
      { business: 'a', rep: 2, plan: { lang: 'es' as const, arc: '', sections: [sec()] } },
      { business: 'b', rep: 1, plan: { lang: 'es' as const, arc: '', sections: [sec({ objective: 'Sumar al equipo a la lista de espera', proof: 'stats', density: 'airy' })] } },
      { business: 'b', rep: 2, plan: { lang: 'es' as const, arc: '', sections: [sec({ objective: 'Sumar al equipo a la lista de espera', proof: 'stats', density: 'airy' })] } },
    ];
    const [row] = summarizePlans(runs);
    expect(row.within.mean).toBe(0);
    expect(row.between.mean).toBeGreaterThan(0);
    expect(row.separation).toBe(Infinity);
    expect(row.shapeByBusiness).toEqual({ a: 'feature-detail|normal|base|medium', b: 'stats|airy|base|medium' });
  });

  test('regla intención → forma y elección de patrón, determinista', () => {
    expect(formOfIntent(sec({ density: 'dense', surface: 'inverse', emphasis: 'high' }))).toEqual({ cols: 4, media: 'background', cards: true });
    expect(formOfIntent(sec({ density: 'airy', proof: 'demo' }))).toEqual({ cols: 2, media: 'image', cards: false });
    const p = (cols: number, media: string, cards: boolean, key: string) => ({ key, count: 1, sig: { cols, media, cards }, tree: {}, why: '', slugs: [] }) as never;
    const patterns = [p(3, 'none', false, 'P3'), p(4, 'background', true, 'P4bg'), p(2, 'image', false, 'P2img')];
    expect(patternForIntent(patterns, sec({ density: 'dense', surface: 'inverse', emphasis: 'high' }))?.key).toBe('P4bg');
    expect(patternForIntent(patterns, sec({ density: 'airy', proof: 'demo' }))?.key).toBe('P2img');
    expect(patternForIntent(patterns, sec({ density: 'airy' }))?.key).toBe('P2img');
    expect(patternForIntent(patterns, sec())?.key).toBe('P3');
  });
});
