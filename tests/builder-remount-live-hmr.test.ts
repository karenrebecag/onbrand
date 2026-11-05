// QA u3 (b) sobre main a352af5d, en vivo con el builder: tras duplicar una sección o reemplazar una imagen, el cambio
// entra por HMR con estado (vite manda js-update de App.tsx o de la sección), y ~5 s después del fin de la corrida el
// builder reemplaza los dos iframes (key nueva) y la página recarga entera: se pierden scroll, selección y estado. Sin
// builder no recarga. Causa: framesToRemount (preview-heartbeat.ts:29) remonta con cualquier cambio de versión, también
// de live a live, donde vite ya aplicó el cambio en la página. R4.6 lo pide para la url estable que sirve un dist o la
// página de carga; con vite vivo la página no queda vieja. Si el dueño
// prefiere remontar solo tras corridas de agente, este test cambia con ese contrato.
import { expect, test } from 'bun:test';
import { framesToRemount } from '../apps/builder/src/lib/preview-heartbeat';

test('un cambio de versión con vite vivo antes y después no remonta el marco: ya entró por HMR', () => {
  const prev = { a: { status: 'live' as const, version: 's1' } };
  const next = { a: { status: 'live' as const, version: 's2' } };
  expect(framesToRemount(prev, next)).toEqual([]);
});
