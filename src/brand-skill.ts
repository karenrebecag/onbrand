// Partes del skill del DS que salen del brand pack (ADR 0011: el agente aprende la marca leyendo el skill, como en v0).
// appearance es la presentación del DS en la UI del builder (frontmatter de SKILL.md), no los tokens de la página;
// colors.md y logos.md sí guían lo que el agente escribe. Puro: el mismo pack da el mismo texto.

import { logoDarkSrc, logoIncludesName, logoSrc, type BrandPack } from './brand';
import { variantsMd } from './brand-components';

export interface Appearance { light: { background: string; foreground: string }; dark: { background: string; foreground: string } }
export interface BrandSkillParts {
  appearance: Appearance;
  colorsMd: string;
  logosMd: string;
  /** references/components/brand-variants.md; solo si el pack declara variantes. */
  variantsMd?: string;
}
export interface BrandSkillOptions {
  /** Sin BrandMark en el starter, logos.md enseña el <img> directo a public/brand. */
  brandMark?: boolean;
}

/** WCAG AA para texto normal: lo que pide el skill-authoring de v0 para appearance. */
export const MIN_CONTRAST = 4.5;
const NEUTRAL: Appearance = { light: { background: '#FFFFFF', foreground: '#0A0A0A' }, dark: { background: '#0A0A0A', foreground: '#FFFFFF' } };

const HEX6 = /^#([\da-f]{6})$/i;
const HEX3 = /^#([\da-f]{3})$/i;

/** '#abc' o '#aabbcc' → '#AABBCC'; cualquier otra forma (rgb(), oklch(), preset) no se puede verificar fuera del navegador. */
export function hex6(value: string | undefined): string | null {
  const v = value?.trim() ?? '';
  const short = HEX3.exec(v);
  if (short) return `#${[...short[1]].map((c) => c + c).join('')}`.toUpperCase();
  return HEX6.test(v) ? v.toUpperCase() : null;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** El primer foreground que llega a 4.5:1 sobre background, o null. */
function readable(background: string, candidates: (string | null)[]): string | null {
  return candidates.find((c): c is string => !!c && c !== background && contrast(background, c) >= MIN_CONTRAST) ?? null;
}

/** El color de identidad: --brand-highlight si el pack lo separa, si no el acento propio. Un preset no tiene hex. */
function identity(pack: BrandPack): string | null {
  return hex6(pack.tokens?.['--brand-highlight']) ?? (typeof pack.accent === 'string' ? null : hex6(pack.accent.base));
}

export function brandAppearance(pack: BrandPack): Appearance {
  const id = identity(pack);
  const fg = hex6(pack.surface?.foreground);
  const bg = hex6(pack.surface?.background);
  const neutral: Appearance = {
    light: bg && fg && contrast(bg, fg) >= MIN_CONTRAST ? { background: bg, foreground: fg } : NEUTRAL.light,
    dark: bg && fg && contrast(bg, fg) >= MIN_CONTRAST ? { background: fg, foreground: bg } : NEUTRAL.dark,
  };
  if (!id) return neutral;
  // Claro: la identidad de fondo con el texto de la marca. Oscuro: el texto de la marca de fondo con la identidad
  // encima. Cada lado prueba el otro color de la marca antes de caer a los neutros; nada se invierte sin medir.
  const lightFg = readable(id, [fg, bg]);
  const darkBg = fg ?? NEUTRAL.dark.background;
  const darkFg = readable(darkBg, [id, bg]);
  return {
    light: lightFg ? { background: id, foreground: lightFg } : neutral.light,
    dark: darkFg ? { background: darkBg, foreground: darkFg } : neutral.dark,
  };
}

const row = (token: string, value: string | undefined, use: string): string => `| \`${token}\` | ${value ? `\`${value}\`` : 'contrato'} | ${use} |`;

function colorsMd(pack: BrandPack): string {
  const custom = typeof pack.accent === 'string' ? null : pack.accent;
  const highlight = pack.tokens?.['--brand-highlight'];
  const separated = !!highlight && hex6(highlight) !== (custom ? hex6(custom.base) : null);
  const t = (k: string): string | undefined => pack.tokens?.[k];
  return [
    `# Colores de ${pack.name}`,
    '',
    `Esta es la paleta de ${pack.name}: reemplaza a la del DS genérico. En el código, cada color se escribe como \`var(--token)\`;`,
    'nunca hex, rgb ni oklch crudos. Los valores de la tabla son para entender la marca, no para copiarlos.',
    '',
    '## Interactivo',
    '',
    '| Token | Valor | Uso |',
    '|---|---|---|',
    row('--accent', custom?.base ?? (typeof pack.accent === 'string' ? `preset ${pack.accent}` : undefined), 'Botón primario, selección, estado activo, burbuja propia de un chat, barras de progreso.'),
    row('--accent-strong', custom?.strong, 'Hover y presionado del interactivo.'),
    row('--accent-subtle', custom?.subtle, 'Fondo suave de un elemento seleccionado.'),
    row('--accent-foreground', custom?.foreground, 'Texto e iconos sobre `--accent`.'),
    '',
    '## Identidad',
    '',
    ...(separated
      ? [
          '| Token | Valor | Uso |',
          '|---|---|---|',
          row('--brand-highlight', highlight, 'Solo detalles: una palabra destacada, un icono puntual, un punto o línea de énfasis.'),
          '',
          `**Regla de ${pack.name}:** \`--brand-highlight\` nunca pinta un CTA, un botón, una burbuja ni el fondo de una`,
          'sección o tarjeta. Las acciones usan `--accent`. Un elemento de más de 80×32 px con este color es un error de marca.',
        ]
      : ['El color de identidad es el mismo interactivo (`--accent`): puede pintar CTAs y estados activos.']),
    '',
    '## Superficies y texto',
    '',
    '| Token | Valor | Uso |',
    '|---|---|---|',
    row('--background', pack.surface?.background, 'Fondo de la página y de las secciones base.'),
    row('--surface', pack.surface?.surface, 'Tarjetas y paneles sobre el fondo.'),
    row('--surface-raised', t('--surface-raised'), 'Elementos elevados (popover, menú).'),
    row('--surface-muted', t('--surface-muted'), 'Fondos atenuados dentro de un componente.'),
    row('--surface-band', undefined, 'Sección que se separa del fondo (banda): derivada del fondo de la marca.'),
    row('--foreground', pack.surface?.foreground, 'Texto principal.'),
    row('--text-secondary', pack.surface?.textSecondary, 'Texto secundario, descripciones.'),
    '',
    '## Zonas oscuras',
    '',
    ...(pack.colorMode === 'dark' ? [`La página de ${pack.name} es oscura por defecto: una zona clara es la que lleva \`data-theme="light"\`.`, ''] : []),
    'Una sección con `data-theme="dark"` (o el contrario de la raíz) redeclara todos los tokens: dentro de ella se usan los',
    'mismos nombres y la marca resuelve sus valores oscuros. No se escriben colores alternativos a mano.',
    '',
    ...formMd(pack),
  ].join('\n');
}

