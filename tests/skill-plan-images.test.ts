import { expect, test } from 'bun:test';
import { agentSkillMd } from '../src/ds-skill-agent';

// El foco y el detalle se fijan en el plan; cada imagen sale de la tool generate_image, nunca de un atributo del slot.
test('el SKILL.md ata foco y detalle a page-plan.md y pide las imágenes a generate_image', () => {
  const md = agentSkillMd({ light: { background: '#fff', foreground: '#000' }, dark: { background: '#000', foreground: '#fff' } });
  const rules = md.slice(md.indexOf('## Reglas de siempre'), md.indexOf('## Reglas duras'));
  expect(rules).toContain('`focal:` y `detalle:`');
  expect(rules).toContain('cuando el prompt dice que tienes la tool `generate_image`');
  expect(md.slice(md.indexOf('## Revisión final'))).toContain('el `src` que devolvió `generate_image`');
  expect(md).not.toContain('data-alt');
  expect(rules).toContain('Si escribes `page-plan.md`');
});
