import { describe, expect, test } from 'bun:test';
import { suggestionsFromSummary, type Suggestion } from '../src/runtime/agent-summary';

const plain = (...t: string[]): Suggestion[] => t.map((x) => ({ title: x, message: x }));

// Resúmenes como los escribe sonnet (live5-7, demo cc7b8016): numerados, con comillas o en negrita, y viñetas con "-" o "•".
describe('agent-summary', () => {
  test('lee las sugerencias del apartado "Siguientes pasos" sin viñetas ni formato, máximo 3', () => {
    const s = ['1. Secciones: hero, beneficios, precios.', '3. "Datos de ejemplo": número de WhatsApp en src/sections/wa.ts.', '4. "Pendiente": nada.',
      '5. "Siguientes pasos":', '- Añadir una sección de **integraciones** con logos', '• Variante del hero con `video` del producto', '- Precios en USD y MXN', '- Una cuarta que sobra', '', '6. Otra cosa'].join('\n');
    expect(suggestionsFromSummary(s)).toEqual(plain('Añadir una sección de integraciones con logos', 'Variante del hero con video del producto', 'Precios en USD y MXN'));
  });

  test('acepta el título en negrita o como encabezado markdown y corta en el siguiente apartado', () => {
    expect(suggestionsFromSummary('**Siguientes pasos**\n1) Sección de FAQ más corta\n2) Testimonio con foto\n\n**Pendiente**\n- menú móvil')).toEqual(plain('Sección de FAQ más corta', 'Testimonio con foto'));
    expect(suggestionsFromSummary('## Next steps\n- Add pricing toggle\n## Pending\n- none')).toEqual(plain('Add pricing toggle'));
  });

  test('sin apartado devuelve [] (resúmenes anteriores al contrato siguen valiendo)', () => {
    expect(suggestionsFromSummary('Listo. Datos de ejemplo: ...\n- algo con viñeta pero sin apartado')).toEqual([]);
    expect(suggestionsFromSummary('')).toEqual([]);
  });
});

// S2: tras el primer follow-up el builder se quedaba sin chips porque el agente cerró sin "Siguientes pasos".
test('un follow-up sin siguientes pasos conserva los chips del padre, menos el que se pidió', async () => {
  const { turnSuggestions } = await import('../src/runtime/agent-summary');
  const parent = ['Agrega una franja de logos', 'Añade una tabla comparativa', 'Agrega enlaces legales al footer'];
  expect(turnSuggestions('Cambié el hero.', parent, 'Agrega una franja de logos')).toEqual(plain('Añade una tabla comparativa', 'Agrega enlaces legales al footer'));
  expect(turnSuggestions('Listo.\n\nSiguientes pasos:\n- Cambia el titular', parent, 'x')).toEqual(plain('Cambia el titular'));
  expect(turnSuggestions('Listo.', undefined, 'x')).toEqual([]);
});

// Lovable featureSuggestions (dashboard-shared bA): el chip lleva un título corto y el clic manda el pedido completo.
test('"Título: pedido" sale separado; sin título corto el chip muestra el pedido entero', async () => {
  const { turnSuggestions } = await import('../src/runtime/agent-summary');
  expect(suggestionsFromSummary('Siguientes pasos:\n- Franja de logos: Añade una franja de logos entre el hero y los beneficios\n- precios en USD y MXN.'))
    .toEqual([{ title: 'Franja de logos', message: 'Añade una franja de logos entre el hero y los beneficios' }, ...plain('Precios en USD y MXN')]);
  const parent = [{ title: 'Logos', message: 'Añade logos' }, { title: 'FAQ', message: 'Añade FAQ' }];
  expect(turnSuggestions('Listo.', parent, 'Añade logos')).toEqual([{ title: 'FAQ', message: 'Añade FAQ' }]);
});
