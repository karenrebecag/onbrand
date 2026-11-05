// preserve.pinned (Q1, O3): lo dictado literal queda fijo. La secuencia es la de QA en vivo (verificacion.md §6.1 paso 4,
// §7.3 paso 14; O3 sobre b70cc248): ta dicta el titular, tc pide "Usa un tono más formal en toda la página" y el agente
// pasaba "Convierte" a "Convierta". Sin LLM ni reloj: agente falso y CLI falso.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPinned, createAgentComposer } from '../src/runtime/agent-composer';
import type { RunAgentCli } from '../src/runtime/agent-loop';
import { followUpUserPrompt } from '../src/runtime/agent-prompt';
import { readEvents, type EngineEvent } from '../src/runtime/events';
import { commitAll, initRepo } from '../src/runtime/git-workspace';
import { pinNorm, pinnedLost, pinsFrom, planLiterals, quotedLiterals, type Pin } from '../src/runtime/pinned';
import type { PageModel } from '../src/runtime/runner';
import { Runtime, type ComposeRequest } from '../src/runtime/server';

const HEADLINE = 'Convierte cada conversación de WhatsApp en una venta';
const TA = `Cambia el titular del hero por: "${HEADLINE}"`;
const TC = 'Usa un tono más formal en toda la página';
const HERO = 'src/sections/02-hero.tsx';
const hero = (h1: string, sub = 'Tu equipo vende mientras duermes.') =>
  `export default function Hero() {\n  return (\n    <section>\n      <h1 className="hero__title">\n        ${h1}\n      </h1>\n      <p>${sub}</p>\n    </section>\n  );\n}\n`;

describe('qué queda fijo', () => {
  test('el texto entre comillas de un pedido, con dos palabras o más, en cualquier comilla doble', () => {
    expect(quotedLiterals(TA)).toEqual([HEADLINE]);
    expect(quotedLiterals('Pon «Agenda tu demo» y “Hablemos hoy mismo” en los botones')).toEqual(['Agenda tu demo', 'Hablemos hoy mismo']);
    // Una palabra suelta o un apóstrofo no fijan nada.
    expect(quotedLiterals('Cambia "Hola" por algo mejor; it\'s fine')).toEqual([]);
  });

  test('del plan, solo titular/apoyo/cta que la persona escribió (línea usuario:)', () => {
    const plan = ['## Cambios', '## 02-hero', `- titular: usuario: ${HEADLINE}`, '- apoyo: Atiende 24/7', '- focal: usuario: foto del equipo', '- cta: usuario: "Agenda tu demo"'].join('\n');
    expect(planLiterals(plan)).toEqual([HEADLINE, 'Agenda tu demo']);
  });

  test('el TSX se compara sin saltos de JSX ni entidades', () => {
    expect(pinNorm(hero(HEADLINE))).toContain(HEADLINE);
    expect(pinNorm('<h1>Convierte cada{" "}\n conversación&nbsp;de WhatsApp en una venta</h1>')).toContain(HEADLINE);
  });

  test('solo se fija lo que la versión padre todavía tiene; el más nuevo gana si dos turnos dictan lo mismo', () => {
    const files = { [HERO]: hero(HEADLINE) };
    const pins = pinsFrom([{ messageId: 't0', literals: ['Un titular viejo reemplazado'] }, { messageId: 'ta', literals: [HEADLINE] }], files);
    expect(pins).toEqual([{ text: HEADLINE, file: HERO, messageId: 'ta' }]);
  });
});

describe('el sensor pinned.lost', () => {
  const pins: Pin[] = [{ text: HEADLINE, file: HERO, messageId: 'ta' }];

  test('marca el titular dictado que un cambio global pisó, con archivo y texto', () => {
    expect(pinnedLost(pins, { [HERO]: hero('Convierta cada conversación de WhatsApp en una venta', 'Su equipo vende.') }, TC)).toEqual([{ text: HEADLINE, file: HERO, messageId: 'ta' }]);
    expect(pinnedLost(pins, { [HERO]: hero(HEADLINE, 'Su equipo vende.') }, TC)).toEqual([]);
  });

  test('un pedido que dicta otro texto para ese archivo lo reemplaza: no es pérdida', () => {
    expect(pinnedLost(pins, { [HERO]: hero('Venda por WhatsApp sin perder un cliente') }, 'Cambia el titular por "Venda por WhatsApp sin perder un cliente"')).toEqual([]);
  });

  test('el prompt del follow-up lleva la lista como texto fijo', () => {
    const p = followUpUserPrompt(TC, { contextFiles: [], pinned: pins });
    expect(p).toContain('TEXTO FIJO');
    expect(p).toContain(`- "${HEADLINE}" (${HERO})`);
    expect(p.indexOf('TEXTO FIJO')).toBeLessThan(p.indexOf('MENSAJE'));
    expect(followUpUserPrompt(TC, { contextFiles: [] })).not.toContain('TEXTO FIJO');
  });
});

