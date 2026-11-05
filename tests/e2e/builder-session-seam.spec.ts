import { afterAll, beforeAll, expect, test } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { createChatIndex } from '../../src/orchestrator/chat-index';
import { fsBlobClient } from '../../src/orchestrator/fs-blob';
import { orchestratorFromEnv } from '../../src/orchestrator/main';
import { prefixedBlob } from '../../src/orchestrator/prefixed-blob';
import { Runtime, type Composer } from '../../src/runtime/server';

// Seam de sesión del builder (ADR 0017, docs/profile-module.md §Builder) de punta a punta: un provider de prueba registrado
// en el entry antes de montar, como lo hace una distro; el builder pone el Bearer solo; GET /spend lo atiende el
// orquestador real (verifier jwt, Blob en disco) y el medidor pinta su cifra; el menú muestra lo que el provider trae.
// Opt-in: BUILDER_E2E=1 (levanta vite en dev y chromium), como PORTER_E2E en fidelity.spec.ts.
const run = process.env.BUILDER_E2E === '1';
const BUILDER = join(import.meta.dir, '../../apps/builder');
const AZP = 'http://localhost';
const OWNER = 'qa_user_a';
const CHAT = 'seam-chat';

// Mediodía UTC fijo para el índice del seed y el del orquestador: los dos leen el mismo día aunque la corrida cruce 00:00 UTC.
const NOON_UTC = Date.UTC(2026, 0, 15, 12);
const SNAPSHOT = join(import.meta.dir, '../fixtures/page-provenance-snapshot');

/** Como --fixture de scripts/serve.ts: copia el snapshot al workspace del agente, sin runner ni LLM (el camino props/JSON
 * se retira en B3). */
const snapshotComposer: Composer = async (req) => {
  const dir = req.workspace?.dir;
  if (!dir) throw new Error('el snapshot necesita el workspace del agente (agent: true)');
  cpSync(SNAPSHOT, dir, { recursive: true });
  const files = readdirSync(SNAPSHOT, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => join(d.parentPath, d.name).slice(SNAPSHOT.length + 1));
  return { sections: [], agent: { files, summary: 'snapshot', missing: [], suggestions: [] } };
};

// Un follow-up con este texto pide permiso para generar una imagen como lo haría approval-mcp desde el CLI, espera la
// respuesta y sigue con el snapshot. Va en follow-up: en el T1 con imágenes preapproveSpend permite sin tarjeta.
const IMAGE_ASK = 'Genera la foto del equipo';
const IMAGE_PROMPT = 'equipo celebrando en la oficina';
const imageReplies = new Map<string, { behavior?: string }>();
const approvalComposer: Composer = async (req, log) => {
  if (!req.prompt.includes(IMAGE_ASK) || !req.approval) return snapshotComposer(req, log);
  const callId = req.prompt.includes('sin registro') ? 'img-404' : 'img-1';
  const res = await fetch(req.approval.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wt-approval-token': req.approval.token },
    body: JSON.stringify({ tool_name: 'mcp__wt__generate_image', tool_use_id: callId, input: { prompt: IMAGE_PROMPT } }),
  });
  imageReplies.set(callId, (await res.json()) as { behavior?: string });
  return snapshotComposer(req, log);
};

let tmp: string;
let rtUrl: string;
let browser: Browser;
let runtime: Server;
let orch: ReturnType<typeof Bun.serve>;
let vite: ReturnType<typeof Bun.spawn>;
let viteUrl: string;
let token: string;

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
const freePort = (): number => { const s = Bun.serve({ port: 0, fetch: () => new Response() }); const p = s.port; s.stop(true); return p!; };

async function waitFor(url: string, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if ((await fetch(url)).ok) return; } catch { /* todavía arrancando */ }
    await Bun.sleep(250);
  }
  throw new Error(`${url} no respondió en ${ms} ms`);
}

