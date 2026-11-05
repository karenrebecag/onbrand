import { describe, expect, test } from 'bun:test';
import { parseIconModule, parseLucideTypes, type IconLibrary } from '../src/ds-skill-icons';
import { runTool, type ToolContext } from '../src/runtime/tools';
import { verifySection } from '../src/runtime/verify';
import type { AllowEntry } from '../src/ds-skill';

const DTS = [
  'declare const Rocket: LucideIcon;',
  'declare const CircleAlert: LucideIcon;',
  'export { CircleAlert as AlertCircle, CircleAlert as AlertCircleIcon, CircleAlert as LucideCircleAlert, Rocket, Rocket as RocketIcon };',
].join('\n');

const lucide = parseLucideTypes(DTS);
const own = parseIconModule("export const RocketIcon = (props) => (\n);\nexport const VisaBadgeIcon = (props) => (\n);\n");
const icons: IconLibrary = { sets: [
  { id: 'interface', title: 'propia', importPath: '@/components/interface-essentials', names: own, aliases: {} },
  { id: 'lucide', title: 'lucide', importPath: 'lucide-react', version: '1.0.0', ...lucide },
] };
const allow: Record<string, AllowEntry> = {
  badge: { export: 'Badge', importPath: '@/components/arc/badge/badge', kind: 'component', schema: 'x', propless: false, accepts: [{ prop: 'icon', required: false, type: 'ReactNode' }], provides: [] },
};
const ctx: ToolContext = { skillDir: '/no-existe', allowlist: allow, schemas: () => ({ type: 'object', additionalProperties: false, properties: { icon: {}, children: { type: 'string' } } }), icons };

describe('iconos y tools del agente', () => {
  test('lucide da canónicos y alias sin variantes Icon/Lucide; el módulo propio da sus exports', () => {
    expect(lucide).toEqual({ names: ['CircleAlert', 'Rocket'], aliases: { AlertCircle: 'CircleAlert' } });
    expect(own).toEqual(['RocketIcon', 'VisaBadgeIcon']);
  });

  test('check_icon_names marca MISSING y resuelve alias', () => {
    const r = runTool('check_icon_names', { names: ['interface/RocketIcon', 'lucide/AlertCircle', 'lucide/Hexagon', 'Rocket'] }, ctx);
    expect(r).toEqual({ ok: true, content: [
      { ref: 'interface/RocketIcon', ok: true },
      { ref: 'lucide/AlertCircle', ok: true, canonical: 'lucide/CircleAlert' },
      { ref: 'lucide/Hexagon', ok: false },
      { ref: 'Rocket', ok: false },
    ] });
  });

  test('un icono anidado se verifica contra el paquete', () => {
    const sec = (name: string) => ({ role: 'features', parts: [{ component: 'badge', props: { children: 'Nuevo', icon: { $component: `icon:${name}` } } }] });
    expect(verifySection(sec('interface/RocketIcon'), allow, ctx.schemas, icons).ok).toBe(true);
    expect(verifySection(sec('lucide/Hexagon'), allow, ctx.schemas, icons).violations.map((v) => v.code)).toEqual(['unknown-icon']);
  });

  test('read_component_doc no lee un slug fuera de la allowlist', () => {
    expect(runTool('read_component_doc', { slug: '../../etc/passwd' }, ctx)).toEqual({ ok: false, error: 'componente desconocido: ../../etc/passwd' });
  });

  test('list_icons busca en todos los sets, los propios primero', () => {
    expect(runTool('list_icons', { query: 'rock' }, ctx)).toEqual({ ok: true, content: { total: 2, refs: ['interface/RocketIcon', 'lucide/Rocket'] } });
  });
});
