import { describe, expect, test } from 'bun:test';
import { countWords, describeBudget, fitToBudget, jq, parseBudget } from '../src/copygen/budget';

// jq replica el presupuesto de Relume desde el texto default (page-content.js:208).
describe('jq — presupuesto desde el texto default', () => {
  test('una palabra -> "1 word"; hasta 5 -> N words; 6..15 -> N+2 words', () => {
    expect(describeBudget(jq('Button'))).toBe('1 word');
    expect(describeBudget(jq('Name Surname'))).toBe('2 words');
    expect(describeBudget(jq('Medium length section heading goes here'))).toBe('8 words');
  });

  test('más de 15 palabras: 1 punto -> "1 sentence"; pocos puntos -> floor(t/15) sentences; muchos -> N sentences', () => {
    const one = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore.';
    expect(describeBudget(jq(one))).toBe('1 sentence');
    const twoDots = `${one} Ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure dolor.`;
    expect(describeBudget(jq(twoDots))).toBe('2 sentences');
    // 60 palabras y 4 puntos: 15*4 no supera a 60, así que manda el número de puntos.
    const fifteen = 'a b c d e f g h i j k l m n o.';
    expect(describeBudget(jq(`${fifteen} ${fifteen} ${fifteen} ${fifteen}`))).toBe('4 sentences');
    // Quirk heredado de Relume: largo sin puntos -> "0 sentences".
    expect(describeBudget(jq('a b c d e f g h i j k l m n o p q'))).toBe('0 sentences');
  });

  test('varias líneas con 3+ puntos y 10+ palabras -> N paragraphs', () => {
    const paras = 'Uno dos tres cuatro cinco seis. Siete ocho.\nNueve diez once doce. Trece catorce quince.';
    expect(describeBudget(jq(paras))).toBe('2 paragraphs');
  });

  test('parseBudget invierte describeBudget', () => {
    for (const s of ['1 word', '7 words', '1 sentence', '3 sentences', '2 paragraphs']) {
      const b = parseBudget(s);
      expect(b && describeBudget(b)).toBe(s);
    }
    expect(parseBudget('mucho')).toBeUndefined();
  });
});

describe('fitToBudget — text-fit determinista', () => {
  test('lo que cabe no se toca; lo que sobra cierra en fin de frase antes que a media idea', () => {
    expect(fitToBudget('Agendar una demo', { unit: 'words', n: 4 })).toBe('Agendar una demo');
    const long = 'Acme Pulse responde el WhatsApp de un e-commerce y recupera carritos. Agendar una demo es el primer paso.';
    expect(fitToBudget(long, { unit: 'words', n: 16 })).toBe('Acme Pulse responde el WhatsApp de un e-commerce y recupera carritos.');
  });

  test('sin fin de frase a la vista corta en cláusula o en palabra plena, nunca en artículo/preposición', () => {
    expect(fitToBudget('Agente de IA que responde el WhatsApp de tu tienda', { unit: 'words', n: 8 })).toBe('Agente de IA que responde el WhatsApp');
    expect(fitToBudget('Resume el research, redacta el spec y conecta tus herramientas.', { unit: 'words', n: 7 })).toBe('Resume el research, redacta el spec.');
  });

  test('presupuesto en frases conserva N frases enteras y las comillas envolventes', () => {
    const quote = '"Con Lumen confirmamos citas sin llamar. Se nota desde la primera semana. Y el equipo respira."';
    expect(fitToBudget(quote, { unit: 'sentences', n: 2 })).toBe('"Con Lumen confirmamos citas sin llamar. Se nota desde la primera semana."');
    expect(countWords(fitToBudget('a b c d e', { unit: 'paragraphs', n: 1 }))).toBe(5);
  });
});