beforeAll(async () => {
  if (!run) return;
  tmp = mkdtempSync(join(tmpdir(), 'builder-seam-'));
  const scaffold = join(tmp, 'scaffold');
  mkdirSync(join(scaffold, 'src'), { recursive: true });
  writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n');
  writeFileSync(join(scaffold, 'src', 'main.tsx'), '// main\n');
  mkdirSync(join(tmp, 'vault'));
  const port = freePort();
  viteUrl = `http://localhost:${port}`;
  // builderOrigin: sin él el runtime rechaza los POST del builder (guardWrite); el caso del 401 escribe /runs.
  const rt = new Runtime({ builderOrigin: viteUrl, root: join(tmp, 'state'), allow: {}, agent: true, compose: approvalComposer, build: false, imageModels: [], autoRepair: false, heartbeatMs: 50, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands') });
  runtime = rt.listen(0);
  await new Promise((r) => runtime.once('listening', r));
  rtUrl = `http://127.0.0.1:${(runtime.address() as { port: number }).port}`;
  await fetch(`${rtUrl}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'Una landing', messageId: CHAT }) });
  await fetch(`${rtUrl}/runs/${CHAT}/events?cursor=-1`).then((r) => r.text());

  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', typ: 'JWT' });
  const body = b64({ iss: 'https://qa.onbrand.test', sub: OWNER, azp: AZP, iat: now, nbf: now, exp: now + 600, wt_scopes: ['chat:read', 'chat:write', 'spend'] });
  token = `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
  const blobDir = join(tmp, 'blob');
  const boot = orchestratorFromEnv({
    WT_JWT_ISSUER: 'https://qa.onbrand.test',
    WT_JWT_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    WT_JWT_AUTHORIZED_PARTIES: AZP,
    WT_ORCH_PRIVATE_KEY: generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    WT_BLOB_DIR: blobDir,
    WT_SANDBOX_DIR: join(tmp, 'vms'),
  }, { gateway: { upstream: async () => { throw new Error('sin upstream en este test'); }, priceOf: () => 0, credential: async () => 'Bearer qa', waitUntil: () => undefined } }, () => NOON_UTC);
  await boot.warm();
  orch = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: boot.fetch });
  await createChatIndex({ blob: prefixedBlob(fsBlobClient(blobDir), 'wt/'), daily: true, now: () => NOON_UTC }).addSpend(OWNER, 1.24);

  vite = Bun.spawn(['bunx', 'vite', '--port', String(port), '--strictPort'], { cwd: BUILDER, env: { ...process.env, VITE_RUN_API: '/api', WT_TRANSPORT_URL: rtUrl }, stdout: 'ignore', stderr: 'ignore' });
  await waitFor(viteUrl, 60_000);
  browser = await chromium.launch({ headless: true });
}, 120_000);

afterAll(async () => {
  if (!run) return;
  await browser?.close();
  vite?.kill();
  orch?.stop(true);
  runtime?.close();
  rmSync(tmp, { recursive: true, force: true });
});

test.if(run)('el provider registrado antes de montar pone el Bearer, /spend real pinta el medidor y el menú muestra la sesión', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // El entry de una distro: setSessionProvider antes de que main.tsx monte el builder.
  await page.route('**/src/main.tsx', async (r) => {
    const res = await r.fetch();
    const entry = `import { setSessionProvider } from "/src/lib/session-provider.ts";\nsetSessionProvider({ getToken: async () => ${JSON.stringify(token)}, onRejected: () => {}, user: () => ({ id: ${JSON.stringify(OWNER)}, label: ${JSON.stringify(OWNER)} }), signOut: async () => {} });\n`;
    await r.fulfill({ response: res, body: entry + (await res.text()) });
  });
  // Hasta la spec de enrutamiento builder↔orquestador, /spend no pasa por el proxy de vite: va directo al orquestador real.
  let authorization: string | undefined;
  await page.route('**/api/spend', async (r) => {
    authorization = r.request().headers().authorization;
    await r.fulfill({ response: await r.fetch({ url: `http://127.0.0.1:${orch.port}/spend` }) });
  });
  await page.goto(`${viteUrl}/?chat=${CHAT}`, { waitUntil: 'networkidle' });
  await expect(page.locator('[role=status]', { hasText: 'USD' }).first().innerText({ timeout: 15_000 })).resolves.toBe('1,24 / 5,00 USD');
  expect(authorization).toBe(`Bearer ${token}`);
  await page.getByRole('button', { name: 'Menú' }).click();
  const menu = await page.locator('[role=menu]').innerText();
  expect(menu).toContain(OWNER);
  expect(menu).toContain('Cerrar sesión');
}, 60_000);

