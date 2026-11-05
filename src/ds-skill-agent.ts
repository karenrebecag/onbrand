// Skill del DS para el agente que escribe la página (ADR 0011), calcado del skill `v0-example-carbon` de v0
// (copia local en ~/v0-fe-capture/calidad-re/carbon-skill: 17 archivos, 48 KB). SKILL.md con starter, reglas, ruteo,
// reglas duras y revisión final; todo lo demás bajo `references/` (components por tarea con `index.md`, foundations
// por tema, examples, assets/icons). La doc por componente es corta y remite al código del workspace como fuente de
// verdad, igual que Carbon remite a su monorepo: el skill anterior pesaba 867 KB y v0 lee 2 referencias por página.
// Puro: el IO vive en scripts/build-ds-skill.ts (--mode agent).
import { DESIGN_COLOR_ROLES, DESIGN_FILE, DESIGN_SECTIONS } from './identity-design';
import { familyOf, FONT_LIST, googleFontsHref, REQUIRED_TOKENS } from './identity-ephemeral';
import type { IconLibrary } from './ds-skill-icons';

export type RefItem = {
  slug: string;
  exportName: string;
  importPath: string;
  summary: string;
  props: string[];
  /** Archivo del componente dentro del workspace: fuente de verdad de sus props. */
  source: string;
  /** Lo que el contrato de skill de v0 pide por componente (`design-system-skill-authoring`): casos de uso, errores
   * comunes y accesibilidad. */
  use?: string[];
  avoid?: string[];
  a11y?: string[];
};

const clip = (t: string, n = 160): string => (t.length > n ? `${t.slice(0, n - 3).trimEnd()}...` : t);

