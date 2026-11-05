// Sensores del SDK de WhatsApp de Atom (spec wa-sdk §3.6). Deciden sobre lo que midió scripts/wa-measure.ts en el `/`
// que sirve static-serve: el script del SDK, si adoptó los CTA, qué hizo el clic y el número que escribió el agente.
// Hasta el paso 3 de §5 solo informan: el CLI no los cuenta para el código de salida.

import type { BrandTracking } from './brand-facts';
import type { Owner } from './page-sensors';
import { WA_SDK_BUNDLE, WCI_SINK } from './wa-sdk';

export type WaField = 'sdk.script' | 'sdk.float' | 'wa.adopted' | 'wa.click' | 'wa.number';

export interface WaDefect { field: WaField; owner: Owner; section: string; expected: string; actual: string; message: string }

const OWNER: Record<WaField, Owner> = { 'sdk.script': 'A', 'sdk.float': 'A', 'wa.adopted': 'B', 'wa.click': 'B', 'wa.number': 'B' };

/** El enum de `cta` del SDK (README de atom-whatsapp-buttons); sin `data-cta` el SDK usa `default`. */
export const WA_CTAS = ['agendar_demo', 'hablar_asesor', 'demo_5min', 'consultar_precio'] as const;

export interface WaScript {
  src: string;
  integrity: string | null;
  token: string | null;
  mode: string | null;
  phone: string | null;
  phonePt: string | null;
  phoneEn: string | null;
  webhookUrl: string | null;
}

export interface WaMeasure {
  /** `<html lang>` de la página servida. */
  lang: string;
  /** Scripts del SDK en el `/` servido. */
  scripts: WaScript[];
  /** Scripts del SDK en `dist/index.html` en disco: el loader lo pone solo static-serve. */
  diskScripts: number;
  /** Hojas CSS del SDK pedidas o enlazadas. */
  stylesheets: string[];
  /** `.atom-wa-btn` y `[data-aa-mount]`: UI propia del SDK. */
  floats: number;
  links: { section: string; href: string; atomButton: boolean; bound: boolean; cta: string | null }[];
  /** Un clic sintético por sección en su primer CTA adoptado. */
  clicks: { section: string; cta: string | null; prevented: boolean; opened: string | null; dataLayerCta: string | null }[];
  /** POST al sink: cabecera Authorization y cuerpo. */
  sink: { auth: string | null; body: string }[];
  /** Requests a api.atomchat.io, abortados por la medición. */
  atomchat: string[];
  /** Números de wa.me o api.whatsapp.com que escribió el agente, por archivo del workspace. */
  agentNumbers: { file: string; phone: string }[];
}

const CHAT_ID = /(?:wci=|referencia: )([A-Za-z0-9]{5})(?![A-Za-z0-9])/;

/** El chatId que el SDK mete en el texto del wa.me (wci/strategy.ts: `wci=<id>` o `Codigo de referencia: <id>`). */
export function chatIdOf(waUrl: string): string | null {
  try {
    return CHAT_ID.exec(new URL(waUrl).searchParams.get('text') ?? '')?.[1] ?? null;
  } catch {
    return null;
  }
}

const expectedPhone = (sdk: BrandTracking, lang: string): string | undefined => sdk.whatsapp[lang.slice(0, 2) as 'es' | 'pt' | 'en'] ?? sdk.whatsapp.es;