// Sesión vencida a mitad de chat: el 401 {code:'expired'} llega a onRejected, el provider de prueba "abre su sign-in" y
// trae un token nuevo; el siguiente envío lo lleva y el copy de sesión desaparece. El builder no reintenta solo (session.ts).
test.if(run)('un 401 de sesión llama a onRejected, el sign-in del provider trae token nuevo y el siguiente envío pasa', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route('**/src/main.tsx', async (r) => {
    const res = await r.fetch();
    const entry = `import { setSessionProvider } from "/src/lib/session-provider.ts";\nwindow.__tok = "viejo"; window.__signIns = [];\nsetSessionProvider({ getToken: async () => window.__tok, onRejected: (p) => { window.__signIns.push(p.code); window.__tok = "nuevo"; } });\n`;
    await r.fulfill({ response: res, body: entry + (await res.text()) });
  });
  const runs: string[] = [];
  await page.route(`**/api/chats/${CHAT}/runs`, async (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    const auth = r.request().headers().authorization ?? '';
    runs.push(auth);
    if (auth === 'Bearer viejo') return r.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'expired', code: 'expired' }) });
    await r.fallback();
  });
  await page.goto(`${viteUrl}/?chat=${CHAT}`, { waitUntil: 'networkidle' });
  const box = page.getByPlaceholder('Pide un cambio a la página…');
  const notice = page.locator('[role=status]', { hasText: 'Tu sesión venció' });

  await box.fill('Cambia el título');
  await box.press('Enter');
  await expect(notice.innerText({ timeout: 15_000 })).resolves.toBe('Tu sesión venció. Vuelve a iniciar sesión para seguir.');
  expect(await page.evaluate(() => (window as unknown as { __signIns: string[] }).__signIns)).toEqual(['expired']);

  await box.fill('Cambia el título');
  const accepted = page.waitForResponse((res) => res.url().endsWith(`/api/chats/${CHAT}/runs`) && res.request().method() === 'POST', { timeout: 15_000 });
  await box.press('Enter');
  expect((await accepted).status()).toBe(202);
  expect(runs).toEqual(['Bearer viejo', 'Bearer nuevo']);
  await expect(notice.count()).resolves.toBe(0);
}, 60_000);

// Spec §3.1-§3.4 en local y A2: una visita sin ?chat= que no toca nada no reserva (0 POST /chats). Abrir el selector de marca
// reserva uno y pide las marcas por él; la primera corrida va a POST /chats/<id>/runs con messageId = <id> y la URL lo recuerda.
test.if(run)('un builder nuevo no reserva al montar; abrir el selector reserva una vez y la primera corrida usa ese chat', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const seen: string[] = [];
  page.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/api/')) seen.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  const posts = () => seen.filter((l) => l === 'POST /api/chats').length;
  await page.goto(viteUrl, { waitUntil: 'networkidle' });
  const idle = posts();
  const created = page.waitForResponse((res) => res.url().endsWith('/api/chats') && res.request().method() === 'POST', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Tema', exact: true }).click();
  const chat = ((await (await created).json()) as { chatId: string }).chatId;
  await page.waitForLoadState('networkidle');
  expect([idle, posts(), seen.includes(`GET /api/chats/${chat}/brands`)]).toEqual([0, 1, true]);
  await page.keyboard.press('Escape');
  const started = page.waitForRequest((r) => r.url().endsWith(`/api/chats/${chat}/runs`) && r.method() === 'POST', { timeout: 15_000 });
  const box = page.getByPlaceholder('Describe la página…');
  await box.fill('Una landing');
  await box.press('Enter');
  expect((JSON.parse((await started).postData() ?? '{}') as { messageId?: string }).messageId).toBe(chat);
  await page.waitForURL((u) => u.searchParams.get('chat') === chat, { timeout: 15_000 });
  if (process.env.WT_SEAM_SHOT) await page.screenshot({ path: process.env.WT_SEAM_SHOT });
  console.log(`seam: al montar POST /api/chats ${idle}; ${seen.filter((l) => !l.includes('/events')).slice(0, 10).join(' | ')}`);
}, 60_000);