// Las palancas del contrato (foundation.css:93-103) escalan radios, espacios y texto juntos: el agente las lee en
// palabras para no compensarlas a mano (un radio "más redondo" escrito en px rompería la escala de la marca).
function formMd(pack: BrandPack): string[] {
  const factor = (k: string): number | undefined => { const v = Number(pack.tokens?.[k]); return Number.isFinite(v) && v > 0 && v !== 1 ? v : undefined; };
  const radius = factor('--radius-factor');
  const scaling = factor('--scaling');
  if (!radius && !scaling) return [];
  const pct = (v: number, more: string, less: string): string => `${Math.round(Math.abs(v - 1) * 100)} % ${v > 1 ? more : less} que el DS`;
  return [
    '## Forma',
    '',
    ...(radius ? [`- Esquinas: ${pct(radius, 'más redondas', 'más rectas')} (\`--radius-factor: ${radius}\`).`] : []),
    ...(scaling ? [`- Escala: espacios, alturas de control y texto ${pct(scaling, 'más grandes', 'más chicos')} (\`--scaling: ${scaling}\`).`] : []),
    '',
    'Ya están aplicadas en `var(--radius-*)`, `var(--space-*)` y `var(--text-*)`: se usan esos tokens tal cual, sin',
    'multiplicar ni escribir px a mano.',
    '',
  ];
}

function logosMd(pack: BrandPack, brandMark: boolean): string {
  const light = logoSrc(pack);
  const dark = logoDarkSrc(pack);
  const usage = brandMark
    ? [
        '```tsx',
        "import { BrandMark } from '@/components/brand-mark/brand-mark'",
        '',
        '<BrandMark />            // header',
        '<BrandMark height={20} /> // footer',
        '```',
        '',
        light
          ? `BrandMark pinta \`${light}\`${dark ? ` y, dentro de una zona oscura, \`${dark}\`` : ''}; sin logo pinta el nombre "${pack.name}".`
          : `${pack.name} no tiene archivo de logo: BrandMark pinta el nombre como texto.`,        ...(logoIncludesName(pack)
          ? [
              '',
              `El logo de ${pack.name} ya es el wordmark: el nombre no se escribe al lado. En SiteHeader y SiteFooter pasa`,
              `\`brand={{ name: "${pack.name}", href: "#", mark: <BrandMark />, markIncludesName: true }}\`; el nombre queda como`,
              'aria-label y en el copyright.',
            ]
          : []),
      ]
    : light
      ? ['```tsx', `<img src="${light}" alt="${pack.name}" height={28} />`, '```', ...(dark ? ['', `En una zona oscura usa \`${dark}\`.`] : [])]
      : [`${pack.name} no tiene archivo de logo: el header y el footer escriben el nombre "${pack.name}" como texto.`];
  return [
    `# Logos de ${pack.name}`,
    '',
    '## El logo de la marca',
    '',
    ...usage,
    '',
    'No se redibuja, no se reemplaza por un icono ni se genera como imagen.',
    '',
    '## Logos de terceros',
    '',
    '- **Integraciones o canales reales que el brief nombra** (p. ej. WhatsApp, Instagram): se pueden mostrar con su logo',
    '  real (theSVG o los iconos de marca del DS), con su nombre como texto alternativo.',
    '- **Clientes, testimonios y casos de éxito inventados:** nombre en texto, sin logo. Un logo real junto a un caso',
    '  ficticio insinúa una relación que no existe.',
    '- Nunca se inventa el logo de una empresa ni se usa uno real para una empresa ficticia.',
    '',
  ].join('\n');
}

export function brandSkillParts(pack: BrandPack, opts: BrandSkillOptions = {}): BrandSkillParts {
  const variants = variantsMd(pack.name, pack.components);
  return { appearance: brandAppearance(pack), colorsMd: colorsMd(pack), logosMd: logosMd(pack, opts.brandMark ?? true), ...(variants ? { variantsMd: variants } : {}) };
}
