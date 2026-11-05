import { describe, expect, test } from 'bun:test';
import { dsLint, formatLint } from '../src/ds-lint';
import { formatTypecheck } from '../src/runtime/workspace-tools';

describe('lint del DS (Figma Make: rg de elementos crudos antes del commit)', () => {
  test('marca elementos crudos, estilos inline y pendientes en una sección; deja pasar tokens en style y componentes del DS', () => {
    const tsx = [
      "import { Action } from '@/components/relume/action';",
      '<button onClick={go}>Ir</button>',
      '<input type="email" />',
      "<div style={{ marginTop: 8 }} />",
      "<li style={{ '--i': index }} />",
      '<Action href="#cierre">Ir</Action>',
      '// TODO copy real',
    ].join('\n');
    expect(dsLint('src/sections/02-hero.tsx', tsx).map((h) => [h.line, h.rule.split(':')[0]])).toEqual([[2, 'button-crudo'], [3, 'campo-crudo'], [4, 'estilo-inline'], [7, 'pendiente']]);
  });

  test('en el CSS de una sección marca colores a mano y no los tokens ni los comentarios', () => {
    const css = ['.hero { color: var(--foreground); }', '/* antes #fff */', '.hero__cta { background: #0f6b5c; }', '.hero__glow { box-shadow: 0 0 8px rgb(0 0 0 / .2); }', '.band { background: color-mix(in oklab, var(--background), var(--foreground) 4%); }'].join('\n');
    expect(dsLint('src/sections/02-hero.module.css', css).map((h) => h.line)).toEqual([3, 4]);
  });

  test('cada hit cuenta en la primera línea del typecheck, la que agent-stream lee para darlo por bueno', () => {
    expect(formatTypecheck([], new Set(), 2).split('\n')[0]).toBe('2 errores en tus archivos:');
    expect(formatTypecheck([], new Set(), 0).split('\n')[0]).toBe('0 errores en tus archivos.');
    expect(formatLint([])).toMatch(/sin elementos crudos/);
  });
});