function scriptDefects(m: WaMeasure, sdk: BrandTracking | undefined, d: (f: WaField, s: string, e: string, a: string, msg: string) => void): void {
  if (!sdk) {
    if (m.scripts.length) d('sdk.script', '-', 'sin script', `${m.scripts.length} script(s)`, `la marca no trae tracking y la página carga el SDK (${m.scripts[0]!.src})`);
    return;
  }
  if (m.scripts.length !== 1) d('sdk.script', '-', '1 script', `${m.scripts.length}`, `con wa-sdk.json la página debe cargar el SDK una vez y lo carga ${m.scripts.length}`);
  const s = m.scripts[0];
  if (s) {
    const want: [string, string | null, string | undefined][] = [
      ['src', s.src, WA_SDK_BUNDLE.src],
      ['integrity', s.integrity, WA_SDK_BUNDLE.integrity],
      ['data-company-token', s.token, sdk.companyToken],
      ['data-mode', s.mode, 'attach'],
      ['data-phone', s.phone, sdk.whatsapp.es],
      ['data-phone-pt', s.phonePt, sdk.whatsapp.pt],
      ['data-phone-en', s.phoneEn, sdk.whatsapp.en],
      ['data-webhook-url', s.webhookUrl, WCI_SINK],
    ];
    const off = want.filter(([, got, exp]) => (got ?? undefined) !== exp);
    if (off.length) d('sdk.script', '-', off.map(([k, , e]) => `${k}=${e ?? '(ninguno)'}`).join(' '), off.map(([k, g]) => `${k}=${g ?? '(ninguno)'}`).join(' '), `el script del SDK no cumple el contrato en ${off.map(([k]) => k).join(', ')}`);
  }
  if (m.diskScripts) d('sdk.script', '-', 'dist/index.html sin SDK', `${m.diskScripts} en disco`, 'dist/index.html trae el SDK en disco: static-serve lo agrega otra vez y sale duplicado');
  if (m.stylesheets.length) d('sdk.script', '-', 'sin hoja del SDK', m.stylesheets[0]!, `la página carga la hoja del SDK (${m.stylesheets[0]}); su :root --whatsapp pisa al DS`);
  if (m.atomchat.length) d('sdk.script', '-', 'sin requests a api.atomchat.io', m.atomchat[0]!, `la página pidió ${m.atomchat[0]}: fuera del deploy el webhook va al sink`);
}

function linkDefects(m: WaMeasure, d: (f: WaField, s: string, e: string, a: string, msg: string) => void): void {
  for (const section of new Set(m.links.map((l) => l.section))) {
    const bad = m.links.filter((l) => l.section === section && (!l.atomButton || !l.bound || (l.cta !== null && !(WA_CTAS as readonly string[]).includes(l.cta))));
    if (!bad.length) continue;
    const l = bad[0]!;
    const why = !l.atomButton ? 'sin data-atom-button' : !l.bound ? 'sin data-atom-bound (el SDK no lo enganchó)' : `data-cta="${l.cta}" fuera del enum`;
    d('wa.adopted', section, 'data-atom-button y data-atom-bound', why, `${bad.length} CTA de WhatsApp ${why}, p. ej. ${l.href.slice(0, 60)}`);
  }
}

function clickDefects(m: WaMeasure, sdk: BrandTracking, d: (f: WaField, s: string, e: string, a: string, msg: string) => void): void {
  for (const c of m.clicks) {
    const id = c.opened ? chatIdOf(c.opened) : null;
    const want = c.cta ?? 'default';
    const sent = id ? m.sink.find((p) => p.body.includes(`"${id}"`)) : undefined;
    const why = !c.prevented ? 'el clic navegó (sin preventDefault)'
      : !c.opened ? 'el clic no abrió WhatsApp'
      : !id ? `abrió ${c.opened.slice(0, 60)} sin chatId`
      : !sent ? `el sink no recibió el chatId ${id}`
      : sent.auth !== `Bearer ${sdk.companyToken}` ? 'el webhook no lleva el token de la marca'
      : c.dataLayerCta !== want ? `dataLayer atom_cta_click con cta=${c.dataLayerCta ?? '(ninguno)'}`
      : null;
    if (why) d('wa.click', c.section, `wa.me con chatId, webhook al sink y atom_cta_click cta=${want}`, why, `clic en el CTA de WhatsApp: ${why}`);
  }
}

export function waSensors(m: WaMeasure, sdk: BrandTracking | undefined): WaDefect[] {
  const out: WaDefect[] = [];
  const d = (field: WaField, section: string, expected: string, actual: string, message: string) => out.push({ field, owner: OWNER[field], section, expected, actual, message });
  scriptDefects(m, sdk, d);
  if (!sdk) return out;
  if (m.floats) d('sdk.float', '-', 'sin UI propia del SDK', `${m.floats}`, `el SDK pintó ${m.floats} botón(es) propio(s) (.atom-wa-btn o [data-aa-mount]): no corre en attach`);
  linkDefects(m, d);
  clickDefects(m, sdk, d);
  const phone = expectedPhone(sdk, m.lang);
  for (const file of new Set(m.agentNumbers.filter((n) => n.phone !== phone).map((n) => n.file))) {
    const n = m.agentNumbers.find((x) => x.file === file && x.phone !== phone)!;
    d('wa.number', file, phone ?? '(sin número)', n.phone, `${file} escribe el número ${n.phone} y wa-sdk.json dice ${phone ?? 'ninguno'} para "${m.lang}": número inventado`);
  }
  return out;
}
