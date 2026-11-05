// Servidor estático estricto que comparten los sensores: un asset ausente es 404. vite preview responde
// 200 con index.html y esconde una imagen rota; el sensor tiene que ver el 404 para contarla.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { BrandTracking } from '../src/brand-facts';
import { WCI_SINK, withWaSdk } from '../src/wa-sdk';

// Los snapshots de v0 no traen <meta charset>: sin utf-8 en el header el navegador lee los acentos como latin-1.
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon' };

/** Con `waSdk` (spec wa-sdk §3.5), `/` lleva el script del SDK apuntando al sink del mismo origen y `/__wci-sink`
 * responde 204: el webhook es un POST JSON con Authorization y a otro origen pediría preflight. Nada sale a AtomChat. */
export interface ServeOptions {
  waSdk?: BrandTracking;
  /** Cada POST al sink, ya parseado: lo lee el sensor wa.click. */
  onSink?: (payload: unknown) => void;
}

const MAX_SINK = 64 * 1024;

/** `index` es el archivo de la raíz: index.html de un dist o un snapshot suelto. */
export function serve(root: string, index = 'index.html', opts: ServeOptions = {}) {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      if (opts.waSdk && path === WCI_SINK) {
        if (req.method === 'POST') {
          const body = await req.text();
          if (body.length <= MAX_SINK) {
            try {
              opts.onSink?.(JSON.parse(body));
            } catch {
              opts.onSink?.(body);
            }
          }
        }
        return new Response(null, { status: 204 });
      }
      const file = path === '/' ? join(root, index) : join(root, path);
      if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) return new Response('not found', { status: 404 });
      if (path === '/' && opts.waSdk) {
        return new Response(withWaSdk(readFileSync(file, 'utf8'), opts.waSdk, { webhookUrl: WCI_SINK }), { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      return new Response(Bun.file(file), { headers: { 'content-type': path === '/' ? 'text/html; charset=utf-8' : MIME[extname(file)] ?? 'application/octet-stream' } });
    },
  });
}
