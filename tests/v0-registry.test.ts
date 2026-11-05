import { describe, expect, test } from 'bun:test';
import { resolveItems, type RegistrySource } from '../src/runtime/registry';

const source = (items: Record<string, unknown>): RegistrySource => ({
  pin: 'abc',
  getItem: async (slug) => {
    if (!(slug in items)) throw new Error('404');
    return items[slug] as never;
  },
});
const file = (path: string) => ({ path, content: '//' });

describe('registry', () => {
  test('resuelve las dependencias una sola vez cada una', async () => {
    const items = await resolveItems(['hero-section'], source({
      'hero-section': { name: 'hero-section', files: [file('src/components/arc/blocks/hero-section/hero-section.tsx')], registryDependencies: ['button', 'badge'] },
      button: { name: 'button', files: [file('src/components/arc/button/button.tsx')], registryDependencies: ['badge'] },
      badge: { name: 'badge', files: [file('src/components/arc/badge/badge.tsx')] },
    }));
    expect(items.map((i) => i.name)).toEqual(['hero-section', 'button', 'badge']);
  });

  test('acepta una sección Relume portada bajo src/components/relume/ y rechaza otra ruta del workspace', async () => {
    const relume = { cta3_shell: { name: 'cta3_shell', files: [file('src/components/relume/cta-sections/cta-3/cta-3-shell.tsx')], registryDependencies: ['button'] }, button: { name: 'button', files: [file('src/components/arc/button/button.tsx')] } };
    expect((await resolveItems(['cta3_shell'], source(relume))).map((i) => i.name)).toEqual(['cta3_shell', 'button']);
    await expect(resolveItems(['x'], source({ x: { name: 'x', files: [file('src/sections/01-hero.tsx')] } }))).rejects.toThrow('fuera de');
  });

  // gen sobre el pin 5ceb5a7c: el item bencho-faq-accordion abortó la instalación entera.
  test('acepta los bloques portados de Morphin y Bencho con sus archivos hermanos', async () => {
    const ported = {
      'bencho-faq-accordion': { name: 'bencho-faq-accordion', files: [file('src/components/bencho/faq-accordion/faq-accordion.tsx'), file('src/components/bencho/faq-accordion/faq-accordion-data.ts')] },
      'morphin-shaders-hero': { name: 'morphin-shaders-hero', files: [file('src/components/morphin/shaders-hero/shaders-hero.tsx')] },
    };
    expect((await resolveItems(['bencho-faq-accordion', 'morphin-shaders-hero'], source(ported))).map((i) => i.name)).toEqual(['bencho-faq-accordion', 'morphin-shaders-hero']);
    await expect(resolveItems(['x'], source({ x: { name: 'x', files: [file('src/components/bencho/../../sections/01-hero.tsx')] } }))).rejects.toThrow('fuera de');
  });

  test('acepta una lib suelta en la raíz de src/components (iconos de marca de los footers) y no una carpeta ahí', async () => {
    const footer = { footer14_component: { name: 'footer14_component', files: [file('src/components/relume/footers/footer-14/footer-14.tsx')], registryDependencies: ['components-brand-icons'] }, 'components-brand-icons': { name: 'components-brand-icons', files: [file('src/components/brand-icons.tsx')] } };
    expect((await resolveItems(['footer14_component'], source(footer))).map((i) => i.name)).toEqual(['footer14_component', 'components-brand-icons']);
    await expect(resolveItems(['x'], source({ x: { name: 'x', files: [file('src/components/otra/cosa.tsx')] } }))).rejects.toThrow('fuera de');
  });

  test('rechaza un archivo que escapa de src/components/arc/ y un item que no responde', async () => {
    await expect(resolveItems(['x'], source({ x: { name: 'x', files: [file('src/components/arc/../../main.tsx')] } }))).rejects.toThrow('fuera de');
    await expect(resolveItems(['y'], source({}))).rejects.toThrow('registry@abc: no se pudo leer y');
  });
});
