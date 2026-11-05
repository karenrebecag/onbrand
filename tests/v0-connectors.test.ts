import { describe, expect, test } from 'bun:test';
import { Connectors } from '../src/runtime/connectors';

const cfg = { clientId: 'id', clientSecret: 'secret', projectId: 'proj', environment: 'development', externalUserId: 'u1' };

function fake(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    calls.push(key);
    const h = routes[key];
    return h ? h() : new Response('no', { status: 500 });
  }) as typeof fetch;
  return { f, calls };
}
const token = () => Response.json({ access_token: 't', expires_in: 3600 });

describe('connectors', () => {
  test('un usuario sin cuentas (404 de Pipedream) es lista vacía y el token se pide una sola vez', async () => {
    const { f, calls } = fake({ 'POST /v1/oauth/token': token, 'GET /v1/connect/proj/users/u1/accounts': () => new Response('', { status: 404 }) });
    const c = new Connectors(cfg, f);
    expect(await c.accounts()).toEqual([]);
    await c.accounts();
    expect(calls.filter((k) => k.includes('oauth')).length).toBe(1);
  });

  test('no borra una cuenta que no es del usuario y descarta íconos de otro origen', async () => {
    const { f, calls } = fake({
      'POST /v1/oauth/token': token,
      'GET /v1/connect/proj/users/u1/accounts': () => Response.json([{ id: 'apn_1', app: { name_slug: 'slack' }, name: 'ws', healthy: true, dead: false }]),
      'GET /v1/connect/apps': () => Response.json({ data: [{ name_slug: 'slack', name: 'Slack', img_src: 'https://evil.example/x.png' }], page_info: { total_count: 1 } }),
    });
    const c = new Connectors(cfg, f);
    expect(await c.disconnect('apn_2')).toBe(false);
    expect(calls.some((k) => k.startsWith('DELETE'))).toBe(false);
    expect((await c.apps()).apps[0].icon).toBeNull();
  });
});
