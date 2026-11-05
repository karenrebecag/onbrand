import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffCheck, isCopyOnly } from '../src/runtime/change-kind';

const HERO = `export function Hero() {
  return <section className="hero px-4" style={{ padding: '8px' }}><h1>Tus agentes venden por WhatsApp</h1><Button label="Agendar demo" /></section>
}
`;

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wt-change-'));
  mkdirSync(join(dir, 'src', 'sections'), { recursive: true });
  writeFileSync(join(dir, 'src', 'sections', '02-hero.tsx'), HERO);
  writeFileSync(join(dir, 'page-plan.md'), '# plan\n');
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'v1']]) spawnSync('git', args, { cwd: dir });
  return dir;
}

describe('verificación proporcional (Q6)', () => {
  // Un copy no pide capturas; clases, estilos, estructura u otra sección sí.
  test('solo copy es texto cambiado en una sección, con o sin el plan; lo demás pide la verificación completa', () => {
    const dir = repo();
    const hero = join(dir, 'src', 'sections', '02-hero.tsx');
    writeFileSync(hero, HERO.replace('Tus agentes venden por WhatsApp', 'Convierte cada conversación en una venta').replace('Agendar demo', 'Hablar con ventas'));
    expect(isCopyOnly(dir, ['src/sections/02-hero.tsx', 'page-plan.md'])).toBe(true);
    for (const changed of [HERO.replace('hero px-4', 'hero px-8'), HERO.replace("'8px'", "'16px'"), HERO.replace('<h1>Tus agentes venden por WhatsApp</h1>', '<h1>Tus agentes</h1><p>venden</p>')]) {
      writeFileSync(hero, changed);
      expect(isCopyOnly(dir, ['src/sections/02-hero.tsx'])).toBe(false);
    }
    expect(isCopyOnly(dir, ['src/sections/02-hero.tsx', 'src/sections/03-beneficios.tsx'])).toBe(false);
    expect(isCopyOnly(dir, ['src/sections/04-nueva.tsx'])).toBe(false);
    writeFileSync(hero, `${HERO}   \n`);
    expect(diffCheck(dir)).toContain('trailing whitespace');
  });
});