describe('ta → tc por el transport', () => {
  let tmp: string;
  let root: string;
  let server: Server | undefined;
  let seen: Record<string, ComposeRequest>;
  // Lo que escribe el agente falso en tc: con el titular intacto o pisado.
  let tcHeadline: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pinned-'));
    root = join(tmp, 'state');
    mkdirSync(join(tmp, 'scaffold', 'src'), { recursive: true });
    writeFileSync(join(tmp, 'scaffold', '.gitignore'), 'node_modules\n');
    writeFileSync(join(tmp, 'scaffold', 'src', 'main.tsx'), '// main\n');
    mkdirSync(join(tmp, 'vault'));
    seen = {};
  });
  afterEach(() => {
    server?.close();
    server = undefined;
    rmSync(tmp, { recursive: true, force: true });
  });

  async function agent(req: ComposeRequest, log: Parameters<typeof checkPinned>[3]): Promise<PageModel> {
    seen[req.messageId] = req;
    const dir = req.workspace?.dir as string;
    mkdirSync(join(dir, 'src', 'sections'), { recursive: true });
    const h1 = req.messageId === 't1' ? 'Tu equipo de ventas, despierto 24/7' : req.messageId === 'ta' ? HEADLINE : tcHeadline;
    writeFileSync(join(dir, HERO), hero(h1, req.messageId === 'tc' ? 'Su equipo vende mientras usted descansa.' : undefined));
    // El composer real corre el sensor al cerrar (agent-composer checkPinned); el falso lo llama igual.
    checkPinned(dir, req, undefined, log);
    return { sections: [], agent: { files: [HERO], summary: 'Listo', missing: [], sessionId: `s-${req.messageId}` } } as unknown as PageModel;
  }

  async function chain(): Promise<void> {
    const t = new Runtime({ root, allow: {}, agent: true, compose: agent as never, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), autoRepair: false });
    server = t.listen(0);
    await new Promise((r) => server!.once('listening', r));
    const at = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    let parent: string | undefined;
    for (const [id, prompt] of [['t1', 'Landing para Acme'], ['ta', TA], ['tc', TC]] as const) {
      const r = await fetch(`${at}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, messageId: id, ...(parent ? { parentId: parent } : {}) }) });
      expect(r.status).toBe(202);
      for (let i = 0; i < 1000 && !readEvents(join(root, 'logs'), id).events.some((e) => e.type === 'settled'); i++) await new Promise((res) => setTimeout(res, 10));
      parent = id;
    }
  }
  const pinnedStep = (id: string) => readEvents(join(root, 'logs'), id).events.find((e) => e.type === 'step.end' && (e as { stepId?: string }).stepId === 'agent:pinned') as (EngineEvent & { status?: string; label?: string; detail?: { output?: { defects?: unknown[] } } }) | undefined;

  test('tc recibe el titular de ta como fijo; si lo conserva, el sensor queda en verde', async () => {
    tcHeadline = HEADLINE;
    await chain();
    expect(seen.ta?.history?.pinned).toBeUndefined();
    expect(seen.tc?.history?.pinned).toEqual([{ text: HEADLINE, file: HERO, messageId: 'ta' }]);
    expect(pinnedStep('tc')).toMatchObject({ status: 'ok', detail: { output: { defects: [] } } });
  });

  test('si tc lo pisa ("Convierta"), el log del mensaje trae pinned.lost con archivo y texto', async () => {
    tcHeadline = 'Convierta cada conversación de WhatsApp en una venta';
    await chain();
    expect(pinnedStep('tc')).toMatchObject({ status: 'error', detail: { output: { defects: [{ field: 'pinned.lost', file: HERO, text: HEADLINE, messageId: 'ta' }] } } });
  });
});

describe('en el composer real (CLI falso)', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'pinned-composer-')); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  test('el prompt del follow-up lleva el texto fijo y el turno que lo pisa cierra con agent:pinned en error', async () => {
    const skill = join(tmp, 'skill');
    mkdirSync(join(skill, 'references'), { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '# skill\n');
    const ws = join(tmp, 'ws');
    mkdirSync(join(ws, 'src', 'sections'), { recursive: true });
    writeFileSync(join(ws, 'index.html'), '<!doctype html><html lang="es"><head><title>Acme</title></head><body></body></html>');
    writeFileSync(join(ws, HERO), hero(HEADLINE));
    initRepo(ws);
    commitAll(ws, 'ta');
    let input = '';
    const run: RunAgentCli = async (_bin, _args, stdin, cwd, onLine) => {
      // La primera llamada lleva el prompt; las reanudaciones por verificación faltante traen otro texto.
      input ||= String(stdin ?? '');
      const file = join(cwd, HERO);
      writeFileSync(file, hero('Convierta cada conversación de WhatsApp en una venta', 'Su equipo vende.'));
      onLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }));
      onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w1', name: 'Edit', input: { file_path: file } }] } }));
      onLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'ok' }] } }));
      onLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'Pasé la página a usted.', session_id: 's', duration_ms: 10 }));
      return 0;
    };
    const evs: EngineEvent[] = [];
    const compose = createAgentComposer(skill, { run });
    const pinned: Pin[] = [{ text: HEADLINE, file: HERO, messageId: 'ta' }];
    const page = await compose({ prompt: TC, messageId: 'tc', parentId: 'ta', workspace: { dir: ws }, history: { thread: [{ messageId: 'ta', prompt: TA }], tools: [], lastFiles: [HERO], pinned } }, { emit: (e: EngineEvent) => evs.push(e) } as never);
    expect(input).toContain(`- "${HEADLINE}" (${HERO})`);
    const end = evs.find((e) => e.type === 'step.end' && (e as { stepId?: string }).stepId === 'agent:pinned') as { status?: string; error?: { message?: string } } | undefined;
    expect(end?.status).toBe('error');
    expect(end?.error?.message).toBe(`${HERO}: "${HEADLINE}"`);
    expect(readFileSync(join(ws, HERO), 'utf8')).toContain('Convierta');
    expect(page.agent?.pinnedLost).toEqual([{ text: HEADLINE, file: HERO, messageId: 'ta' }]);
  });
});