/** Primeras viñetas de una sección `## <title>` del doc del vault: lo justo para decidir, no la doc entera. */
export function docBullets(doc: string | null, title: string, max = 2): string[] {
  if (!doc) return [];
  const sec = doc.split(/^## /m).slice(1).find((p) => p.slice(0, p.indexOf('\n')).trim().toLowerCase() === title.toLowerCase());
  if (!sec) return [];
  return sec.split('\n').filter((l) => /^- /.test(l)).slice(0, max).map((l) => clip(l.slice(2).trim()));
}

const list = (label: string, xs: readonly string[] | undefined): string[] => (xs?.length ? ['', `${label}:`, ...xs.map((x) => `- ${clip(x)}`)] : []);

/** Ruta del componente en el workspace del agente: el alias `@/` es `src/`. */
export const workspaceSource = (importPath: string): string => `${importPath.replace(/^@\//, 'src/')}.tsx`;

// Palanca D (tipos de bloque precargados): del código de un bloque extrae solo su superficie de tipos
// —`export interface …`, `export type …`— sin JSDoc ni cuerpo del componente, para precargarla compacta y que el
// agente no vaya a la fuente a buscar las props (T1 #398: ~30 llamadas de exploración).
export function blockTypeDecls(src: string): string[] {
  const noDoc = src.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const out: string[] = [];
  for (const m of noDoc.matchAll(/export\s+interface\s+\w+[^{]*\{/g)) {
    let depth = 0;
    let j = noDoc.indexOf('{', m.index);
    for (; j < noDoc.length; j++) { const c = noDoc[j]; if (c === '{') depth++; else if (c === '}' && --depth === 0) { j++; break; } }
    out.push(noDoc.slice(m.index, j).split('\n').filter((l) => l.trim()).join('\n'));
  }
  // `export type X = …;` (incluye uniones multilínea); excluye el re-export `export type { … } from "…"`.
  for (const m of noDoc.matchAll(/export\s+type\s+\w+\s*=/g)) {
    let depth = 0;
    let j = m.index + m[0].length;
    for (; j < noDoc.length; j++) { const c = noDoc[j]; if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--; else if (c === ';' && depth <= 0) { j++; break; } }
    out.push(noDoc.slice(m.index, j).replace(/\s+/g, ' ').trim());
  }
  return out;
}

type SchemaProp = { type?: string | string[]; enum?: unknown[] };
export type PropSchema = { properties?: Record<string, SchemaProp>; required?: string[] } | null;
export type Accepts = readonly { prop: string; type: string; required?: boolean }[];

/** Una línea por prop. El tipo TS de `accepts` gana al del schema porque dice la forma real
 * (`{ title: string; content: ReactNode }[]` en vez de `array`). */
export function propsOf(schema: PropSchema, accepts: Accepts): string[] {
  const ts = new Map(accepts.map((a) => [a.prop, a]));
  const required = new Set([...(schema?.required ?? []), ...accepts.filter((a) => a.required).map((a) => a.prop)]);
  const names = [...new Set([...Object.keys(schema?.properties ?? {}), ...ts.keys()])];
  return names.map((n) => {
    const s = schema?.properties?.[n];
    const type = ts.get(n)?.type ?? (s?.enum ? s.enum.map(String).join(' | ') : [s?.type ?? 'unknown'].flat().join(' | '));
    return `\`${n}\`${required.has(n) ? ' (requerida)' : ''}: \`${type}\``;
  });
}

export const REFERENCE_MAX_CHARS = 40_000;

export type RefFile = { name: string; category: string; items: RefItem[] };

function itemReference(i: RefItem): string[] {
  return [
    `## ${i.exportName}`,
    '',
    `\`import { ${i.exportName} } from "${i.importPath}"\`. ${i.summary}`,
    ...(i.props.length ? ['', ...i.props.map((p) => `- ${p}`)] : []),
    ...list('Úsalo para', i.use),
    ...list('No lo uses / errores comunes', i.avoid),
    ...list('Accesibilidad', i.a11y),
    '',
    `Código: \`${i.source}\``,
    '',
  ];
}

/** Una referencia por tarea, como `references/components/data-display.md` de Carbon. */
export function categoryReference(category: string, items: readonly RefItem[]): string {
  return [`# ${category}`, '', 'Cualquier prop que no esté aquí, verifícala en el código del componente antes de usarla.', '', ...items.flatMap(itemReference)].join('\n');
}

/** Con la doc corta ninguna categoría llega al tope hoy; el tope evita que un catálogo que crece vuelva a producir un
 * archivo que el agente carga entero para usar un componente. */
export function referenceFiles(categories: readonly { name: string; items: readonly RefItem[] }[], max = REFERENCE_MAX_CHARS): RefFile[] {
  return categories.flatMap((c) => {
    const parts: RefItem[][] = [[]];
    let size = 0;
    for (const i of c.items) {
      const n = itemReference(i).join('\n').length;
      if (size + n > max && parts[parts.length - 1].length) { parts.push([]); size = 0; }
      parts[parts.length - 1].push(i);
      size += n;
    }
    return parts.map((items, k) => ({ name: parts.length === 1 ? c.name : `${c.name}-${k + 1}`, category: c.name, items }));
  });
}

/** live4: `data` (39 componentes) pesaba 40 KB, casi la mitad de lo leído, para usar un avatar y un accordion. Los
 * charts son otra tarea, como Carbon separa data-display de charts. */
const CHART = /chart|heatmap|gauge|ridgeline|sankey|sparkline|split-bar|streamgraph|sunburst|treemap|waffle/;

export const taskOf = (category: string, slug: string): string => (category === 'data' && CHART.test(slug) ? 'charts' : category);

/** La columna "Task" de la tabla de Carbon, por categoría del catálogo. */
const TASKS: Record<string, string> = {
  actions: 'Acciones, CTA',
  charts: 'Gráficas',
  data: 'Datos, tarjetas, listas',
  disclosure: 'Acordeones, pestañas, revelado',
  feedback: 'Estado y avisos',
  inputs: 'Formularios y selección',
  special: 'Visuales y piezas especiales',
  text: 'Texto con efecto',
};

/** Un bloque de sección de landing en el índice, de cualquier fuente (`@/components/<fuente>/...`): el contrato que
 * comparten Arc, Morphin y Bencho. Solo props de contenido: el agente importa el bloque y le pasa el del brief. */
export type LandingBlockRow = { role: string; exportName: string; importPath: string; props: string[]; use?: string };

// Estado controlado, callbacks y ajustes de animación no son contenido: el agente no los necesita para llenar el bloque.
const NON_CONTENT_PROP = /^`(on[A-Z]\w*|className|style|value|defaultValue|current|defaultCurrent|query|category|scrollContainer|scrollThreshold|animateIn|duration|locale|multiple)`/;
export const contentProps = (props: readonly string[]): string[] => props.filter((p) => !NON_CONTENT_PROP.test(p));

function landingBlocksSection(rows: readonly LandingBlockRow[]): string[] {
  if (!rows.length) return [];
  const sorted = [...rows].sort((a, z) => a.role.localeCompare(z.role) || a.exportName.localeCompare(z.exportName));
  return [
    '',
    '## Secciones de landing (bloques)',
    '',
    'Secciones completas. Si el rol de tu sección tiene bloque, impórtalo y pásale el contenido del brief por props; no',
    'escribas esa sección desde cero. El bloque trae su propio contenedor: móntalo en `<Section id role slug bare>`, que',
    'solo pone el ancla y los atributos del contrato. Sin props de contenido, el bloque pinta su demo: nunca lo dejes así.',
    '',
    '| Rol | Bloque | Props de contenido | Cuándo |',
    '| --- | --- | --- | --- |',
    ...sorted.map((r) => `| ${r.role} | \`import { ${r.exportName} } from "${r.importPath}"\` | ${contentProps(r.props).join(', ')} | ${r.use ?? ''} |`),
  ];
}

export function indexReference(files: readonly RefFile[], blocks: readonly LandingBlockRow[] = []): string {
  const rows = [...new Set(files.map((f) => f.category))].map((cat) => {
    const of = files.filter((f) => f.category === cat);
    const names = of.flatMap((f) => f.items.map((i) => `\`${i.exportName}\``)).join(', ');
    return `| ${TASKS[cat] ?? cat} | ${names} | ${of.map((f) => `\`${f.name}.md\``).join(', ')} |`;
  });
  return [
    '# Índice de componentes',
    '',
    'Se importan con el import exacto de su referencia (alias `@/` = `src/`). La fuente de verdad de las props es el',
    'código del componente en `src/components/`. Lo que no está en estas tablas no existe en el DS, y lo que está no',
    'se reescribe a mano.',
    '',
    '| Tarea | Componentes | Doc |',
    '| --- | --- | --- |',
    '| Estructura de página | `Section`, `Grid`, `Split`, `Stack`, `Cluster`, `Text`, `Image` | `layout.md` |',
    // Como la fila de layout: la tarea "chat" no sale de ninguna categoría del catálogo y sin fila propia el agente no
    // encuentra ChatThread dentro de "Datos" y escribe su propio chat (QA perf/audit, chat d62b35cb).
    '| Chat o mockup de mensajería (WhatsApp) | `ChatThread` dentro de `data-skin="whatsapp"` | `data.md` |',
    // Paquetes de npm, no del catálogo: sin doc propio, la regla 1 del SKILL.md trae el import y el uso.
    '| Persona sin foto real (reseña, equipo, testimonio) | `Avatar` de `@usespaceui/avatars/react`, `seedAvatarSrc` | regla 1 |',
    '| Emoji con dibujo (chat, reseña) | `Emoji` de `@usespaceui/emoji/react` | regla 1 |',
    ...rows,
    '',
    '## Reglas universales',
    '',
    '- Todo control lleva etiqueta visible o `aria-label`; nunca un input sin label.',
    '- `size` es `sm` | `md` | `lg` en botones y controles.',
    '- No se restilan los internos de un componente: se compone con CSS de layout en el archivo de la sección.',
    ...landingBlocksSection(blocks),
  ].join('\n');
}

/** Las primitivas de layout no están en el catálogo: su referencia es el propio código, como Grid/Column en Carbon. */
export function layoutReference(source: string): string {
  return ['# Layout', '', '`import { Section, Grid, Split, Stack, Cluster, Text, Image } from "@/components/layout/layout"`', '', '```tsx', source.trim(), '```'].join('\n');
}

/** Los organismos portados (Arc, Relume) son molde de lectura (ADR 0011): qué hay y dónde está su código. */
export function exampleReference(role: string, items: readonly RefItem[]): string {
  return [
    `# Ejemplos: ${role}`,
    '',
    'Secciones ya resueltas, para leer su marcado y su CSS antes de escribir la tuya. No se importan ni se copia su',
    'texto: la sección de esta página se escribe para su brief, con los componentes y tu propio CSS.',
    '',
    ...items.flatMap((i) => [`## ${i.slug}`, '', i.summary, '', `Código: \`${i.source}\``, '']),
  ].join('\n');
}

/** El equivalente a `examples/page-layout.md` de Carbon: una sección completa con el patrón del DS. */
export const PAGE_LAYOUT_EXAMPLE = [
  '# Ejemplo: una sección',
  '',
  'Cada sección es un archivo con su CSS module al lado. `Section` y `Grid` dan el contenedor y las columnas; la',
  'jerarquía, la escala, el ritmo y el tratamiento de cada pieza son clases BEM propias sobre tokens, como en el',
  '`globals.scss` que escribe v0 sobre Carbon.',
  '',
  '```tsx',
  "import { Section, Grid } from '@/components/layout/layout';",
  "import styles from './features.module.css';",
  '',
  'const items = [',
  "  { n: '01', title: 'Escritorio fijo o flexible', body: 'Elige un lugar propio o el que esté libre cada mañana.' },",
  "  { n: '02', title: 'Salas por hora', body: 'Reserva una sala para seis personas desde el celular.' },",
  "  { n: '03', title: 'Café incluido', body: 'Barra de especialidad abierta de 8 a 18 h.' },",
  '];',
  '',
  'export default function Features() {',
  '  return (',
  '    <Section id="funciones" role="features" slug="03-features" surface="muted">',
  '      <div className={styles.features}>',
  '        <header className={styles.features__head}>',
  '          <h2 className={styles.features__title}>Un lugar para trabajar sin pensar en la oficina</h2>',
  '          <p className={styles.features__lead}>Todo listo al llegar: internet, salas y café.</p>',
  '        </header>',
  '        <Grid cols={{ base: 1, md: 3 }} gap="md">',
  '          {items.map((i) => (',
  '            <article key={i.n} className={styles.features__item}>',
  '              <span className={styles.features__index} aria-hidden="true">{i.n}</span>',
  '              <h3 className={styles.features__itemTitle}>{i.title}</h3>',
  '              <p className={styles.features__itemBody}>{i.body}</p>',
  '            </article>',
  '          ))}',
  '        </Grid>',
  '      </div>',
  '    </Section>',
  '  );',
  '}',
  '```',
  '',
  '```css',
  '.features { display: grid; gap: var(--space-10); }',
  '.features__head { display: grid; gap: var(--space-3); max-width: 40rem; }',
  '.features__title {',
  '  margin: 0;',
  '  font-family: var(--font-display);',
  '  font-size: var(--text-2xl);',
  '  line-height: var(--leading-display);',
  '  letter-spacing: var(--tracking-display);',
  '}',
  '.features__lead { margin: 0; font-size: var(--text-lg); color: var(--text-secondary); }',
  '.features__item {',
  '  display: grid;',
  '  gap: var(--space-2);',
  '  padding-block-start: var(--space-4);',
  '  border-block-start: 1px solid var(--border-strong);',
  '}',
  '.features__index { font-size: var(--text-sm); color: var(--text-muted); font-variant-numeric: tabular-nums; }',
  '.features__itemTitle { margin: 0; font-family: var(--font-display); font-size: var(--text-lg); }',
  '.features__itemBody { margin: 0; color: var(--text-secondary); }',
  '',
  '@media (min-width: 768px) {',
  '  .features__title { font-size: var(--text-3xl); }',
  '}',
  '@media (min-width: 1024px) {',
  '  .features { gap: var(--space-16); }',
  '  .features__title { font-size: var(--text-4xl); }',
  '}',
  '```',
  '',
  'El mismo patrón para cada sección, con su propia forma: un hero no se parece a una lista de beneficios.',
].join('\n');

const TOKEN_GROUPS: { file: 'typography' | 'spacing-layout' | 'motion'; test: RegExp }[] = [
  { file: 'typography', test: /^--(font-|text-(xs|sm|base|lg|\d?xl)$|tracking-|leading-)/ },
  { file: 'spacing-layout', test: /^--(space-|radius|control-height|scaling)/ },
  { file: 'motion', test: /^--(ease-|duration-)/ },
];

type Tokens = [string, string][];

/** Reparte los tokens por archivo de foundations; lo que no es tipo, espacio ni motion es color. */
export function tokensByFile(vars: readonly [string, string][]): Record<'colors' | 'typography' | 'spacing-layout' | 'motion', Tokens> {
  const out: Record<'colors' | 'typography' | 'spacing-layout' | 'motion', Tokens> = { colors: [], typography: [], 'spacing-layout': [], motion: [] };
  for (const v of vars) out[TOKEN_GROUPS.find((g) => g.test.test(v[0]))?.file ?? 'colors'].push(v);
  return out;
}

const table = (vars: readonly [string, string][]): string[] => ['| Token | Valor |', '| --- | --- |', ...vars.map(([k, v]) => `| \`${k}\` | \`${v}\` |`)];

// Sin pack (decisión de Karen 2026-10-25) el agente declara la marca de la página; identity-ephemeral.ts la valida en
// la tool typecheck con estas mismas reglas.
// Un solo juego de valores de ejemplo para identity.css y DESIGN.md: si el ejemplo se contradice a sí mismo, el agente
// copia la contradicción que checkIdentity rechaza (el caso S2 de Stitch).
export const EXAMPLE_LIGHT: Readonly<Record<string, string>> = {
  '--accent': '#1f4d3a',
  '--accent-strong': '#163829',
  '--accent-subtle': 'rgb(31 77 58 / 0.1)',
  '--accent-foreground': '#ffffff',
  '--background': '#fbfaf7',
  '--foreground': '#14130f',
  '--font-display': "'Fraunces', serif",
  '--font-body': "'Manrope', sans-serif",
};
export const EXAMPLE_DARK: Readonly<Record<string, string>> = {
  '--accent': '#7fc8a4',
  '--accent-strong': '#a9dcc2',
  '--accent-subtle': 'rgb(127 200 164 / 0.16)',
  '--accent-foreground': '#0d1a13',
  '--background': '#12130f',
  '--foreground': '#f4f2ec',
  '--font-display': "'Fraunces', serif",
  '--font-body': "'Manrope', sans-serif",
};

const cssBlock = (selector: string, tokens: Readonly<Record<string, string>>): string[] => [selector, ...Object.entries(tokens).map(([k, v]) => `  ${k}: ${v};`), '}'];

/** El DESIGN.md del ejemplo, en el formato de google-labs-code/design.md: frontmatter copiado de los tokens y prosa que
 * solo nombra colores del frontmatter. */
export function exampleDesignMd(light: Readonly<Record<string, string>> = EXAMPLE_LIGHT, dark: Readonly<Record<string, string>> = EXAMPLE_DARK): string {
  const colors = Object.entries(DESIGN_COLOR_ROLES).flatMap(([role, { token, block }]) => {
    const v = (block === 'dark' ? dark : light)[token];
    return v ? [`  ${role}: '${v}'`] : [];
  });
  const prose: Record<(typeof DESIGN_SECTIONS)[number], string> = {
    'Brand & Style': 'Sereno y artesanal: un estudio que cuida el detalle sin ruido.',
    Colors: `El acento ${light['--accent']} va solo en el botón principal, los enlaces y una cifra por sección; nunca en fondos grandes. La página vive sobre ${light['--background']}; las bandas muted separan ritmo, y el cierre inverse va sobre ${dark['--background']}.`,
    Typography: `${familyOf(light['--font-display'])} en titulares (medium) y ${familyOf(light['--font-body'])} en el cuerpo (regular). Sin otros pesos.`,
  };
  return [
    '---',
    'name: <negocio>',
    'colors:',
    ...colors,
    'typography:',
    '  display:',
    `    fontFamily: ${familyOf(light['--font-display'])}`,
    '    fontWeight: 500',
    '  body:',
    `    fontFamily: ${familyOf(light['--font-body'])}`,
    '    fontWeight: 400',
    '---',
    '',
    ...DESIGN_SECTIONS.flatMap((section) => [`## ${section}`, '', prose[section], '']),
  ].join('\n');
}

export function identityReference(light: readonly [string, string][]): string {
  const highlight = light.some(([k]) => k === '--brand-highlight');
  const roleOf = { display: 'titulares', body: 'cuerpo', both: 'titulares o cuerpo' } as const;
  return [
    '# Identidad sin marca',
    '',
    'Si `src/identity.css` no empieza con `/* brand-pack: … */` y está vacía, la página no tiene marca y la decides tú',
    'para ESTE negocio, antes de escribir secciones: un acento propio (no el naranja ni el gris del DS), un fondo y',
    'un texto con un matiz que acompañe al acento, y un par de fuentes de la lista de abajo. Escríbela una sola vez:',
    '',
    `- En \`:root, [data-theme]\`: ${REQUIRED_TOKENS.map((t) => `\`${t}\``).join(', ')} (obligatorios) y, si los cambias,`,
    '  `--background`, `--surface`, `--foreground`, `--text-secondary`, `--border`.',
    '- En `[data-theme="dark"]`: el valor oscuro de CADA token del bloque claro. Si falta, una zona oscura hereda el claro.',
    '- `--accent-foreground` sobre `--accent` y `--foreground` sobre `--background` con contraste de 4.5:1 o más, en los dos',
    '  bloques (el oscuro pinta el cierre inverse). Esos cuatro en hex o `rgb()`, y `--foreground` con `--background` siempre',
    '  juntos: así se miden. Si el CTA no llega, `typecheck` propone el tono del acento que sí llega.',
    ...(highlight ? ['- `--brand-highlight` solo si la marca tiene un segundo color de detalle; si no, no lo declares.'] : []),
    '- Quita `data-accent` del `<html>` de `index.html`: el preset del scaffold le gana a tu `--accent` en las zonas.',
    '- Solo tokens del contrato (las tablas de `colors.md` y `typography.md`) y solo esos dos selectores. Nada de `@import`, `@font-face`, `url()`,',
    '  gradientes ni otras reglas: las fuentes van por `<link>` en `index.html`.',
    '- La tool `typecheck` revisa la hoja ("Identidad: …"): corrige hasta que diga "declarada".',
    '- El resumen final la declara: acento, fondo y fuentes elegidos, y por qué.',
    '',
    '## Sin estética genérica',
    '',
    'Salvo que el brief lo pida, descarta lo que hace que una página parezca hecha por IA: Inter o Poppins como fuente de',
    'cuerpo, un acento índigo o violeta sobre fondo blanco, y un hero, navbar y footer intercambiables con los de cualquier',
    'plantilla. Elige una sola dirección visual para este negocio y sostenla en todas las secciones.',
    '',
    '```css',
    '/* identidad de <negocio>: <intención en una línea> */',
    ':root,',
    ...cssBlock('[data-theme] {', EXAMPLE_LIGHT),
    ...cssBlock('[data-theme="dark"] {', EXAMPLE_DARK),
    '```',
    '',
    `## ${DESIGN_FILE}: la identidad exportable`,
    '',
    `Justo después de \`src/identity.css\` (y antes del plan de página, si lo escribes), escribe \`${DESIGN_FILE}\` en la raíz`,
    'del workspace, en el formato abierto de google-labs-code/design.md (el de Stitch): frontmatter YAML con los tokens y',
    'prosa corta de intención. Describe la identidad que ya escribiste; no es otra fuente.',
    '',
    `- Frontmatter: \`name\`, \`colors\` con ${Object.entries(DESIGN_COLOR_ROLES).map(([r, { token, block }]) => `\`${r}\` = \`${token}\`${block === 'dark' ? ' oscuro' : ''}`).join(', ')}`,
    '  (cada valor copiado tal cual de identity.css; `surface` solo si lo declaraste) y `typography` con `display` y `body`:',
    '  `fontFamily` (la familia de `--font-display` / `--font-body`, sin "Variable") y `fontWeight` 400 o 500.',
    `- Prosa con estos encabezados y en este orden: ${DESIGN_SECTIONS.map((s) => `\`## ${s}\``).join(', ')}. Brand & Style en una`,
    '  frase; Colors dice dónde va el acento y dónde no, las superficies y el cierre inverse; Typography, el par, su uso y los pesos.',
    '- La prosa solo nombra colores que están en el frontmatter. La tool `typecheck` lo compara con identity.css en la línea',
    '  "Identidad:".',
    '- Con pack de marca (`/* brand-pack: … */`) no se escribe.',
    '',
    '```md',
    exampleDesignMd(),
    '```',
    '',
    '## Fuentes: lista cerrada',
    '',
    'Sin pack, `--font-display` y `--font-body` salen SOLO de esta lista (la tool `typecheck` rechaza cualquier otra).',
    'Elige por el carácter del negocio; un serif de titulares con un sans de cuerpo, o dos sans distintos.',
    '',
    '| Familia | Tipo | Uso | Cómo se carga |',
    '| --- | --- | --- | --- |',
    ...FONT_LIST.map((f) => `| ${f.family} | ${f.category} | ${roleOf[f.role]} | ${f.installed ? `instalada: \`'${f.family} Variable'\`` : 'link de Google Fonts'} |`),
    '',
    'Las de Google Fonts se enlazan en el `<head>` de `index.html`, un solo `<link>` con las dos familias:',
    '',
    '```html',
    '<link rel="preconnect" href="https://fonts.googleapis.com" />',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />',
    `<link rel="stylesheet" href="${googleFontsHref(['Fraunces', 'Manrope'])}" />`,
    '```',
    '',
    'Y en `src/identity.css` el stack con su genérico: `--font-display: \'Fraunces\', serif;`.',
  ].join('\n');
}

