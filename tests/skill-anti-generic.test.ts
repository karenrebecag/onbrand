import { expect, test } from 'bun:test';
import { EXAMPLE_DARK, EXAMPLE_LIGHT, identityReference } from '../src/ds-skill-agent';
import { familyOf } from '../src/identity-ephemeral';

// Regla de sistema de Lovable (L1, RE 2026-10-27) que Karen aprobó: nuestras corridas sin marca cayeron en índigo
// (live5, live7) e Inter de cuerpo (live6, live7, demo cc7b8016). El ejemplo no puede enseñar lo que la regla prohíbe.
test('identity.md descarta lo genérico y su ejemplo no usa Inter ni Poppins de cuerpo', () => {
  const md = identityReference([]);
  expect(md).toContain('## Sin estética genérica');
  expect(md).toContain('Inter o Poppins como fuente de');
  expect(md).toContain('índigo o violeta sobre fondo blanco');
  for (const block of [EXAMPLE_LIGHT, EXAMPLE_DARK]) expect(['Inter', 'Poppins']).not.toContain(familyOf(block['--font-body']));
});
