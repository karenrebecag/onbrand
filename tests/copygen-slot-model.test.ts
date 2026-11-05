import { describe, expect, test } from 'bun:test';
import { extractDefaultLeaves, listCounts, placeholderText } from '../src/copygen/defaults';
import { assembleRoleCopy, roleCounts, roleFields, setPath } from '../src/copygen/role-fields';
import { blockSlotFields, budgetFor, budgetsOf, modelFromSource, semanticOf } from '../src/copygen/slot-model';

const SOURCE = `
type Props = { heading: string };
export const Testimonial3 = (props: Props) => null;
export const Testimonial3Defaults: Props = {
  heading: "Customer testimonials",
  description: "Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
  buttons: [{ title: "Button" }, { title: "Button", variant: "secondary" }],
  testimonials: [
    {
      image: { src: "https://x/webflow-logo.svg", alt: "Webflow logo 1" },
      quote:
        '"Lorem ipsum dolor sit amet, consectetur adipiscing elit. Suspendisse varius enim in eros elementum tristique. Duis cursus, mi quis viverra ornare."',
      name: "Name Surname",
      position: "Position",
      companyName: "Company name",
    },
    { image: { src: "s", alt: "a" }, quote: '"Lorem ipsum."', name: "Name Surname", position: "Position", companyName: "Company name" },
  ],
  socialLinks: [{ href: "#", icon: <BiLogoFacebookCircle className="size-6" /> }],
};
`;

describe('defaults — lectura de los Defaults de un bloque Relume sin ejecutarlo', () => {
  test('cada string sale con su ruta de claves (sin índices) y el JSX se ignora', () => {
    const leaves = extractDefaultLeaves(SOURCE);
    expect(leaves.find((l) => l.path.join('.') === 'heading')?.text).toBe('Customer testimonials');
    expect(leaves.filter((l) => l.path.join('.') === 'testimonials.quote').length).toBe(2);
    expect(leaves.find((l) => l.path.join('.') === 'buttons.title')?.text).toBe('Button');
    expect(leaves.some((l) => l.text.includes('BiLogo'))).toBe(false);
  });

  test('listCounts cuenta items por lista y placeholderText distingue cita, relleno y texto literal', () => {
    const counts = listCounts(extractDefaultLeaves(SOURCE));
    expect(counts.testimonials).toBe(2);
    expect(counts.buttons).toBe(2);
    expect(counts.heading).toBeUndefined();
    expect(placeholderText('"Lorem ipsum dolor"')).toBe('quote');
    expect(placeholderText('Lorem ipsum dolor')).toBe('placeholder');
    expect(placeholderText('Customer testimonials')).toBe('Customer testimonials');
  });
});

describe('slot-model — input text fields y presupuestos por semántica', () => {
  test('los campos llevan semántica por ruta (buttons.title es cta) y presupuesto jq del default', () => {
    const fields = blockSlotFields(SOURCE);
    const quote = fields.find((f) => f.path === 'testimonials.quote');
    expect(quote?.semantic).toBe('quote');
    expect(quote?.budget).toEqual({ unit: 'sentences', n: 1 });
    expect(fields.find((f) => f.path === 'buttons.title')?.semantic).toBe('cta');
    expect(fields.some((f) => f.path.endsWith('.alt') || f.path.endsWith('.src'))).toBe(false);
    expect(fields.map((f) => f.id)).toEqual(fields.map((_, i) => i + 1));
  });

  test('budgetsOf toma el primer slot por semántica y budgetFor aplica el piso de palabras a un CTA de "Button"', () => {
    const budgets = budgetsOf(blockSlotFields(SOURCE));
    expect(budgets.heading).toEqual({ unit: 'words', n: 2 });
    expect(budgetFor('cta', budgets)).toEqual({ unit: 'words', n: 4 });
    // Sin bloque: canon Relume ("Medium length section heading goes here" -> 8 words).
    expect(budgetFor('heading', undefined)).toEqual({ unit: 'words', n: 8 });
    expect(semanticOf(['questions', 'title'])).toBe('question');
    expect(semanticOf(['logos', 'alt'])).toBeUndefined();
  });

  test('modelFromSource junta campos, presupuestos y conteos, y roleCounts los acota', () => {
    const model = modelFromSource('t3', SOURCE);
    expect(model.counts.testimonials).toBe(2);
    const counts = roleCounts(model.counts);
    expect(counts.testimonials).toBe(2);
    expect(roleCounts({ questions: 12 }).faq).toBe(6);
    expect(roleCounts({}).features).toBe(3);
  });
});

describe('role-fields — campos del copy agnóstico y ensamblado', () => {
  test('roleFields enumera los items según los conteos y assembleRoleCopy reconstruye el árbol', () => {
    const fields = roleFields('testimonials', roleCounts({ testimonials: 2 }));
    expect(fields.filter((f) => f.semantic === 'quote').length).toBe(2);
    const copy = assembleRoleCopy([
      { path: 'testimonials.heading', text: 'Lo que dicen' },
      { path: 'testimonials.items[0].quote', text: '"Bien."' },
      { path: 'testimonials.items[0].name', text: 'Ana' },
      { path: 'hero.secondaryCta', text: '  ' },
      { path: 'stats.stats[0].label', text: 'Siempre' },
      { path: 'pricing.heading', text: 'Planes' },
    ], 'es');
    expect(copy.testimonials?.items[0].quote).toBe('"Bien."');
    // Un opcional vacío no se escribe; stats trae número de muestra; pricing trae su sufijo.
    expect(copy.hero).toBeUndefined();
    expect(copy.stats?.stats[0].value).toBe(24);
    expect(copy.pricing?.periodLabel).toBe('/mes');
  });

  test('setPath no muta la entrada', () => {
    const base = { a: { b: ['x'] } };
    const next = setPath(base, 'a.b[1]', 'y') as typeof base;
    expect(base.a.b).toEqual(['x']);
    expect(next.a.b).toEqual(['x', 'y']);
  });
});
