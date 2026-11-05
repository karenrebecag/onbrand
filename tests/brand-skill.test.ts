import { describe, expect, test } from 'bun:test';
import { brandModule, parseBrandPack } from '../src/brand';
import { brandAppearance, brandSkillParts, contrast } from '../src/brand-skill';

// Acme con el mapeo de #200: interactivo oscuro, naranja como identidad.
const ACME = parseBrandPack({
  name: 'Acme',
  logo: 'logo/acme.svg',
  accent: { base: '#0a0a0a', strong: '#000000', subtle: 'rgb(10 10 10 / 0.06)', foreground: '#fafafa' },
  surface: { background: '#fafafa', surface: '#ffffff', foreground: '#0a0a0a', textSecondary: '#525252' },
  tokens: { '--brand-highlight': '#ff6600' },
});

describe('appearance del skill por marca', () => {
  test('Acme: identidad naranja con el texto de la marca, ambos lados sobre 4.5:1', () => {
    const a = brandAppearance(ACME);
    expect(a).toEqual({ light: { background: '#FF6600', foreground: '#0A0A0A' }, dark: { background: '#0A0A0A', foreground: '#FF6600' } });
    expect(contrast(a.light.background, a.light.foreground)).toBeGreaterThanOrEqual(4.5);
  });

  test('si el primer foreground no llega a 4.5:1 prueba el otro color de la marca', () => {
    const inverted = parseBrandPack({ name: 'Noche', accent: { base: '#ff6600', strong: '#a44200', subtle: '#ffe0cc' }, surface: { background: '#0a0a0a', foreground: '#ffffff' } });
    // Blanco sobre naranja da 2.9:1; el fondo oscuro de la marca sí llega.
    expect(brandAppearance(inverted).light).toEqual({ background: '#FF6600', foreground: '#0A0A0A' });
  });

  test('si ningún color de la marca llega, cae a los neutros en vez de inventar', () => {
    const pale = parseBrandPack({ name: 'Pálida', accent: { base: '#ffeb3b', strong: '#fdd835', subtle: '#fffde7' }, surface: { background: '#fffbe6', foreground: '#ffffff' } });
    expect(brandAppearance(pale).light).toEqual({ background: '#FFFFFF', foreground: '#0A0A0A' });
  });

  test('un acento preset sin hex no tiene identidad verificable: neutros de la marca', () => {
    expect(brandAppearance(parseBrandPack({ name: 'Base', accent: 'neutral' })).light).toEqual({ background: '#FFFFFF', foreground: '#0A0A0A' });
  });
});

describe('colors.md y logos.md', () => {
  test('con identidad separada, colors.md da la regla de marca y reemplaza la paleta genérica', () => {
    const { colorsMd } = brandSkillParts(ACME);
    expect(colorsMd).toContain('# Colores de Acme');
    expect(colorsMd).toContain('| `--brand-highlight` | `#ff6600` |');
    expect(colorsMd).toContain('nunca pinta un CTA');
    expect(colorsMd).toContain('| `--accent` | `#0a0a0a` |');
  });

  test('si la identidad es el mismo interactivo, no hay regla de detalle', () => {
    const plain = parseBrandPack({ name: 'Lumbre', accent: { base: '#c2410c', strong: '#9a3412', subtle: '#ffedd5' } });
    expect(brandSkillParts(plain).colorsMd).toContain('puede pintar CTAs');
    expect(brandSkillParts(plain).colorsMd).not.toContain('nunca pinta un CTA');
  });

  test('logos.md enseña BrandMark, o el <img> directo sin él, y prohíbe logos reales en clientes ficticios', () => {
    const withMark = brandSkillParts(ACME).logosMd;
    expect(withMark).toContain("import { BrandMark } from '@/components/brand-mark/brand-mark'");
    expect(withMark).toContain('Clientes, testimonios y casos de éxito inventados:** nombre en texto, sin logo');
    expect(brandSkillParts(ACME, { brandMark: false }).logosMd).toContain('<img src="/brand/logo.svg" alt="Acme" height={28} />');
  });

  // QA gen7: el logo de Acme ya es el wordmark y el agente le pasaba además el nombre al header y al footer.
  test('logoKind wordmark: logos.md pide markIncludesName y src/brand.ts lo expone; sin él, nada cambia', () => {
    const wordmark = parseBrandPack({ name: 'Acme', logo: 'logo/acme.svg', logoKind: 'wordmark', accent: 'blue' });
    expect(brandSkillParts(wordmark).logosMd).toContain('markIncludesName: true');
    expect(brandModule(wordmark)).toContain('"logoIncludesName":true');
    expect(brandSkillParts(ACME).logosMd).not.toContain('markIncludesName');
    expect(brandModule(ACME)).not.toContain('logoIncludesName":');
    expect(() => parseBrandPack({ name: 'Acme', logoKind: 'logo', accent: 'blue' })).toThrow('wordmark|mark');
  });
});

describe('colors.md describe el theme de v2 en palabras', () => {
  test('las palancas de forma y el modo oscuro por defecto se dicen en palabras; sin ellas no aparece nada', () => {
    const { colorsMd } = brandSkillParts(parseBrandPack({ name: 'Rotunda', theme: { preset: 'violet', colorMode: 'dark', roundness: 1.6, scale: 0.9 } }));
    expect(colorsMd).toContain('La página de Rotunda es oscura por defecto');
    expect(colorsMd).toContain('- Esquinas: 60 % más redondas que el DS (`--radius-factor: 1.6`).');
    expect(colorsMd).toContain('- Escala: espacios, alturas de control y texto 10 % más chicos que el DS (`--scaling: 0.9`).');
    const plain = brandSkillParts(parseBrandPack({ name: 'Plana', theme: { preset: 'violet' } })).colorsMd;
    expect(plain).not.toContain('## Forma');
    expect(plain).not.toContain('oscura por defecto');
  });
});
