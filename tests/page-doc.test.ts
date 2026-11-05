import { describe, expect, test } from 'bun:test';
import { pageDocErrors, projectDocument } from '../src/runtime/page-doc';

const HTML = '<!doctype html>\n<html lang="es" data-theme="light" data-accent="orange">\n  <head>\n    <meta charset="UTF-8" />\n    <title>Acme Pulse</title>\n  </head>\n</html>\n';

describe('page-doc', () => {
  test('proyecta lang, título y descripción sobre el index.html del scaffold, escapando el texto', () => {
    const out = projectDocument(HTML, { lang: 'en', title: 'Tom & "Jerry" <Co>', description: 'a > b' });
    expect(out).toContain('<html lang="en" data-theme="light" data-accent="orange">');
    expect(out).toContain('<title>Tom &amp; &quot;Jerry&quot; &lt;Co&gt;</title>');
    expect(out).toContain('<meta name="description" content="a &gt; b" />\n    <title>');
    expect(projectDocument(out, { description: 'otra' }).match(/name="description"/g)).toHaveLength(1);
    expect(projectDocument(HTML, {})).toBe(HTML);
  });

  test('valida solo los campos del documento; el resto del contrato pasa sin tocarse', () => {
    expect(pageDocErrors(undefined)).toEqual([]);
    expect(pageDocErrors({ lang: 'en', title: 'Nimbus', sections: [{ id: 'x' }], facts: {} })).toEqual([]);
    expect(pageDocErrors({ lang: 'English' })[0]).toContain('page.lang');
    expect(pageDocErrors({ title: '' })[0]).toContain('page.title');
    expect(pageDocErrors({ description: 'x'.repeat(301) })[0]).toContain('page.description');
    expect(pageDocErrors([])).toEqual(['page: debe ser un objeto']);
  });
});
