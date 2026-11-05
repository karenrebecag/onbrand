// Sensores de contenido sobre una página ya medida (salida de page-sensors --json, o una medida suelta del preview de
// v0 tomada con page-sensors.browser.js).
//   bun scripts/content-sensors.ts --sensors page.json [--brief-file brief.txt] [--message-file resumen.txt]
//     [--corpus dir …] [--lang es] [--before anterior.json] [--json out.json]
// --corpus son los directorios del DS que el agente lee (scaffold, starter, referencias): sus literales de demo son
// lo que no puede salir en pantalla. --message-file es el texto final del mensaje: sin él no se afirma
// facts.disclosed. Sale 1 si hay defectos.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { contentSensors } from '../src/content-sensors';
import type { Lang } from '../src/foreign-text';
import type { PageMeasure } from '../src/page-sensors';
import { demoLiterals } from '../src/render-gate';

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const all = (n: string): string[] => args.flatMap((a, i) => (a === n && args[i + 1] ? [args[i + 1]] : []));
const text = (f: string | undefined): string | undefined => (f ? readFileSync(resolve(f), 'utf8') : undefined);

const sensors = flag('--sensors');
if (!sensors) { console.error('uso: bun scripts/content-sensors.ts --sensors page.json [--brief-file f] [--message-file f] [--corpus dir]'); process.exit(2); }
const lang = flag('--lang') as Lang | undefined;
if (lang && !['en', 'es', 'pt'].includes(lang)) { console.error(`--lang ${lang}: se espera en, es o pt`); process.exit(2); }
const raw = JSON.parse(readFileSync(resolve(sensors), 'utf8'));
const m: PageMeasure = raw.measures ? raw.measures[0] : raw;
const before = flag('--before');
const measureOf = (f: string): PageMeasure => { const r = JSON.parse(readFileSync(resolve(f), 'utf8')); return r.measures ? r.measures[0] : r; };
const dirs = all('--corpus');
const corpus = dirs.length ? new Set(dirs.flatMap((d) => [...demoLiterals(resolve(d))])) : undefined;

const defects = contentSensors(m, { ...(lang ? { lang } : {}), ...(corpus ? { corpus } : {}), brief: text(flag('--brief-file')) ?? '', ...(flag('--message-file') ? { message: text(flag('--message-file')) } : {}), ...(before ? { before: measureOf(before) } : {}) });
const json = flag('--json');
if (json) writeFileSync(json, `${JSON.stringify({ target: sensors, corpus: corpus?.size ?? 0, defects }, null, 2)}\n`);
console.log(`${defects.length ? 'FAIL' : 'PASS'} ${sensors} defectos=${defects.length}${corpus ? ` corpus=${corpus.size}` : ''}`);
for (const d of defects) console.log(`  [${d.owner}] ${d.field} ${d.section}: ${d.message}`);
process.exitCode = defects.length ? 1 : 0;
