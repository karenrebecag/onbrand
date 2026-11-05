// Hechos de marca desde una fuente viva (el proxy de solo lectura de Webflow, contrato /v1), leídos por el transport
// antes del turno. Fail-closed: una fuente configurada que no valida rompe la corrida; nunca se cae a facts.json ni a
// inventar (el proxy ya sirve su último snapshot bueno si Webflow falla). Si la fuente no responde la versión, se
// reintenta una vez y después se usa el último snapshot que esta misma fuente publicó y ya pasó la validación, con aviso
// (D1, verificacion.md §7.1: un timeout transitorio tumbaba el T1). Cada versión se guarda una vez y no cambia, así una
// página se reproduce con los mismos datos.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isBrandId } from './brand-registry';
import { parseBrandFacts, parseTracking, type BrandFacts } from './brand-facts';

export interface FactsSource {
  /** Distingue dos fuentes de la misma marca en la caché (otra base u otro idioma no comparten archivo). */
  readonly id?: string;
  /** Identificador de la versión publicada; barato, se pide en cada corrida nueva. */
  version(brand: string): Promise<string>;
  /** El snapshot completo de esa versión, sin validar: es dato externo. */
  snapshot(brand: string, version: string): Promise<unknown>;
}

/** De dónde puede venir una imagen: host https y, si se da, uno de sus prefijos de ruta (las cuentas de Webflow). */
export interface AssetRule { host: string; prefixes?: readonly string[] }

/** `skipped`: entradas inválidas (sin fuente, con texto o foto que no pasan); `overCap`: válidas que no entran por el tope.
 * `stale`: la fuente no respondió y la versión es la última guardada, no necesariamente la vigente. */
export interface LoadedFacts { facts: BrandFacts; version: string; cached: boolean; stale?: true; skipped: number; overCap: number; trackingIssue?: string }

export interface LoadFactsOptions {
  cacheDir: string;
  /** Versión del mensaje padre: un follow-up se queda en ella aunque la fuente haya publicado otra. */
  version?: string;
  assets: readonly AssetRule[];
  /** Espera antes del reintento de la versión. */
  retryMs?: number;
}

const RETRY_MS = 1_000;

export class FactsSourceError extends Error {}

/** La fuente publicó otro snapshot entre dos lecturas: no es un error del dato, es una carrera con los webhooks. */
export class VersionMovedError extends Error {}

const VERSION = /^[A-Za-z0-9._-]{1,64}$/;

/** Los hechos de `brand` en la versión vigente (o la del padre), del disco si ya se bajó esa versión. */
export async function loadFacts(source: FactsSource, brand: string, opts: LoadFactsOptions): Promise<LoadedFacts> {
  if (!isBrandId(brand)) throw new FactsSourceError(`hechos: id de marca inválido "${brand}"`);
  const latest = () => fail(() => source.version(brand), 'no respondió la versión');
  let first = opts.version;
  if (!first) {
    try {
      first = await retryOnce(latest, opts.retryMs ?? RETRY_MS);
    } catch (e) {
      // v0 y Lovable no cortan el turno por una fuente de contexto caída: el error queda en esa parte y el turno sigue
      // (deob/v0-layers/deobfuscated.js:64383-64392, transport/lovable/deob/registry-CmMIU-Jy/deobfuscated.js:4905-4912).
      // Sin nada guardado de esta fuente no hay dato verificado que usar y la corrida falla como antes.
      const stale = latestCached(source, brand, opts.cacheDir);
      if (!stale) throw e;
      return { ...(await loadVersion(source, brand, stale, opts)), stale: true };
    }
  }
  try {
    return await loadVersion(source, brand, first, opts);
  } catch (e) {
    // Un webhook de Webflow puede rehacer el snapshot a media lectura: una página nueva relee la versión una vez. Un
    // follow-up no, porque su versión está fijada por el padre. Si vuelve a moverse, corta.
    if (!(e instanceof VersionMovedError) || opts.version) throw wrap(e, `no respondió el snapshot ${first}`);
    try {
      return await loadVersion(source, brand, await latest(), opts);
    } catch (again) {
      throw wrap(again, 'cambió dos veces durante la lectura');
    }
  }
}

