import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyHeaderAlign, checkLayout, stripUnknownNodes } from '../src/runtime/layout-check';
import { layoutPolicyOf } from '../src/runtime/skill';
import type { AllowEntry } from '../src/ds-skill';
import type { JsonSchema, SchemaStore } from '../src/runtime/verify';

const entry = (kind: 'component' | 'block', accepts: string[], propless = false): AllowEntry => ({
  export: 'X', importPath: '@/x', kind, schema: 'x', propless, accepts: accepts.map((prop) => ({ prop, required: false, type: 'ReactNode' })), provides: [],
});
const allow: Record<string, AllowEntry> = {
  card: entry('component', ['action', 'children']),
  button: entry('component', ['children']),
  'hero-section': entry('block', []),
};
const cardSchema: JsonSchema = { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string' }, action: {}, children: {}, items: { type: 'array' } } };
const heroSchema: JsonSchema = { type: 'object', additionalProperties: false, properties: { title: { type: 'string', format: 'heading' } } };
const schemas: SchemaStore = (slug) => (slug === 'card' ? cardSchema : slug === 'hero-section' ? heroSchema : null);
const codes = (s: unknown) => checkLayout(s, allow, schemas).violations.map((v) => `${v.path}:${v.code}`);

describe('check_layout', () => {
  test('una sección con split, slots en accepts y texto pasa', () => {
    const s = { role: 'pricing', width: 'content', children: [{ layout: 'split', ratio: '1:2', gap: 'xl', children: [
      { text: 'title', value: 'Planes' },
      { layout: 'grid', cols: { base: 1, md: 2 }, gap: 'lg', children: [
        { component: 'card', props: { title: 'Starter', action: { $slot: { component: 'button', props: { children: 'Empezar' } } } } },
      ] },
    ] }] };
    expect(codes(s)).toEqual([]);
  });

  test('un block solo vale como único hijo directo de la sección', () => {
    expect(codes({ role: 'hero', children: [{ component: 'hero-section', props: { title: 'Hola' } }] })).toEqual([]);
    expect(codes({ role: 'hero', children: [{ text: 'title', value: 'x' }, { component: 'hero-section', props: { title: 'Hola' } }] })).toEqual(['children[1]:block-not-alone']);
    expect(codes({ role: 'hero', children: [{ layout: 'stack', children: [{ component: 'hero-section', props: { title: 'Hola' } }] }] })).toEqual(['children[0].children[0]:block-nested']);
  });

  test('enums, aridad de split y slot fuera de accepts', () => {
    const s = { role: 'x', padding: 'xxl', children: [
      { layout: 'grid', cols: 5, gap: '3xl', children: [{ text: 'body', value: 'a' }] },
      { layout: 'split', children: [{ text: 'hero', value: 'b' }] },
      { component: 'card', props: { title: 'T', items: [{ $slot: { text: 'body', value: 'c' } }] } },
    ] };
    expect(codes(s)).toEqual([
      'padding:bad-enum',
      'children[0].gap:bad-enum',
      'children[0].cols:bad-enum',
      'children[1].children:split-arity',
      'children[1].children[0].text:bad-enum',
      'children[2].props.items[0]:slot-not-accepted',
    ]);
  });

  test('los props del componente pasan por verify, también dentro de un slot', () => {
    const s = { role: 'x', children: [{ component: 'card', props: { action: { $slot: { component: 'nope' } } } }] };
    expect(codes(s)).toEqual(['children[0].props.action.$slot:unknown-component', 'children[0].props.title:missing-required']);
  });

  test('parts[] legado se lee como stack implícito', () => {
    expect(codes({ role: 'cta', parts: [{ component: 'button', props: { children: 'Ir' } }] })).toEqual([]);
    expect(codes({ role: 'cta', children: [] })).toEqual(['children:empty-section']);
  });
});

// Brecha #5: con una política de hrefs, un enlace que no es ancla de la página, ruta legal ni externo
// se rebota (href-unresolved); el `#` y las anclas válidas pasan.
test('checkLayout rebota hrefs inventados y acepta ancla de la página / # / externo', () => {
  const policy = { anchors: ['#features', '#cta'], legalRoutes: [] as string[] };
  const mk = (href: string) => ({ role: 'cta', children: [{ component: 'button', props: { children: 'Ir', href } }] });
  const codesWith = (href: string) => checkLayout(mk(href), allow, schemas, undefined, policy).violations.map((v) => v.code);
  expect(codesWith('/privacidad')).toContain('href-unresolved');
  expect(codesWith('#inicio')).toContain('href-unresolved');
  expect(codesWith('#features')).not.toContain('href-unresolved');
  expect(codesWith('#')).not.toContain('href-unresolved');
  expect(codesWith('mailto:hola@acme.example')).not.toContain('href-unresolved');
  // sin política, los hrefs no se tocan
  expect(checkLayout(mk('/privacidad'), allow, schemas).violations.map((v) => v.code)).not.toContain('href-unresolved');
});

// Bug 817da32c: las 4 secciones de árbol salían con la cabecera centrada (v0: 10/10 a la izquierda).
// La alineación la fija el DS y se corrige sin reintento; el interior de los componentes no se toca.
describe('applyHeaderAlign', () => {
  const section = {
    role: 'features',
    children: [{ layout: 'stack', align: 'stretch', children: [
      { layout: 'stack', align: 'center', children: [{ text: 'title', value: 'T', align: 'center' }, { text: 'body', value: 'B', align: 'center' }] },
      { layout: 'grid', cols: 3, children: [{ component: 'card', props: { title: 'x', children: { $slot: { text: 'body', value: 'dentro', align: 'center' } } } }] },
    ] }],
  };

  test('con política del DS, la cabecera sale con su alineación y el slot del componente queda igual', () => {
    const out = applyHeaderAlign(section, { sectionHeaderAlign: 'start' });
    const [outer] = out.children as any[];
    expect(outer.align).toBe('stretch');
    expect(outer.children[0]).toEqual({ layout: 'stack', align: 'start', children: [{ text: 'title', value: 'T', align: 'start' }, { text: 'body', value: 'B', align: 'start' }] });
    expect(outer.children[1]).toEqual(section.children[0].children[1]);
    expect((section.children[0].children[0] as any).align).toBe('center');
  });

  test('sin política del DS no cambia nada', () => {
    expect(applyHeaderAlign(section, undefined)).toBe(section);
  });
});

test('layoutPolicyOf lee el campo del DS e ignora valores fuera del enum', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-skill-'));
  writeFileSync(join(dir, 'v0.json'), JSON.stringify({ layout: { sectionHeaderAlign: 'start' } }));
  expect(layoutPolicyOf(join(dir, 'v0.json'))).toEqual({ sectionHeaderAlign: 'start' });
  writeFileSync(join(dir, 'v0.json'), JSON.stringify({ layout: { sectionHeaderAlign: 'left' } }));
  expect(layoutPolicyOf(join(dir, 'v0.json'))).toBeUndefined();
  expect(layoutPolicyOf(join(dir, 'nope.json'))).toBeUndefined();
});

