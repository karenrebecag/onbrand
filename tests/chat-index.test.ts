import { expect, test } from 'bun:test';
import { APPLIED_IDS, BlobConflictError, BlobExistsError, ChatExistsError, ChatNotFoundError, createChatIndex, IndexContentionError, PendingLimitError, type BlobClient, type ChatEntry } from '../src/orchestrator/chat-index';

// docs/spec/deploy-sandbox.md §3: un blob por chat y uno por dueño para el contador, escritura condicional con etag. Blob falso con
// etags y precondición; el SDK real no entra (ni token) en estos tests.
class FakeBlob implements BlobClient {
  readonly files = new Map<string, { text: string; etag: number }>();
  private seq = 0;
  /** Antes de devolver una lectura, espera a que `gate` pida soltarla: así dos escritores leen el mismo etag antes de que escriba alguno. */
  gate: (() => Promise<void>) | undefined;
  /** Cuántas escrituras se rechazaron por etag viejo. */
  conflicts = 0;

  async read(pathname: string) {
    const hit = this.files.get(pathname);
    const snapshot = hit ? { text: hit.text, etag: `e${hit.etag}` } : undefined;
    if (this.gate) await this.gate();
    return snapshot;
  }
  async create(pathname: string, body: string) {
    if (this.files.has(pathname)) throw new BlobExistsError(pathname);
    this.files.set(pathname, { text: body, etag: ++this.seq });
    return { etag: `e${this.seq}` };
  }
  async replace(pathname: string, body: string, ifMatch: string) {
    const hit = this.files.get(pathname);
    if (!hit || `e${hit.etag}` !== ifMatch) { this.conflicts++; throw new BlobConflictError(pathname); }
    this.files.set(pathname, { text: body, etag: ++this.seq });
    return { etag: `e${this.seq}` };
  }
  async list(prefix: string) {
    return [...this.files.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

/** Una barrera de `n`: la primera lectura de cada uno espera a que lleguen los `n`, y las siguientes pasan. */
const barrier = (n: number): (() => Promise<void>) => {
  let waiting: (() => void)[] = [];
  let open = false;
  return () => {
    if (open) return Promise.resolve();
    return new Promise<void>((resolve) => {
      waiting.push(resolve);
      if (waiting.length === n) { open = true; for (const w of waiting) w(); waiting = []; }
    });
  };
};

const noSleep = async (): Promise<void> => {};
const entry = (over: Partial<ChatEntry> = {}): ChatEntry => ({ chatId: 'chat-1', owner: 'user_a', title: 'Landing', sandbox: { name: 'sbx-1' }, head: { messageId: 'm1', commit: 'c1' }, updatedAt: 1, spend: 0, ...over });
const make = (blob: FakeBlob, extra: { now?: () => number; maxRetries?: number } = {}) => createChatIndex({ blob, sleep: noSleep, ...extra });

test('crear una vez: el segundo createChat del mismo chat falla y no pisa el primero', async () => {
  const blob = new FakeBlob();
  const index = make(blob);
  await index.createChat(entry());
  await expect(index.createChat(entry({ title: 'otro' }))).rejects.toBeInstanceOf(ChatExistsError);
  expect((await index.getChat('user_a', 'chat-1'))?.title).toBe('Landing');
  expect(await index.getChat('user_a', 'no-existe')).toBeUndefined();
});

test('cada chat y cada contador va en su blob, por dueño, con el nombre de la spec', async () => {
  const blob = new FakeBlob();
  const index = make(blob);
  await index.createChat(entry());
  await index.addSpend('user_a', 5);
  const b64 = Buffer.from('user_a').toString('base64url');
  expect([...blob.files.keys()].sort()).toEqual([`chats/${b64}/chat-1.json`, `spend/${b64}.json`]);
});

test('listChats filtra por dueño (el prefijo no recoge a otro dueño parecido) y ordena por el más reciente', async () => {
  let t = 100;
  const index = make(new FakeBlob(), { now: () => t++ });
  await index.createChat(entry({ chatId: 'a1' }));
  await index.createChat(entry({ chatId: 'a2' }));
  await index.createChat(entry({ chatId: 'x1', owner: 'user_ab' }));
  await index.updateChat('user_a', 'a1', (c) => ({ ...c, title: 'tocado' }));
  expect((await index.listChats('user_a')).map((c) => c.chatId)).toEqual(['a1', 'a2']);
  expect((await index.listChats('user_ab')).map((c) => c.chatId)).toEqual(['x1']);
  expect(await index.listChats('nadie')).toEqual([]);
});

test('updateChat reaplica el cambio sobre lo vigente, sellando updatedAt, y no toca el original', async () => {
  const index = make(new FakeBlob(), { now: () => 777 });
  const created = entry();
  await index.createChat(created);
  const next = await index.updateChat('user_a', 'chat-1', (c) => ({ ...c, head: { messageId: 'm2', commit: 'c2' } }));
  expect(next).toMatchObject({ head: { messageId: 'm2', commit: 'c2' }, updatedAt: 777 });
  expect(created.head.messageId).toBe('m1');
  await expect(index.updateChat('user_a', 'ghost', (c) => c)).rejects.toBeInstanceOf(ChatNotFoundError);
  await expect(index.updateChat('user_a', 'chat-1', (c) => ({ ...c, owner: 'otro' }))).rejects.toThrow('no puede cambiar owner ni chatId');
});

test('dos escritores del contador a la vez: uno gana, el otro reintenta y el total converge sin perder ninguno', async () => {
  const blob = new FakeBlob();
  const index = make(blob);
  await index.addSpend('user_a', 10);
  blob.gate = barrier(2);
  const [a, b] = await Promise.all([index.addSpend('user_a', 3), index.addSpend('user_a', 4)]);
  expect(blob.conflicts).toBe(1);
  expect(Math.max(a.spent, b.spent)).toBe(17);
  expect((await index.readSpend('user_a')).spent).toBe(17);
});

test('dos escritores del head de un chat a la vez: ambos cambios sobreviven', async () => {
  const blob = new FakeBlob();
  const index = make(blob);
  await index.createChat(entry());
  blob.gate = barrier(2);
  await Promise.all([
    index.updateChat('user_a', 'chat-1', (c) => ({ ...c, title: 'nuevo título' })),
    index.updateChat('user_a', 'chat-1', (c) => ({ ...c, spend: c.spend + 9 })),
  ]);
  expect(blob.conflicts).toBe(1);
  expect(await index.getChat('user_a', 'chat-1')).toMatchObject({ title: 'nuevo título', spend: 9 });
});

test('dos que crean el contador a la vez (no existe): uno crea, el otro reintenta sobre lo creado', async () => {
  const blob = new FakeBlob();
  const index = make(blob);
  blob.gate = barrier(2);
  await Promise.all([index.addSpend('user_a', 2), index.addSpend('user_a', 5)]);
  expect((await index.readSpend('user_a')).spent).toBe(7);
});

test('con disputa permanente: si la disputa no cede en maxRetries, falla en voz alta en vez de perder la escritura', async () => {
  const blob = new FakeBlob();
  await make(blob).addSpend('user_a', 1);
  // Un blob que siempre rechaza el reemplazo: otro escritor gana en cada intento.
  blob.replace = async (pathname) => { blob.conflicts++; throw new BlobConflictError(pathname); };
  await expect(make(blob, { maxRetries: 3 }).addSpend('user_a', 1)).rejects.toBeInstanceOf(IndexContentionError);
  expect(blob.conflicts).toBe(4);
});

test('entradas inválidas: dueño vacío, chatId con ruta, gasto negativo o un blob con otra forma', async () => {
  const blob = new FakeBlob();
  const index = make(blob);
  await expect(index.createChat(entry({ owner: '' }))).rejects.toThrow('dueño');
  await expect(index.createChat(entry({ chatId: '../x' }))).rejects.toThrow('chatId inválido');
  await expect(index.addSpend('user_a', -1)).rejects.toThrow('>= 0');
  await expect(index.addSpend('user_a', Number.NaN)).rejects.toThrow('>= 0');
  blob.files.set(`chats/${Buffer.from('user_a').toString('base64url')}/roto.json`, { text: '{"chatId":"roto"}', etag: 1 });
  await expect(index.getChat('user_a', 'roto')).rejects.toThrow('no tiene la forma');
});

test('addSpend suma el desglose de tokens por modelo sin mezclar modelos; un blob sin desglose se lee como vacío', async () => {
  const blob = new FakeBlob();
  const index = make(blob);
  const u = (input: number, output: number, cc: number, cr: number) => ({ input, output, cache_creation_input: cc, cache_read_input: cr });
  await index.addSpend('user_a', 1, { model: 'm1', usage: u(10, 5, 2, 1) });
  await index.addSpend('user_a', 2, { model: 'm1', usage: u(1, 1, 1, 1) });
  const c = await index.addSpend('user_a', 4, { model: 'm2', usage: u(7, 0, 0, 0) });
  expect(c.spent).toBe(7);
  expect(c.byModel).toEqual({ m1: u(11, 6, 3, 2), m2: u(7, 0, 0, 0) });
  const b64 = Buffer.from('user_b').toString('base64url');
  blob.files.set(`spend/${b64}.json`, { text: JSON.stringify({ owner: 'user_b', spent: 3, updatedAt: 1 }), etag: 99 });
  expect((await index.readSpend('user_b')).byModel).toEqual({});
  expect((await index.addSpend('user_b', 1)).spent).toBe(4);
});

test("byModel resiste el modelo '__proto__' y rechaza un blob con forma inválida", async () => {
  const blob = new FakeBlob();
  const index = make(blob);
  const u = { input: 1, output: 1, cache_creation_input: 0, cache_read_input: 0 };
  await index.addSpend('user_a', 1, { model: '__proto__', usage: u });
  const c = await index.addSpend('user_a', 1, { model: '__proto__', usage: u });
  expect(Object.keys(c.byModel)).toEqual(['__proto__']);
  expect(c.byModel['__proto__']).toEqual({ input: 2, output: 2, cache_creation_input: 0, cache_read_input: 0 });
  expect(({} as Record<string, unknown>).input).toBeUndefined();
  const b64 = Buffer.from('user_c').toString('base64url');
  blob.files.set(`spend/${b64}.json`, { text: JSON.stringify({ owner: 'user_c', spent: 1, byModel: { m: { input: 'x' } }, updatedAt: 1 }), etag: 98 });
  await expect(index.readSpend('user_c')).rejects.toThrow('uso inválido');
});

test('adjustSpend acepta deltas negativos, no deja el contador bajo cero y rechaza no finitos', async () => {
  const index = make(new FakeBlob());
  await index.addSpend('user_a', 10);
  expect((await index.adjustSpend('user_a', -4)).spent).toBe(6);
  expect((await index.adjustSpend('user_a', -100)).spent).toBe(0);
  await expect(index.adjustSpend('user_a', Number.NaN)).rejects.toThrow('finito');
  await expect(index.addSpend('user_a', -1)).rejects.toThrow('>= 0');
});

test('opId hace idempotentes addSpend y adjustSpend; el contador solo recuerda los últimos APPLIED_IDS', async () => {
  const index = make(new FakeBlob());
  await index.addSpend('user_a', 5, undefined, 'op-1');
  await index.addSpend('user_a', 5, undefined, 'op-1');
  await index.adjustSpend('user_a', -2, undefined, 'op-2');
  expect((await index.adjustSpend('user_a', -2, undefined, 'op-2')).spent).toBe(3);
  for (let i = 0; i < APPLIED_IDS; i++) await index.addSpend('user_a', 1, undefined, `fill-${i}`);
  const c = await index.readSpend('user_a');
  expect(c.applied).toHaveLength(APPLIED_IDS);
  expect(c.applied).not.toContain('op-1');
  expect((await index.addSpend('user_a', 1, undefined, 'op-1')).spent).toBe(3 + APPLIED_IDS + 1);
});

test('reserveSpend suma solo si cabe en el tope y N reservas paralelas no se cuelan', async () => {
  const blob = new FakeBlob();
  const index = createChatIndex({ blob, sleep: async () => undefined, maxRetries: 30 });
  expect((await index.reserveSpend('u', 6, 5, 'a')).ok).toBe(false);
  expect((await index.readSpend('u')).spent).toBe(0);
  // 10 reservas de 1 con tope 4: exactamente 4 caben, el resto se rechaza sin sumar.
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => index.reserveSpend('w', 1, 4, `r${i}`)));
  expect(results.filter((r) => r.ok)).toHaveLength(4);
  expect((await index.readSpend('w')).spent).toBe(4);
  // La misma reserva repetida (reintento tras un write que sí se aplicó) no suma dos veces.
  expect((await index.reserveSpend('w', 1, 99, 'r0')).ok).toBe(true);
  expect((await index.readSpend('w')).spent).toBe(4);
});

test('la liquidación de una reserva cae en el día de la reserva aunque llegue pasada la medianoche UTC', async () => {
  const blob = new FakeBlob();
  let t = Date.UTC(2026, 10, 5, 23, 59, 0);
  const index = createChatIndex({ blob, daily: true, now: () => t });
  const reserved = await index.reserveSpend('u', 4, 5, 'res');
  expect(reserved).toMatchObject({ ok: true, day: '2026-11-05' });
  t = Date.UTC(2026, 10, 6, 0, 1, 0);
  // El ajuste a la baja (el uso real fue 1 USD) va al contador del 5; el del 6 no se toca ni queda negativo.
  await index.adjustSpend('u', -3, undefined, 'adj', reserved.day);
  expect((await index.readSpend('u')).spent).toBe(0);
  expect(blob.files.get(`spend/${Buffer.from('u').toString('base64url')}/2026-11-05.json`)?.text).toContain('"spent":1');
  expect(blob.files.has(`spend/${Buffer.from('u').toString('base64url')}/2026-11-06.json`)).toBe(false);
  await expect(index.adjustSpend('u', 1, undefined, 'x', '../2026')).rejects.toThrow('día inválido');
});

test('"siempre": idempotente, separado por dueño, con tope y solo nombres de tool', async () => {
  const index = createChatIndex({ blob: new FakeBlob() });
  const T = (n: number) => `mcp__wt__tool${n}`;
  expect(await index.addAlways('a', T(0))).toEqual([T(0)]);
  expect(await index.addAlways('a', T(0))).toEqual([T(0)]);
  expect(await index.readAlways('b')).toEqual([]);
  await expect(index.addAlways('a', 'Bash')).rejects.toThrow();
  for (let i = 1; i < 16; i++) await index.addAlways('a', T(i));
  await expect(index.addAlways('a', T(99))).rejects.toThrow();
  expect(await index.removeAlways('a', T(0))).not.toContain(T(0));
  expect(await index.removeAlways('a', T(0))).not.toContain(T(0));
});

test('"siempre" corrupto: se lee como vacío y revocar lo vacía en vez de dejar al dueño sin salida', async () => {
  const blob = new FakeBlob();
  const index = createChatIndex({ blob });
  await index.addAlways('a', 'mcp__wt__generate_image');
  const key = [...blob.files.keys()].find((k) => k.startsWith('always/'))!;
  blob.files.set(key, { text: '{no es json', etag: 99 });
  expect(await index.readAlways('a')).toEqual([]);
  expect(await index.removeAlways('a', 'mcp__wt__generate_image')).toEqual([]);
  expect(await index.addAlways('a', 'mcp__wt__edit_image')).toEqual(['mcp__wt__edit_image']);
});

test('el log de un "siempre" corrupto no trae el dueño, su base64url ni el contenido del blob', async () => {
  const blob = new FakeBlob();
  const index = createChatIndex({ blob });
  const owner = 'persona@ejemplo.com';
  await index.addAlways(owner, 'mcp__wt__generate_image');
  const key = [...blob.files.keys()].find((k) => k.startsWith('always/'))!;
  blob.files.set(key, { text: '{"secreto-en-el-blob', etag: 99 });
  const logged: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
  try {
    await index.readAlways(owner);
    await index.removeAlways(owner, 'mcp__wt__generate_image');
  } finally {
    console.error = original;
  }
  expect(logged.length).toBe(2);
  for (const line of logged) {
    for (const leak of [owner, Buffer.from(owner).toString('base64url'), 'secreto-en-el-blob']) expect(line).not.toContain(leak);
  }
});

test('"siempre" se guarda como patrón Dynamic(<tool>) y el formato anterior {tools} se sigue leyendo', async () => {
  const blob = new FakeBlob();
  const index = createChatIndex({ blob });
  await index.addAlways('a', 'mcp__wt__generate_image');
  const key = [...blob.files.keys()].find((k) => k.startsWith('always/'))!;
  expect(JSON.parse(blob.files.get(key)!.text).patterns).toEqual(['Dynamic(mcp__wt__generate_image)']);
  blob.files.set(key, { text: JSON.stringify({ tools: ['mcp__wt__edit_image'], updatedAt: 1 }), etag: 99 });
  expect(await index.readAlways('a')).toEqual(['mcp__wt__edit_image']);
  blob.files.set(key, { text: JSON.stringify({ patterns: ['Tool(mcp__wt__x:*)'] }), etag: 100 });
  expect(await index.readAlways('a')).toEqual([]); // un patrón que no es Dynamic(<tool>) no vale como "siempre" (y el blob se lee como corrupto)
});

test('aprobaciones pendientes: patrones calculados aquí, una decisión, permiso una vez, uso una vez, vencimiento y tope por chat', async () => {
  let t = 1_000;
  const index = createChatIndex({ blob: new FakeBlob(), now: () => t });
  const chat = 'c'.repeat(30);
  const item = await index.registerPending('a', chat, 'call1', 'mcp__slack__send', false, 120_000);
  expect(item).toMatchObject({ tool: 'mcp__slack__send', patterns: ['Tool(mcp__slack__send:*)'], remember: [], exp: 121_000 });
  expect((await index.registerPending('a', chat, 'call1', 'mcp__otra__x', false, 120_000)).tool).toBe('mcp__slack__send'); // la primera tool manda
  expect((await index.registerPending('a', chat, 'call2', 'mcp__wt__generate_image', true, 120_000)).remember).toEqual(['Dynamic(mcp__wt__generate_image)']);
  expect(await index.takeGrant('a', chat, 'call1')).toBeUndefined(); // sin decisión
  expect(await index.decidePending('a', chat, 'call1', 'allow')).toBe('ok');
  expect(await index.decidePending('a', chat, 'call1', 'always')).toBe('decided');
  expect(await index.decidePending('a', chat, 'nada', 'allow')).toBe('none');
  expect(await index.useGrant('a', chat, 'call1', 'mcp__slack__send')).toBe(false); // aún no entregado
  expect((await index.takeGrant('a', chat, 'call1'))?.tool).toBe('mcp__slack__send');
  expect(await index.takeGrant('a', chat, 'call1')).toBeUndefined();
  expect(await index.useGrant('a', chat, 'call1', 'mcp__otra__x')).toBe(false);
  expect(await index.useGrant('a', chat, 'call1', 'mcp__slack__send')).toBe(true);
  expect(await index.useGrant('a', chat, 'call1', 'mcp__slack__send')).toBe(false);
  expect(await index.readPending('b', chat, 'call1')).toBeUndefined(); // otro dueño no lo ve
  t += 121_001;
  expect(await index.readPending('a', chat, 'call2')).toBeUndefined(); // vencido
  for (let i = 0; i < 16; i++) await index.registerPending('a', chat, `n${i}`, 'mcp__slack__send', false, 120_000);
  await expect(index.registerPending('a', chat, 'n16', 'mcp__slack__send', false, 120_000)).rejects.toThrow(PendingLimitError);
  await index.registerPending('a', 'd'.repeat(30), 'n0', 'mcp__slack__send', false, 120_000); // el tope es por chat
});

test('el input de una aprobación sale del blob al entregar el permiso o al saltarla', async () => {
  const blob = new FakeBlob();
  const index = createChatIndex({ blob, now: () => 1_000 });
  const chat = 'c'.repeat(30);
  const dump = () => [...blob.files.values()].map((f) => f.text).join('');
  await index.registerPending('a', chat, 'k1', 'mcp__a__b', false, 120_000, { body: 'secreto-1' });
  await index.registerPending('a', chat, 'k2', 'mcp__a__b', false, 120_000, { body: 'secreto-2' });
  await index.decidePending('a', chat, 'k1', 'allow');
  expect(dump()).toContain('secreto-1'); // un revert aún necesita mostrar la tarjeta
  await index.takeGrant('a', chat, 'k1');
  expect(dump()).not.toContain('secreto-1');
  await index.decidePending('a', chat, 'k2', 'skip');
  expect(dump()).not.toContain('secreto-2');
  expect((await index.readPending('a', chat, 'k1'))?.args).toMatch(/^[0-9a-f]{64}$/);
});

test('consultas que no cambian nada no escriben ni crean blobs, y los errores del índice no citan la ruta del dueño', async () => {
  const blob = new FakeBlob();
  const owner = 'persona@ejemplo.com';
  const index = createChatIndex({ blob });
  const chat = 'c'.repeat(30);
  expect(await index.decidePending(owner, chat, 'nada', 'allow')).toBe('none');
  expect(await index.takeGrant(owner, chat, 'nada')).toBeUndefined();
  expect(await index.useGrant(owner, chat, 'nada', 'mcp__a__b')).toBe(false);
  await index.revertPending(owner, chat, 'nada');
  expect(blob.files.size).toBe(0);
  await index.registerPending(owner, chat, 'k', 'mcp__a__b', false, 120_000, { x: 1 });
  const key = [...blob.files.keys()][0]!;
  const etag = blob.files.get(key)!.etag;
  expect(await index.decidePending(owner, chat, 'k', 'allow')).toBe('ok');
  const afterDecide = blob.files.get(key)!.etag;
  expect(afterDecide).not.toBe(etag);
  expect(await index.decidePending(owner, chat, 'k', 'always')).toBe('decided');
  expect(await index.takeGrant(owner, chat, 'otro')).toBeUndefined();
  expect(blob.files.get(key)!.etag).toBe(afterDecide);
  // Los mensajes de error llegan a los logs: ni el dueño ni su base64url.
  blob.files.set(key, { text: '{"items":3}', etag: 77 });
  const leak = Buffer.from(owner).toString('base64url');
  const msg = await index.registerPending(owner, chat, 'k2', 'mcp__a__b', false, 120_000).then(() => '', (e: Error) => e.message);
  expect(msg).toContain('no tiene la forma');
  expect(msg).not.toContain(leak);
  const stuck = createChatIndex({ blob: { read: async () => ({ text: '{"items":{}}', etag: 'e1' }), create: async () => ({ etag: 'e2' }), replace: async () => { throw new BlobConflictError('x'); }, list: async () => [] }, sleep: async () => undefined, maxRetries: 1 });
  const contention = await stuck.registerPending(owner, chat, 'k3', 'mcp__a__b', false, 120_000).then(() => '', (e: Error) => e.message);
  expect(contention).toContain('sigue en disputa');
  expect(contention).not.toContain(leak);
  expect(contention).not.toContain(owner);
});