// Arq (#858, MEDIUM): recargar antes del primer envío no reserva otro chat; la primera corrida va con el id que quedó en la URL.
test.if(run)('recargar con la reserva en la URL no pide otro chat y la primera corrida usa ese id', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let posts = 0;
  page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/chats') posts++; });
  await page.goto(viteUrl, { waitUntil: 'networkidle' });
  // A2: la reserva sale del primer gesto (abrir el selector de marca), no de la visita.
  await page.getByRole('button', { name: 'Tema', exact: true }).click();
  await page.waitForURL((u) => Boolean(u.searchParams.get('chat')), { timeout: 15_000 });
  const chat = new URL(page.url()).searchParams.get('chat')!;
  await page.reload({ waitUntil: 'networkidle' });
  const started = page.waitForRequest((r) => r.url().endsWith(`/api/chats/${chat}/runs`) && r.method() === 'POST', { timeout: 15_000 });
  const box = page.getByPlaceholder('Describe la página…');
  await box.fill('Una landing');
  await box.press('Enter');
  expect((JSON.parse((await started).postData() ?? '{}') as { messageId?: string }).messageId).toBe(chat);
  await expect(page.locator('[role=status]', { hasText: 'La página está lista' }).first().innerText({ timeout: 30_000 })).resolves.toBe('La página está lista');
  expect(posts).toBe(1);
  if (process.env.WT_SEAM_SHOT) await page.screenshot({ path: process.env.WT_SEAM_SHOT.replace(/\.png$/, '-recarga.png') });
  console.log(`recarga: POST /api/chats ${posts}, chat ${chat}, url ${new URL(page.url()).search}`);
}, 60_000);

// Arq (#860, LOW): un ?chat= que no es reserva de este dueño (de otro, perdido en un reinicio o mal escrito) no deja las marcas
// en 404: el primer 404 lo descarta, se reserva un chat nuevo una sola vez y la URL pasa a ese.
test.if(run)('un ?chat= ajeno carga las marcas tras un solo POST /chats nuevo y la URL pasa al chat reservado', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const loose = '3f0c2b7a-9d14-4e6b-8a55-0c1d2e3f4a5b';
  let posts = 0;
  page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/chats') posts++; });
  const created = page.waitForResponse((res) => res.url().endsWith('/api/chats') && res.request().method() === 'POST', { timeout: 15_000 });
  await page.goto(`${viteUrl}/?chat=${loose}`, { waitUntil: 'networkidle' });
  const chat = ((await (await created).json()) as { chatId: string }).chatId;
  await page.waitForLoadState('networkidle');
  const brands = await page.evaluate(async (c) => (await fetch(`/api/chats/${c}/brands`)).status, chat);
  expect([posts, new URL(page.url()).searchParams.get('chat'), brands]).toEqual([1, chat, 200]);
  console.log(`ajeno: POST /api/chats ${posts}, ${loose} -> ${chat}`);
}, 60_000);

