import { expect, test } from 'bun:test';
import { PAGE_LAYOUT_EXAMPLE } from '../src/ds-skill-agent';

// El ejemplo hablaba del mismo negocio que el brief de QA (WhatsApp, inbox, ventas) y el agente podía copiar su copy:
// el ejemplo enseña la forma, así que su dominio no se cruza con el de las pruebas.
test('el ejemplo page-layout no usa el dominio del brief de QA', () => {
  for (const word of ['WhatsApp', 'Instagram', 'inbox', 'ventas', 'asistente', 'conversaciones']) expect(PAGE_LAYOUT_EXAMPLE).not.toContain(word);
});