/** Las reglas que antes eran un pase sobre los ports (ADR 0009) quedan como reglas de escritura, cada una en el
 * fundamento de su tema, como en Carbon. */
export function foundationFiles(light: readonly [string, string][], dark: readonly [string, string][]): Record<string, string> {
  const t = tokensByFile(light);
  return {
    'colors.md': [
      '# Color',
      '',
      'Solo `var(--token)`: nunca hex, rgb ni oklch escritos a mano. La marca reemplaza estos valores en',
      '`src/identity.css` y la página se repinta sin tocar código.',
      '',
      '- Fondo de sección: `surface` de `Section` (base, muted, raised, inverse); nunca un `background` propio en la',
      '  sección. `--surface-muted` es el gris de los controles, no de las bandas: no sigue la identidad.',
      '- Texto: `--foreground`; `--text-secondary` para apoyo y `--text-muted` para notas.',
      '- Acción principal: `--accent` con `--accent-foreground` encima. Estados: `--success`, `--warning`, `--danger`.',
      '- Sombras: `--shadow-resting`, `--shadow-raised`, `--shadow-floating`. Sin gradientes ni glows decorativos.',
      '',
      ...table(t.colors),
    ].join('\n'),
    'typography.md': [
      '# Tipografía',
      '',
      '- Titulares con `--font-display`, `--leading-display` y `--tracking-display`; cuerpo con `--font-body`,',
      '  `--leading-body` y `--tracking-body`.',
      '- Tamaños solo de la escala `--text-*`. El titular de una sección, claramente más grande que su cuerpo; el del',
      '  hero, el más grande de la página.',
      '- Pesos regular y medium. Sentence case en títulos y botones, sin eyebrow labels ni em dashes.',
      '- Cada titular, entradilla y pieza de una sección lleva su clase propia en el `.module.css` de la sección, con estos',
      '  tokens (como Carbon pide `type-style` en el SCSS de cada sección). `Text` de `../components/layout.md` es para',
      '  texto corriente, no para la jerarquía de la sección.',
      '',
      ...table(t.typography),
    ].join('\n'),
    'spacing-layout.md': [
      '# Espacio y layout',
      '',
      'Padding, margin y gap solo con `--space-*`; radios con `--radius-*`. Nada de valores crudos.',
      '',
      '## Grilla',
      '',
      '- La estructura de página sale de las primitivas de `../components/layout.md`: `Section` (ancho, fondo, padding),',
      '  `Grid` (columnas por breakpoint), `Split` (dos columnas desde 1024 px), `Stack` y `Cluster` (ritmo vertical y',
      '  filas). No armes la grilla a mano con flex o grid; flex propio solo dentro de una pieza pequeña.',
      '- Cada sección es `Section`: da el contenedor centrado y su ancho (`content`; la FAQ, `narrow` sola por su `role`).',
      '  Tu CSS empieza en el primer nodo dentro de `Section`; nunca `max-width` ni `margin-inline` en ese contenedor.',
      '- Cabeceras de sección alineadas a la izquierda (texto y caja) dentro del contenedor, también la del cierre.',
      '- Columnas de una colección según el número de items: filas completas, como mucho 2 en tablet y 4 en escritorio;',
      '  con 3 items, 3 columnas, nunca 2+1.',
      '- Una tarjeta es para un item de una colección, no para envolver una sección entera.',
      '',
      ...table(t['spacing-layout']),
    ].join('\n'),
    'responsiveness.md': [
      '# Responsive',
      '',
      'Mobile-first. Puntos de quiebre del DS: 768 px y 1024 px, los mismos de `Grid` y `Split`.',
      '',
      '- `Grid cols={{ base: 1, md: 2, lg: 3 }}`: fija las columnas de cada breakpoint; a 375 px, una columna.',
      '- CSS propio con `@media (min-width: 768px)` y `@media (min-width: 1024px)`. Ningún otro breakpoint.',
      '- Sin anchos fijos en contenedores: el ancho lo da `Section`; `max-width` en rem solo para limitar una línea de texto.',
      '- Nada desborda en horizontal a 375 px; imágenes con `max-width: 100%` y `height: auto`.',
      '- Los grupos de botones envuelven en vez de encogerse.',
      '- Revisa a 375, 768 y 1440 px antes de dar por buena una sección.',
    ].join('\n'),
    'motion.md': [
      '# Motion',
      '',
      '- La página no anima entradas: nada de `whileInView`, `useInView` ni reveal al hacer scroll, y los props de',
      '  entrada de los componentes en `false` (`animateIn={false}`, `animateOnView={false}`).',
      '- Las micro-interacciones del componente (hover, press, acordeón, toggle) son del componente y se quedan.',
      '- Una transición propia usa estos tokens o los presets de `@/components/arc/motion-tokens`, siempre con rama de',
      '  `prefers-reduced-motion`.',
      '',
      ...table(t.motion),
    ].join('\n'),
    'theming.md': [
      '# Tema',
      '',
      '- La marca vive en `src/identity.css`. Si empieza con `/* brand-pack: … */` es la del pack: no la edites. Si está',
      '  vacía, la declaras tú una vez (ver `identity.md`). Los componentes y tu CSS leen los mismos tokens.',
      '- Zona oscura de sección: `<Section surface="inverse">`, que pone `data-theme="dark"`. Dentro de una pieza,',
      '  `data-theme="dark"` en su contenedor. Los tokens se resuelven por ancestro; no escribas colores para la zona. Hasta dos',
      '  zonas oscuras de sección por página y nunca seguidas: normalmente el cierre y una banda intermedia.',
      '- No inventes un sistema de modo oscuro paralelo.',
      '',
      '## Valores en `[data-theme="dark"]`',
      '',
      ...table(dark),
    ].join('\n'),
    'identity.md': identityReference(light),
  };
}

