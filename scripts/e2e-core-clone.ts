// e2e del clon limpio del core: verifica con un comando que onbrand funciona con `git clone` + bun + el CLI `claude`, sin
// cuentas ni servicios de una distro (criterio D1-D10 y D3b de re-sistema/onbrand/next/qa-done-clon-limpio.md).
//
//   bun scripts/e2e-core-clone.ts [--repo <url|ruta>] [--ref <rama|sha>] [--dir <vacío>] [--port 5440] [--turn]
//
// Sin --turn no llama a ningún modelo: clone, install, arranque del core, /brands, chequeo de origen y DS montable desde
// registry/. --turn manda UN turno real con `claude -p` (gasta tokens: necesita el OK de Karen). El directorio del clon
// no se borra: queda como evidencia y lo limpia quien lo pidió.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const HERE = resolve(import.meta.dir, '..');
const repo = flag('--repo') ?? spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: HERE, encoding: 'utf8' }).stdout.trim();
const ref = flag('--ref');
const base = flag('--dir') ?? mkdtempSync(join(tmpdir(), 'onbrand-e2e-'));
const port = Number(flag('--port') ?? 5440);
const TURN = args.includes('--turn');
const BUILDER = 'http://localhost:5173';
const PROMPT = 'Landing para una cafetería de especialidad en CDMX';
// Hosts que un turno del core no puede tocar: si aparecen en el log, algo de la variante se coló.
const THIRD_PARTY = /gateway|atom-knowledge|knowledgemcp|pipedream|vercel blob|blob\.vercel|webflow/i;

// Env mínimo: sin él, el check pasa en la máquina de Karen por accidente (vault por $HOME, tokens en el shell). USER se
// queda: en macOS el CLI `claude` busca su login en el llavero por usuario, y sin USER responde "Not logged in" (fase B).
const ENV = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', USER: process.env.USER ?? '', TERM: 'dumb', WT_VAULT_ROOT: '/nonexistent' };

