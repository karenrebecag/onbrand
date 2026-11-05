import { expect, test } from 'bun:test';
import { planDisclosure, realDataSuggestion } from '../src/facts-disclosure';

const INVENTED = [{ slug: '04-testimonios', text: 'testimonios con nombres de clientes' }, { slug: '05-precios', text: 'precios de ejemplo' }];

// C4: el cruce de cada corrida es el `inventado:` del plan contra el resumen; el bench sigue cruzando la página medida.
test('el resumen que declara solo los testimonios deja los precios sin declarar; sin inventado no hay cruce', () => {
  expect(planDisclosure(INVENTED, '## Datos de ejemplo\n- Los testimonios son inventados.\n\n## Siguientes pasos')).toEqual({ invented: INVENTED, declared: true, undisclosed: ['prices'] });
  expect(planDisclosure(INVENTED, 'Armé la página.')).toEqual({ invented: INVENTED, declared: false, undisclosed: ['people', 'prices'] });
  expect(planDisclosure([], '## Datos de ejemplo')).toBeUndefined();
  expect(realDataSuggestion(INVENTED, 'es')).toEqual({ title: 'Usar mis datos reales', message: 'Reemplaza los datos de ejemplo (testimonios con nombres de clientes; precios de ejemplo) con mi información real: [tus datos].' });
  expect(realDataSuggestion(INVENTED, 'pt')?.title).toBe('Usar meus dados reais');
});