// Arq (#863, LOW): si el GET del hilo falla sin 404 (red, 500, un fetch cortado), el ?chat= no se toma por un chat con
// corridas: va como reserva y las rutas del dueño se recuperan con su reintento. Aquí se corta el primer GET del hilo.
test.if(run)('con el primer GET del hilo cortado, un ?chat= no reservado carga las marcas tras un solo POST /chats', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const loose = '6a1d0e9c-2b47-4f3e-9c8a-5d4e3f2a1b0c';
  let cut = false;
  await page.route(`**/api/chats/${loose}`, async (r) => {
    if (!cut && r.request().method() === 'GET') { cut = true; return r.abort('failed'); }
    await r.fallback();
  });
  let posts = 0;
  page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/chats') posts++; });
  const created = page.waitForResponse((res) => res.url().endsWith('/api/chats') && res.request().method() === 'POST', { timeout: 15_000 });
  await page.goto(`${viteUrl}/?chat=${loose}`, { waitUntil: 'networkidle' });
  const chat = ((await (await created).json()) as { chatId: string }).chatId;
  await page.waitForLoadState('networkidle');
  const brands = await page.evaluate(async (c) => (await fetch(`/api/chats/${c}/brands`)).status, chat);
  expect([cut, posts, new URL(page.url()).searchParams.get('chat'), brands]).toEqual([true, 1, chat, 200]);
  console.log(`cortado: POST /api/chats ${posts}, ${loose} -> ${chat}`);
}, 60_000);

// Arq (#870, LOW): un 500 transitorio en el GET del hilo de un chat con corridas no lo vuelve reserva. Se pregunta otra vez,
// el hilo carga y el envío va a ese chat como continuación, sin POST /chats ni messageId = chatId.
test.if(run)('con un 500 en el primer GET del hilo, el chat con corridas carga y el envío va a ese chat', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // Vite corre en StrictMode: el primer montaje pide el hilo y se aborta. Fallan los dos primeros GET para que el 500 lo
  // reciba el montaje que decide; con uno solo lo absorbía el abortado y el test pasaba sin el fix.
  let failed = 0;
  await page.route(`**/api/chats/${CHAT}`, async (r) => {
    if (failed < 2 && r.request().method() === 'GET') { failed++; return r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"transitorio"}' }); }
    await r.fallback();
  });
  let posts = 0;
  page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/chats') posts++; });
  await page.goto(`${viteUrl}/?chat=${CHAT}`, { waitUntil: 'networkidle' });
  const started = page.waitForRequest((r) => r.url().endsWith(`/api/chats/${CHAT}/runs`) && r.method() === 'POST', { timeout: 15_000 });
  const box = page.getByPlaceholder('Pide un cambio a la página…');
  await box.fill('Cambia el título');
  await box.press('Enter');
  const messageId = (JSON.parse((await started).postData() ?? '{}') as { messageId?: string }).messageId;
  expect([failed, posts, messageId === CHAT, new URL(page.url()).searchParams.get('chat')]).toEqual([2, 0, false, CHAT]);
  console.log(`500: GET fallidos ${failed}, POST /api/chats ${posts}, messageId ${messageId}`);
}, 60_000);

