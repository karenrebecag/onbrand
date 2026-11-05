import { describe, expect, test } from 'bun:test';
import { ngrams, repetitionOf, textsOf } from '../src/exp/repetition';

const section = (title: string, body: string, cardTitle?: string) => ({
  role: 'x',
  children: [
    { layout: 'stack', children: [{ text: 'title', value: title }, { text: 'body', value: body }] },
    ...(cardTitle ? [{ component: 'card', props: { title: cardTitle, media: { $slot: { component: 'icon:lucide/Zap' } } } }] : []),
  ],
});

describe('repetición entre secciones', () => {
  test('recoge textos de nodos text y de props string, incluidos los de dentro de slots', () => {
    const t = textsOf({ role: 'x', children: [{ component: 'card', props: { title: 'A', children: { $slot: [{ text: 'body', value: 'B' }] } } }] });
    expect(t.titles).toEqual(['A']);
    expect(t.all.sort()).toEqual(['A', 'B']);
  });

  test('un titular repetido en dos secciones cuenta una vez, sin importar mayúsculas ni puntuación', () => {
    const r = repetitionOf([section('Tu equipo, en el mismo tablero', 'uno'), section('tu equipo en el mismo tablero.', 'dos'), section('Otra cosa', 'tres')]);
    expect(r.duplicateTitles).toEqual(['tu equipo en el mismo tablero']);
    expect(r.sections).toBe(3);
  });

  test('los 4-gramas compartidos entre secciones distintas marcan el par; dentro de una sección no cuentan', () => {
    const body = 'responde a tus clientes en segundos y recupera carritos';
    const r = repetitionOf([section('A', body), section('B', 'texto sin nada en común'), section('C', `El agente ${body} abandonados`)]);
    expect(r.pairs).toBe(3);
    expect(r.overlappingPairs).toBe(1);
    expect(r.sharedNgrams.length).toBeGreaterThan(0);
    expect(ngrams('a b c d e', 4)).toEqual(new Set());
    expect(ngrams('uno dos tres cuatro cinco', 4)).toEqual(new Set(['uno dos tres cuatro', 'dos tres cuatro cinco']));
  });
});
