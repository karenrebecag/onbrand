// docs/spec/identidad-sesion.md §5 y §10 fase 2: en una ruta con :id el dueño se resuelve antes que el scope. Un chat
// ajeno o inexistente da 404 con el mismo cuerpo aunque la sesión no tenga el scope de la ruta. Con el scope primero, un
// 403 confirmaría que el id existe (arq-spec 3b). Se mide por HTTP con una sesión del puerto de §3 (`opts.session`)
// sin scopes:
//   - una ruta sin id (POST /runs) da 403: prueba que el scope sí se aplica, así el 404 de abajo no es solo "ruta sin
//     verifier";
//   - cada familia de ruta con id da 404 sobre un id que no es de esa sesión.
// Verde desde la fase 2: el dueño se resuelve antes que el scope y antes que el proveedor.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Scope } from '../src/runtime/session';
import { Runtime } from '../src/runtime/server';

const JSON_HEADERS = { 'content-type': 'application/json' };
const B_WITHOUT_SCOPES = { owner: 'B', scopes: new Set<Scope>() };
const verifier = { verify: async () => B_WITHOUT_SCOPES };
const ID = 'chat-de-a';

// Una por familia de §5: /chats/:id/*, /runs/:id/*, /variants/:id/cancel.
const ID_ROUTES: readonly [string, string][] = [
  ['GET', `/chats/${ID}`],
  ['GET', `/chats/${ID}/canvas`],
  ['GET', `/chats/${ID}/plans/p1`],
  ['PUT', `/chats/${ID}/plans/p1`],
  ['POST', `/chats/${ID}/approvals/call-1`],
  ['POST', `/runs/${ID}/cancel`],
  ['POST', `/runs/${ID}/publish`],
  ['GET', `/runs/${ID}/files`],
  ['POST', `/variants/${ID}/cancel`],
];

let tmp: string | undefined;
afterEach(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); tmp = undefined; });

test('con una sesión sin scopes, toda ruta con :id ajeno da 404 y la ruta sin id da 403', async () => {
  tmp = mkdtempSync(join(tmpdir(), 'estandares-404-403-'));
  const root = join(tmp, 'state');
  const scaffold = join(tmp, 'scaffold');
  mkdirSync(root, { recursive: true });
  mkdirSync(scaffold, { recursive: true });
  // `session` es el campo de §3; hoy RuntimeOptions no lo tiene y se ignora.
  const opts = { root, allow: {}, compose: async () => ({ sections: [] }), build: false, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), session: verifier };
  const s = new Runtime(opts).listen(0);
  await new Promise((r) => s.once('listening', r));
  const at = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  const call = (method: string, path: string) => fetch(`${at}${path}`, { method, headers: JSON_HEADERS, ...(method === 'GET' ? {} : { body: '{}' }) });
  try {
    expect((await call('POST', '/runs')).status).toBe(403);
    const got = await Promise.all(ID_ROUTES.map(async ([m, p]) => `${m} ${p} ${(await call(m, p)).status}`));
    expect(got).toEqual(ID_ROUTES.map(([m, p]) => `${m} ${p} 404`));
  } finally {
    s.close();
  }
});
