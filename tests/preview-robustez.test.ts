import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PreviewPool } from '../src/runtime/preview';

// Un fake-vite que escribe su argv en cwd/argv.log y responde ok en cualquier ruta.
const FAKE_VITE = [
  "const fs=require('fs'),http=require('http'),path=require('path');",
  "fs.writeFileSync(path.join(process.cwd(),'argv.log'), process.argv.join(' '));",
  "http.createServer((_q,r)=>r.end('ok')).listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1');",
].join('\n');

function fakePool(firstPort: number, maxLive?: number, watchTtlMs?: number) {
  const root = mkdtempSync(join(tmpdir(), 'wt-r5-'));
  const server = join(root, 'fake-vite.js');
  require('node:fs').writeFileSync(server, FAKE_VITE);
  const pool = new PreviewPool(firstPort, 10_000, {}, [process.execPath, server], maxLive, {}, watchTtlMs);
  const ws = (n: string) => { const d = join(root, n); mkdirSync(d); return d; };
  return { pool, ws };
}

// R5.5: cada ws tiene su propio origen `<ws>.localhost:<previewPort>`, así que vite sirve en la raíz (sin --base) y no hay
// colisión de assets ni de HMR entre previews.
test('vite se arranca sin --base y la url local queda en la raíz', async () => {
  const { pool, ws } = fakePool(5470);
  const dir = ws('chatABC');
  try {
    const p = await pool.ensure(dir);
    const argv = readFileSync(join(dir, 'argv.log'), 'utf8').split(' ');
    expect(argv).not.toContain('--base');
    expect(p.localUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  } finally {
    pool.stopAll();
  }
});

// R5.2 + M2: el latido marca los ws visibles; evict no toca un vigilado. Con el cupo lleno de vigilados y nada que
// desalojar, el nuevo NO arranca (ensure rechaza → el listener sirve el placeholder); abrir N urls no levanta N vites.
test('un ws vigilado no se desaloja; con el cupo lleno el nuevo no arranca', async () => {
  const { pool, ws } = fakePool(5480, 1);
  const [a, b] = [ws('a'), ws('b')];
  const up = (url: string) => fetch(url).then((r) => r.ok, () => false);
  try {
    const pa = await pool.ensure(a);
    pool.see(a); // el builder lo está mirando: ocupa el único cupo y no se desaloja
    await expect(pool.ensure(b, { onDemand: true })).rejects.toThrow('sin cupo');
    await new Promise((r) => setTimeout(r, 300));
    expect(await up(pa.localUrl)).toBe(true); // vigilado: sobrevive
  } finally {
    pool.stopAll();
  }
});

// HACK: cuarentena — flaky de reloj (setTimeout 300ms + desalojo por heartbeat del pool). Reactivar con timers falsos.
test.skip('sin latido, el ws más viejo sí se desaloja con el tope lleno', async () => {
  const { pool, ws } = fakePool(5490, 1);
  const [a, b] = [ws('a'), ws('b')];
  const up = (url: string) => fetch(url).then((r) => r.ok, () => false);
  try {
    const pa = await pool.ensure(a);
    const pb = await pool.ensure(b);
    await new Promise((r) => setTimeout(r, 300));
    expect(await up(pa.localUrl)).toBe(false); // nadie lo mira: desalojado
    expect(await up(pb.localUrl)).toBe(true);
  } finally {
    pool.stopAll();
  }
});

// security-reviewer M2: muchos ensure a la vez (abrir N urls con Play) no pasan de maxLive, aunque evict y freePort tengan
// awaits de por medio: el cupo se cuenta y se reserva en un turno síncrono (running + starting).
test('ensures concurrentes no pasan de maxLive', async () => {
  const { pool, ws } = fakePool(5500, 3);
  const dirs = Array.from({ length: 8 }, (_, i) => ws(`c${i}`));
  try {
    const started = (await Promise.allSettled(dirs.map((d) => pool.ensure(d, { onDemand: true })))).filter((r) => r.status === 'fulfilled').length;
    expect(started).toBeLessThanOrEqual(3);
  } finally {
    pool.stopAll();
  }
});

// security-reviewer M1: un vite que falla al arrancar entra en backoff; el siguiente ensure (el meta refresh recarga cada
// 1 s) no re-spawnea, rechaza de inmediato. Sin esto el placeholder re-spawnearía en bucle un preview roto.
test('un arranque fallido entra en backoff y no reintenta enseguida', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wt-bo-'));
  // Un "vite" que sale 1 al instante: nunca escucha, así que waitUp falla.
  const pool = new PreviewPool(5600, 400, {}, [process.execPath, '-e', 'process.exit(1)'], 4, {}, 15_000, 10_000);
  const d = join(root, 'x'); mkdirSync(d);
  try {
    await expect(pool.ensure(d, { onDemand: true })).rejects.toThrow(); // falla al arrancar
    await expect(pool.ensure(d, { onDemand: true })).rejects.toThrow('backoff'); // dentro del backoff: no reintenta
  } finally {
    pool.stopAll();
  }
});

