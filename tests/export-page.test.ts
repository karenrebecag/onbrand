import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pageHtml } from '../src/runtime/export';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function dist(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'page-'));
  dirs.push(d);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(d, rel, '..'), { recursive: true });
    writeFileSync(join(d, rel), body);
  }
  return d;
}

test('pageHtml deja un solo archivo: CSS y JS inline, imágenes y url() como data:', () => {
  const d = dist({
    'index.html': '<html><head><link rel="stylesheet" crossorigin href="/assets/a.css"><script type="module" crossorigin src="/assets/a.js"></script></head><body><img src="/logo.svg"></body></html>',
    'assets/a.css': 'body{background:url(/logo.svg)}',
    'assets/a.js': 'console.log("</script>")',
    'logo.svg': '<svg/>',
  });
  const out = pageHtml(d);
  expect(out).not.toMatch(/href="\/assets|src="\/assets|src="\/logo/);
  expect(out).toContain('<style>body{background:url(data:image/svg+xml;base64,');
  expect(out).toContain('<script type="module">console.log("<\\/script>")</script>');
  expect(out).toContain('<img src="data:image/svg+xml;base64,');
});

test('pageHtml no toca referencias externas ni lo que no está en el dist', () => {
  const d = dist({ 'index.html': '<link rel="stylesheet" href="https://x.test/a.css"><script src="/falta.js"></script>' });
  expect(pageHtml(d)).toBe('<link rel="stylesheet" href="https://x.test/a.css"><script src="/falta.js"></script>');
});

test('pageHtml no lee fuera del dist por ../ ni por symlink', () => {
  const d = dist({ 'index.html': '<script src="/../secreto.js"></script><img src="/ln.png">' });
  const out = tmpdir();
  writeFileSync(join(out, 'secreto.js'), 'x');
  symlinkSync(join(out, 'secreto.js'), join(d, 'ln.png'));
  expect(pageHtml(d)).toBe('<script src="/../secreto.js"></script><img src="/ln.png">');
});
