import { describe, expect, test } from 'bun:test';
import { buildFlow, type FlowInputs } from '../src/log/flow';
import type { PageResult } from '../src/select';
import type { LayeredPage } from '../src/compose-layers';
import type { EmitReport } from '../src/emit';
import type { RouteResult } from '../src/router';
import type { GeneratedCopy } from '../src/copygen/generate';
import type { Brief, RoleSpec, Selection } from '../src/types';

const brief: Brief = { summary: 'Producto X', goal: 'empezar', sections: ['hero', 'features'] };
const specs: RoleSpec[] = [
  { role: 'hero', category: 'hero-header-sections', desiredTags: ['2 Columns'] },
  { role: 'features', category: 'feature-sections', desiredTags: ['3 Columns'] },
];
const sel = (role: 'hero' | 'features', slug: string): Selection => ({ role, pick: { slug, name: slug, category: 'c', tags: [], surface: { light: 'base', dark: 'base' }, geometry: 'standard' }, score: 5, reasons: ['tags+1'], alternates: [] });
const page: PageResult = { frame: {}, strips: [sel('hero', 'hero-section'), sel('features', 'feature-bento')], total: 10, cohesionReasons: ['sin bandas apiladas'], profile: 'quiet', effective: { light: 'quiet', dark: 'quiet' } };
const layered: LayeredPage = { ...page, layers: [] };
const report: EmitReport = { dir: 'generated/x', library: 'arc', brand: 'Acme', blocks: [{ role: 'hero', slug: 'hero-section', export: 'HeroSection' }, { role: 'features', slug: 'feature-bento', export: 'FeatureBento' }], omittedRoles: [], omitted: [], demoVisible: [], simulated: [], appPath: 'generated/x/src/App.tsx' } as unknown as EmitReport;

const base: FlowInputs = { brief, brand: 'Acme', specs, rhythm: 'quiet', page, layered, report };

describe('buildFlow — log de flujo mapeado a Relume', () => {
  test('con routed+copy: etapas en orden y page-content refleja el inputJson', () => {
    const routed = { intent: { intent: 'demo' }, trace: { hero: { shortlisted: [{ slug: 'hero-section', score: 7, matched: [] }], excluded: [], rescued: [], dropped: [] } } } as unknown as RouteResult;
    const generated = { generator: 'determinista', input: { 'all pages': ['home'], 'page name': 'home', 'page sections': ['hero'], sections: [{ section_id: 'section_0', category: 'hero', outline: '', 'input text fields': [] }] } } as unknown as GeneratedCopy;
    const log = buildFlow({ ...base, routed, generated });
    expect(log.stages.map((s) => s.stage)).toEqual(['plan', 'route', 'select', 'page-content', 'text-fit', 'emit']);
    expect(log.intent).toBe('demo');
    expect(log.stages.find((s) => s.stage === 'route')?.relume).toBe('section-component-1');
    expect(log.stages.find((s) => s.stage === 'page-content')?.relume).toBe('page-content-1');
    expect(log.stages.find((s) => s.stage === 'page-content')?.detail).toBe(generated.input); // comparación directa con el extract
  });

  test('sin marca/router/capas/copy: solo plan, select y emit', () => {
    const log = buildFlow(base);
    expect(log.stages.map((s) => s.stage)).toEqual(['plan', 'select', 'emit']);
    expect(log.intent).toBeUndefined();
    expect(log.stages[1].detail).toMatchObject({ profile: 'quiet' });
  });

  test('marca y capas agregan sus etapas con contraparte Relume', () => {
    const withBrand = buildFlow({ ...base, composition: { density: 'spacious' }, layered: { ...page, layers: [{ role: 'features', layout: { slug: 'layout255_shell', export: 'L', importPath: 'p' }, inner: { slug: 'feature-bento', export: 'F', importPath: 'p' }, props: { inner: { slug: 'feature-bento' } }, innerSelection: sel('features', 'feature-bento') }] } });
    expect(withBrand.stages.map((s) => s.stage)).toEqual(['plan', 'brand', 'select', 'compose-layers', 'emit']);
    expect(withBrand.stages.find((s) => s.stage === 'brand')?.relume).toContain('brief-to-theme-and-color');
  });
});
