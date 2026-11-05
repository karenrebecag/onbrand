// Regenera src/theme/presets.json, contract.json y neutral-tones.json desde el contrato del core (tokens.css del DS base). Correr después de tocar los presets del
// contrato; tests/theme-presets.test.ts falla mientras el JSON no coincida.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { contractFromCss, presetsFromCss, serializePresets } from '../src/theme/presets-from-css';
import { neutralTonesFrom } from '../src/theme/neutral-tones';

const root = new URL('../', import.meta.url);
const css = readFileSync(fileURLToPath(new URL('templates/base-scaffold/src/theme/tokens.css', root)), 'utf8');
const out = fileURLToPath(new URL('src/theme/presets.json', root));
writeFileSync(out, serializePresets(presetsFromCss(css)));
console.log(`escrito ${out}`);
// El contrato claro/oscuro para la derivación de semilla (src/theme/seed.ts): mismo test de igualdad que presets.json.
const contractOut = fileURLToPath(new URL('src/theme/contract.json', root));
const contract = contractFromCss(css);
writeFileSync(contractOut, `${JSON.stringify(contract, null, 2)}\n`);
console.log(`escrito ${contractOut}`);
// Los tonos de la rampa neutra para theme.seed.neutral (seed.ts): tests/theme-seed.test.ts los compara con tokens.css.
const tonesOut = fileURLToPath(new URL('src/theme/neutral-tones.json', root));
writeFileSync(tonesOut, `${JSON.stringify(neutralTonesFrom(contract), null, 2)}\n`);
console.log(`escrito ${tonesOut}`);