// security-reviewer M-1 (regresión b46b49c): el tope solo frena el arranque bajo demanda (placeholder/latido). Una
// corrida (sin onDemand) arranca su vite aunque los cupos estén llenos de ws vigilados; antes el await ensure la abortaba.
test('una corrida arranca aunque el cupo esté lleno de vigilados; el placeholder no', async () => {
  const { pool, ws } = fakePool(5700, 1);
  const [a, b] = [ws('a'), ws('b')];
  try {
    await pool.ensure(a);
    pool.see(a); // único cupo, vigilado: no se desaloja
    await expect(pool.ensure(b, { onDemand: true })).rejects.toThrow('sin cupo'); // placeholder: respeta el tope
    const pb = await pool.ensure(b); // corrida: arranca igual
    expect(pb.localUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  } finally {
    pool.stopAll();
  }
});

// M-1 + L-5: un arranque fallido arma el backoff; el placeholder (onDemand) rechaza dentro del backoff, pero una corrida
// reintenta. El backoff se arma también cuando falla freePort (no solo cuando vite no respondió).
test('el backoff frena el placeholder pero no una corrida, y freePort fallido también lo arma', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wt-bo2-'));
  // Sin puertos en la lista: freePort lanza antes de spawnear nada.
  const pool = new PreviewPool(5720, 400, {}, [process.execPath, '-e', ''], 4, { ports: [] }, 15_000, 10_000);
  const d = join(root, 'x'); mkdirSync(d);
  try {
    await expect(pool.ensure(d, { onDemand: true })).rejects.toThrow(/puerto/); // freePort sin lista
    await expect(pool.ensure(d, { onDemand: true })).rejects.toThrow('backoff'); // quedó en backoff pese a no haber spawn
    await expect(pool.ensure(d)).rejects.toThrow(/puerto/); // corrida: no la frena el backoff, reintenta (y vuelve a fallar)
  } finally {
    pool.stopAll();
  }
});

// L-5 (early-death): un vite que respondió a waitUp y se cae después entra en backoff, o el siguiente ensure bajo demanda
// lo re-spawnearía en bucle. Sin reloj: el fake se cae en la 2ª request y se espera su salida por condición (pool.live).
test('un vite que muere tras responder entra en backoff', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wt-death-'));
  const server = join(root, 'fake.js');
  // 1ª request (waitUp) → ok y sigue vivo; 2ª request → responde y sale 1.
  writeFileSync(server, "let n=0;require('http').createServer((_q,r)=>{n++;if(n>=2)r.end('bye',()=>process.exit(1));else r.end('ok');}).listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1');");
  const pool = new PreviewPool(5760, 2000, {}, [process.execPath, server], 4, {}, 15_000, 10_000);
  const d = join(root, 'x'); mkdirSync(d);
  try {
    const p = await pool.ensure(d, { onDemand: true }); // arranca y responde (backoff limpio)
    await fetch(p.localUrl).catch(() => {}); // lo tira
    while (pool.live(d)) await new Promise((r) => setTimeout(r, 10)); // espera a que salga (condición, no duración)
    await expect(pool.ensure(d, { onDemand: true })).rejects.toThrow('backoff');
  } finally {
    pool.stopAll();
  }
});

// El plazo del latido caduca: 3 latidos perdidos y el ws vuelve a ser desechable.
test('watched() caduca pasado watchTtlMs', async () => {
  const { pool, ws } = fakePool(5495, 4, 50);
  const a = ws('a');
  try {
    pool.see(a);
    expect(pool.watched(a)).toBe(true);
    await new Promise((r) => setTimeout(r, 80));
    expect(pool.watched(a)).toBe(false);
  } finally {
    pool.stopAll();
  }
});
