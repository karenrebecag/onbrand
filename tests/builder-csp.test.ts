// La CSP del builder (apps/builder/vercel.json) y la del preview (preview-serve.ts) se miran entre sí: el builder enmarca
// la url estable del preview y el preview solo deja enmarcarse por el builder. Si D6 mueve el preview de host, este test
// obliga a tocar frame-src en el mismo cambio (docs/notas/deploy-builder.md; I4 en docs/estandares.md).
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PreviewDist } from '../src/runtime/preview-dist';
import { previewCsp } from '../src/runtime/preview-serve';

// Origen del preview en el deploy de la distro (Sandbox), el mismo de tests/loopback.test.ts.
const SANDBOX_PREVIEW_ORIGIN = 'https://sb-71uhuh9ri4ix.vercel.run';
const BUILDER_ORIGIN = 'https://onbrand.acme.test';

type Route = { headers?: Record<string, string> };
const routes = (JSON.parse(readFileSync(resolve(import.meta.dir, '..', 'apps', 'builder', 'vercel.json'), 'utf8')) as { routes: Route[] }).routes;
const headers = routes.find((r) => r.headers)?.headers ?? {};

function directive(csp: string, name: string): string[] {
  return csp.split(';').map((d) => d.trim().split(/\s+/)).find(([n]) => n === name)?.slice(1) ?? [];
}

/** host-source de CSP3: esquema y host, con `*.` para cualquier subdominio. Sin puertos ni rutas (la lista no los usa). */
function allows(sources: readonly string[], url: string): boolean {
  const u = new URL(url);
  return sources.some((s) => {
    const m = /^(https?):\/\/(\*\.)?([^/:]+)$/.exec(s);
    if (!m) return false;
    if (`${m[1]}:` !== u.protocol) return false;
    return m[2] ? u.hostname.endsWith(`.${m[3]}`) : u.hostname === m[3];
  });
}

test('la CSP del builder va en enforce, no en Report-Only', () => {
  expect(headers['Content-Security-Policy']).toBeString();
  expect(headers['Content-Security-Policy-Report-Only']).toBeUndefined();
});

test('frame-src del builder deja enmarcar la url estable del preview del Sandbox, y el preview solo al builder', () => {
  const frameSrc = directive(headers['Content-Security-Policy'] ?? '', 'frame-src');
  const dist = new PreviewDist({ previewOrigin: SANDBOX_PREVIEW_ORIGIN, wsDir: () => '/nada', hasWs: () => false });
  expect(allows(frameSrc, dist.stableUrl('abc123'))).toBe(true);
  expect(allows(frameSrc, 'https://evil.example.com/')).toBe(false);
  expect(directive(previewCsp([BUILDER_ORIGIN]), 'frame-ancestors')).toEqual(["'self'", BUILDER_ORIGIN]);
});

test('connect-src es solo self: el transport va por el proxy /api del mismo origen', () => {
  expect(directive(headers['Content-Security-Policy'] ?? '', 'connect-src')).toEqual(["'self'"]);
});
