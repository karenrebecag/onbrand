// Modelo del core de finding. Deliberadamente agnóstico de la librería: un Candidate lleva lo que
// el ADAPTADOR ya tradujo a vocabulario del core (superficie por tema + geometría), nunca el
// vocabulario crudo de Relume o Arc. El core no llama al MCP; recibe candidatos y decide. Así es
// puro y testeable. (Brief cohesion-superficie-agnostica, APROBADO 2026-10-15.)

/** Rol de contenido. Un strip = una sección full-width de contenido. */
export type SectionRole =
  | 'hero'
  | 'features'
  | 'steps'
  | 'cta'
  | 'testimonials'
  | 'pricing'
  | 'faq'
  | 'logos'
  | 'stats';

/** Rol de marco (chrome): componentes que envuelven la página, no cuentan como strips.
 * banner (arriba, opcional) → navbar (arriba) → [strips] → footer (abajo). */
export type FrameRole = 'navbar' | 'footer' | 'banner';

export type Role = SectionRole | FrameRole;

/** Tono pedido por el brief: 'clean' prioriza claridad (superficie base);
 * 'bold' premia superficies pesadas (dark/media). Solo pesa la superficie, no la geometría. */
export type Tone = 'clean' | 'bold';

export interface Brief {
  summary: string;
  goal?: string;
  tone?: Tone;
  /** Si viene, fija los roles (se recorta a maxStrips). Si no, se infieren del summary/goal. */
  sections?: SectionRole[];
  /** Tope de strips de CONTENIDO (el marco no cuenta). Default 3; una landing completa sube esto. */
  maxStrips?: number;
  /** Brand pack activo (ruta a un directorio brand-pack); su bloque `composition` sesga la composición de
   * forma determinista. Ausente = sin sesgo de marca (se usa WT_BRAND_PACK o el base). */
  brand?: string;
  /** Tema con el que se emite el `data-theme` del <html>. Default `light`. */
  theme?: 'light' | 'dark';
  /** Marcas reales que el cliente autoriza mostrar. Sin ellas no hay fila de logos: el pipeline no
   * inventa clientes. */
  brands?: string[];
  /** Organismos propless (sin copy, demo horneado) que el brief pide como showcase del inner de un
   * layout. Sin nombrarlos no entran: su contenido demo no es del cliente. */
  showcases?: string[];
}

/** Lo que el core necesita de cada rol para buscar y rankear. */
export interface RoleSpec {
  role: Role;
  category: string; // slug de categoría del MCP Relume
  desiredTags: string[];
  /** Tags que CONTRADICEN la intención del rol (p.ej. "Form" en un CTA que debe agendar/contactar).
   * Cada uno presente resta: la intención importa, no solo el parecido estructural. */
  undesiredTags?: string[];
  /** Sesgo de marca (ADR 0003): si viene, solo candidatos de estas categorías son elegibles para el
   * rol; si el filtro deja el pool vacío, el rol se omite (no se inventa). Entra por specFor. */
  allowedCategories?: string[];
}

/** Intensidad de superficie de un strip RELATIVA al fondo de página, vocabulario cerrado del core:
 * base = el mismo fondo de la página; tinted = tinte/gradiente sutil; dark = fondo oscuro de
 * sección; media = imagen o vídeo de fondo. `accent` (sección de color saturado) queda pospuesto
 * hasta que una librería lo traiga. */
export type Surface = 'base' | 'tinted' | 'dark' | 'media';

export type Theme = 'light' | 'dark';

/** La superficie cambia con el tema (los tokens de Arc tienen valor claro y oscuro), así que se
 * clasifica por tema y la cohesión se evalúa en ambos. */
export type SurfaceByTheme = Record<Theme, Surface>;

/** Perfil de ritmo que declara cada librería: banded = alterna banda/claro y exige contraste
 * (Relume); quiet = casi todo neutro, como mucho un backdrop, no repite geometría entre vecinas
 * (Arc); neutral = sin requisito de banda, el default cuando un adaptador no declara. */
export const RHYTHM_PROFILES = ['banded', 'quiet', 'neutral'] as const;
export type RhythmProfile = (typeof RHYTHM_PROFILES)[number];

/** Un candidato ya traducido por su adaptador. */
export interface Candidate {
  slug: string;
  name: string;
  category: string;
  /** Librería de origen y tipo de item: el core los usa para la regla "Arc es la unidad"
   * (organism-first): se prefiere un organismo Arc o un shell que lo envuelva; un bloque Relume
   * plano solo es fallback. Opcionales para no romper candidatos de test hechos a mano. El catálogo admite las cuatro
   * librerías (Library): el adaptador Arc las copia tal cual y las reglas solo comparan con 'arc'. */
  library?: 'arc' | 'relume' | 'morphin' | 'bencho';
  kind?: 'block' | 'component' | 'layout';
  tags: string[];
  surface: SurfaceByTheme;
  /** Geometría del layout en el vocabulario del adaptador (bento, split, centered, off_grid...).
   * El core solo la compara por igualdad: variedad entre strips y repetición entre vecinas. */
  geometry: string;
  /** Preview renderizado real del componente (gif/png del CDN de Relume), si el MCP lo trae. */
  preview?: string;
  /** Señales semánticas del manifiesto (keywords + whenToUse), para el eje semántico del ranking.
   * Ausentes si el adaptador no las llevó: entonces el candidato se ordena solo por el scorer base. */
  keywords?: string[];
  whenToUse?: string[];
}

export interface Scored {
  candidate: Candidate;
  score: number;
  reasons: string[];
}

export interface Selection {
  role: Role;
  pick: Candidate;
  score: number;
  reasons: string[];
  alternates: Candidate[];
}
