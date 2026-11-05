import { expect, test } from 'bun:test';
import { EXAMPLE_DARK, EXAMPLE_LIGHT, exampleDesignMd, identityReference } from '../src/ds-skill-agent';
import { checkDesignMd, DESIGN_FILE } from '../src/identity-design';

// El agente copia el ejemplo: si el DESIGN.md del skill no pasa el validador de Front contra el identity.css del mismo
// ejemplo, enseña justo la contradicción que checkIdentity rechaza.
test('el DESIGN.md de ejemplo del skill pasa checkDesignMd contra el identity.css de ejemplo', () => {
  expect(checkDesignMd(exampleDesignMd(), EXAMPLE_LIGHT, EXAMPLE_DARK)).toEqual([]);
});

test('identity.md pide DESIGN.md en la raíz, después de identity.css, y lo omite con pack', () => {
  const md = identityReference([]);
  expect(md).toContain(`## ${DESIGN_FILE}: la identidad exportable`);
  expect(md).toContain('en la raíz');
  expect(md).toContain('Justo después de `src/identity.css`');
  expect(md).toContain('Con pack de marca');
  expect(md.indexOf('```md')).toBeGreaterThan(md.indexOf('```css'));
});
