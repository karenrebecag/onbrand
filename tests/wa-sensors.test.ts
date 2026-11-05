import { expect, test } from 'bun:test';
import { chatIdOf, waSensors, type WaMeasure } from '../src/wa-sensors';
import { WA_SDK_BUNDLE, WCI_SINK } from '../src/wa-sdk';

const sdk = { companyToken: '3f2a9c1e-0b7d-4e5f-9a8b-1c2d3e4f5a6b', whatsapp: { es: '5215512345678', pt: '5511987654321' } };
const opened = (id: string) => `https://wa.me/5215512345678?text=${encodeURIComponent(`Hola\n\nEnlace de referencia: http://localhost/?wci=${id}`)}`;
const ok = (): WaMeasure => ({
  lang: 'es',
  scripts: [{ src: WA_SDK_BUNDLE.src, integrity: WA_SDK_BUNDLE.integrity, token: sdk.companyToken, mode: 'attach', phone: sdk.whatsapp.es, phonePt: sdk.whatsapp.pt, phoneEn: null, webhookUrl: WCI_SINK }],
  diskScripts: 0,
  stylesheets: [],
  floats: 0,
  links: [{ section: '02-hero', href: 'https://wa.me/5215512345678', atomButton: true, bound: true, cta: 'agendar_demo' }],
  clicks: [{ section: '02-hero', cta: 'agendar_demo', prevented: true, opened: opened('aB3x9'), dataLayerCta: 'agendar_demo' }],
  sink: [{ auth: `Bearer ${sdk.companyToken}`, body: '{"chatId":"aB3x9"}' }],
  atomchat: [],
  agentNumbers: [{ file: 'src/lib/wa.ts', phone: '5215512345678' }],
});
const fields = (m: WaMeasure) => waSensors(m, sdk).map((d) => d.field);
const withoutSdk = (m: WaMeasure) => waSensors(m, undefined).map((d) => d.field);

test('una página con el SDK en attach, adoptado y con clic completo no tiene defectos', () => {
  expect(waSensors(ok(), sdk)).toEqual([]);
});

test('sdk.script: sin tracking no hay script; con tracking, uno con el bundle fijado, sin hoja y sin api.atomchat.io', () => {
  expect(withoutSdk(ok())).toEqual(['sdk.script']);
  expect(withoutSdk({ ...ok(), scripts: [] })).toEqual([]);
  expect(fields({ ...ok(), scripts: [{ ...ok().scripts[0]!, src: 'https://atom-whatsapp-buttons.vercel.app/v1/loader.js', webhookUrl: null }] })).toEqual(['sdk.script']);
  expect(fields({ ...ok(), stylesheets: ['https://atom-whatsapp-buttons.vercel.app/v1/assets/styles.css'] })).toEqual(['sdk.script']);
  expect(fields({ ...ok(), atomchat: ['https://api.atomchat.io/wci'] })).toEqual(['sdk.script']);
  expect(fields({ ...ok(), diskScripts: 1 })).toEqual(['sdk.script']);
});

test('sdk.float: un botón propio del SDK es defecto', () => {
  expect(fields({ ...ok(), floats: 1 })).toEqual(['sdk.float']);
});

test('wa.adopted: un CTA sin data-atom-bound o con un cta fuera del enum es defecto; sin data-cta pasa', () => {
  const link = ok().links[0]!;
  expect(fields({ ...ok(), links: [{ ...link, bound: false }] })).toEqual(['wa.adopted']);
  expect(fields({ ...ok(), links: [{ ...link, cta: 'comprar' }] })).toEqual(['wa.adopted']);
  expect(fields({ ...ok(), links: [{ ...link, cta: null }], clicks: [{ ...ok().clicks[0]!, cta: null, dataLayerCta: 'default' }] })).toEqual([]);
});

test('wa.click: un wa.me sin chatId, sin webhook al sink o sin preventDefault es defecto', () => {
  const click = ok().clicks[0]!;
  expect(chatIdOf(opened('aB3x9'))).toBe('aB3x9');
  expect(fields({ ...ok(), clicks: [{ ...click, opened: 'https://wa.me/5215512345678?text=Hola' }] })).toEqual(['wa.click']);
  expect(fields({ ...ok(), sink: [] })).toEqual(['wa.click']);
  expect(fields({ ...ok(), clicks: [{ ...click, prevented: false }] })).toEqual(['wa.click']);
});

test('wa.number: el agente escribe un número distinto al de wa-sdk.json para el idioma de la página', () => {
  expect(waSensors({ ...ok(), agentNumbers: [{ file: 'src/lib/wa.ts', phone: '5215500000000' }] }, sdk).map((d) => [d.field, d.section])).toEqual([['wa.number', 'src/lib/wa.ts']]);
  expect(fields({ ...ok(), lang: 'pt', agentNumbers: [{ file: 'src/lib/wa.ts', phone: '5511987654321' }] })).toEqual([]);
});
