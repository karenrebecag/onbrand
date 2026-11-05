import type { CSSProperties, ReactNode } from 'react';
import './layout.css';

type Space = 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
type Align = 'start' | 'center' | 'end' | 'stretch';
type Responsive<T> = T | { base: T; md?: T; lg?: T };

const SPACE: Record<Space, string> = {
  none: '0',
  xs: 'var(--space-2)',
  sm: 'var(--space-3)',
  md: 'var(--space-4)',
  lg: 'var(--space-6)',
  xl: 'var(--space-10)',
  '2xl': 'var(--space-16)',
};
const ALIGN: Record<Align, string> = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' };
const WIDTH = { prose: '42rem', narrow: '48rem', content: '72rem', wide: '80rem', full: 'none' } as const;
type Surface = 'base' | 'muted' | 'raised' | 'inverse';
// Lovable, Stitch y v0 coinciden: un contenedor centrado por sección y solo la FAQ más angosta (RE 2026-10-27).
const ROLE_WIDTH: Partial<Record<string, keyof typeof WIDTH>> = { faq: 'narrow' };
const PAD = { none: '0', sm: 'var(--space-8)', md: 'var(--space-12)', lg: 'var(--space-20)' } as const;
const RATIO = { '1:1': '1fr 1fr', '1:2': '1fr 2fr', '2:1': '2fr 1fr' } as const;

// Custom properties en vez de clases por valor: el CSS queda fijo y el token lo resuelve el tema.
// Cada primitiva fija SIEMPRE todas sus variables (con su default): las custom properties se heredan,
// y sin esto el align="center" de un Stack exterior centraba el contenido de las cards anidadas.
const vars = (o: Record<string, string | number>): CSSProperties => o as CSSProperties;

// muted y raised son la banda del contrato (data-wt-surface en theme/tokens.css), no --surface-muted: ese es un gris
// neutro fijo de controles que no sigue la identidad, y con una marca propia la banda quedaba igual a la página
// (live6). El atributo remapea --background en la sección, así que el fondo es siempre var(--background).
// inverse es la zona oscura del cierre: data-theme="dark" resuelve los tokens y el atributo la deja medible.
// id, role y slug son los del contrato de página (anclas y sensores): sin ellos el agente escribía un <section> crudo
// con su propio contenedor, y su margin-inline pisaba el centrado en el mismo nodo (demo cc7b8016, cierre pegado al borde).
// backdrop es la media a sangre (full-bleed): va detrás de toda la sección y el texto sigue en el contenedor. Sin esto
// el agente metía la foto en una tarjeta dentro del contenedor con su propio padding, y el texto del cierre arrancaba
// 64 px más adentro que el resto de la página (gen fac2bce5, section.gutter).
// bare monta un bloque de sección (índice, "Secciones de landing") que trae su propio <section> y contenedor: solo pone
// el ancla, los atributos del contrato y el tema, sin otro contenedor ni padding que se sumen a los del bloque.
export function Section(p: { id?: string; role?: string; slug?: string; width?: keyof typeof WIDTH; surface?: Surface; padding?: keyof typeof PAD; backdrop?: ReactNode; bare?: boolean; children: ReactNode }) {
  const band = p.surface && p.surface !== 'base' ? p.surface : undefined;
  const width = p.width ?? ROLE_WIDTH[p.role ?? ''] ?? 'content';
  if (p.bare) {
    return (
      <div id={p.id} className="l-bare" data-wt-role={p.role} data-wt-slug={p.slug} data-wt-surface={band} data-theme={p.surface === 'inverse' ? 'dark' : undefined}>
        {p.children}
      </div>
    );
  }
  return (
    <section
      id={p.id}
      className={p.backdrop ? 'l-section l-section--backdrop' : 'l-section'}
      data-wt-role={p.role}
      data-wt-slug={p.slug}
      data-wt-surface={band}
      data-theme={p.surface === 'inverse' ? 'dark' : undefined}
      style={vars({ '--l-surface': p.surface ? 'var(--background)' : 'transparent', '--l-pad': PAD[p.padding ?? 'lg'] })}
    >
      {p.backdrop ? <div className="l-backdrop">{p.backdrop}</div> : null}
      <div className="l-container" style={vars({ '--l-width': WIDTH[width] })}>{p.children}</div>
    </section>
  );
}

export function Stack(p: { gap?: Space; align?: Align; children: ReactNode }) {
  return <div className="l-stack" style={vars({ '--l-gap': SPACE[p.gap ?? 'md'], '--l-align': ALIGN[p.align ?? 'stretch'] })}>{p.children}</div>;
}

// Sin modo carrusel: el carrusel móvil de una grilla es de un DS con motion (B9 §2.2); aquí la grilla apila por columnas.
export function Grid(p: { cols: Responsive<number>; gap?: Space; align?: Align; children: ReactNode }) {
  const c = typeof p.cols === 'number' ? { base: p.cols } : p.cols;
  return (
    <div className="l-grid" style={vars({ '--l-cols': c.base, '--l-cols-md': c.md ?? c.base, '--l-cols-lg': c.lg ?? c.md ?? c.base, '--l-gap': SPACE[p.gap ?? 'lg'], '--l-align': ALIGN[p.align ?? 'stretch'] })}>
      {p.children}
    </div>
  );
}

export function Cluster(p: { gap?: Space; justify?: 'start' | 'center' | 'end' | 'between'; align?: Align; children: ReactNode }) {
  const justify = p.justify === 'between' ? 'space-between' : ALIGN[p.justify ?? 'start'];
  return <div className="l-cluster" style={vars({ '--l-gap': SPACE[p.gap ?? 'sm'], '--l-justify': justify, '--l-align': ALIGN[p.align ?? 'center'] })}>{p.children}</div>;
}

export function Split(p: { ratio?: keyof typeof RATIO; gap?: Space; align?: Align; children: ReactNode }) {
  return <div className="l-split" style={vars({ '--l-ratio': RATIO[p.ratio ?? '1:1'], '--l-gap': SPACE[p.gap ?? 'xl'], '--l-align': ALIGN[p.align ?? 'center'] })}>{p.children}</div>;
}

const TAG = { display: 'h1', title: 'h2', subtitle: 'p', body: 'p', caption: 'p' } as const;

export function Text(p: { role: keyof typeof TAG; align?: 'start' | 'center'; children: ReactNode }) {
  const Tag = TAG[p.role];
  return <Tag className={`l-text l-text--${p.role}`} style={vars({ '--l-text-align': p.align ?? 'start' })}>{p.children}</Tag>;
}

// La imagen de producto del paso de imagen: marco por token (radio, borde, sombra) para que se lea como
// captura de producto y el brandpack la repinte; width/height reservan el espacio y evitan el salto.
// data-alt es el prompt del slot (como Stitch): lo lee el paso de imagen, y el alt queda corto para lectores de pantalla.
export function Image(p: { src: string; alt: string; 'data-alt'?: string; width?: number; height?: number }) {
  return <img className="l-image" src={p.src} alt={p.alt} data-alt={p['data-alt']} width={p.width} height={p.height} loading="eager" decoding="async" />;
}
