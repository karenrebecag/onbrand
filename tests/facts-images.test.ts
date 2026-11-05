import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageExt, localizeFactImages, MAX_FACT_IMAGE } from '../src/facts-images';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const WEBP = new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')]);
const svg = (s: string) => new Uint8Array(Buffer.from(s));
const CDN = 'https://cdn.prod.website-files.com/68add96c398c867ed988e62d';

describe('imágenes de los hechos', () => {
  test('el tipo sale de los primeros bytes; ningún SVG entra, tampoco los que evaden una lista negra', () => {
    expect([PNG, JPG, WEBP].map(imageExt)).toEqual(['png', 'jpg', 'webp']);
    for (const bad of [
      '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><path d="M0"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><x:script xmlns:x="http://www.w3.org/2000/svg">alert(1)</x:script></svg>',
      '<svg><a href="&#106;avascript:alert(1)"><rect/></a></svg>',
      '<svg><rect/onload=alert(1)></svg>',
      '<html><body/></html>',
    ]) expect(imageExt(svg(bad))).toBeUndefined();
  });

  test('logos y fotos pasan a public/brand/facts/<hash>.<ext>; lo que no baja o no es imagen se quita y se cuenta; lo ya bajado no se pide', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-facts-img-'));
    const asked: string[] = [];
    const bytes: Record<string, Uint8Array> = { [`${CDN}/a.png`]: PNG, [`${CDN}/b.jpg`]: JPG, [`${CDN}/html.png`]: svg('<html/>'), [`${CDN}/grande.png`]: new Uint8Array(MAX_FACT_IMAGE + 1) };
    const fetchBytes = async (url: string) => { asked.push(url); if (url.endsWith('caida.png')) throw new Error('503'); return bytes[url]!; };
    const facts = {
      clients: [{ name: 'A', logo: `${CDN}/a.png` }, { name: 'B', logo: `${CDN}/caida.png` }, { name: 'C', logo: `${CDN}/grande.png` }],
      testimonials: [{ quote: 'q', person: 'Ana', photo: `${CDN}/b.jpg` }, { quote: 'q', person: 'Luis', photo: `${CDN}/html.png` }],
    };
    const r = await localizeFactImages(facts, dir, fetchBytes);
    expect(r.facts.clients?.[0]?.logo).toMatch(/^\/brand\/facts\/[0-9a-f]{16}\.png$/);
    expect(r.facts.clients?.slice(1).map((c) => c.logo)).toEqual([undefined, undefined]);
    expect(r.facts.testimonials?.map((t) => t.photo?.replace(/[0-9a-f]{16}/, 'H'))).toEqual(['/brand/facts/H.jpg', undefined]);
    expect([r.written.length, r.dropped]).toEqual([2, 3]);
    expect(readdirSync(join(dir, 'public', 'brand', 'facts'))).toHaveLength(2);
    expect(existsSync(join(dir, 'public', r.facts.clients![0].logo!))).toBe(true);
    asked.length = 0;
    const again = await localizeFactImages({ clients: [{ name: 'A', logo: `${CDN}/a.png` }] }, dir, fetchBytes);
    expect(asked).toEqual([]);
    expect(again.facts.clients?.[0]?.logo).toBe(r.facts.clients?.[0]?.logo);
  });

  test('una URL repetida se baja una vez, un archivo previo que ya no es imagen se vuelve a bajar y un directorio roto no tumba el paso', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-facts-img-'));
    let calls = 0;
    const fetchBytes = async () => { calls += 1; return PNG; };
    const twice = await localizeFactImages({ clients: [{ name: 'A', logo: `${CDN}/a.png` }, { name: 'B', logo: `${CDN}/a.png` }] }, dir, fetchBytes);
    expect([calls, twice.written.length, twice.facts.clients?.[0]?.logo === twice.facts.clients?.[1]?.logo]).toEqual([1, 1, true]);
    expect(readdirSync(join(dir, 'public', 'brand', 'facts')).some((f) => f.includes('.tmp-'))).toBe(false);
    writeFileSync(join(dir, 'public', twice.facts.clients![0].logo!), '<svg onload=x>');
    const again = await localizeFactImages({ clients: [{ name: 'A', logo: `${CDN}/a.png` }] }, dir, fetchBytes);
    expect([calls, again.written.length]).toEqual([2, 1]);
    const broken = mkdtempSync(join(tmpdir(), 'wt-facts-img-'));
    mkdirSync(join(broken, 'public', 'brand'), { recursive: true });
    writeFileSync(join(broken, 'public', 'brand', 'facts'), 'no es un directorio');
    const r = await localizeFactImages({ clients: [{ name: 'A', logo: `${CDN}/a.png` }] }, broken, fetchBytes);
    expect([r.facts.clients?.[0]?.logo, r.dropped]).toEqual([undefined, 1]);
  });
});
