// Tras revertir preserve.visual, el store wt-visual/<sha>/ solo guarda dom@1440.html y texts.json; su poda la dispara
// saveDom (una vez por versión). Este test fija que la poda sigue acotando el store sin las capturas PNG, y que su
// guarda crítica impide podar hermanos cuando el padre no es wt-visual.
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveDom } from '../src/dom-snapshot';
import { pruneVersions } from '../src/shot-store';

function version(root: string, name: string, ageSeconds: number): void {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'dom@1440.html'), '<!doctype html>');
  writeFileSync(join(d, 'texts.json'), '{}');
  const t = new Date(Date.now() - ageSeconds * 1000);
  utimesSync(d, t, t);
}

test('saveDom poda wt-visual a las últimas 12 versiones con solo dom+texts', () => {
  const store = mkdtempSync(join(tmpdir(), 'wt-visual-store-'));
  const root = join(store, 'wt-visual');
  try {
    // i mayor = más reciente, para una poda determinista por mtime.
    for (let i = 0; i < 20; i += 1) version(root, `sha-${String(i).padStart(2, '0')}`, 20 - i);
    saveDom(join(root, 'sha-new'), 1440, '<!doctype html>');
    const left = readdirSync(root).sort();
    expect(left.length).toBe(12);
    expect(left).toContain('sha-new');
    expect(left).not.toContain('sha-00');
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

test('pruneVersions no borra nada si el padre no es wt-visual', () => {
  const root = mkdtempSync(join(tmpdir(), 'no-store-'));
  try {
    for (let i = 0; i < 20; i += 1) version(root, `dir-${String(i).padStart(2, '0')}`, 20 - i);
    pruneVersions(join(root, 'dir-19'));
    expect(readdirSync(root).length).toBe(20);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
