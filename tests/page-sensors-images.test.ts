import { expect, test } from 'bun:test';
import { pageSensors, type MeasuredSection, type PageMeasure } from '../src/page-sensors';

const sec = (key: string, role: string, images: MeasuredSection['images']): MeasuredSection =>
  ({ key, role, frame: false, height: 400, header: null, collections: [], hiddenBefore: 0, revealed: 0, text: 'texto de la sección en español para el sensor de idioma', images });
const page = (s: MeasuredSection[]): PageMeasure => ({ viewport: 1440, lang: 'es', title: 'Acme', animations: 0, sections: s, fonts: [] });
const img = (src: string, flat: boolean | null) => ({ src: `http://localhost:5310${src}`, alt: 'foto', width: 800, height: 600, flat });
const of = (r: ReturnType<typeof pageSensors>, field: string) => r.defects.filter((x) => x.field === field).map((x) => x.message);

// c734443f: el cupo de fal se agotó, image-slots dejó el placeholder gris y la página salió como lista.
test('image.pending marca la sección cuya imagen quedó pendiente, y no la cuenta también como lisa', () => {
  const s = [sec('02-hero', 'hero', [img('/images/hero.jpg', false)]), sec('03-features', 'features', [img('/images/03-features-1.jpg', true)])];
  const r = pageSensors([page(s)], { pendingImages: ['/images/03-features-1.jpg'] });
  expect(of(r, 'image.pending')).toEqual(['features: focal sin imagen: el generador falló (/images/03-features-1.jpg)']);
  expect(of(r, 'image.blank')).toEqual([]);
});

test('image.blank marca una imagen de un solo color que no está pendiente', () => {
  const s = [sec('03-features', 'features', [img('/placeholder-image.svg', true)]), sec('05-casos', 'testimonials', [img('/images/caso.jpg', null)])];
  expect(pageSensors([page(s)]).defects.filter((x) => x.field === 'image.blank').map((x) => x.section)).toEqual(['03-features']);
});
