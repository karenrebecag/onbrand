import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brandFactsLines, parseBrandFacts, readBrandFacts } from '../src/brand-facts';

describe('brand facts', () => {
  test('valida facts.json en el límite: tipa, recorta y exige fuente en las métricas', () => {
    const f = parseBrandFacts({ domain: 'zed.io', whatsapp: '+5215512345678', channels: ['WhatsApp'], clients: [{ name: ' Acme ', result: '+40 % de leads', source: 'caso-acme' }], metrics: [{ label: 'Mensajes al mes', value: '2 M', source: 'reporte-2026' }], prices: [{ plan: 'Pro', price: 'USD 49', period: 'al mes', includes: ['3 agentes'] }] });
    expect(f.clients?.[0]).toEqual({ name: 'Acme', result: '+40 % de leads', source: 'caso-acme' });
    expect(f.prices?.[0]).toEqual({ plan: 'Pro', price: 'USD 49', period: 'al mes', includes: ['3 agentes'] });
    expect(() => parseBrandFacts({ metrics: [{ label: 'x', value: '1' }] })).toThrow('metrics[0].source');
    expect(() => parseBrandFacts({ domain: 'no es dominio' })).toThrow('domain');
    expect(() => parseBrandFacts({ whatsapp: '55 1234' })).toThrow('whatsapp');
    expect(() => parseBrandFacts({ clients: new Array(13).fill({ name: 'a' }) })).toThrow('12 entradas');
  });

  test('sin facts.json no hay hechos; con él, las líneas del prompt llevan dominio, wa.me, clientes y planes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'facts-'));
    expect(readBrandFacts(dir)).toBeUndefined();
    writeFileSync(join(dir, 'facts.json'), JSON.stringify({ domain: 'zed.io', whatsapp: '+5215512345678', clients: [{ name: 'Acme', result: '+40 % de leads', source: 'caso-acme' }], prices: [{ plan: 'Pro', price: 'USD 49', period: 'al mes' }] }));
    const lines = brandFactsLines(readBrandFacts(dir) as never);
    expect(lines).toEqual(['- Dominio: zed.io', '- WhatsApp: +5215512345678 (enlace wa.me/5215512345678)', '- Cliente: Acme — +40 % de leads (fuente: caso-acme)', '- Plan Pro: USD 49 al mes']);
  });
});
