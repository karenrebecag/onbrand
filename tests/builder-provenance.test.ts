import { describe, expect, test } from 'bun:test';
import { pageTitleFromFiles, pendingImagesFromFiles, planFromFiles, suggestionsFromFiles } from '../apps/builder/src/lib/provenance';

test('el título del builder sale de page.json.page.title y cae al prompt si no hay', () => {
  expect(pageTitleFromFiles([{ path: 'page.json', content: JSON.stringify({ page: { title: ' Nimbus ' } }) }])).toBe('Nimbus');
  expect(pageTitleFromFiles([{ path: 'page.json', content: JSON.stringify({ page: {} }) }])).toBeUndefined();
  expect(pageTitleFromFiles([{ path: 'page.json', content: '{' }])).toBeUndefined();
});

describe('siguientes pasos del agente (chips)', () => {
  test('salen de page.json.agent.suggestions: hasta 3, sin vacíos; sin page.json o ilegible, ninguno', () => {
    const page = (agent: unknown) => [{ path: 'page.json', content: JSON.stringify({ sections: [], agent }) }]
    expect(suggestionsFromFiles(page({ suggestions: [' Agrega FAQ ', '', 3, 'Precios en MXN', 'Video', 'Cuarto'] }))).toEqual(['Agrega FAQ', 'Precios en MXN', 'Video'].map((t) => ({ title: t, message: t })))
    expect(suggestionsFromFiles(page({ suggestions: [{ title: 'FAQ', message: 'Añade una FAQ' }, { title: '', message: 'x' }] }))).toEqual([{ title: 'FAQ', message: 'Añade una FAQ' }])
    expect(suggestionsFromFiles(page({}))).toEqual([])
    expect(suggestionsFromFiles([{ path: 'page.json', content: '{' }])).toEqual([])
    expect(suggestionsFromFiles([])).toEqual([])
  })
})

describe('planFromFiles', () => {
  const files = (agent: unknown) => [{ path: 'page.json', content: JSON.stringify({ page: {}, sections: [], agent }) }];

  test('lee agent.plan y descarta secciones mal formadas y campos fuera del contrato', () => {
    const plan = planFromFiles(files({ plan: { header: ['Negocio: Nimbus', 3], sections: [{ slug: '01-hero', role: 'hero', anchor: 'inicio', fields: { titular: 'Planifica sin reuniones', otro: 'x', cta: '' } }, { slug: 2 }] } }));
    expect(plan).toEqual({ header: ['Negocio: Nimbus'], sections: [{ slug: '01-hero', role: 'hero', anchor: 'inicio', fields: { titular: 'Planifica sin reuniones' } }] });
  });

  test('sin secciones válidas no hay plan, y pending sale de agent.images', () => {
    expect(planFromFiles(files({ plan: { header: ['x'], sections: [] } }))).toBeUndefined();
    expect(pendingImagesFromFiles(files({ images: { filled: ['/images/a.png'], pending: ['/images/b.png'] } }))).toEqual(['/images/b.png']);
  });
});