const wrap = (e: unknown, what: string): Error =>
  e instanceof FactsSourceError ? e : new FactsSourceError(`hechos: la fuente ${what}: ${e instanceof Error ? e.message : String(e)}`);

async function loadVersion(source: FactsSource, brand: string, version: string, opts: LoadFactsOptions): Promise<LoadedFacts> {
  // La versión termina en una ruta del disco: se valida antes de usarla.
  if (!VERSION.test(version)) throw new FactsSourceError(`hechos: versión inválida "${version}"`);
  const file = join(opts.cacheDir, `${brand}@${source.id ? `${source.id}-` : ''}${version}.json`);
  if (existsSync(file)) return { ...parseSnapshot(JSON.parse(readFileSync(file, 'utf8')), opts.assets), version, cached: true };
  const raw = await source.snapshot(brand, version);
  const parsed = parseSnapshot(raw, opts.assets);
  mkdirSync(opts.cacheDir, { recursive: true });
  // Escritura atómica: dos corridas de la misma versión no pueden dejar un archivo a medias que la siguiente lea.
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(raw));
  renameSync(tmp, file);
  return { ...parsed, version, cached: false };
}

async function retryOnce<T>(fn: () => Promise<T>, waitMs: number): Promise<T> {
  try {
    return await fn();
  } catch {
    await new Promise((r) => setTimeout(r, waitMs));
    return fn();
  }
}

