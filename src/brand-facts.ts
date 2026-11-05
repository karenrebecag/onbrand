// Hechos reales de una marca (facts.json del pack): dominio, WhatsApp, clientes con resultado, métricas con fuente y
// precios. El agente los usa tal cual y NO los declara como "Datos de ejemplo" ni como `inventado:`; lo que el pack
// no trae sigue siendo ejemplo. Dato externo: se valida en el límite igual que brand.json.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FACTS_FILE = 'facts.json';
const MAX_ITEMS = 12;
const MAX_LEN = 300;
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const PHONE = /^\+?[0-9]{8,15}$/;

export interface BrandFactClient { name: string; result?: string; source?: string; logo?: string }
export interface BrandFactMetric { label: string; value: string; source: string }
export interface BrandFactPrice { plan: string; price: string; period?: string; includes?: string[]; source?: string }
/** Una reseña real: la cita y quién la dijo. `photo` es una URL que la fuente ya validó contra sus hosts. */
export interface BrandFactTestimonial { quote: string; person: string; role?: string; company?: string; photo?: string; source?: string }
export interface BrandFacts {
  domain?: string;
  /** Número en dígitos con prefijo de país (+5215512345678): el agente arma el wa.me. */
  whatsapp?: string;
  channels?: string[];
  clients?: BrandFactClient[];
  /** Una cifra sin fuente no es un hecho: `source` es obligatorio aquí. */
  metrics?: BrandFactMetric[];
  prices?: BrandFactPrice[];
  testimonials?: BrandFactTestimonial[];
  /** Tracking del SDK de WhatsApp (spec wa-sdk §3.3). No va al prompt: `brandFactsLines` no lo imprime. */
  tracking?: BrandTracking;
}

export type TrackingLang = 'es' | 'pt' | 'en';
export interface BrandTracking { companyToken: string; whatsapp: Partial<Record<TrackingLang, string>> }

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const DIGITS = /^[0-9]{8,15}$/;

/** El token y los números del SDK, o el motivo por el que no sirven: una página sin tracking sale como hoy. Sin token no
 * hay motivo que reportar: las marcas que no usan el SDK no lo tienen. */
export function parseTracking(token: unknown, whatsapp: unknown): { tracking?: BrandTracking; issue?: string } {
  if (token === undefined || token === null || token === '') return {};
  if (typeof token !== 'string' || !UUID.test(token.trim())) return { issue: 'companyToken no es un UUID' };
  const phones: Partial<Record<TrackingLang, string>> = {};
  for (const lang of ['es', 'pt', 'en'] as const) {
    const raw = isObj(whatsapp) ? whatsapp[lang] : undefined;
    if (raw === undefined || raw === null || raw === '') continue;
    const digits = typeof raw === 'string' ? raw.trim().replace(/^\+/, '') : '';
    if (!DIGITS.test(digits)) return { issue: `whatsapp.${lang} no son dígitos con prefijo de país` };
    phones[lang] = digits;
  }
  if (!phones.es) return { issue: 'falta whatsapp.es, el número por defecto' };
  return { tracking: { companyToken: token.trim().toLowerCase(), whatsapp: phones } };
}