// Un icono inventado no tumba la sección: check_layout lo quita como fix determinista, sin otro infer.
describe('iconos inexistentes', () => {
  const icons = { sets: [{ id: 'lucide', title: 'l', importPath: 'lucide-react', names: ['Zap'], aliases: {} }] };
  const section = {
    role: 'features',
    children: [{ layout: 'grid', cols: 2, children: [
      { layout: 'stack', children: [{ component: 'icon:lucide/Zap' }, { text: 'subtitle', value: 'Rápido' }] },
      { layout: 'stack', children: [{ component: 'icon:lucide/NoExiste' }, { text: 'subtitle', value: 'Seguro' }] },
      { component: 'card', props: { title: 'x', action: { $slot: { component: 'icon:lucide/NoExiste' } } } },
    ] }],
  };

  test('el verdict trae un fix sin el icono desconocido y el resto intacto', () => {
    const v = checkLayout(section, allow, schemas, icons);
    expect(v.ok).toBe(false);
    expect(v.violations.every((x) => x.code === 'unknown-icon')).toBe(true);
    const grid = (v.fix!.section.children[0] as any).children;
    expect(grid[0].children).toEqual([{ component: 'icon:lucide/Zap' }, { text: 'subtitle', value: 'Rápido' }]);
    expect(grid[1].children).toEqual([{ text: 'subtitle', value: 'Seguro' }]);
    expect(grid[2]).toEqual({ component: 'card', props: { title: 'x' } });
    expect(checkLayout(v.fix!.section, allow, schemas, icons).ok).toBe(true);
  });

  test('si además hay otra violación no hay fix: el reintento la tiene que ver', () => {
    const bad = { ...section, children: [...section.children, { text: 'title', value: '' }] };
    expect(checkLayout(bad, allow, schemas, icons).fix).toBeUndefined();
  });

  test('stripUnknownNodes no muta la entrada', () => {
    const copy = JSON.parse(JSON.stringify(section));
    stripUnknownNodes(section, { icons, assets: new Set() });
    expect(section).toEqual(copy);
  });

  test('layoutPolicyOf deja en la paleta solo los iconos que icons.json tiene', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-skill-'));
    writeFileSync(join(dir, 'v0.json'), JSON.stringify({ layout: { icons: ['lucide/Zap', 'lucide/NoExiste', 7] } }));
    expect(layoutPolicyOf(join(dir, 'v0.json'), icons)).toEqual({ icons: ['lucide/Zap'] });
    expect(layoutPolicyOf(join(dir, 'v0.json'))).toBeUndefined();
  });
});

test('applyHeaderAlign solo toca la cabecera: el texto de los items del cuerpo queda como vino', () => {
  const s = { role: 'steps', children: [
    { text: 'title', value: 'T', align: 'center' },
    { layout: 'grid', cols: 3, children: [{ layout: 'stack', children: [{ text: 'subtitle', value: 'Paso', align: 'center' }] }] },
  ] };
  const out = applyHeaderAlign(s, { sectionHeaderAlign: 'start' }) as any;
  expect(out.children[0].align).toBe('start');
  expect(out.children[1]).toEqual(s.children[1]);
});

describe('nodo image', () => {
  const sec = (image: string) => ({ role: 'hero', children: [{ layout: 'split', children: [{ text: 'display', value: 'Hola' }, { image }] }] });
  test('un asset de la página valida; uno inventado se quita como fix', () => {
    expect(checkLayout(sec('product'), allow, schemas, undefined, undefined, ['product']).ok).toBe(true);
    const v = checkLayout({ role: 'hero', children: [{ layout: 'stack', children: [{ text: 'display', value: 'Hola' }, { image: 'hero.png' }] }] }, allow, schemas, undefined, undefined, ['product']);
    expect(v.violations.map((x) => x.code)).toEqual(['unknown-asset']);
    expect((v.fix!.section.children[0] as any).children).toEqual([{ text: 'display', value: 'Hola' }]);
  });
});

// El runner rechaza la página si un nodo trae una clave fuera de component/props; el verify lo ve antes.
test('una clave suelta en un nodo componente es stray-key', () => {
  const s = { role: 'cta', children: [{ component: 'hero-section', props: { title: 'Hola' }, provenance: { 'props.title': { claims: [] } } }] };
  expect(codes(s)).toEqual(['children[0].provenance:stray-key']);
});