// Arq (#874): si el hilo no carga ni con el reintento, el chat sigue vigente pero sin padre; un envío iría por startFirst a un
// chat nuevo y el real quedaría abandonado. Fallan 3 GET: el del montaje que StrictMode aborta, el que decide y su reintento.
test.if(run)('si el hilo no carga tras el reintento, el envío se bloquea y pide recargar', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let failed = 0;
  await page.route(`**/api/chats/${CHAT}`, async (r) => {
    if (failed < 3 && r.request().method() === 'GET') { failed++; return r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"transitorio"}' }); }
    await r.fallback();
  });
  const sent: string[] = [];
  page.on('request', (r) => { const p = new URL(r.url()).pathname; if (r.method() === 'POST' && (p === '/api/chats' || p.endsWith('/runs'))) sent.push(p); });
  await page.goto(`${viteUrl}/?chat=${CHAT}`, { waitUntil: 'networkidle' });
  const box = page.getByPlaceholder('Describe la página…');
  await box.fill('Cambia el título');
  await box.press('Enter');
  const notice = page.locator('[role=status]', { hasText: 'No se pudo cargar el historial' });
  const text = await notice.first().innerText({ timeout: 15_000 });
  await page.waitForLoadState('networkidle');
  const draft = await box.inputValue();
  expect([failed, text, draft, sent, new URL(page.url()).searchParams.get('chat')]).toEqual([3, 'No se pudo cargar el historial de este chat. Recarga la página para seguir', 'Cambia el título', [], CHAT]);
  if (process.env.WT_SEAM_SHOT) await page.screenshot({ path: process.env.WT_SEAM_SHOT.replace(/\.png$/, '-hilo-perdido.png') });
  console.log(`hilo perdido: GET fallidos ${failed}, POST ${sent.length}, aviso "${text}", borrador "${draft}"`);
}, 60_000);

// PR 2 de slots (Arq): el menú + se renderiza solo al abrirlo, así que el SSR no ve la zona `menu`. Aquí se abre y se lee:
// primero los ítems del bloque, después los del builder bajo su separador.
test.if(run)('el menú + muestra los ítems del bloque y después los del builder', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(viteUrl, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Agregar archivos y contexto' }).click();
  const menu = page.locator('[role=menu]');
  const text = await menu.innerText({ timeout: 15_000 });
  expect(text.indexOf('Subir archivo')).toBeGreaterThanOrEqual(0);
  expect(text.indexOf('Plan')).toBeGreaterThan(text.indexOf('Subir archivo'));
  expect(await menu.locator('[role=separator]').count()).toBeGreaterThan(0);
  if (process.env.WT_SEAM_SHOT) await page.screenshot({ path: process.env.WT_SEAM_SHOT.replace(/\.png$/, '-menu.png') });
  console.log(`menu +: ${text.replace(/\s+/g, ' ')}`);
}, 60_000);

