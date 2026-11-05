import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filesOutOfScope, scopeDefects, textOutOfScope, turnScope } from '../src/scope-sensor';

const commit = (dir: string, files: Record<string, string>, drop: string[] = []): string => {
  for (const f of drop) rmSync(join(dir, f));
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
  for (const args of [['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'v']]) spawnSync('git', args, { cwd: dir });
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
};

describe('preserve.files y preserve.text (alcance de selectedSections)', () => {
  // Paso 5 de la ronda: el chip de sección pedía 03-features. Lo que el turno toque fuera de lo elegido es defecto; un
  // slug que no existe no amplía el alcance (security-review de #375).
  test('lo de fuera del alcance es defecto; el steer suma secciones; la renumeración, el plan y un slug falso no cuentan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-scope-'));
    mkdirSync(join(dir, 'src', 'sections'), { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: dir });
    // La faq renumerada reescribe su slug y su import (como 04-steps → 05-steps en la ronda en vivo): sigue intacta.
    const faq = (n: string): string => `import s from './${n}-faq.module.css';\nexport default () => <section data-wt-slug="${n}-faq" className={s.a}>¿Cuánto tarda la implementación de Acme en una empresa?</section>;\n`;
    const v1 = commit(dir, { 'src/sections/02-hero.tsx': 'h', 'src/sections/03-precios.module.css': '.a{}', 'src/sections/04-faq.tsx': faq('04'), 'page-plan.md': 'p', 'request.json': '{}' });
    const v2 = commit(dir, {
      'src/sections/02-hero.tsx': 'h2',
      'src/sections/03-precios.module.css': '.a{color:red}',
      'src/sections/05-faq.tsx': faq('05'),
      'page-plan.md': 'p2',
      'request.json': JSON.stringify({ selectedSections: ['02-hero', '99-x'] }),
    }, ['src/sections/04-faq.tsx']);
    const scope = turnScope(dir, v1, v2) as Set<string>;
    expect([...scope]).toEqual(['02-hero']);
    expect(filesOutOfScope(dir, v1, v2, scope)).toEqual(['src/sections/03-precios.module.css']);

    const log = join(dir, 'm.ndjson');
    writeFileSync(log, `${JSON.stringify({ type: 'message.start' })}\n${JSON.stringify({ type: 'steer', text: 'y precios', selectedSections: ['03-precios'] })}\n`);
    const both = turnScope(dir, v1, v2, log) as Set<string>;
    expect(filesOutOfScope(dir, v1, v2, both)).toEqual([]);

    writeFileSync(join(dir, 'request.json'), JSON.stringify({ selectedSections: ['99-x'] }));
    expect(turnScope(dir, v1, v2)).toBeNull();

    const texts = textOutOfScope({ '02-hero': 'Hola', '04-faq': '¿Cuánto?', '03-precios': '$1' }, { '02-hero': 'Hola de nuevo', '05-faq': '¿Cuánto?', '03-precios': '$2' }, scope);
    expect(texts).toEqual(['03-precios']);
    expect(scopeDefects(['src/sections/03-precios.module.css'], texts, scope, 1440).map((d) => [d.kind, d.slug, d.message])).toEqual([
      ['preserve-files', null, 'el pedido era sobre 02-hero y el turno cambió src/sections/03-precios.module.css'],
      ['preserve-text', '03-precios', 'el pedido era sobre 02-hero y cambió el texto de 03-precios'],
    ]);
  });
});
