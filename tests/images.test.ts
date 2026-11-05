import { describe, expect, test } from 'bun:test';
import { avatarFor, fillImages, logoFor, photoFor } from '../src/images';

const PH = 'https://d22po4pjz3o32e.cloudfront.net/placeholder-image.svg';

describe('fillImages', () => {
  test('un avatar de persona (alt = nombre) se reemplaza por un SVG de iniciales', () => {
    const out = fillImages({ avatar: { src: PH, alt: 'Mariana López' } }, 'seed');
    const src = (out.avatar as { src: string }).src;
    expect(src.startsWith('data:image/svg+xml,')).toBe(true);
    expect(decodeURIComponent(src)).toContain('>ML<');
  });

  test('un logo (alt "Logo de X") se reemplaza por un monograma de la marca', () => {
    const out = fillImages({ image: { src: PH, alt: 'Logo de Casa Verde' } }, 'seed');
    const src = (out.image as { src: string }).src;
    expect(decodeURIComponent(src)).toContain('>CV<');
  });

  test('una imagen genérica se reemplaza por una foto por seed', () => {
    const out = fillImages({ media: { src: PH, alt: 'captura del producto' } }, 'brief');
    expect((out.media as { src: string }).src).toContain('picsum.photos/seed/');
  });

  test('un src que no es placeholder no se toca', () => {
    const keep = { image: { src: 'https://cdn.example.com/real.jpg', alt: 'x' } };
    expect(fillImages(keep, 's')).toEqual(keep);
  });

  test('recorre arrays y no muta la entrada', () => {
    const input = { items: [{ avatar: { src: PH, alt: 'Ana Ruiz' } }, { avatar: { src: PH, alt: 'Beto Sol' } }] };
    const out = fillImages(input, 'seed');
    expect((input.items[0].avatar as { src: string }).src).toBe(PH);
    expect((out.items[1].avatar as { src: string }).src.startsWith('data:image/svg+xml,')).toBe(true);
  });

  test('avatarFor/logoFor son deterministas y photoFor codifica el seed', () => {
    expect(avatarFor('Mariana López')).toBe(avatarFor('Mariana López'));
    expect(logoFor('Logo de Ritmo Store')).toContain('%3E'); // SVG codificado
    expect(photoFor('a b')).toBe('https://picsum.photos/seed/a%20b/1200/900');
  });

  test('modo builder (como v0): avatar y logo locales, foto y cualquier asset del CDN de Relume quedan vacíos, nunca stock', () => {
    const out = fillImages({
      avatar: { src: PH, alt: 'Mariana López' },
      logo: { src: PH, alt: 'Logo de Casa Verde' },
      media: { src: PH, alt: 'captura del producto' },
      icon: { src: 'https://d22po4pjz3o32e.cloudfront.net/kit-icon.svg', alt: '' },
    }, 'seed', '', { photo: 'omit' }) as Record<string, { src: string }>;
    expect(out.avatar.src.startsWith('data:image/svg+xml,')).toBe(true);
    expect(out.logo.src.startsWith('data:image/svg+xml,')).toBe(true);
    expect(out.media.src).toBe('');
    expect(out.icon.src).toBe('');
  });
});

