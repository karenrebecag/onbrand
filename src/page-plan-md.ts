// Parser de `page-plan.md`, el plan de página que el agente escribe antes de las secciones (spec plan-de-pagina-artefacto,
// ADR 0012). Lo comparten el composer (agent.plan en page.json), QA (sensores plan.*) y el builder (panel). Formato por
// línea a propósito: una entrada `## NN-<rol> · #ancla` y campos `- clave: valor`; nada que necesite un parser de markdown.
import { roleOfSlug } from './section-slug';

export const PLAN_FILE = 'page-plan.md';
export const PLAN_FIELDS = ['titular', 'apoyo', 'cta', 'conteo', 'focal', 'detalle', 'superficie', 'inventado'] as const;
// La forma la pide la dirección (catálogo de direcciones, spec §5): sin dirección el plan no la lleva.
export const OPTIONAL_FIELDS = ['forma'] as const;
export type PlanField = (typeof PLAN_FIELDS)[number] | (typeof OPTIONAL_FIELDS)[number];

export interface PlanSection {
  /** `NN-<rol>`, el slug de `Section`. */
  slug: string;
  role: string;
  /** Ancla sin `#`, si la entrada la trae. */
  anchor?: string;
  fields: Partial<Record<PlanField, string>>;
}

export interface PagePlanMd {
  /** Líneas de la cabecera (negocio, acción principal, idioma) tal cual, antes de la primera entrada. */
  header: string[];
  /** `direccion: <id>` de la cabecera, si la página sigue una dirección del catálogo. */
  direction?: string;
  sections: PlanSection[];
}

const ENTRY_RE = /^##\s+(\d{2}-([a-z0-9-]+))(?:\s*[·|:-]\s*#?([^\s#]+))?\s*$/i;
const DIRECTION_RE = /^direcci[oó]n\s*:\s*`?([a-z0-9-]+)`?\s*$/i;
const FIELD_RE = /^\s*[-*]\s*([a-záéíóú]+)\s*:\s*(.*?)\s*$/i;

/** Parsea el texto del plan. Tolerante: ignora lo que no es entrada ni campo; un campo repetido se queda con el último. */
export function parsePagePlanMd(text: string): PagePlanMd {
  const header: string[] = [];
  const sections: PlanSection[] = [];
  let current: PlanSection | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const entry = ENTRY_RE.exec(raw);
    if (entry) {
      current = { slug: entry[1]!.toLowerCase(), role: roleOfSlug(entry[1]!.toLowerCase()), ...(entry[3] ? { anchor: entry[3] } : {}), fields: {} };
      sections.push(current);
      continue;
    }
    const field = FIELD_RE.exec(raw);
    if (current && field) {
      const key = field[1]!.toLowerCase() as PlanField;
      if ([...PLAN_FIELDS, ...OPTIONAL_FIELDS].includes(key)) current.fields[key] = field[2]!.replace(/\*\*|`/g, '').trim();
      continue;
    }
    // La cabecera se limpia como los campos: 999ea0e0 la escribió con viñetas y backticks y así llegó al panel.
    if (!current && raw.trim() && !raw.startsWith('#')) header.push(raw.trim().replace(/^[-*]\s+/, '').replace(/\*\*|`/g, '').trim());
  }
  const direction = header.map((h) => DIRECTION_RE.exec(h)?.[1]).find(Boolean)?.toLowerCase();
  return { header, sections, ...(direction ? { direction } : {}) };
}

/** `conteo: 4 tarjetas` → 4; sin número (o `ninguno`) → undefined. */
export const planCount = (s: PlanSection): number | undefined => {
  const m = /^(\d+)\b/.exec(s.fields.conteo ?? '');
  return m ? Number(m[1]) : undefined;
};

/** Lista del campo `inventado` de todas las secciones, con su slug; `nada` y vacío no cuentan. */
export const planInvented = (plan: PagePlanMd): { slug: string; text: string }[] =>
  plan.sections.flatMap((s) => {
    const v = s.fields.inventado?.trim() ?? '';
    return v && !/^(nada|ninguno|none)\.?$/i.test(v) ? [{ slug: s.slug, text: v }] : [];
  });

/** Campos que faltan en una entrada. Navbar, footer y FAQ pueden no llevar focal ni detalle (Arq, ronda Stitch);
 * en una sección de contenido `focal: ninguno` es defecto. */
// El rol sale en el idioma de la página: la FAQ de una página en español es `07-preguntas` (QA 97fd95dc).
export const optionalFocal = (s: PlanSection): boolean => /^(navbar|header|footer|faqs?|preguntas(-frecuentes)?|perguntas)$/.test(s.role);

export function planDefects(plan: PagePlanMd): { slug: string; message: string }[] {
  const out: { slug: string; message: string }[] = [];
  for (const s of plan.sections) {
    const optional = optionalFocal(s);
    for (const f of PLAN_FIELDS) {
      if ((f === 'focal' || f === 'detalle') && optional) continue;
      if (!s.fields[f]) out.push({ slug: s.slug, message: `falta ${f}` });
    }
    if (!optional && /^(ninguno|none)\.?$/i.test(s.fields.focal ?? '')) out.push({ slug: s.slug, message: 'focal no admite ninguno en una sección de contenido' });
  }
  return out;
}