export function agentSkillMd(meta: { light: { background: string; foreground: string }; dark: { background: string; foreground: string } }): string {
  return [
    '---',
    'name: arc',
    'description: Design system Arc para landing pages (React + CSS modules sobre tokens semánticos). Úsalo para toda página de este workspace; es la única fuente de UI, por encima de Tailwind, shadcn/ui o componentes a mano.',
    'disable-model-invocation: true',
    'metadata:',
    '  v0.kind: design-system',
    '  v0.design-system:',
    '    appearance:',
    '      light:',
    `        background: "${meta.light.background}"`,
    `        foreground: "${meta.light.foreground}"`,
    '      dark:',
    `        background: "${meta.dark.background}"`,
    `        foreground: "${meta.dark.foreground}"`,
    '---',
    '',
    '# Arc',
    '',
    'Arc es la fuente de UI de esta página: componentes de `src/components/`, tokens de `src/components/arc/foundation.css`',
    'y CSS propio por sección sobre esos tokens.',
    '',
    '## El starter ya está montado',
    '',
    'No lo recrees ni lo dupliques:',
    '',
    '- `src/main.tsx`: monta `App` en `#root`.',
    '- `src/index.css`: fuentes, `foundation.css` (tokens claro y oscuro) e `identity.css`, más el fondo y el color base.',
    '- `src/identity.css`: tokens de la marca. Con cabecera `/* brand-pack: … */` no se edita; vacía, la declaras tú (regla 10).',
    '- `src/components/`: el DS, con el alias `@/` = `src/`. No se edita.',
    '- `src/App.tsx`: vacío; aquí se monta la página, cada sección dentro de `<WtSection slug>` de `@/wt-section`.',
    '',
    'Para construir: un archivo por sección con su `.module.css` al lado, componentes importados de `@/components/...`',
    'e iconos de `references/assets/icons.md`.',
    '',
    '## Reglas de siempre',
    '',
    '1. **Componentes**: el import exacto de su referencia. Empieza en `references/components/index.md`. Si la tabla',
    '   tiene un componente para lo que vas a pintar, se importa: nunca un equivalente a mano en `src/sections`. Un chat',
    '   o mockup de WhatsApp es `ChatThread` de `@/components/arc/chat-thread/chat-thread` dentro de un contenedor con',
    '   `data-skin="whatsapp"`, que le pone los colores reales de WhatsApp; nunca divs, hex ni tokens `--wa-*` propios.',
    '   Una grilla de cards que se repiten (más de 2: beneficios, casos, reseñas, planes, equipo) es `Grid` con',
    '   `carousel="<nombre de la lista>"`: en escritorio queda en grilla y en móvil pasa a `Carousel`. Nunca un carrusel ni',
    '   un `overflow-x` escritos a mano.',
    '   Una persona sin foto real (reseña, equipo, testimonio, participante de un chat) lleva el avatar generativo con',
    '   su nombre como semilla, siempre el mismo para la misma persona: `<SeedAvatar name="Ana Ruiz" size={48} circle />`',
    '   con `import { Avatar as SeedAvatar } from "@usespaceui/avatars/react"`. Donde la prop pide una URL (`avatar` de',
    '   un bloque, `participants` de `ChatThread`), `seedAvatarSrc("Ana Ruiz")` de `@/lib/seed-avatar`. Nunca iniciales,',
    '   fotos de stock ni `src` inventados.',
    '   Un emoji con dibujo (en un chat, una reseña o un detalle) es `<Emoji emoji="🎉" fallback size={20} />` de',
    '   `@usespaceui/emoji/react`: uno o dos por sección como mucho, solo si suma al mensaje, y nunca en titulares ni',
    '   botones. Sin `format="lottie"`: carga lottie-web. Las imágenes salen de un CDN, así que `fallback` va siempre.',
    '2. **Iconos**: solo los de `references/assets/icons.md`, por nombre exacto.',
    '3. **Color**: solo `var(--token)`. Ver `references/foundations/colors.md`.',
    '4. **Espacio y tipo**: solo `--space-*`, `--radius-*` y la escala `--text-*`. Ver',
    '   `references/foundations/typography.md` y `references/foundations/spacing-layout.md`.',
    '5. **Layout y responsive**: primitivas de `references/components/layout.md` y `@media` a 768 y 1024 px. Lee',
    '   `references/foundations/responsiveness.md` antes de maquetar.',
    '6. **Tema**: la zona oscura de una sección es `Section surface="inverse"`. Ver `references/foundations/theming.md`.',
    '7. **Estilo de sección**: cada sección tiene su `.module.css` con clases BEM propias (`hero`, `hero__title`,',
    '   `hero__media`) sobre tokens: titulares, escala, ritmo, media y sus `@media`. Las primitivas solo dan la grilla;',
    '   la dirección de arte de la sección la escribes tú, para este negocio. Patrón en `references/examples/page-layout.md`.',
    '   Si el rol tiene bloque en "Secciones de landing" (`references/components/index.md`), no escribes esa sección: importas',
    '   el bloque en `<Section id role slug bare>` y le pasas el contenido del brief por props.',
    '8. **Enlaces**: un botón con destino (ancla, `wa.me`, `mailto:`) es `Action` de `@/components/relume/action`',
    '   con `href`, que pinta un `<a>` con las clases de `Button`. Nunca `window.open` en un `onClick`.',
    '   Si el `href` es `wa.me`, el botón lleva `variant="whatsapp"` (el verde de WhatsApp del contrato); cualquier otro',
    '   destino va con la variante por defecto, el interactivo de la marca. `Action` y las acciones de los bloques ya',
    '   lo derivan del `href`: una acción de bloque con `href` a `wa.me` pinta el botón de WhatsApp, así que esta regla',
    '   nunca es motivo para reescribir un bloque a mano. Una sola acción principal por sección (en precios, una por plan).',
    '   Todo botón a `wa.me` lleva `cta` con su intención: `agendar_demo`, `hablar_asesor`, `demo_5min` o',
    '   `consultar_precio` (en `Action` y en las acciones de bloque). Es el tracking de Atom: el mensaje va en el `?text=`',
    '   del `href`, y `Action` pone los atributos del SDK. Nunca escribas `data-atom-button` ni el script del SDK a mano.',
    '   La tabla comparativa de precios (`featureGroups` de PricingTable) va solo si el brief pide comparar planes; si no,',
    '   cada plan lleva su lista en `features` y la tabla no se pinta.',
    '9. **Motion**: sin animaciones de entrada. Ver `references/foundations/motion.md`.',
    '10. **Identidad sin marca**: si `src/identity.css` está vacío, decide y declara la marca antes de escribir. Ver',
    '   `references/foundations/identity.md`.',
    '11. **Foco y detalle**: antes de escribir una sección, decide su elemento focal (un mockup, una cifra grande, una foto,',
    '   la tabla de planes) y al menos un detalle de soporte junto a él: micro-texto bajo el botón, un badge de estado',
    '   dentro del mockup, nombre, cargo y empresa en un testimonio, una prueba social con su dato. El detalle va junto al',
    '   foco o debajo del titular, nunca encima del titular (eso es eyebrow). Una sección con solo titular y lista no basta.',
    '   Si escribes `page-plan.md`, el foco y el detalle de cada sección son sus campos `focal:` y `detalle:`, y la sección',
    '   los cumple tal cual. La FAQ también: su foco es el acordeón y su detalle una nota en letra chica de texto plano',
    '   debajo (p. ej. el tiempo de respuesta), no un enlace. Solo navbar y footer van sin foco ni detalle.',
    '   Las cifras que inventes se ajustan al sector y nunca son las de plantilla (38 %, 42 s, 3x, $49, $149, $249); si',
    '   `references/direction.md` trae "Cifras guía", parte de ellas.',
    '12. **Imágenes**: cuando el prompt dice que tienes la tool `generate_image`, cada imagen se genera con ella antes de',
    '   escribir la sección y va en `Image` de `@/components/layout/layout` con el `src` que devuelve la tool y un `alt`',
    '   corto para lectores de pantalla. Sin la tool no hay imágenes generadas: esa sección muestra el producto en código.',
    '',
    '## Orden de lectura',
    '',
    'Antes de escribir código, en este orden y sin saltarte pasos:',
    '',
    '1. **Panorama**: `references/components/index.md` (qué hay y en qué archivo) y `references/examples/page-layout.md`.',
    '2. **Fundamentos**: todos los archivos de `references/foundations/` (color, tipo, espacio, responsive, tema, motion,',
    '   identidad).',
    '3. **Dirección**: si existe `references/direction.md`, léelo. Fija la forma, el focal y la superficie de cada',
    '   sección; el plan la sigue. Si la fila trae Bloque, lo importas; si no, haz Read de la ruta de su fila (columna',
    '   Referencia de layout) antes de escribir esa sección.',
    '4. **Plan**: lista los componentes que vas a usar en cada sección, con `index.md` como inventario. Solo esos.',
    '5. **Cada componente, antes de usarlo**: su entrada en el archivo de su categoría y su código (la ruta `Código:`).',
    '   Confirma ahí el nombre del export y las props que vas a pasar. No leas componentes que no vas a usar.',
    '6. **Ejemplos por rol** si te sirven: `references/examples/<rol>.md` (secciones ya resueltas, para leer). Con',
    '   dirección, el bloque de referencia de cada sección va antes que el ejemplo.',
    '',
    'Si el typecheck marca un import o una prop, vuelve al código del componente: es la fuente de verdad, nunca adivines.',
    '',
    '## Reglas duras',
    '',
    '- Nunca inventes componentes, props, variantes, tokens ni iconos. Un import o una prop que no viste en el código del',
    '  componente (paso 4 del orden de lectura) no se usa.',
    '- Nunca edites `src/components/` ni restiles sus internos: si un componente no hace lo que necesitas, escribe el',
    '  marcado en tu sección.',
    '- Nunca mezcles otra librería de componentes ni CSS utilitario (Tailwind).',
    '- `references/` es documentación: nunca importes nada desde la carpeta del skill.',
    '- Cada sección es `<Section id role slug>` de `@/components/layout/layout`: nunca un `<section>` propio ni un',
    '  contenedor con `max-width` o `margin-inline`. El centrado y el ancho son del contrato.',
    '- Sin eyebrow: nada encima del titular de una sección, ni texto pequeño ni `Badge` o pill ("Agentes de IA para',
    '  ventas"). El titular abre la sección.',
    '',
    '## Revisión final',
    '',
    '- La página se lee en el tema claro y en su zona oscura: texto y controles con tokens, no con literales.',
    '- El layout aguanta a 375, 768 y 1440 px: una columna a 375 y sin desborde horizontal.',
    '- Todo lo interactivo sale de componentes del DS, con label o `aria-label` donde el componente lo pide.',
    '- Cada sección tiene su elemento focal y su detalle de soporte (regla 11).',
    '- Todo botón que va a `wa.me` lleva `variant="whatsapp"`; ninguno más (regla 8).',
    '- Ningún componente propio en `src/sections` repite uno de la tabla del índice; un chat es `ChatThread` (regla 1).',
    '- Toda grilla de más de 2 cards repetidas lleva `carousel` en su `Grid` (regla 1).',
    '- Toda persona sin foto real tiene su avatar generativo con su nombre; ninguna lleva iniciales (regla 1).',
    '- Cada `Image` generada usa el `src` que devolvió `generate_image` y lleva `alt` corto (regla 12).',
    '- Sentence case, pesos regular y medium, sin eyebrow, sin gradientes ni glows.',
    '- Después del build, relee el copy de todas las secciones juntas: ningún titular, frase, cifra ni etiqueta se repite',
    '  entre secciones. Si algo se repite, reescríbelo en la sección donde pesa menos.',
  ].join('\n');
}

