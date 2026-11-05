import { expect, test } from 'bun:test';
import { createHmrRecover } from '../templates/base-scaffold/src/wt-hmr-recover';

const upd = (...paths: string[]) => ({ updates: paths.map((p) => ({ acceptedPath: p, path: p })) });

// c7c7ec26 (vite.log 11:57:01-11:58:43): cada update de App falla mientras el navbar no compila; el arreglo del navbar
// sale bien pero App sigue viejo, así que hay que recargar.
test('recarga cuando un update sale bien y otro módulo quedó sin su última versión', () => {
  let reloads = 0;
  const r = createHmrRecover(() => { reloads += 1; });
  r.before(upd('/src/App.tsx')); r.error(); r.after();
  r.before(upd('/src/App.tsx')); r.error(); r.after();
  expect(reloads).toBe(0);
  r.before(upd('/src/sections/01-navbar.tsx')); r.after();
  expect(reloads).toBe(1);
});

// El css que faltaba aparece y el App siguiente compila: App ya está al día y recargar sería un full-reload de más (A2).
test('no recarga si el propio módulo que falló se actualiza bien después', () => {
  let reloads = 0;
  const r = createHmrRecover(() => { reloads += 1; });
  r.before(upd('/src/App.tsx')); r.error(); r.after();
  r.before(upd('/src/App.tsx')); r.after();
  r.before(upd('/src/sections/02-hero.tsx')); r.after();
  expect(reloads).toBe(0);
});