/** La última versión de esta fuente en la caché, por fecha de escritura. Sin `id` no se sabe de qué fuente es un archivo. */
function latestCached(source: FactsSource, brand: string, cacheDir: string): string | undefined {
  if (!source.id || !existsSync(cacheDir)) return undefined;
  const prefix = `${brand}@${source.id}-`;
  return readdirSync(cacheDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json') && VERSION.test(f.slice(prefix.length, -'.json'.length)))
    .map((f) => ({ version: f.slice(prefix.length, -'.json'.length), at: statSync(join(cacheDir, f)).mtimeMs }))
    .sort((a, z) => z.at - a.at)[0]?.version;
}

async function fail<T>(fn: () => Promise<T>, what: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new FactsSourceError(`hechos: la fuente ${what}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- Adaptador del proxy /v1 -------------------------------------------------------------------------------------

export type GetJson = (url: string) => Promise<unknown>;

const TIMEOUT_MS = 10_000;
const MAX_BODY = 2 * 1024 * 1024;
const COLLECTIONS = ['clientes', 'casos', 'resenas', 'metricas', 'planes'] as const;

export const httpGetJson: GetJson = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error', headers: { accept: 'application/json', 'cache-control': 'no-cache' } });
  const body = await readCapped(r, MAX_BODY);
  // El proxy responde { success: false, error } en 404, 429 y 503: el motivo viaja al paso en rojo.
  if (!r.ok) throw new Error(`${url} respondió ${r.status}${errorOf(body)}`);
  return JSON.parse(body) as unknown;
};

/** El cuerpo hasta `max` bytes: corta por content-length antes de leer y, si no lo trae o miente, durante el stream. */
export async function readCapped(r: Response, max: number): Promise<string> {
  return (await readCappedBytes(r, max)).toString('utf8');
}

export async function readCappedBytes(r: Response, max: number): Promise<Buffer> {
  const declared = Number(r.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) throw new Error(`${r.url || 'la respuesta'} declara ${declared} bytes, más de ${max}`);
  if (!r.body) return Buffer.alloc(0);
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new Error(`${r.url || 'la respuesta'} pasa de ${max} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function errorOf(body: string): string {
  try {
    const o = JSON.parse(body) as { error?: unknown };
    return typeof o.error === 'string' ? `: ${o.error.slice(0, 200)}` : '';
  } catch {
    return '';
  }
}

/** La fuente como se imprime en el log de arranque: origen y ruta, sin query, usuario ni token (gen7: el log no decía de
 * dónde salían los hechos). */
export function factsSourceLabel(base: string): string {
  const u = new URL(base);
  return `${u.origin}${u.pathname.replace(/\/$/, '')}`;
}

/** `brand` es la marca que publica ese proxy: el contrato /v1 no la lleva en la ruta, así que pedir otra es un error de
 * configuración. */
export function webflowFacts(base: string, brand: string, getJson: GetJson = httpGetJson, lang = 'es', now: () => number = Date.now): FactsSource {
  const at = new URL(base);
  // Los hechos van al prompt como verificados: por http cualquiera en la ruta los cambia. Localhost queda para desarrollo.
  if (at.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(at.hostname)) throw new Error(`hechos: la fuente tiene que ser https (${at.origin})`);
  // El CDN de Vercel ignora el no-cache de la request y cachea cada URL hasta 6 min: la clave tiene que cambiar con lo que
  // se pide. /v1/version lleva ?t= (siempre fresca) y cada colección ?v= con su versión anunciada (nunca una vieja). El
  // proxy no filtra por t ni v; lang sí es filtro.
  const url = (path: string, bust: Record<string, string> = {}) => `${base.replace(/\/$/, '')}/v1/${path}?${new URLSearchParams({ lang, ...bust })}`;
  const versionDoc = () => getJson(url('version', { t: String(now()) }));
  const only = (asked: string) => { if (asked !== brand) throw new Error(`esta fuente /v1 solo publica ${brand}, no "${asked}"`); };
  return {
    id: createHash('sha256').update(`${base}|${lang}`).digest('hex').slice(0, 12),
    async version(brand) {
      only(brand);
      const v = (await versionDoc() as { version?: unknown } | null)?.version;
      if (typeof v !== 'string') throw new Error('/v1/version sin version');
      return v;
    },
    async snapshot(brand, version) {
      only(brand);
      // El proxy solo sirve el snapshot vigente: un follow-up sin caché en disco no puede volver a la versión de su padre.
      const doc = await versionDoc();
      const before = isObj(doc) ? doc.version : undefined;
      if (before !== version) throw new VersionMovedError(`la versión ${version} ya no está publicada (vigente: ${String(before)}) y no está en la caché de este servidor`);
      const expected = isObj(doc) && isObj(doc.colecciones) ? doc.colecciones : {};
      const at = (name: string) => { const v = isObj(expected[name]) ? expected[name].version : undefined; return url(name, typeof v === 'string' ? { v } : {}); };
      const [config, ...lists] = await Promise.all([getJson(at('config')), ...COLLECTIONS.map((c) => getJson(at(c)))]);
      for (const [i, l] of lists.entries()) if (!isObj(l) || !Array.isArray(l.items)) throw new Error(`/v1/${COLLECTIONS[i]} sin items`);
      // Red de seguridad: con ?v= ya no debería pasar, salvo un cambio real a media lectura. Cada envoltorio tiene que traer
      // la versión que /v1/version anuncia para su colección; si no, ese contenido quedaría guardado con otra versión.
      for (const [name, got] of [['config', config], ...COLLECTIONS.map((c, i) => [c, lists[i]] as const)] as const) {
        const want = isObj(expected[name]) ? expected[name].version : undefined;
        const have = isObj(got) ? got.version : undefined;
        if (typeof want === 'string' && have !== want) throw new VersionMovedError(`/v1/${name} sirve ${String(have)} y /v1/version anuncia ${want}`);
      }
      // Cada colección trae la versión suya, no la del snapshot: si el proxy publicó otro snapshot en medio, mezclar
      // colecciones daría un estado que nunca existió y quedaría guardado como `version`.
      const after = (await versionDoc() as { version?: unknown } | null)?.version;
      if (after !== version) throw new VersionMovedError(`el snapshot cambió durante la lectura (${version} → ${String(after)})`);
      return { version, config, ...Object.fromEntries(COLLECTIONS.map((c, i) => [c, (lists[i] as { items: unknown[] }).items])) };
    },
  };
}

// --- Del contrato a BrandFacts -----------------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Un texto del CMS no puede romper el prompt ni el código que lo cita: rechaza la entrada que lo intente. */
class Rejected extends Error {}

/** Todo texto del CMS: espacios colapsados (sin saltos que abran una línea nueva del prompt), sin caracteres de control,
 * formato, bidi ni tag (\p{C} los cubre), y sin < > { } que pasarían a JSX o a una instrucción. */
export function clean(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const out = v.replace(/\s+/gu, ' ').replace(/\p{C}/gu, '').trim();
  if (/[<>{}]/.test(out)) throw new Rejected(`"${out.slice(0, 40)}" trae < > { }`);
  return out || undefined;
}
const str = clean;
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObj) : []);
const imgUrl = (v: unknown): string | undefined => (isObj(v) ? str(v.url) : undefined);
// Lo que DATOS REALES admite por entrada (brand-facts.ts): una entrada más larga no entra al prompt, no tumba la página.
const MAX_LEN = 300;
const MAX_ITEMS = 12;
const fits = (o: Record<string, unknown>): boolean => Object.values(o).every((v) => typeof v !== 'string' || v.length <= MAX_LEN);

/** Snapshot del contrato /v1 → hechos. Lo que falta de un campo obligatorio (fuente), no cabe o trae algo que no debe se
 * omite y se cuenta; un snapshot sin forma tumba la carga. */
export function parseSnapshot(raw: unknown, assets: readonly AssetRule[]): { facts: BrandFacts; skipped: number; overCap: number; trackingIssue?: string } {
  if (!isObj(raw) || !isObj(raw.config)) throw new FactsSourceError('hechos: el snapshot no trae config');
  let skipped = 0;
  let overCap = 0;
  // Una colección vacía no es un hecho: sin la clave, mergeFacts deja lo que traiga facts.json.
  // Una entrada que trae algo que no debe (texto con < > { }, foto de un host ajeno) se omite y se cuenta: no tumba la marca.
  const each = <T>(items: Record<string, unknown>[], fn: (o: Record<string, unknown>) => T[]): T[] => items.flatMap((o) => {
    try {
      return fn(o);
    } catch (e) {
      if (!(e instanceof Rejected)) throw e;
      skipped += 1;
      return [];
    }
  });
  const keep = <T extends Record<string, unknown>>(items: T[]): T[] | undefined => {
    const ok = items.filter(fits);
    skipped += items.length - ok.length;
    overCap += Math.max(0, ok.length - MAX_ITEMS);
    return ok.length ? ok.slice(0, MAX_ITEMS) : undefined;
  };
  try {
    const wa = isObj(raw.config.whatsapp) ? each([raw.config.whatsapp], (w) => [str(w.es)])[0] : undefined;
    // casos traen el resultado con su fuente; un cliente sin caso entra solo con el nombre.
    // El logo de un caso sale de su cliente; si el caso no lo trae, del cliente con el mismo slug (en vivo, cliente es null).
    const logoBySlug = new Map(arr(raw.clientes).flatMap((c) => (typeof c.slug === 'string' && imgUrl(c.logo) ? [[c.slug, imgUrl(c.logo)!] as const] : [])));
    const logoOf = (url: string | undefined) => (url ? { logo: assetUrl(url, assets) } : {});
    const casos = each(arr(raw.casos), (c) => {
      const nombre = str(c.nombre) ?? (isObj(c.cliente) ? str(c.cliente.nombre) : undefined);
      if (!nombre) return [];
      const result = arr(c.metricas).map((m) => [str(m.numero), str(m.etiqueta)].filter(Boolean).join(' ')).filter(Boolean).join(', ');
      const logo = (isObj(c.cliente) ? imgUrl(c.cliente.logo) : undefined) ?? (typeof c.slug === 'string' ? logoBySlug.get(c.slug) : undefined);
      return [{ name: nombre, ...(result ? { result } : {}), ...(str(c.fuente) ? { source: str(c.fuente) } : {}), ...logoOf(logo) }];
    });
    const conCaso = new Set(casos.map((c) => c.name));
    const clientes = each(arr(raw.clientes), (c) => (str(c.nombre) && !conCaso.has(str(c.nombre)!) ? [{ name: str(c.nombre)!, ...logoOf(imgUrl(c.logo)) }] : []));
    const metrics = each(arr(raw.metricas).filter((m) => m.vigente === true && m.alcance === 'global'), (m) => (str(m.valor) && str(m.etiqueta) && str(m.fuente) ? [{ label: str(m.etiqueta)!, value: str(m.valor)!, source: str(m.fuente)! }] : []));
    const prices = each([...arr(raw.planes)].sort((a, b) => Number(a.orden ?? 0) - Number(b.orden ?? 0)), (p) => {
      const precio = isObj(p.precio) ? p.precio : {};
      const price = typeof precio.monto === 'number' ? `${precio.moneda === 'USD' ? 'US$' : '$'}${precio.monto}` : str(precio.etiqueta);
      if (!str(p.nombre) || !price || !str(p.fuente)) return [];
      const includes = (Array.isArray(p.features) ? p.features : []).map(str).filter((f): f is string => Boolean(f && f.length <= MAX_LEN)).slice(0, MAX_ITEMS);
      return [{ plan: str(p.nombre)!, price, ...(precio.periodo === 'mes' ? { period: 'al mes' } : {}), ...(includes.length ? { includes } : {}), source: str(p.fuente)! }];
    });
    // avatar son iniciales, no una foto: solo `foto` cuenta como imagen de la reseña.
    const testimonials = each(arr(raw.resenas), (r) => {
      const source = isObj(r.fuente) ? str(r.fuente.url) : undefined;
      if (!str(r.cita) || !str(r.autor) || !source) return [];
      const photo = imgUrl(r.foto);
      // La cita se pinta entre comillas en DATOS REALES: una comilla suya cerraría la cita antes de tiempo.
      return [{ quote: str(r.cita)!.replace(/"/g, "'"), person: str(r.autor)!, ...(str(r.cargo) ? { role: str(r.cargo) } : {}), ...(str(r.empresa) ? { company: str(r.empresa) } : {}), ...(photo ? { photo: assetUrl(photo, assets) } : {}), source }];
    });
    const facts = parseBrandFacts({
      ...(wa ? { whatsapp: `+${wa.replace(/^\+/, '')}` } : {}),
      clients: keep([...casos, ...clientes]),
      metrics: keep(metrics),
      prices: keep(prices),
      testimonials: keep(testimonials),
    });
    // Un token o un número que no valida deja la página sin SDK, no sin hechos: se dice y la corrida sigue.
    const { tracking, issue } = parseTracking(raw.config.companyToken, raw.config.whatsapp);
    return { facts: tracking ? { ...facts, tracking } : facts, skipped, overCap, ...(issue ? { trackingIssue: issue } : {}) };
  } catch (e) {
    if (e instanceof FactsSourceError) throw e;
    throw new FactsSourceError(`hechos: el snapshot no valida: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Una imagen de la fuente solo entra por https desde una regla conocida: su URL termina en el workspace y en el prompt. */
export function assetUrl(value: string, rules: readonly AssetRule[]): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Rejected(`"${value}" no es una URL`);
  }
  // Credenciales, puerto o separadores codificados en la ruta harían que el prefijo permitido no sea el que se sirve.
  const plain = !url.username && !url.password && !url.port && !/%2f|%5c|%2e/i.test(url.pathname);
  const ok = plain && url.protocol === 'https:' && rules.some((r) => r.host === url.hostname && (!r.prefixes || r.prefixes.some((p) => `${url.pathname}/`.startsWith(p))));
  if (!ok) throw new Rejected(`la imagen ${url.hostname}${url.pathname} no viene de un host permitido`);
  return url.href;
}

/** Los hechos de la fuente mandan sobre los de facts.json campo por campo; lo que la fuente no trae queda del pack. */
export function mergeFacts(pack: BrandFacts | undefined, live: BrandFacts): BrandFacts {
  const out: BrandFacts = { ...(pack ?? {}) };
  for (const [k, v] of Object.entries(live) as [keyof BrandFacts, BrandFacts[keyof BrandFacts]][]) {
    if (v !== undefined && (!Array.isArray(v) || v.length)) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