/** Como `references/assets/icons.md` de Carbon: uso en prosa más los nombres de los sets propios, que no se descubren
 * de otra forma. Un nombre de lucide-react mal escrito lo atrapa el type-check, así que de lucide va solo la paleta. */
export function agentIconsReference(lib: IconLibrary, palette: readonly string[] = []): string {
  const own = lib.sets.filter((s) => s.id !== 'lucide');
  const lucide = lib.sets.find((s) => s.id === 'lucide');
  return [
    '# Iconos',
    '',
    '## Uso',
    '',
    '```tsx',
    'import { ZapIcon } from "@/components/interface-essentials";',
    '',
    '<ZapIcon aria-hidden="true" />',
    '```',
    '',
    '- Va donde el componente acepta JSX. El color sale de `currentColor`: se fija con tokens de texto en el padre.',
    '- Decorativo junto a texto: `aria-hidden="true"`. Solo y con significado: `aria-label`.',
    '- Nunca pegues a mano el SVG de un icono que existe aquí.',
    '',
    '## Logos',
    '',
    'Si el contexto trae un logo real (archivo en `public/`), úsalo con `<img>` y su alt. Si no, un wordmark de texto con',
    'el nombre del negocio. Nunca dibujes un logo.',
    ...own.flatMap((s) => ['', `## ${s.title} (${s.names.length})`, '', `Import desde \`${s.importPath}\`.`, '', s.names.join(' ')]),
    ...(lucide
      ? ['', `## ${lucide.title}`, '', `Import desde \`${lucide.importPath}\` por su nombre exportado. Prefiere los sets de arriba.`, ...(palette.length ? ['', `Paleta recomendada: ${palette.join(' ')}`] : [])]
      : []),
  ].join('\n');
}
