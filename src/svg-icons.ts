// SVG del vault → componente React (scripts/svg-to-icons.ts). Puro para poder probarlo: el script solo hace el IO.

export interface Svg { viewBox: string; inner: string; rootAttrs: Record<string, string> }

// Atributos de presentación del <svg> raíz que heredan los hijos. Sin `fill="none"` del raíz, un icono de trazo pinta
// sus formas cerradas rellenas: el reloj y el globo de interface-essentials salían como círculos negros (QA c9c5a540).
const INHERITED = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin'] as const;

/** Extrae viewBox, inner y los atributos heredables de un SVG, descartando el prólogo XML y la etiqueta <svg> externa. */
export function parseSvg(raw: string): Svg {
  const open = /<svg\b([^>]*)>/i.exec(raw);
  const attrs = open?.[1] ?? '';
  const viewBox = /viewBox="([^"]+)"/i.exec(attrs)?.[1] ?? '0 0 24 24';
  const rootAttrs = Object.fromEntries(INHERITED.flatMap((a) => {
    const m = new RegExp(`\\s${a}="([^"]*)"`, 'i').exec(attrs);
    return m ? [[a, m[1]]] : [];
  }));
  const inner = raw
    .replace(/<\?xml[\s\S]*?\?>/i, '')
    .replace(/<svg\b[^>]*>/i, '')
    .replace(/<\/svg>\s*$/i, '')
    .trim();
  return { viewBox, inner, rootAttrs };
}

// Un icono de interfaz es de un color: el negro del vault pasa a currentColor para seguir al texto y a la zona oscura.
// Los logos y badges conservan sus colores de marca.
const BLACK = /(fill|stroke)="(?:black|#000|#000000)"/gi;
export const monochrome = (svg: Svg): Svg => ({
  ...svg,
  inner: svg.inner.replace(BLACK, '$1="currentColor"'),
  rootAttrs: Object.fromEntries(Object.entries(svg.rootAttrs).map(([k, v]) => [k, /^(black|#000|#000000)$/i.test(v) ? 'currentColor' : v])),
});

const jsxName = (attr: string): string => attr.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

export function component(name: string, svg: Svg): string {
  const root = Object.entries(svg.rootAttrs).map(([k, v]) => ` ${jsxName(k)}="${v}"`).join('');
  return `export const ${name} = (props: ComponentPropsWithoutRef<'svg'>) => (\n` +
    `  <svg viewBox="${svg.viewBox}"${root} width="1em" height="1em" aria-hidden {...props} dangerouslySetInnerHTML={{ __html: ${JSON.stringify(svg.inner)} }} />\n);\n`;
}
