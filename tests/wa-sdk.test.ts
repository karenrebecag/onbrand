import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factsForLang, parseTracking } from '../src/brand-facts';
import { readWaSdk, WA_SDK_BUNDLE, withWaSdk, writeWaSdk } from '../src/wa-sdk';
import { agentSystemPrompt } from '../src/runtime/agent-prompt';
import { serve } from '../scripts/static-serve';

const TOKEN = '00000000-0000-4000-8000-000000000001';
const tracking = { companyToken: TOKEN, whatsapp: { es: '5215555550100', pt: '5511987654321' } };
const HTML = '<!doctype html><html lang="pt"><head><title>x</title></head><body><div id="root"></div></body></html>';
const scripts = (html: string) => html.match(/<script\b[^>]*atom-whatsapp-buttons[^>]*>/g) ?? [];

describe('SDK de WhatsApp', () => {
  test('el tracking exige un token UUID y whatsapp.es; lo que no valida da el motivo, no un tracking', () => {
    expect(parseTracking(TOKEN.toUpperCase(), { es: '+5215555550100', pt: '5511987654321', en: '' })).toEqual({ tracking: { companyToken: TOKEN, whatsapp: { es: '5215555550100', pt: '5511987654321' } } });
    expect(parseTracking(undefined, { es: '5215555550100' })).toEqual({});
    expect(parseTracking('pk_live_123', { es: '5215555550100' }).issue).toBe('companyToken no es un UUID');
    expect(parseTracking(TOKEN, { es: '51 907 881 217' }).issue).toBe('whatsapp.es no son dígitos con prefijo de país');
    expect(parseTracking(TOKEN, { pt: '5511987654321' }).issue).toBe('falta whatsapp.es, el número por defecto');
  });

  test('withWaSdk deja un solo bundle fijado en attach con el idioma de la página; quita el del agente y es idempotente', () => {
    const agentWrote = HTML.replace('</body>', '<script src="https://atom-whatsapp-buttons.vercel.app/v1/loader.js" data-company-token="otro"></script></body>');
    const once = withWaSdk(agentWrote, tracking, { webhookUrl: '/__wci-sink' });
    expect(withWaSdk(once, tracking, { webhookUrl: '/__wci-sink' })).toBe(once);
    const [tag] = scripts(once);
    expect(scripts(once)).toHaveLength(1);
    for (const attr of [`src="${WA_SDK_BUNDLE.src}"`, `integrity="${WA_SDK_BUNDLE.integrity}"`, 'crossorigin="anonymous"', `data-company-token="${TOKEN}"`, 'data-phone="5215555550100"', 'data-phone-pt="5511987654321"', 'data-lang="pt"', 'data-mode="attach"', 'data-webhook-url="/__wci-sink"']) expect(tag).toContain(attr);
    expect(tag).not.toContain('loader.js');
    expect(tag).not.toContain('data-phone-en');
    expect(once.indexOf('<script')).toBeGreaterThan(once.indexOf('id="root"'));
    // Sin webhookUrl (solo el deploy) no hay override: el SDK usa el endpoint real.
    expect(withWaSdk(HTML, tracking)).not.toContain('data-webhook-url');
    expect(withWaSdk(HTML.replace('lang="pt"', 'lang="pt onload=x"'), tracking)).not.toContain('data-lang');
  });

  test('wa-sdk.json se escribe con el tracking, se borra sin él y uno alterado en el workspace no se lee', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-wa-'));
    writeWaSdk(dir, tracking);
    expect(readWaSdk(dir)).toEqual(tracking);
    writeFileSync(join(dir, 'wa-sdk.json'), JSON.stringify({ companyToken: '"><script>x</script>', whatsapp: { es: '5215555550100' } }));
    expect(readWaSdk(dir)).toBeUndefined();
    writeWaSdk(dir, undefined);
    expect(existsSync(join(dir, 'wa-sdk.json'))).toBe(false);
  });

  test('static-serve con tracking sirve / con el bundle apuntando al sink del mismo origen, y el sink guarda el POST', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'wt-wa-dist-'));
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'index.html'), HTML);
    const seen: unknown[] = [];
    const server = serve(dist, 'index.html', { waSdk: tracking, onSink: (p) => seen.push(p) });
    try {
      const html = await (await fetch(`http://localhost:${server.port}/`)).text();
      expect(scripts(html)[0]).toContain('data-webhook-url="/__wci-sink"');
      expect(html).not.toContain('api.atomchat.io');
      const sink = await fetch(`http://localhost:${server.port}/__wci-sink`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ chatId: 'Ab3x9', cta: 'agendar_demo' }) });
      expect(sink.status).toBe(204);
      expect((await fetch(`http://localhost:${server.port}/__wci-sink`)).status).toBe(204);
      expect(seen).toEqual([{ chatId: 'Ab3x9', cta: 'agendar_demo' }]);
    } finally {
      server.stop(true);
    }
    const plain = serve(dist);
    try {
      expect(scripts(await (await fetch(`http://localhost:${plain.port}/`)).text())).toEqual([]);
      expect((await fetch(`http://localhost:${plain.port}/__wci-sink`)).status).toBe(404);
    } finally {
      plain.stop(true);
    }
  });

  test('una página pt lleva en la regla de botones el número pt del tracking', () => {
    const facts = factsForLang({ whatsapp: '+5215555550100', tracking }, 'pt');
    const p = agentSystemPrompt({ skillDir: '.wt/skill', hasBrowser: true, followUp: false, brand: { name: 'Atom', facts } });
    expect(p).toContain('https://wa.me/5511987654321?text=');
    expect(p).not.toContain(TOKEN);
    expect(factsForLang({ whatsapp: '+5215555550100', tracking }, 'en').whatsapp).toBe('+5215555550100');
  });
});
