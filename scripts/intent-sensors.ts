// Sensores de intención sobre una página ya medida (salida de page-sensors --json, o una medida suelta del preview
// de v0 tomada con page-sensors.browser.js).
//   bun scripts/intent-sensors.ts --sensors page.json --brief-file brief.txt
//     [--attach nombre:2048x1450 …] [--before anterior.json --follow-up-file followup.txt] [--brand-pack brand.json] [--ws workspace]
// --attach y --before van con el follow-up: adjuntos del mensaje y la versión sobre la que se editó. Sale 1 si
// hay defectos. --ws es el workspace medido: con su page.json se afirma cta.link. --brand-pack es el brand.json del pack que pidió la página (page.brand); sin él y con --ws se afirma la identidad que el agente declaró en src/identity.css.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PageMeasure } from '../src/page-sensors';
import { brandSensors } from '../src/brand-sensors';
import { brandExpectOf } from '../src/brand';
import { emittedActions } from './emitted-sections';
import { identitySensors } from '../src/identity-ephemeral';
import { actionLinks, attachmentsUsed, brandNames, ctaTarget, deadLinks, editScope, imagesRequested, surfacePainted, type Attachment } from '../src/intent-sensors';

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const all = (n: string): string[] => args.flatMap((a, i) => (a === n && args[i + 1] ? [args[i + 1]] : []));
const measureOf = (f: string): PageMeasure => { const raw = JSON.parse(readFileSync(resolve(f), 'utf8')); return raw.measures ? raw.measures[0] : raw; };
const text = (f: string | undefined): string => (f ? readFileSync(resolve(f), 'utf8') : '');

const wsText = (rel: string): string => { const p = join(resolve(flag('--ws')!), rel); return existsSync(p) ? readFileSync(p, 'utf8') : ''; };

const sensors = flag('--sensors');
if (!sensors) { console.error('uso: bun scripts/intent-sensors.ts --sensors page.json --brief-file brief.txt [--attach n:WxH] [--before a.json --follow-up-file f.txt]'); process.exit(2); }
const m = measureOf(sensors);
const brief = text(flag('--brief-file'));
const attachments: Attachment[] = all('--attach').map((a) => {
  const hit = /^(.+):(\d+)x(\d+)$/.exec(a);
  if (!hit) { console.error(`--attach ${a}: se espera nombre:ANCHOxALTO`); process.exit(2); }
  return { name: hit[1], width: Number(hit[2]), height: Number(hit[3]) };
});
const before = flag('--before');
const defects = [
  ...deadLinks(m), ...ctaTarget(m, brief), ...brandNames(m, brief), ...surfacePainted(m),
  ...attachmentsUsed(m, attachments),
  ...(before ? editScope(measureOf(before), m, text(flag('--follow-up-file'))) : []),
  ...(before ? imagesRequested(measureOf(before), m, text(flag('--follow-up-file')), attachments) : []),
  ...(flag('--ws') ? actionLinks(m, emittedActions(resolve(flag('--ws')!))) : []),
  ...(flag('--brand-pack') ? brandSensors(m, brandExpectOf(JSON.parse(text(flag('--brand-pack'))))) : []),
  ...(!flag('--brand-pack') && flag('--ws') ? identitySensors(m, wsText('src/identity.css'), wsText('index.html')) : []),
];
console.log(`${defects.length ? 'FAIL' : 'PASS'} ${sensors} defectos=${defects.length}`);
for (const d of defects) console.log(`  [${d.owner}] ${d.field} ${d.section}: ${d.message}`);
process.exitCode = defects.length ? 1 : 0;
