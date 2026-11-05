import { describe, expect, test } from 'bun:test';
import { allowEntry, formOf, childSlotsOf, declaresChildren, distillDoc, inheritsChildren, referenceHeader, swatchHex, unresolvedImports, type AllowEntry } from '../src/ds-skill';
import type { CatalogEntry } from '../src/catalog/schema';

const DOC = [
  '# Hero section',
  '',
  '> Three heroes.',
  '- Access: Free, open source',
  '',
  '## When to use',
  '- First section.',
  '## Installation',
  'npx shadcn@latest add @uikit/hero-section',
  '## Usage',
  '```tsx',
  'import { HeroSection } from "@/components/uikit/blocks/hero-section/hero-section";',
  '```',
  '## Notes for AI',
  '- Replace the copy in hero-lumen.tsx.',
  '- Composes Button.',
  '',
].join('\n');

describe('ds-skill', () => {
  test('el doc destilado no instala ni manda a editar internos, e importa del scaffold', () => {
    const out = distillDoc(DOC);
    expect(out).not.toContain('Installation');
    expect(out).not.toContain('hero-lumen.tsx');
    expect(out).toContain('- Composes Button.');
    expect(out).toContain('@/components/arc/blocks/hero-section/hero-section');
  });

  test('un import del ejemplo fuera de la allowlist se reporta', () => {
    const text = 'import { A } from "@/components/arc/a/a";\nimport { B } from "@/components/arc/b/b";';
    expect(unresolvedImports(text, new Set(['@/components/arc/a/a']))).toEqual(['@/components/arc/b/b']);
  });

  test('los props ReactNode son donde se anida, con la marca de obligatorio limpia', () => {
    const e = { manifest: { props: [
      { name: 'items` (required)', type: '{ title: string; content: ReactNode }[]', description: '' },
      { name: 'size', type: '"md" | "lg"', description: '' },
      { name: 'children', type: 'ReactNode', description: '' },
    ] } } as unknown as CatalogEntry;
    expect(childSlotsOf(e)).toEqual([
      { prop: 'items', required: true, type: '{ title: string; content: ReactNode }[]' },
      { prop: 'children', required: false, type: 'ReactNode' },
    ]);
  });

  test('el swatch resuelve var() y oklch acromático a hex', () => {
    const vars: [string, string][] = [['--neutral-0', 'oklch(100% 0 0)'], ['--background', 'var(--neutral-0)']];
    expect(swatchHex('var(--background)', vars)).toBe('#ffffff');
    expect(swatchHex('#7747ff', vars)).toBe('#7747ff');
  });

  test('children heredado de HTMLAttributes cuenta como slot, salvo que el Omit lo excluya', () => {
    expect(inheritsChildren('export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onDrag"> {', 'Button')).toBe(true);
    expect(inheritsChildren('export interface HoldProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "onClick"> {', 'Hold')).toBe(false);
    expect(inheritsChildren('export interface ChartProps {', 'Chart')).toBe(false);
  });
});

describe('ds-skill — componentes solo-default', () => {
  test('la cabecera de la referencia enseña el import sin llaves', () => {
    const e = { slug: 'toast', export: 'Toast', importPath: '@/components/arc/toast/toast', exportDefault: true, kind: 'component' } as CatalogEntry;
    const header = referenceHeader(e, { export: 'Toast', exportDefault: true, importPath: e.importPath, kind: 'component', schema: null, propless: false, accepts: [], provides: [] } as AllowEntry, []);
    expect(header).toContain('- import: `import Toast from "@/components/arc/toast/toast";`');
  });
});

describe('ds-skill — cáscaras Relume', () => {
  test('un children declarado tras quitar el de HTML es el slot de la cáscara', () => {
    const src = 'export type Cta3ShellProps = Omit<ComponentPropsWithoutRef<"section">, "children"> &\n  Partial<Props> & { children?: ReactNode };';
    expect(declaresChildren(src, 'Cta3Shell')).toBe(true);
    expect(declaresChildren(src.replace('{ children?: ReactNode }', '{ tone?: string }'), 'Cta3Shell')).toBe(false);
  });
});

describe('ds-skill — usage 2-layer', () => {
  const block = (slug: string, role?: string, kind: CatalogEntry['kind'] = 'block') =>
    ({ library: 'arc', kind, slug, name: slug, export: 'X', importPath: `@/x/${slug}`, ...(role ? { role } : {}), category: role ? `${role}-sections` : 'app-ui' }) as unknown as CatalogEntry;

  test('un showcase con rol features es interior, no sección: la madurez no puede fijarlo como sección', () => {
    expect(allowEntry(block('ai-chat', 'features'), null, []).usage).toBe('showcase');
    expect(allowEntry(block('feature-bento', 'features'), null, []).usage).toBe('section');
    expect(allowEntry(block('cta3_shell', 'cta', 'layout'), null, []).usage).toBe('section');
  });

  test('sin rol (UI de app) o un componente no llevan usage', () => {
    expect(allowEntry(block('api-keys'), null, []).usage).toBeUndefined();
    expect(allowEntry(block('avatar', undefined, 'component'), null, []).usage).toBeUndefined();
  });
});

describe('ds-skill — forma del bloque', () => {
  test('formOf: geometry + tags en blocks; standard no distingue y los átomos no tienen forma', () => {
    expect(formOf({ kind: 'block', geometry: 'card', tags: ['2 Columns', 'Image'] })).toBe('card, 2 Columns, Image');
    expect(formOf({ kind: 'layout', geometry: 'standard', tags: ['1 Column'] })).toBe('1 Column');
    expect(formOf({ kind: 'component', geometry: 'card', tags: ['Button'] })).toBeUndefined();
  });
});
