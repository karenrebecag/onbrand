// Medición del SDK de WhatsApp para src/wa-sensors.ts (spec wa-sdk §3.6). Nada sale a AtomChat: api.atomchat.io y la
// telemetría del SDK (<origen del bundle>/api/*) se abortan siempre, y WhatsApp no se abre: window.open queda stubeado
// y una navegación a wa.me se aborta. El webhook va al sink de static-serve, que responde 204; aquí se lee del request.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { WCI_SINK } from '../src/wa-sdk';
import type { WaMeasure } from '../src/wa-sensors';

export interface WaCapture { sink: WaMeasure['sink']; atomchat: string[]; stylesheets: string[] }

const SDK_ORIGIN = /^https:\/\/atom-whatsapp-buttons\.vercel\.app\//;
const SETTLE_MS = 400;

/** Antes de navegar: rutas cortadas y window.open stubeado. */
export async function armWa(page: Page): Promise<WaCapture> {
  const cap: WaCapture = { sink: [], atomchat: [], stylesheets: [] };
  await page.route(/^https:\/\/([a-z0-9-]+\.)*atomchat\.io\//, (r) => { cap.atomchat.push(r.request().url()); return r.abort(); });
  await page.route((u) => SDK_ORIGIN.test(u.href) && u.pathname.startsWith('/api/'), (r) => r.abort());
  await page.route((u) => SDK_ORIGIN.test(u.href) && u.pathname.endsWith('.css'), (r) => { cap.stylesheets.push(r.request().url()); return r.abort(); });
  await page.route(/^https:\/\/(wa\.me|api\.whatsapp\.com)\//, (r) => r.abort());
  page.on('request', (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === WCI_SINK) cap.sink.push({ auth: req.headers().authorization ?? null, body: req.postData() ?? '' });
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __waOpened: string[]; open: (u?: string | URL) => null };
    w.__waOpened = [];
    w.open = (u) => { w.__waOpened.push(String(u)); return null; };
  });
  return cap;
}

const WA_NUMBER = /(?:wa\.me\/|api\.whatsapp\.com\/send\?phone=)\+?(\d{8,15})/g;
const QUOTED_NUMBER = /["'`]\+?(\d{10,15})["'`]/g;

/** Números de WhatsApp que escribió el agente: src/ del workspace sin src/components (el DS no trae números). */
export function agentNumbers(ws: string): WaMeasure['agentNumbers'] {
  const out: WaMeasure['agentNumbers'] = [];
  const walk = (dir: string): void => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) { if (f !== 'components') walk(p); continue; }
      if (!/\.(tsx?|jsx?)$/.test(f)) continue;
      const text = readFileSync(p, 'utf8');
      const rel = p.slice(ws.length + 1);
      const phones = new Set([...text.matchAll(WA_NUMBER)].map((m) => m[1]!));
      // Un helper (`const PHONE = "521…"`) arma el wa.me con una variable: el número va entre comillas en un archivo de WhatsApp.
      if (/wa\.me|whatsapp/i.test(text)) for (const m of text.matchAll(QUOTED_NUMBER)) phones.add(m[1]!);
      for (const phone of phones) out.push({ file: rel, phone });
    }
  };
  const src = join(ws, 'src');
  if (existsSync(src)) walk(src);
  return out;
}

/** Después de cargar: scripts, UI propia, CTA adoptados y un clic sintético por sección. */
export async function measureWa(page: Page, cap: WaCapture, ws: string): Promise<WaMeasure> {
  const dist = join(ws, 'dist', 'index.html');
  const diskScripts = existsSync(dist) ? (readFileSync(dist, 'utf8').match(/<script\b[^>]*atom-whatsapp-buttons/gi) ?? []).length : 0;
  const dom = await page.evaluate(() => {
    const attr = (e: Element, k: string) => e.getAttribute(k);
    const scripts = [...document.querySelectorAll('script[src*="atom-whatsapp-buttons"]')].map((s) => ({
      src: attr(s, 'src') ?? '', integrity: attr(s, 'integrity'), token: attr(s, 'data-company-token'), mode: attr(s, 'data-mode'),
      phone: attr(s, 'data-phone'), phonePt: attr(s, 'data-phone-pt'), phoneEn: attr(s, 'data-phone-en'), webhookUrl: attr(s, 'data-webhook-url'),
    }));
    const sheets = [...document.querySelectorAll('link[rel="stylesheet"][href*="atom-whatsapp-buttons"]')].map((l) => attr(l, 'href') ?? '');
    const floats = document.querySelectorAll('.atom-wa-btn, [data-aa-mount]').length;
    const probed = new Set<string>();
    const links = [...document.querySelectorAll('a[href]')].filter((a) => /^https:\/\/(wa\.me|api\.whatsapp\.com)\//.test((a as HTMLAnchorElement).href)).map((a) => {
      const section = a.closest('[data-wt-role]')?.getAttribute('data-wt-slug') ?? '-';
      const bound = a.hasAttribute('data-atom-bound');
      if (bound && !probed.has(section)) { probed.add(section); a.setAttribute('data-wt-wa-probe', section); }
      return { section, href: (a as HTMLAnchorElement).href, atomButton: a.hasAttribute('data-atom-button'), bound, cta: attr(a, 'data-cta') };
    });
    return { lang: document.documentElement.lang, scripts, sheets, floats, links, probes: [...probed] };
  });
  const clicks: WaMeasure['clicks'] = [];
  for (const section of dom.probes) {
    clicks.push(await page.evaluate(async ({ section, settle }) => {
      const a = document.querySelector(`[data-wt-wa-probe="${CSS.escape(section)}"]`)!;
      const w = window as unknown as { __waOpened: string[]; dataLayer?: { event?: string; cta?: string }[] };
      const before = w.__waOpened.length;
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
      a.dispatchEvent(ev);
      await new Promise((r) => setTimeout(r, settle));
      const pushed = (w.dataLayer ?? []).filter((e) => e?.event === 'atom_cta_click').pop();
      return { section, cta: a.getAttribute('data-cta'), prevented: ev.defaultPrevented, opened: w.__waOpened[before] ?? null, dataLayerCta: pushed?.cta ?? null };
    }, { section, settle: SETTLE_MS }));
  }
  await page.waitForTimeout(SETTLE_MS);
  return {
    lang: dom.lang, scripts: dom.scripts, diskScripts, stylesheets: [...dom.sheets, ...cap.stylesheets], floats: dom.floats,
    links: dom.links, clicks, sink: cap.sink, atomchat: cap.atomchat, agentNumbers: agentNumbers(ws),
  };
}
