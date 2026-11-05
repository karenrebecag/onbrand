// SDK de WhatsApp de Atom (spec wa-sdk §3.4-3.5). El transport deja en cada versión `wa-sdk.json` con el token y los
// números, y el loader se inserta al servir: static-serve con el sink del mismo origen (dist local y QA) y el paso de
// deploy con el endpoint real. Nunca va en el index.html del workspace: el agente lo reescribe en su turno y el preview
// del builder no tiene cómo cortar la telemetría del SDK.

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parseTracking, type BrandTracking } from './brand-facts';

export const WA_SDK_FILE = 'wa-sdk.json';
export const WCI_SINK = '/__wci-sink';

// Decisión (a) de la spec: bundle con hash y SRI, no /v1/loader.js, que cambia sin aviso dentro del major. Un asset con
// hash es inmutable mientras existe, pero cada deploy del SDK borra los anteriores (HIBW7KH7 dio 404 tras fc0df52), aunque
// version.json no cambie de versión. Cada deploy de atom-whatsapp-buttons obliga a repetir esto: leer assets.js de
// https://atom-whatsapp-buttons.vercel.app/v1/version.json y recalcular el sha384 del archivo.
// HACK: pin a mano que se rompe con cada deploy del SDK. Servir el bundle desde aquí cuando el deploy de páginas exista.
export const WA_SDK_BUNDLE = {
  version: '1.1.2',
  src: 'https://atom-whatsapp-buttons.vercel.app/v1/assets/wa-buttons.Y4HEOJW6.js',
  integrity: 'sha384-4v/ZsOuLzznpcCpYoDmxQgBTpukTKElwYeqjxsHL/w8nbAv52q+ga+EXPKe+yLYm',
} as const;

/** Escribe `wa-sdk.json` con el tracking de la marca o lo borra sin él: un follow-up no hereda un token que ya no aplica. */
export function writeWaSdk(dir: string, tracking: BrandTracking | undefined): void {
  const file = join(dir, WA_SDK_FILE);
  if (!tracking) {
    rmSync(file, { force: true });
    return;
  }
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(tracking, null, 2)}\n`);
  renameSync(tmp, file);
}

/** El tracking de una versión, validado otra vez: el archivo está en el workspace, donde también escribe el agente. */
export function readWaSdk(dir: string): BrandTracking | undefined {
  const file = join(dir, WA_SDK_FILE);
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { companyToken?: unknown; whatsapp?: unknown };
    return parseTracking(raw.companyToken, raw.whatsapp).tracking;
  } catch {
    return undefined;
  }
}

const escapeAttr = (v: string): string => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Cualquier script del SDK que ya traiga el HTML (el loader mutable o un bundle), también si lo escribió el agente.
const ANY_SDK = /<script\b[^>]*\bsrc="[^"]*atom-whatsapp-buttons[^"]*"[^>]*>\s*<\/script>\s*/gi;

/** El HTML con un solo script del SDK al final de <body>, en modo attach. Idempotente. Sin `webhookUrl` el SDK usa el
 * endpoint real: solo el paso de deploy lo llama así. */
export function withWaSdk(html: string, tracking: BrandTracking, opts: { webhookUrl?: string } = {}): string {
  const clean = html.replace(ANY_SDK, '');
  const lang = /<html\b[^>]*\slang="([a-zA-Z-]{2,10})"/.exec(clean)?.[1];
  const attrs: [string, string | undefined][] = [
    ['src', WA_SDK_BUNDLE.src],
    ['integrity', WA_SDK_BUNDLE.integrity],
    ['crossorigin', 'anonymous'],
    ['data-company-token', tracking.companyToken],
    ['data-phone', tracking.whatsapp.es],
    ['data-phone-pt', tracking.whatsapp.pt],
    ['data-phone-en', tracking.whatsapp.en],
    ['data-lang', lang],
    ['data-mode', 'attach'],
    ['data-webhook-url', opts.webhookUrl],
  ];
  const tag = `<script ${attrs.filter(([, v]) => v).map(([k, v]) => `${k}="${escapeAttr(v!)}"`).join(' ')}></script>`;
  const at = clean.lastIndexOf('</body>');
  return at < 0 ? `${clean}\n${tag}\n` : `${clean.slice(0, at)}${tag}\n${clean.slice(at)}`;
}
