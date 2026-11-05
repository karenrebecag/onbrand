import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPublishable, localPublish } from '../src/runtime/publish';

function dist(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'wt-pub-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

test('un dist con index.html y assets locales pasa, y lista los orígenes externos', () => {
  const r = checkPublishable(dist({ 'index.html': '<link href="https://cdn.example.com/a.css">', 'app.js': 'fetch("https://api.acme.io/x")' }));
  expect(r.ok).toBe(true);
  expect(r.externalOrigins).toEqual(['api.acme.io', 'cdn.example.com']);
});

test('sin index.html no es publicable', () => {
  const r = checkPublishable(dist({ 'page.html': '<p>hola</p>' }));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.some((e) => e.code === 'asset-missing')).toBe(true);
});

test('un origen de dev (preview vivo) bloquea la publicación', () => {
  const r = checkPublishable(dist({ 'index.html': 'ok', 'app.js': 'import("http://localhost:5173/@vite/client")' }));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.some((e) => e.code === 'dev-origin')).toBe(true);
});

test('una referencia a una ruta del transport bloquea', () => {
  const r = checkPublishable(dist({ 'index.html': 'ok', 'app.js': 'fetch("/runs/abc/events")' }));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.some((e) => e.code === 'transport-route')).toBe(true);
});

test('un secreto embebido bloquea sin devolver su valor', () => {
  const r = checkPublishable(dist({ 'index.html': 'ok', 'cfg.js': 'const k="sk-abcdef0123456789ABCDEF"' }));
  expect(r.ok).toBe(false);
  if (!r.ok) {
    const sec = r.errors.find((e) => e.code === 'secret');
    expect(sec).toBeDefined();
    expect(sec?.detail).not.toContain('sk-abcdef0123456789');
  }
});

test('sourcemaps y archivos ocultos no se publican', () => {
  const r = checkPublishable(dist({ 'index.html': 'ok', 'app.js.map': '{}', '.env': 'X=1' }));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.filter((e) => e.code === 'forbidden-file').length).toBeGreaterThanOrEqual(2);
});

test('localPublish copia el dist a una carpeta y devuelve un file:// con conteos', async () => {
  const src = dist({ 'index.html': '<h1>hola</h1>', 'assets/a.css': 'body{}' });
  const out = mkdtempSync(join(tmpdir(), 'wt-out-'));
  const res = await localPublish(out).publish(src, { chat: 'ws1', commit: 'abc', externalOrigins: [] });
  expect(res.url).toBe(`file://${join(out, 'ws1')}`);
  expect(res.files).toBe(2);
  expect(res.bytes).toBeGreaterThan(0);
});

// Un agente que escribe un symlink en el dist no puede publicar archivos de fuera del workspace (Arq, publish.ts).
function distWithLinks(): { root: string; src: string } {
  const root = mkdtempSync(join(tmpdir(), 'wt-pub-link-'));
  mkdirSync(join(root, 'outside'));
  writeFileSync(join(root, 'outside', 'secret.txt'), 'TOP-SECRET');
  const src = join(root, 'dist');
  mkdirSync(src);
  writeFileSync(join(src, 'index.html'), '<h1>hola</h1>');
  symlinkSync(join('..', 'outside', 'secret.txt'), join(src, 'secret.txt'));
  symlinkSync(join('..', 'outside'), join(src, 'more'));
  return { root, src };
}

test('un symlink en el dist (a archivo o a carpeta) o un dist que es symlink no es publicable', () => {
  const { root, src } = distWithLinks();
  const r = checkPublishable(src);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.filter((e) => e.code === 'symlink').map((e) => e.path).sort()).toEqual(['more', 'secret.txt']);
  symlinkSync(join(root, 'outside'), join(root, 'linked-dist'));
  const whole = checkPublishable(join(root, 'linked-dist'));
  expect(whole.ok).toBe(false);
  if (!whole.ok) expect(whole.errors.map((e) => e.code)).toEqual(['symlink']);
});

test('localPublish no copia el destino de un symlink', async () => {
  const { src } = distWithLinks();
  const out = mkdtempSync(join(tmpdir(), 'wt-out-'));
  const res = await localPublish(out).publish(src, { chat: 'ws1', commit: 'abc', externalOrigins: [] });
  expect(readdirSync(join(out, 'ws1'))).toEqual(['index.html']);
  expect(existsSync(join(out, 'ws1', 'secret.txt'))).toBe(false);
  expect(res.files).toBe(1);
});

// saveDist deja `.base` en la raíz de dist/<commit> y servableDist lo exige: es lo que publishRun valida siempre.
test('el marcador .base del snapshot no bloquea ni se publica; un .base en una subcarpeta sigue siendo oculto', async () => {
  const src = dist({ 'index.html': '<h1>hola</h1>', '.base': '/' });
  expect(checkPublishable(src)).toEqual({ ok: true, externalOrigins: [], files: 1, bytes: 13 });
  const out = mkdtempSync(join(tmpdir(), 'wt-out-'));
  const res = await localPublish(out).publish(src, { chat: 'ws1', commit: 'abc', externalOrigins: [] });
  expect(readdirSync(join(out, 'ws1'))).toEqual(['index.html']);
  expect(res.files).toBe(1);
  const nested = checkPublishable(dist({ 'index.html': 'ok', 'assets/.base': '/' }));
  expect(nested.ok).toBe(false);
  if (!nested.ok) expect(nested.errors.map((e) => e.code)).toEqual(['forbidden-file']);
});
