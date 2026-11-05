// Barrido de #602-#606 sobre lo que sus tests no fijan: el plegado del hilo por el transport real (numeración tras resumir
// en turnos seguidos, respaldo sin modelo, sin archivos viejos sueltos) y la CSP del preview (#604) con el upgrade de HMR y
// una página que trae su propia CSP. Sin LLM ni reloj: el resumen es inyectado y vite es un TCP falso.
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTscError } from '../src/runtime/direct-edit';
import { readEvents } from '../src/runtime/events';
import { commitAll, initRepo, restoreTree } from '../src/runtime/git-workspace';
import { writeFollowUpContext } from '../src/runtime/follow-up-context';
import type { PreviewPool } from '../src/runtime/preview';
import { startPreviewServer, type PreviewResolve } from '../src/runtime/preview-serve';
import type { PageModel } from '../src/runtime/runner';
import { Runtime, type ComposeRequest } from '../src/runtime/server';

describe('#602 plegado del hilo por el transport', () => {
  let tmp: string;
  let root: string;
  let server: HttpServer | undefined;
  // Lo que el agente encontró en .wt/context/conversation_history al empezar cada turno.
  let history: Record<string, Record<string, string>>;
  let asked: string[];
  let summaryFails: boolean;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'fold-http-'));
    root = join(tmp, 'state');
    mkdirSync(join(tmp, 'scaffold', 'src'), { recursive: true });
    writeFileSync(join(tmp, 'scaffold', '.gitignore'), 'node_modules\n');
    writeFileSync(join(tmp, 'scaffold', 'src', 'main.tsx'), '// main\n');
    mkdirSync(join(tmp, 'vault'));
    history = {};
    asked = [];
    summaryFails = false;
  });
  afterEach(() => {
    server?.close();
    server = undefined;
    rmSync(tmp, { recursive: true, force: true });
  });

  async function agent(req: ComposeRequest): Promise<PageModel> {
    const dir = req.workspace?.dir as string;
    // Como agent-composer.ts:287: el composer vuelca req.history a .wt/context antes del turno.
    if (req.history) writeFollowUpContext(dir, req.history);
    const ch = join(dir, '.wt', 'context', 'conversation_history');
    history[req.messageId] = existsSync(ch) ? Object.fromEntries(readdirSync(ch).sort().map((f) => [f, readFileSync(join(ch, f), 'utf8')])) : {};
    writeFileSync(join(dir, 'src', `${req.messageId}.tsx`), 'export {}\n');
    return { sections: [], agent: { files: [`src/${req.messageId}.tsx`], summary: `hecho ${req.messageId}`, missing: [], sessionId: `s-${req.messageId}` } } as unknown as PageModel;
  }

  async function boot(): Promise<string> {
    const threadSummary = async (_s: string, user: string): Promise<unknown> => {
      asked.push(user);
      if (summaryFails) throw new Error('sin red');
      return { summary: `- resumen de ${(JSON.parse(user) as { turns: unknown[] }).turns.length} pedidos` };
    };
    const t = new Runtime({ root, allow: {}, agent: true, compose: agent, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), autoRepair: false, threadSummary: threadSummary as never });
    server = t.listen(0);
    await new Promise((r) => server!.once('listening', r));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }

  async function chain(at: string, ids: string[]): Promise<void> {
    let parent: string | undefined;
    for (const id of ids) {
      const r = await fetch(`${at}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: `pedido ${id}`, messageId: id, ...(parent ? { parentId: parent } : {}) }) });
      expect(r.status).toBe(202);
      for (let i = 0; i < 1000 && !readEvents(join(root, 'logs'), id).events.some((e) => e.type === 'settled'); i++) await new Promise((res) => setTimeout(res, 10));
      parent = id;
    }
  }

  test('turnos seguidos tras el tope: summary.md y la numeración siguen la cadena, sin archivos del turno anterior', async () => {
    const at = await boot();
    const ids = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'];
    await chain(at, ids);
    // f5 ve 4 pedidos (f1-f4): dentro del tope, sin resumen y sin llamar al modelo.
    expect(Object.keys(history.f5 ?? {})).toEqual(['01-f1.md', '02-f2.md', '03-f3.md', '04-f4.md']);
    // f6 ve 5: f1 al resumen, f2-f5 íntegros con su número de la cadena.
    expect(Object.keys(history.f6 ?? {})).toEqual(['02-f2.md', '03-f3.md', '04-f4.md', '05-f5.md', 'summary.md']);
    expect(history.f6?.['02-f2.md']).toStartWith('# Pedido 2\n');
    expect(history.f6?.['summary.md']).toContain('Los pedidos 1 a 1');
    // f7 ve 6: el resumen cubre dos y ningún archivo de f6 queda suelto (01, 02 o el summary viejo).
    expect(Object.keys(history.f7 ?? {})).toEqual(['03-f3.md', '04-f4.md', '05-f5.md', '06-f6.md', 'summary.md']);
    expect(history.f7?.['summary.md']).toContain('- resumen de 2 pedidos');
    // El modelo solo ve los pedidos viejos de cada plegado.
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain('pedido f2');
    expect(asked[1]).not.toContain('pedido f3');
  });

  test('sin modelo el follow-up igual corre y el resumen es la lista de pedidos viejos', async () => {
    summaryFails = true;
    const at = await boot();
    await chain(at, ['g1', 'g2', 'g3', 'g4', 'g5', 'g6']);
    expect(readEvents(join(root, 'logs'), 'g6').events.find((e) => e.type === 'message.end')).toMatchObject({ outcome: 'ok' });
    expect(history.g6?.['summary.md']).toContain('- pedido g1');
    expect(Object.keys(history.g6 ?? {})).toEqual(['02-g2.md', '03-g3.md', '04-g4.md', '05-g5.md', 'summary.md']);
  });
});

describe('#604 CSP del preview', () => {
  const servers: Server[] = [];
  afterAll(() => { for (const s of servers) s.close(); });
  const track = <T extends Server>(s: T): T => { servers.push(s); return s; };
  const addr = (s: Server): number => (s.address() as { port: number }).port;
  const BUILDER = ['http://localhost:5173', 'http://127.0.0.1:5173'];
  const OURS = "content-security-policy: frame-ancestors 'self' http://localhost:5173 http://127.0.0.1:5173";
  const PAGE_CSP = "Content-Security-Policy: default-src 'self'; img-src https:";
  const resolve = (): PreviewResolve => ({ dirFor: () => '/any', distFor: () => undefined, ready: () => true });

  // vite falso: la respuesta normal trae la CSP propia de la página; el upgrade contesta 101 y un frame de texto.
  function vite(): Server {
    return track(createServer((sock) => {
      let b = '';
      sock.on('data', (c: Buffer) => {
        b += c.toString('latin1');
        if (b.indexOf('\r\n\r\n') < 0) return;
        if (/upgrade:\s*websocket/i.test(b)) {
          sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
          sock.write(Buffer.concat([Buffer.from([0x81, 2]), Buffer.from('hi')]));
          return;
        }
        const body = '<meta http-equiv="Content-Security-Policy" content="script-src \'self\'"><h1>ok</h1>';
        sock.write(`HTTP/1.1 200 OK\r\n${PAGE_CSP}\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`);
        sock.end();
      });
    }).listen(0, '127.0.0.1'));
  }
  const pool = (v: Server) => ({ live: () => ({ port: addr(v), url: '', localUrl: '' }) }) as unknown as PreviewPool;
  const raw = (port: number, req: string, until: (buf: string) => boolean): Promise<string> =>
    new Promise((res, rej) => {
      const sock = connect(port, '127.0.0.1', () => sock.write(req));
      let buf = '';
      sock.on('data', (c: Buffer) => { buf += c.toString('binary'); if (until(buf)) { sock.destroy(); res(buf); } });
      sock.on('error', rej);
      setTimeout(() => rej(new Error(`timeout: ${JSON.stringify(buf)}`)), 3000);
    });

  test('una página con CSP propia conserva la suya, recibe frame-ancestors aparte y el cuerpo llega intacto', async () => {
    const p = addr(track(startPreviewServer(pool(vite()), resolve(), 0, '127.0.0.1', undefined, BUILDER)));
    const out = await raw(p, `GET / HTTP/1.1\r\nHost: abc.localhost:${p}\r\n\r\n`, (b) => b.includes('</h1>'));
    const head = out.slice(0, out.indexOf('\r\n\r\n'));
    expect(head).toContain(PAGE_CSP);
    expect(head).toContain(OURS);
    expect(out.slice(out.indexOf('\r\n\r\n') + 4)).toBe('<meta http-equiv="Content-Security-Policy" content="script-src \'self\'"><h1>ok</h1>');
  });

  test('con builder configurado, el upgrade de HMR sigue en 101 sin cabecera agregada y el frame llega', async () => {
    const p = addr(track(startPreviewServer(pool(vite()), resolve(), 0, '127.0.0.1', undefined, BUILDER)));
    const out = await raw(p, `GET / HTTP/1.1\r\nHost: abc.localhost:${p}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: k\r\nSec-WebSocket-Version: 13\r\n\r\n`, (b) => b.endsWith('hi'));
    expect(out).toStartWith('HTTP/1.1 101 Switching Protocols\r\n');
    expect(out.toLowerCase()).not.toContain('content-security-policy');
  });
});

// HALLAZGO QA de #606 (rojo en 7e1787d4), arreglado en #611: freshTscError mide la base contra el árbol del padre (`base`),
// no contra HEAD, y un cambio rechazado deja ese árbol. Con a0 como padre y HEAD en a1, nada de a1 aparece en el ws.
test('una edición directa rechazada por tsc sobre un padre que no es HEAD deja el árbol del padre, no el de HEAD', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fresh-tsc-parent-'));
  const FILE = 'src/sections/01-hero.tsx';
  mkdirSync(join(dir, 'src', 'sections'), { recursive: true });
  writeFileSync(join(dir, FILE), 'A0\n');
  initRepo(dir);
  const a0 = commitAll(dir, 'a0');
  writeFileSync(join(dir, FILE), 'A1\n');
  writeFileSync(join(dir, 'src', 'sections', '02-a1.tsx'), 'x\n');
  commitAll(dir, 'a1');
  restoreTree(dir, a0);
  const apply = () => writeFileSync(join(dir, FILE), 'NEW\n');
  apply();
  const tsc = async () => (readFileSync(join(dir, FILE), 'utf8') === 'NEW\n' ? `${FILE}(1,1): error TS2304: Cannot find name 'x'.` : '');
  try {
    expect((await freshTscError({ tsc }, dir, a0, [FILE], apply))?.message).toBe("Cannot find name 'x'.");
    expect(readFileSync(join(dir, FILE), 'utf8')).toBe('A0\n');
    expect(existsSync(join(dir, 'src', 'sections', '02-a1.tsx'))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
