// Lo inventado de una página frente a lo que el mensaje declara (S11). El bench lo cruza contra la página medida
// (content-sensors factsDisclosed); cada corrida con agente lo cruza contra el `inventado:` de page-plan.md, que es lo
// que hay sin navegador. Sin dependencias: lo importan el composer y los sensores.

export type InventedClass = 'figures' | 'people' | 'prices' | 'links' | 'credentials';

// Lo que el resumen tiene que decir: que algo es inventado y de qué clase. es/en/pt.
// "Ilustrativo" y "de muestra" (Figma Make: "Los casos y precios son contenido ilustrativo") dicen lo mismo.
const DISCLOSE = /inventad|fictici|fictíci|placeholder|de ejemplo|ilustrativ|de muestra|invented|made[- ]up|fictional|illustrative|sample/i;
export const CLASS_WORDS: Record<InventedClass, RegExp> = {
  // Un caso de éxito son sus cifras y sus personas: declarar "los casos" cubre las dos clases.
  figures: /cifra|estad[ií]stic|m[eé]tric|n[uú]mero|caso|stat|number|figure|metric|case|dado/i,
  people: /nombre|persona|cliente|testimoni|cita|caso|name|quote|customer|people|case|depoiment|pessoa/i,
  prices: /precio|price|preç|plan/i,
  links: /enlace|link|bot[oó]n|button|whatsapp|correo|email|destino/i,
  credentials: /certific|credencial|sello|badge|insignia|rating|reseñ|review|partner|auditor|\bG2\b|\bISO\b|\bSLA\b|garant/i,
};

const HEADING = /^\s*(#{1,6}\s|\*\*\d+[.)]|\d+[.)]\s)/;

/** Lo que el mensaje declara inventado: cada frase que lo dice, y el bloque que esa declaración abre. Un título ("Datos
 * de ejemplo" del agente) abre hasta el siguiente título; una frase que termina en dos puntos ("Inventé algunos
 * datos…, así que necesito los reales:" de Lovable) abre hasta la siguiente línea en blanco. */
export function disclosed(message: string): string[] {
  const out: string[] = [];
  let block: 'heading' | 'colon' | null = null;
  for (const line of message.split('\n')) {
    if (HEADING.test(line)) block = DISCLOSE.test(line) ? 'heading' : null;
    else if (block === 'colon' && !line.trim()) block = null;
    else if (!block && DISCLOSE.test(line) && line.trim().endsWith(':')) block = 'colon';
    if (block || DISCLOSE.test(line)) out.push(line);
  }
  return out;
}

export interface FactsDisclosure {
  /** El `inventado:` de cada sección del plan. */
  invented: { slug: string; text: string }[];
  /** El resumen dice que algo es de ejemplo (título "Datos de ejemplo" o una frase que lo declara). */
  declared: boolean;
  /** Clases que ese inventado nombra y el resumen no declara. */
  undisclosed: InventedClass[];
}

/** El cruce por corrida: lo que el plan dice que inventó contra el resumen. Sin nada inventado no hay nada que declarar. */
export function planDisclosure(invented: readonly { slug: string; text: string }[], message: string): FactsDisclosure | undefined {
  if (!invented.length) return undefined;
  const classes = (Object.keys(CLASS_WORDS) as InventedClass[]).filter((c) => invented.some((i) => CLASS_WORDS[c].test(i.text)));
  const said = disclosed(message).join(' ');
  return { invented: [...invented], declared: Boolean(said), undisclosed: classes.filter((c) => !CLASS_WORDS[c].test(said)) };
}

const REAL_DATA: Record<'es' | 'en' | 'pt', { title: string; message: (what: string) => string }> = {
  es: { title: 'Usar mis datos reales', message: (what) => `Reemplaza los datos de ejemplo (${what}) con mi información real: [tus datos].` },
  en: { title: 'Use my real data', message: (what) => `Replace the sample data (${what}) with my real information: [your data].` },
  pt: { title: 'Usar meus dados reais', message: (what) => `Substitua os dados de exemplo (${what}) pelas minhas informações reais: [seus dados].` },
};

/** El chip de Lovable para lo inventado ("Actualizar los datos reales", s3-sugerencias §1): nombra lo que hay que
 * reemplazar y deja el hueco entre corchetes, como pide la regla de suggest.ts. */
export function realDataSuggestion(invented: readonly { text: string }[], lang: string): { title: string; message: string } | undefined {
  if (!invented.length) return undefined;
  const t = REAL_DATA[lang === 'en' || lang === 'pt' ? lang : 'es'];
  const what = [...new Set(invented.map((i) => i.text.replace(/[.;]+$/, '').trim()))].join('; ').slice(0, 240);
  return { title: t.title, message: t.message(what) };
}
