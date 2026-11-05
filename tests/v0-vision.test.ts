import { describe, expect, test } from 'bun:test';
import { cliDescribe, resultOf, streamTrace, visionArgs } from '../src/runtime/vision';

describe('cliDescribe', () => {
  // #403 medido: con Read cada tramo era una vuelta de modelo (35 s a 375, >120 s a 1440).
  test('manda las imágenes en el mensaje por stream-json, sin tools ni MCP ni ajustes del usuario', async () => {
    let args: string[] = [];
    let input = '';
    let timeout = 0;
    const describe = cliDescribe({
      model: 'haiku',
      run: async (_bin, a, i, t) => {
        args = a; input = i; timeout = t;
        return `${JSON.stringify({ type: 'system', subtype: 'init' })}\n${JSON.stringify({ type: 'result', result: '  La columna derecha de precios.\n' })}\n`;
      },
    });
    expect(await describe([Buffer.from('uno'), Buffer.from('dos')], '¿Qué columna queda vacía?', 30_000)).toBe('La columna derecha de precios.');
    const msg = JSON.parse(input).message;
    expect(msg.content.map((b: { type: string }) => b.type)).toEqual(['image', 'image', 'text']);
    expect(msg.content[0].source.data).toBe(Buffer.from('uno').toString('base64'));
    expect(msg.content[2].text).toContain('Pregunta: ¿Qué columna queda vacía?');
    expect(args).toEqual(visionArgs('haiku'));
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', '']);
    expect(args).toContain('--strict-mcp-config');
    expect(timeout).toBe(30_000);
  });

  test('un result con error o sin result es un fallo, no una respuesta', () => {
    expect(() => resultOf(JSON.stringify({ type: 'result', is_error: true, result: 'Prompt is too long' }))).toThrow('Prompt is too long');
    expect(() => resultOf('{"type":"system"}')).toThrow('no devolvió resultado');
  });

  // 024b517c: la visión de una sección vació los 40 s sin dejar rastro de por qué.
  test('la traza del corte cuenta los eventos que el CLI alcanzó a emitir', () => {
    const out = ['{"type":"system","subtype":"init"}', '{"type":"system","subtype":"api_retry"}', '{"type":"system","subtype":"api_retry"}', '{"type":"assis'].join('\n');
    expect(streamTrace(out)).toBe('system/init, system/api_retry×2');
    expect(streamTrace('')).toBe('ninguno');
  });
});
