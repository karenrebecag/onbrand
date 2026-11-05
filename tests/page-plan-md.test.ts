import { describe, expect, test } from 'bun:test';
import { parsePagePlanMd, planCount, planDefects, planInvented } from '../src/page-plan-md';

// El ejemplo de la spec plan-de-pagina-artefacto RF2, más una entrada de FAQ sin focal (permitido) y una de hero sin detalle.
const PLAN = `# Plan de página: Acme
Negocio: Acme (acme.test), agentes de IA que venden por WhatsApp
Acción principal: Agendar demo por WhatsApp → wa.me
Idioma: es

## 01-hero · #inicio
- titular: Multiplica tus ventas por WhatsApp sin crecer el equipo
- apoyo: Agentes de IA que responden, califican y agendan 24/7.
- cta: Agendar demo por WhatsApp → wa.me
- conteo: ninguno
- focal: mockup de conversación
- superficie: base
- inventado: 3 cifras del mockup

## 03-features · #funciones
- titular: Cero leads perdidos por responder tarde
- apoyo: Responde en segundos, de madrugada y en fin de semana.
- cta: ninguno
- conteo: 4 tarjetas
- focal: iconos por tarjeta
- detalle: chip con el dato al pie de cada tarjeta
- superficie: muted
- inventado: 380 % de tasa de contacto; HubSpot y Zoho como integraciones

## 07-faq: #preguntas
- titular: Preguntas frecuentes
- apoyo: Lo que preguntan los gerentes antes de probar.
- cta: ninguno
- conteo: 5 preguntas
- focal: ninguno
- superficie: base
- inventado: nada
`;

describe('page-plan-md', () => {
  test('lee cabecera, entradas NN-rol con ancla y los campos por línea', () => {
    const plan = parsePagePlanMd(PLAN);
    expect(plan.header).toEqual(['Negocio: Acme (acme.test), agentes de IA que venden por WhatsApp', 'Acción principal: Agendar demo por WhatsApp → wa.me', 'Idioma: es']);
    expect(plan.sections.map((s) => [s.slug, s.role, s.anchor])).toEqual([['01-hero', 'hero', 'inicio'], ['03-features', 'features', 'funciones'], ['07-faq', 'faq', 'preguntas']]);
    expect(plan.sections[1]?.fields).toEqual({ titular: 'Cero leads perdidos por responder tarde', apoyo: 'Responde en segundos, de madrugada y en fin de semana.', cta: 'ninguno', conteo: '4 tarjetas', focal: 'iconos por tarjeta', detalle: 'chip con el dato al pie de cada tarjeta', superficie: 'muted', inventado: '380 % de tasa de contacto; HubSpot y Zoho como integraciones' });
    expect(plan.sections.map(planCount)).toEqual([undefined, 4, 5]);
  });

  test('inventado junta lo declarado por sección y omite "nada"; los defectos nombran el campo que falta y el focal ninguno', () => {
    const plan = parsePagePlanMd(PLAN);
    expect(planInvented(plan)).toEqual([{ slug: '01-hero', text: '3 cifras del mockup' }, { slug: '03-features', text: '380 % de tasa de contacto; HubSpot y Zoho como integraciones' }]);
    expect(planDefects(plan)).toEqual([{ slug: '01-hero', message: 'falta detalle' }]);
    expect(planDefects(parsePagePlanMd('## 04-cases · #casos\n- titular: x\n- apoyo: y\n- cta: ninguno\n- conteo: 3 casos\n- focal: ninguno\n- detalle: d\n- superficie: inverse\n- inventado: nada'))).toEqual([{ slug: '04-cases', message: 'focal no admite ninguno en una sección de contenido' }]);
  });

  test('la cabecera llega sin viñetas, negritas ni backticks (999ea0e0 la escribió con "- " y `wa.me`)', () => {
    const plan = parsePagePlanMd('- negocio: **Acme**, agentes de IA\n* acción principal: agendar demo → `https://wa.me/521`\n- idioma: español\n\n## 01-hero · #inicio\n- titular: Hola\n');
    expect(plan.header).toEqual(['negocio: Acme, agentes de IA', 'acción principal: agendar demo → https://wa.me/521', 'idioma: español']);
    expect(plan.sections).toHaveLength(1);
  });

  test('texto vacío o sin entradas devuelve un plan vacío, no un error', () => {
    expect(parsePagePlanMd('')).toEqual({ header: [], sections: [] });
    expect(parsePagePlanMd('# Título\nsolo prosa\n').sections).toEqual([]);
  });

  test('la FAQ con rol en español (07-preguntas) también puede ir sin focal ni detalle', () => {
    expect(planDefects(parsePagePlanMd('## 07-preguntas · #preguntas\n- titular: x\n- apoyo: y\n- cta: ninguno\n- conteo: 5 preguntas\n- focal: ninguno\n- superficie: muted\n- inventado: nada'))).toEqual([]);
  });
});