// Aviso de contraste (#890, patrón v0 "Show N preview issues" + botón manual): el preview-check de la versión trae dos defectos
// contrast; el aviso los lista y "Corregir contraste" manda un turno de la persona con esos pares, sin repair automático.
test.if(run)('el aviso de contraste lista los defectos y su botón envía un turno con el texto', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const contrast = (slug: string, text: string, ratio: number, fg: string, bg: string) => ({ field: 'preview.runtime', kind: 'contrast', slug, viewport: 1280, message: `1 texto bajo WCAG AA; el peor, ${ratio}:1`, text, ratio, colors: { fg, bg } });
  // A todas las corridas del chat: los tests de antes le suman turnos y el aviso es del último.
  await page.route(`**/api/chats/${CHAT}/runs/*/events*`, async (r) => {
    const res = await r.fetch();
    const events = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; seq: number; [k: string]: unknown });
    const end = events.findIndex((e) => e.type === 'message.end');
    if (end < 0) return r.fulfill({ response: res });
    const base = { v: events[end]!.v, messageId: events[end]!.messageId, at: events[end]!.at };
    const id = 'transport:preview-check';
    const defects = [contrast('hero', 'Empieza gratis', 2.31, '#9ca3af', '#ffffff'), contrast('precios', 'Desde $9 al mes', 3.1, '#a1a1aa', '#f4f4f5')];
    const added = [
      { ...base, type: 'step.start', stepId: id, kind: 'tool', label: 'Checking preview' },
      { ...base, type: 'step.end', stepId: id, label: 'Found 2 preview issues', status: 'error', detail: { kind: 'tool', name: 'preview-runtime', output: { url: 'x', defects, server: [] } }, error: { type: 'execution-error', message: 'contrast' } },
    ];
    const all = [...events.slice(0, end), ...added, ...events.slice(end)].map((e, i) => ({ ...e, seq: events[0]!.seq + i }));
    await r.fulfill({ status: 200, contentType: 'application/x-ndjson', body: all.map((e) => JSON.stringify(e)).join('\n') + '\n' });
  });
  await page.goto(`${viteUrl}/?chat=${CHAT}`, { waitUntil: 'networkidle' });
  const notice = page.locator('[data-wt-contrast]');
  const summary = await notice.locator('span').first().innerText({ timeout: 15_000 });
  await notice.getByRole('button', { name: 'Ver detalle' }).click();
  const list = await notice.locator('ul').innerText();
  const started = page.waitForRequest((r) => r.url().endsWith(`/api/chats/${CHAT}/runs`) && r.method() === 'POST', { timeout: 15_000 });
  if (process.env.WT_SEAM_SHOT) await page.screenshot({ path: process.env.WT_SEAM_SHOT.replace(/\.png$/, '-contraste.png') });
  await notice.getByRole('button', { name: 'Corregir contraste' }).click();
  const body = JSON.parse((await started).postData() ?? '{}') as { prompt?: string; runtimeContext?: { contrastDefects?: unknown } };
  const prompt = body.prompt ?? '';
  // #898: el mismo turno lleva los defectos como dato estructurado, además del texto.
  expect(body.runtimeContext?.contrastDefects).toEqual([{ slug: 'hero', ratio: 2.31, colors: { fg: '#9ca3af', bg: '#ffffff' } }, { slug: 'precios', ratio: 3.1, colors: { fg: '#a1a1aa', bg: '#f4f4f5' } }]);
  expect(summary).toBe('Poco contraste en 2 secciones');
  expect(list).toContain('#9ca3af sobre #ffffff · 2.31:1');
  expect(prompt.startsWith('La vista previa tiene textos con poco contraste (bajo WCAG AA):\n- Sección hero: #9ca3af sobre #ffffff, 2.31:1\n- Sección precios:')).toBe(true);
  console.log(`contraste: "${summary}" | ${list.replace(/\s+/g, ' ')} | prompt ${JSON.stringify(prompt.slice(0, 90))}`);
}, 60_000);

/** Hasta que la corrida del mensaje cierra en el Runtime (message.end en su log). */
async function runEnded(messageId: string, ms = 20_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const snap = (await (await fetch(`${rtUrl}/runs/${messageId}`)).json()) as { events?: { type: string }[] };
    if (snap.events?.some((e) => e.type === 'message.end')) return;
    await Bun.sleep(200);
  }
  throw new Error(`la corrida ${messageId} no cerró en ${ms} ms`);
}

async function askImage(page: import('playwright').Page, text: string): Promise<string> {
  // Sin networkidle: si un caso anterior dejó una corrida viva, su stream de eventos nunca deja la red quieta.
  await page.goto(`${viteUrl}/?chat=${CHAT}`);
  const box = page.getByPlaceholder('Pide un cambio a la página…');
  await box.waitFor({ timeout: 15_000 });
  await box.fill(text);
  // Recién cargado, el turno anterior cerrado no es el vivo (Turn.closed): el primer POST ya es corrida nueva, sin steer ni 409.
  const accepted = page.waitForResponse((res) => res.url().endsWith(`/api/chats/${CHAT}/runs`) && res.request().method() === 'POST', { timeout: 15_000 });
  await box.press('Enter');
  const res = await accepted;
  expect([res.status(), JSON.parse(res.request().postData() ?? '{}').steer]).toEqual([202, undefined]);
  return ((await res.json()) as { messageId: string }).messageId;
}

