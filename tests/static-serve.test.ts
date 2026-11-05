import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '../scripts/static-serve';

const dir = mkdtempSync(join(tmpdir(), 'wt-serve-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('static-serve', () => {
  test('un snapshot de v0 sin <meta charset> llega con sus acentos (utf-8 en el header)', async () => {
    writeFileSync(join(dir, 'snap.html'), '<html lang="es"><body><h2>Empieza pequeño. Crece sin límites.</h2></body></html>');
    const server = serve(dir, 'snap.html');
    try {
      const res = await fetch(`http://localhost:${server.port}/`);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    } finally {
      server.stop(true);
    }
  });
});
