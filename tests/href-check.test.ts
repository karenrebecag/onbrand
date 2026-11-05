import { describe, expect, test } from 'bun:test';
import { anchorsOf, hrefPlaceholders, hrefResolves, hrefViolations } from '../src/runtime/href-check';

// Los ids vienen de sectionIds(roles) del runner (kebab-case, repetidos como -2, -3); aquí ya resueltos.
const policy = { anchors: anchorsOf(['hero', 'features', 'features-2', 'cta']), legalRoutes: ['/privacidad', '/terminos'] };

describe('regla de hrefs', () => {
  test('resuelve anclas de la página, rutas legales y destinos externos; rebota el resto', () => {
    expect(hrefResolves('#features', policy)).toBe(true);
    expect(hrefResolves('#features-2', policy)).toBe(true);
    expect(hrefResolves('#pricing', policy)).toBe(false);
    expect(hrefResolves('#', policy)).toBe(true);
    expect(hrefResolves('#  ', policy)).toBe(true);
    expect(hrefResolves('/privacidad', policy)).toBe(true);
    expect(hrefResolves('/about', policy)).toBe(false);
    expect(hrefResolves('https://x.com/nimbus', policy)).toBe(true);
    expect(hrefResolves('mailto:hola@nimbus.app', policy)).toBe(true);
    expect(hrefResolves('tel:+525512345678', policy)).toBe(true);
    expect(hrefResolves('', policy)).toBe(false);
  });

  test('recorre props, arrays y slots; no toca los textos ni claves fuera de props', () => {
    const section = {
      role: 'navbar',
      children: [
        {
          component: 'site-header',
          props: {
            brand: { name: 'Nimbus', href: '/' },
            items: [{ label: 'Funciones', href: '#features' }, { label: 'Blog', href: '/blog' }, { label: 'Precios', href: '#' }],
            primaryAction: { $slot: { component: 'button', props: { href: '#cta', children: 'Entrar a la lista' } } },
          },
        },
        { text: 'body', value: 'visita /blog o #nada' },
      ],
      link: '/fuera-de-props',
    };
    const v = hrefViolations(section, policy);
    expect(v.map((x) => x.path)).toEqual(['children[0].props.brand.href', 'children[0].props.items[1].href']);
    expect(v[1].href).toBe('/blog');
    expect(v[0].code).toBe('href-unresolved');
    expect(hrefPlaceholders(section)).toEqual([{ path: 'children[0].props.items[2].href' }]);
  });

  test('una sección sin hrefs no tiene violaciones', () => {
    expect(hrefViolations({ role: 'hero', children: [{ text: 'title', value: 'Hola' }] }, policy)).toEqual([]);
  });
});