/** El WhatsApp del idioma de la página: el `href` del agente y el `data-phone-<lang>` del SDK salen del mismo número. */
export function factsForLang(f: BrandFacts, lang: string): BrandFacts {
  const phone = f.tracking?.whatsapp[lang as TrackingLang];
  return phone ? { ...f, whatsapp: `+${phone}` } : f;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Claves de facts.json y de cada entrada; las mismas que brands/facts.schema.json (un test las compara). Una clave de
 * más falla: un typo como `metric` dejaba a la marca sin sus cifras sin que nadie lo dijera. */
export const FACTS_KEYS = ['$schema', 'domain', 'whatsapp', 'channels', 'clients', 'metrics', 'testimonials', 'prices'] as const;
export const FACT_ENTRY_KEYS = {
  clients: ['name', 'result', 'source', 'logo'],
  metrics: ['label', 'value', 'source'],
  testimonials: ['quote', 'person', 'role', 'company', 'photo', 'source'],
  prices: ['plan', 'price', 'period', 'includes', 'source'],
} as const satisfies Record<string, readonly string[]>;

function onlyKeys(o: Record<string, unknown>, keys: readonly string[], at: string): void {
  const unknown = Object.keys(o).filter((k) => !keys.includes(k));
  if (unknown.length) throw new Error(`facts.json: ${at}clave desconocida ${unknown.map((k) => `"${k}"`).join(', ')} (válidas: ${keys.filter((k) => k !== '$schema').join(', ')})`);
}

function text(v: unknown, field: string, required = false): string | undefined {
  if (v === undefined || v === null) {
    if (required) throw new Error(`facts.json: falta "${field}"`);
    return undefined;
  }
  if (typeof v !== 'string' || !v.trim()) throw new Error(`facts.json: "${field}" debe ser un texto no vacío`);
  if (v.length > MAX_LEN) throw new Error(`facts.json: "${field}" pasa de ${MAX_LEN} caracteres`);
  return v.trim();
}

function list<T>(v: unknown, field: string, item: (x: unknown, at: string) => T): T[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new Error(`facts.json: "${field}" debe ser una lista`);
  if (v.length > MAX_ITEMS) throw new Error(`facts.json: "${field}" pasa de ${MAX_ITEMS} entradas`);
  return v.map((x, i) => item(x, `${field}[${i}]`));
}

const entry = (keys: readonly string[]) => (x: unknown, at: string): Record<string, unknown> => {
  if (!isObj(x)) throw new Error(`facts.json: ${at} debe ser un objeto`);
  onlyKeys(x, keys, `${at}: `);
  return x;
};
const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** Valida facts.json (dato externo) y devuelve los hechos tipados; un campo mal formado rompe en vez de colarse al prompt. */
export function parseBrandFacts(raw: unknown): BrandFacts {
  if (!isObj(raw)) throw new Error('facts.json: debe ser un objeto');
  onlyKeys(raw, FACTS_KEYS, '');
  const domain = text(raw.domain, 'domain');
  if (domain && !DOMAIN.test(domain)) throw new Error(`facts.json: "domain" no es un dominio (${domain})`);
  const whatsapp = text(raw.whatsapp, 'whatsapp');
  if (whatsapp && !PHONE.test(whatsapp)) throw new Error('facts.json: "whatsapp" debe ser solo dígitos con prefijo de país (+5215512345678)');
  return strip({
    domain,
    whatsapp,
    channels: list(raw.channels, 'channels', (x, at) => text(x, at, true) as string),
    clients: list(raw.clients, 'clients', (x, at) => { const o = entry(FACT_ENTRY_KEYS.clients)(x, at); return strip({ name: text(o.name, `${at}.name`, true) as string, result: text(o.result, `${at}.result`), source: text(o.source, `${at}.source`), logo: text(o.logo, `${at}.logo`) }); }),
    metrics: list(raw.metrics, 'metrics', (x, at) => { const o = entry(FACT_ENTRY_KEYS.metrics)(x, at); return { label: text(o.label, `${at}.label`, true) as string, value: text(o.value, `${at}.value`, true) as string, source: text(o.source, `${at}.source`, true) as string }; }),
    testimonials: list(raw.testimonials, 'testimonials', (x, at) => { const o = entry(FACT_ENTRY_KEYS.testimonials)(x, at); return strip({ quote: text(o.quote, `${at}.quote`, true) as string, person: text(o.person, `${at}.person`, true) as string, role: text(o.role, `${at}.role`), company: text(o.company, `${at}.company`), photo: text(o.photo, `${at}.photo`), source: text(o.source, `${at}.source`) }); }),
    prices: list(raw.prices, 'prices', (x, at) => { const o = entry(FACT_ENTRY_KEYS.prices)(x, at); return strip({ plan: text(o.plan, `${at}.plan`, true) as string, price: text(o.price, `${at}.price`, true) as string, period: text(o.period, `${at}.period`), includes: list(o.includes, `${at}.includes`, (y, at2) => text(y, at2, true) as string), source: text(o.source, `${at}.source`) }); }),
  });
}

/** facts.json es opcional en el pack; sin archivo no hay hechos y todo sigue siendo ejemplo. */
export function readBrandFacts(brandDir: string): BrandFacts | undefined {
  const file = join(brandDir, FACTS_FILE);
  if (!existsSync(file)) return undefined;
  return parseBrandFacts(JSON.parse(readFileSync(file, 'utf8')));
}

const src = (s?: string): string => (s ? ` (fuente: ${s})` : '');

/** Líneas del bloque DATOS REALES del prompt; vacío si el pack no trae nada usable. */
export function brandFactsLines(f: BrandFacts): string[] {
  const lines: string[] = [];
  if (f.domain) lines.push(`- Dominio: ${f.domain}`);
  if (f.whatsapp) lines.push(`- WhatsApp: ${f.whatsapp} (enlace wa.me/${f.whatsapp.replace(/^\+/, '')})`);
  if (f.channels?.length) lines.push(`- Canales: ${f.channels.join(', ')}`);
  for (const c of f.clients ?? []) lines.push(`- Cliente: ${c.name}${c.result ? ` — ${c.result}` : ''}${c.logo ? ` (logo: ${c.logo})` : ''}${src(c.source)}`);
  for (const m of f.metrics ?? []) lines.push(`- Métrica: ${m.label}: ${m.value}${src(m.source)}`);
  for (const t of f.testimonials ?? []) lines.push(`- Reseña: "${t.quote}" — ${[t.person, t.role, t.company].filter(Boolean).join(', ')}${t.photo ? ` (foto: ${t.photo})` : ''}${src(t.source)}`);
  for (const p of f.prices ?? []) lines.push(`- Plan ${p.plan}: ${p.price}${p.period ? ` ${p.period}` : ''}${p.includes?.length ? ` — incluye ${p.includes.join(', ')}` : ''}${src(p.source)}`);
  return lines;
}