// §8.1 en local (#906): la tarjeta de generate_image se pinta desde GET /chats/:chat/approvals/:callId del Runtime, no desde
// el evento, y la decisión viaja sola en el POST; con "Permitir esta vez" la llamada del CLI recibe allow y la corrida cierra.
test.if(run)('la tarjeta de imagen carga el registro del Runtime, ofrece "Permitir siempre" y "Permitir esta vez" sigue la corrida', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const gets: number[] = [];
  const decisions: unknown[] = [];
  // El GET real responde; el prompt del registro se marca antes de llegar al builder para que solo pueda salir de ahí.
  await page.route(`**/api/chats/${CHAT}/approvals/img-1`, async (r) => {
    if (r.request().method() === 'POST') { decisions.push(JSON.parse(r.request().postData() ?? 'null')); return r.fallback(); }
    const res = await r.fetch();
    gets.push(res.status());
    if (!res.ok()) return r.fulfill({ response: res });
    const record = (await res.json()) as { input: { prompt: string } };
    await r.fulfill({ response: res, json: { ...record, input: { ...record.input, prompt: `${record.input.prompt} (del registro)` } } });
  });
  const messageId = await askImage(page, IMAGE_ASK);
  const card = page.locator('[data-approval="ready"]');
  await card.waitFor({ timeout: 20_000 });
  const text = await card.innerText();
  // StrictMode en dev monta dos veces: puede haber más de un GET, todos al registro real.
  expect(gets.length > 0 && gets.every((s) => s === 200)).toBe(true);
  expect(text).toContain('¿Generar una imagen?');
  expect(text).toContain(`${IMAGE_PROMPT} (del registro)`);
  expect(await card.getByRole('button', { name: 'Permitir siempre mcp__wt__generate_image' }).isVisible()).toBe(true);
  if (process.env.WT_SEAM_SHOT) await page.screenshot({ path: process.env.WT_SEAM_SHOT.replace(/\.png$/, '-aprobacion.png') });
  await card.getByRole('button', { name: 'Permitir esta vez' }).click();
  await runEnded(messageId);
  expect(decisions).toEqual([{ decision: 'allow' }]);
  expect(imageReplies.get('img-1')?.behavior).toBe('allow');
  // Al cerrar, el turno pliega sus pasos (la tarjeta queda dentro de "Ver pasos") y el lienzo avisa que la versión está.
  await page.getByText('La página está lista', { exact: true }).waitFor({ timeout: 10_000 });
  console.log(`aprobación: GET ${gets.join(',')} | POST ${JSON.stringify(decisions)} | ${text.replace(/\s+/g, ' ').slice(0, 160)}`);
}, 60_000);

// Fail-closed: sin registro (404) la tarjeta dice "No disponible", no ofrece botones y no manda ninguna decisión.
test.if(run)('sin registro de la aprobación la tarjeta dice "No disponible", sin botones y sin POST', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let posts = 0;
  await page.route(`**/api/chats/${CHAT}/approvals/img-404`, async (r) => {
    if (r.request().method() === 'POST') { posts++; return r.fallback(); }
    await r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'no hay aprobación', code: 'not-found' }) });
  });
  const messageId = await askImage(page, `${IMAGE_ASK} sin registro`);
  const card = page.locator('[data-approval="missing"]');
  const text = await card.innerText({ timeout: 20_000 });
  expect(text).toContain('No disponible: este servidor no tiene el registro de esta aprobación.');
  expect(text).not.toContain(IMAGE_PROMPT);
  expect(await card.getByRole('button').count()).toBe(0);
  expect(posts).toBe(0);
  if (process.env.WT_SEAM_SHOT) await page.screenshot({ path: process.env.WT_SEAM_SHOT.replace(/\.png$/, '-aprobacion-404.png') });
  // La llamada sigue esperando en el Runtime: se omite directo (como lo haría el timeout) para no dejar el chat ocupado.
  const skip = await fetch(`${rtUrl}/chats/${CHAT}/approvals/img-404`, { method: 'POST', headers: { origin: viteUrl, 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'skip' }) });
  expect(skip.status).toBe(200);
  await runEnded(messageId);
  expect(imageReplies.get('img-404')?.behavior).toBe('deny');
}, 60_000);