interface Check { id: string; name: string; ok: boolean; detail: string }
const checks: Check[] = [];
const record = (id: string, name: string, ok: boolean, detail: string): boolean => { checks.push({ id, name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}: ${detail}`); return ok; };

const run = (cmd: string, argv: string[], cwd: string) => spawnSync(cmd, argv, { cwd, env: ENV, encoding: 'utf8' });

if (readdirSync(base).length) { console.error(`${base} no está vacío: el clon tiene que vivir solo, sin repos hermanos`); process.exit(2); }
const clone = join(base, 'onbrand');
console.log(`clon en ${clone}`);
const cl = spawnSync('git', ['clone', '--quiet', ...(ref ? [] : ['--depth', '1']), repo, clone], { encoding: 'utf8' });
if (cl.status !== 0) { console.error(cl.stderr); process.exit(2); }
if (ref && run('git', ['checkout', '--quiet', ref], clone).status !== 0) { console.error(`no existe ${ref}`); process.exit(2); }
const head = run('git', ['rev-parse', '--short', 'HEAD'], clone).stdout.trim();

// D1: los tres installs del core, sin arc-scaffold ni fixtures/relume-themed (son de la distro; B9 §6.1).
const installs = ['.', 'templates/base-scaffold', 'apps/builder'].map((d) => ({ d, r: run('bun', ['install', '--frozen-lockfile'], join(clone, d)) }));
record('D1', 'install sin arc-scaffold ni fixtures/relume-themed', installs.every((i) => i.r.status === 0), installs.map((i) => `${i.d}=${i.r.status}`).join(' '));

// D3: todo componente que el skill le ofrece al agente se materializa desde registry/ del repo. Se corre con el código del
// clon, no del checkout que lanza el script.
const dsProbe = `
import { fileRegistry } from '${join(clone, 'src/runtime/registry-file.ts')}';
import { resolveItems, materializeItems } from '${join(clone, 'src/runtime/registry.ts')}';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs'; import { join } from 'node:path'; import { tmpdir } from 'node:os';
const src = await fileRegistry('${join(clone, 'registry')}');
const allow = src.loadIndex ? await src.loadIndex() : {};
const out = mkdtempSync(join(tmpdir(), 'onbrand-ds-'));
materializeItems(await resolveItems(Object.keys(allow), src), out);
const missing = Object.entries(allow).filter(([, a]) => { const p = join(out, 'src', a.importPath.replace('@/', '')); return !['.tsx', '.ts', '/index.tsx', '/index.ts'].some((x) => existsSync(p + x)); }).map(([k]) => k);
const skill = src.skillPack ? await src.skillPack('base-agent') : undefined;
writeFileSync('${join(base, 'registry-allow.json')}', JSON.stringify(allow));
writeFileSync('${join(base, 'registry-skill-dir.txt')}', skill ?? '');
console.log(JSON.stringify({ pin: src.pin, total: Object.keys(allow).length, missing, skill: Boolean(skill) }));`;
const ds = run('bun', ['-e', dsProbe], clone);
try {
  const r = JSON.parse(ds.stdout.trim().split('\n').pop() ?? '') as { pin: string; total: number; missing: string[]; skill: boolean };
  record('D3', 'DS completo montable desde registry/', r.total > 0 && !r.missing.length && r.skill, `pin ${r.pin}: ${r.total - r.missing.length}/${r.total} con archivo, skill del agente ${r.skill ? 'publicado' : 'AUSENTE'}${r.missing.length ? `; faltan ${r.missing.slice(0, 8).join(', ')}` : ''}`);
} catch {
  record('D3', 'DS completo montable desde registry/', false, (ds.stderr || ds.stdout).trim().split('\n').slice(-3).join(' | '));
}

// D2: arranca con el comando obvio, sin flags ni env de la variante.
let server: ChildProcess | undefined;
let log = '';
const up = await new Promise<boolean>((done) => {
  server = spawn('bun', ['scripts/serve.ts', '--port', String(port), '--preview-port', String(port + 1)], { cwd: clone, env: ENV });
  const timer = setTimeout(() => done(false), 180_000);
  const feed = (b: Buffer) => { log += b.toString(); if (log.includes('transport en ')) { clearTimeout(timer); done(true); } };
  server.stdout?.on('data', feed);
  server.stderr?.on('data', feed);
  server.on('exit', (code) => { clearTimeout(timer); log += `\nexit ${code}`; done(false); });
});
record('D2', 'arranca sin flags', up, up ? (log.match(/transport en [^\n;]+/)?.[0] ?? 'arriba') : log.trim().split('\n').slice(-2).join(' | '));

// D3b (C1b): el agente recibe el skill publicado en registry/, no uno armado al arrancar. Armarlo lee el vault, que un clon
// no tiene, y sale degradado en silencio: category en "other", summary del manifiesto, accepts sin children (fase A,
// qa-e2e-faseA.md). Dos condiciones: el server no armó skill local, y el skill del registry es coherente con su índice.
if (up) skillParity();

function skillParity(): void {
  const name = 'skill servido = skill del registry';
  const local = join(clone, 'generated', 'ds-skills');
  if (existsSync(local)) { record('D3b', name, false, `el arranque armó ${local}: leyó el vault en vez del registry`); return; }
  const regAllow = join(base, 'registry-allow.json');
  const dir = existsSync(join(base, 'registry-skill-dir.txt')) ? readFileSync(join(base, 'registry-skill-dir.txt'), 'utf8').trim() : '';
  const served = dir ? join(dir, 'allowlist.json') : '';
  if (!served || !existsSync(served) || !existsSync(regAllow)) { record('D3b', name, false, `el registry no publica un skill con allowlist (${served || 'sin skillPack'})`); return; }
  const a = JSON.parse(readFileSync(served, 'utf8')) as Record<string, Record<string, unknown>>;
  const b = JSON.parse(readFileSync(regAllow, 'utf8')) as Record<string, Record<string, unknown>>;
  const diff: Record<string, number> = {};
  for (const k of Object.keys(b)) for (const f of ['category', 'summary', 'accepts']) if (JSON.stringify(a[k]?.[f]) !== JSON.stringify(b[k]?.[f])) diff[f] = (diff[f] ?? 0) + 1;
  const others = Object.values(a).filter((e) => e.category === 'other').length;
  const n = Object.values(diff).reduce((x, y) => x + y, 0);
  record('D3b', name, n === 0 && others === 0, n || others ? `${Object.entries(diff).map(([f, c]) => `${f} difiere en ${c}`).join(', ')}${others ? `; ${others} en category other` : ''}` : `sin build local; ${Object.keys(b).length} componentes idénticos al índice, 0 en other`);
}

const api = `http://127.0.0.1:${port}`;
const stop = () => { if (server && server.exitCode === null) server.kill('SIGTERM'); };
try {
  if (up) {
    // D5: las marcas salen del repo (brands/), no de packs hermanos.
    const brands = (await (await fetch(`${api}/brands`)).json()) as { brands?: string[] };
    const ids = brands.brands ?? [];
    record('D5', 'perfil core: marcas del repo', ids.includes('base') && ids.includes('ejemplo'), ids.join(', ') || 'ninguna');

    // D6: el builder local escribe (pasa el origen y falla por body) y un origen ajeno no.
    const post = (origin: string) => fetch(`${api}/runs`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.status);
    const [own, foreign] = [await post(BUILDER), await post('http://evil.example')];
    record('D6', 'el builder local escribe', own === 400 && foreign === 403, `localhost:5173 → ${own}, origen ajeno → ${foreign}`);

    if (TURN) { await enhancer(); await turn(); }
    else console.log('SKIP D7-D10: corre con --turn (gasta tokens de claude -p)');
  }
} finally {
  stop();
}

async function enhancer(): Promise<void> {
  // D10: el enhancer responde con el CLI, sin key del Gateway (C4). Corre antes del turno: después, el suggest del turno
  // puede seguir colgado y tumbar esta llamada (fase B sobre 2deabda: 500 colateral, aislado da 200).
  const enh = await fetch(`${api}/prompt-enhancements`, { method: 'POST', headers: { Origin: BUILDER, 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: PROMPT }) });
  const text = await enh.text();
  // En un fallo el cuerpo trae el error del transport: sin él, un 500 no dice si fue el CLI, el login o el modelo.
  record('D10', 'enhancer sin Gateway', enh.ok && text.trim().length > 0, enh.ok ? `${enh.status}, ${text.trim().length} caracteres` : `${enh.status}: ${text.trim().slice(0, 300)}`);
}

async function turn(): Promise<void> {
  const res = await fetch(`${api}/runs`, { method: 'POST', headers: { Origin: BUILDER, 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: PROMPT }) });
  if (!res.ok) { record('D7', 'turno completo', false, `POST /runs → ${res.status} ${await res.text()}`); return; }
  const { messageId } = (await res.json()) as { messageId: string };
  const events: Record<string, unknown>[] = [];
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline && !events.some((e) => e.type === 'settled')) {
    const body = await (await fetch(`${api}/runs/${messageId}/events?cursor=${events.length}`)).text();
    for (const line of body.split('\n')) if (line.trim()) events.push(JSON.parse(line) as Record<string, unknown>);
    await new Promise((r) => setTimeout(r, 2000));
  }
  const end = events.find((e) => e.type === 'message.end') as { outcome?: string } | undefined;
  const preview = events.find((e) => e.type === 'preview') as { url?: string } | undefined;
  const previewStatus = preview?.url ? await fetch(preview.url).then((r) => r.status, () => 0) : 0;
  const root = join(clone, 'generated', 'v0-transport', 'ws');
  const wss = existsSync(root) ? readdirSync(root).filter((ws) => existsSync(join(root, ws, '.wt', 'dist'))) : [];
  const images = events.filter((e) => e.type === 'step.start' && /image/i.test(String(e.tool ?? e.label ?? ''))).length;
  record('D7', 'turno completo', end?.outcome === 'ok' && wss.length > 0 && previewStatus === 200 && images === 0, `outcome ${end?.outcome ?? 'sin message.end'}, dist en ${wss.length} ws, preview ${previewStatus}, ${images} steps de imagen`);

  // D8: lo que escribió el agente importa componentes que existen en su workspace (el DS montado), no inventados.
  const ws = wss[0] ? join(root, wss[0]) : '';
  const imports = ws ? [...new Set(spawnSync('grep', ['-rhoE', `from ['"]@/components/[^'"]+['"]`, join(ws, 'src')], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map((l) => l.slice(6, -1)))] : [];
  const unresolved = imports.filter((p) => !['.tsx', '.ts', '/index.tsx', '/index.ts'].some((x) => existsSync(join(ws, 'src', p.replace('@/', '')) + x)));
  const fromDs = imports.filter((p) => /^@\/components\/(arc|relume|bencho|morphin)\//.test(p));
  record('D8', 'usa el DS, no lo inventa', fromDs.length >= 3 && !unresolved.length, `${fromDs.length} componentes del DS importados${unresolved.length ? `; sin archivo: ${unresolved.slice(0, 5).join(', ')}` : ''}`);

  const leaks = events.filter((e) => THIRD_PARTY.test(JSON.stringify(e))).length + (THIRD_PARTY.test(log) ? 1 : 0);
  record('D9', 'sin terceros', leaks === 0, `${leaks} eventos o líneas de log con hosts de la variante`);

}

const failed = checks.filter((c) => !c.ok);
writeFileSync(join(base, 'e2e-report.json'), JSON.stringify({ repo, head, at: new Date().toISOString(), turn: TURN, checks }, null, 2));
console.log(`\n${head}: ${checks.length - failed.length}/${checks.length} PASS. Reporte en ${join(base, 'e2e-report.json')}; el clon queda en ${clone}`);
process.exit(failed.length ? 1 : 0);
