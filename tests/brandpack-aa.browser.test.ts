import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { AA_FILE, AA_PAIRS, belowThreshold, measureAA, type AaReport } from '../scripts/brandpack-red';


// Contraste MEDIDO en chromium (oklch, color-mix y alpha resueltos por el navegador) de los pares que pinta una landing,
// para cada pack de la red. Registra el estado actual: no exige AA, exige que nada se mueva sin que se vea en el diff de
// aa-report.json. Los pares bajo umbral quedan listados en el reporte para el PR que los corrija.
describe('brandpack v2: contraste medido (estado actual)', () => {
  test('cada par es medible y coincide con aa-report.json', async () => {
    const recorded = JSON.parse(readFileSync(AA_FILE, 'utf8')) as AaReport;
    const measured = await measureAA();
    for (const themes of Object.values(measured)) {
      for (const pairs of Object.values(themes)) {
        expect(Object.keys(pairs)).toHaveLength(AA_PAIRS.length);
        for (const r of Object.values(pairs)) expect(r).toBeGreaterThanOrEqual(1);
      }
    }
    expect(measured).toEqual(recorded);
    // Visible en la salida del test: cuántos pares de hoy quedan bajo su umbral.
    console.info(`brandpack AA: ${belowThreshold(measured).length} pares bajo umbral`);
    // Levanta un navegador: bajo carga pasa de los 5 s por defecto sin que nada esté mal.
  }, 60_000);
});
