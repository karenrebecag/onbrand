import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectLang, pageForeign, uiLiterals } from '../src/foreign-text';
import type { RenderInputBlock, VisibleBlock } from '../src/render-gate';

const seen = (slug: string, role: string, text: string, placeholders?: string[]): VisibleBlock =>
  ({ slug, role, text, height: 400, opacity: '1', images: 0, brokenImages: 0, ...(placeholders ? { placeholders } : {}) });
const footer: RenderInputBlock = { role: 'footer', slug: '11-footer', props: { title: 'Recibe las novedades del mes en tu correo' } };

describe('foreign-text: texto visible que no viene de page.json', () => {
  test('el chrome fijo del componente cuenta solo si su idioma no es el del brief', () => {
    const ui = new Set(['subscribe']);
    const view = [seen('11-footer', 'footer', 'Recibe las novedades del mes en tu correo Subscribe')];
    const es = pageForeign(view, [footer], ui);
    expect(es.summary.lang).toBe('es');
    expect(es.findings).toEqual([{ slug: '11-footer', role: 'footer', text: 'subscribe', kind: 'ui', lang: 'en' }]);
    expect(pageForeign(view, [footer], ui, 'en').findings).toEqual([]);
  });

  test('el texto que no está en el código ni en los props es demo, en cualquier idioma, y el placeholder cuenta', () => {
    const { findings } = pageForeign([seen('11-footer', 'footer', 'Recibe las novedades del mes en tu correo One email a month', ['you@example.com'])], [footer], new Set(), 'es');
    expect(findings.map((f) => [f.kind, f.text, f.lang])).toEqual([['demo', 'one email a month', 'en'], ['demo', 'you@example.com', undefined]]);
  });

  test('los literales de UI salen del código del componente, no de los datos de demo; una clase con espacio entra pero nunca se ve', () => {
    const root = mkdtempSync(join(tmpdir(), 'ft-'));
    mkdirSync(join(root, 'footer'));
    writeFileSync(join(root, 'footer', 'footer.tsx'), 'const s = state === "done" ? "Subscribed" : "Subscribe";\nexport const F = () => <button className="row gap">Send it</button>;\n');
    writeFileSync(join(root, 'footer', 'footer-data.ts'), 'export const copy = { title: "Get the monthly release notes" };\n');
    expect([...uiLiterals(root)].sort()).toEqual(['row gap', 'send it', 'subscribe', 'subscribed']);
  });

  test('el idioma sale de las palabras funcionales y no se adivina sin señal', () => {
    expect(detectLang('finance teams are on the list')).toBe('en');
    expect(detectLang('Cierra el mes sin hojas de cálculo')).toBe('es');
    expect(detectLang('Feche o mês com mais controle e não perca nada')).toBe('pt');
    expect(detectLang('Subscribe')).toBeUndefined();
  });
});
