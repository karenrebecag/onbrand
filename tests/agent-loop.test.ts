import { chmodSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { AgentTurn } from '../src/runtime/agent-stream';
import { AGENT_STREAM_FILE, CLI_TOOLS, CliInterrupted, agentArgs, createSteer, missingChecks, resumePrompt, runAgent, spawnAgentCli, type RunAgentCli } from '../src/runtime/agent-loop';

const turn = (over: Partial<AgentTurn>): AgentTurn => ({ summary: '', usage: {}, isError: false, writes: [], lastWriteAt: -1, checks: [], denials: 0, ...over });
const REQ = ['typecheck', 'build', 'browser:1440', 'browser:375'] as const;

describe('agent-loop', () => {
  test('una verificación solo cuenta si pasó después de la última escritura', () => {
    const t = turn({ lastWriteAt: 5, checks: [
      { name: 'typecheck', at: 3, ok: true }, // antes de escribir: no vale
      { name: 'build', at: 6, ok: true },
      { name: 'browser:1440', at: 7, ok: false },
      { name: 'browser:375', at: 8, ok: true },
    ] });
    expect(missingChecks(t, REQ)).toEqual(['typecheck', 'browser:1440']);
    expect(missingChecks(turn({ lastWriteAt: -1, checks: [{ name: 'typecheck', at: 0, ok: true }, { name: 'build', at: 1, ok: true }] }), ['typecheck', 'build'])).toEqual([]);
    expect(resumePrompt(['browser:375'])).toContain('375 px');
  });

  test('el agente puede renombrar con mv: el follow-up renumera secciones sin recurrir a node -e (denegado en la demo)', () => {
    expect(CLI_TOOLS).toContain('Bash(mv:*)');
    expect(CLI_TOOLS.some((t) => /Bash\((rm|node|python)/.test(t))).toBe(false);
  });

  // B3: Read ya cubre la lectura; cat/head por Bash solo sumaban superficie de shell sobre el entorno del CLI.
  test('el agente no tiene cat ni head por Bash', () => {
    expect(CLI_TOOLS.some((t) => /^Bash\((cat|head)\b/.test(t))).toBe(false);
  });

  test('los argumentos del CLI llevan modelo, stream-json, system, tools, mcp y resume', () => {
    const args = agentArgs({ dir: '/ws', system: 'S', prompt: 'P', model: 'sonnet', allowedTools: ['Read', 'mcp__wt__browser'], mcpConfig: '{"mcpServers":{}}', resume: 'sess' });
    expect(args).toEqual(['-p', '--model', 'sonnet', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--append-system-prompt', 'S', '--allowedTools', 'Read,mcp__wt__browser', '--strict-mcp-config', '--setting-sources', 'project', '--disable-slash-commands', '--tools', 'Read,Write,Edit,Glob,Grep,Bash', '--mcp-config', '{"mcpServers":{}}', '--resume', 'sess']);
  });

  // thinking.effort se validaba en el transport y nunca llegaba al CLI (agente.md §2).
  test('el esfuerzo del pedido llega como --effort; sin él, el CLI usa el suyo', () => {
    const args = agentArgs({ dir: '/ws', system: 'S', prompt: 'P', model: 'sonnet', allowedTools: ['Read'], effort: 'high' });
    expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2)).toEqual(['--effort', 'high']);
    expect(agentArgs({ dir: '/ws', system: 'S', prompt: 'P', model: 'sonnet', allowedTools: ['Read'] })).not.toContain('--effort');
  });

  test('el subproceso nunca hereda los MCP de la sesión: --strict-mcp-config va siempre, con o sin servidor wt', () => {
    // Hallazgo de QA (QA-FINAL-3): en un follow-up el CLI intentó mcp__atom-knowledge__atom_image_prompt, un servidor
    // de la sesión de Karen con tools de publicar; solo lo paró la allowlist.
    const bare = agentArgs({ dir: '/ws', system: 'S', prompt: 'P', model: 'sonnet', allowedTools: ['Read'] });
    expect(bare).toContain('--strict-mcp-config');
    expect(bare).not.toContain('--mcp-config');
  });

  test('con maxResumes 0 no reanuda aunque falten verificaciones; con 1 reanuda la sesión (lo que usa el composer desde gen7)', async () => {
    const calls: { args: string[]; input: string }[] = [];
    const run: RunAgentCli = async (_bin, args, input, _cwd, onLine) => {
      calls.push({ args, input });
      onLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-9' }));
      onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w', name: 'Write', input: { file_path: '/ws/src/App.tsx' } }] } }));
      onLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'w', content: 'ok' }] } }));
      if (args.includes('--resume')) {
        onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'mcp__wt__typecheck', input: {} }] } }));
        onLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'OK' }] } }));
      }
      onLine(JSON.stringify({ type: 'result', subtype: 'success', result: args.includes('--resume') ? 'segundo' : 'primero', session_id: 'sess-9' }));
      return 0;
    };
    const o = { dir: '/ws', system: 'S', prompt: 'P', model: 'sonnet', allowedTools: ['Write'], run };
    const zero = await runAgent(o, undefined, ['typecheck'], 0);
    expect(zero.turns).toBe(1);
    expect(zero.missing).toEqual(['typecheck']);
    expect(zero.turn.summary).toBe('primero');
    calls.length = 0;
    const one = await runAgent(o, undefined, ['typecheck'], 1);
    expect(one.turns).toBe(2);
    expect(one.missing).toEqual([]);
    expect(one.turn.summary).toBe('segundo');
    expect(one.turn.writes).toEqual(['src/App.tsx']);
    expect(calls[1]?.args.slice(-2)).toEqual(['--resume', 'sess-9']);
    expect(calls[1]?.input).toBe(resumePrompt(['typecheck']));
  });

  test('un mensaje con el turno en curso entra por stdin; el stdin se cierra en el primer result y un segundo result igual cuenta', async () => {
    const steer = createSteer();
    const stdin: (string | null)[] = [];
    const run: RunAgentCli = (_bin, _args, _input, _cwd, onLine, _signal, attach) => new Promise((resolve) => {
      attach?.((text) => { stdin.push(text); if (text === null) resolve(0); return true; });
      onLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }));
      expect(steer.send('y el subtítulo')).toBe(true);
      onLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'primero', session_id: 's1' }));
      // QA en vivo: el CLI puede fundir el mensaje en vuelo en ese mismo result; esperar otro colgaba el turno.
      expect(stdin).toEqual(['y el subtítulo', null]);
      expect(steer.send('después del cierre')).toBe(false);
      // Si lo tomó como turno aparte, su result llega antes del EOF y es el resumen final.
      onLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'con subtítulo', session_id: 's1' }));
    });
    const r = await runAgent({ dir: '/ws', system: 'S', prompt: 'P', model: 'sonnet', allowedTools: ['Write'], run, steer }, undefined, [], 0);
    expect(stdin).toEqual(['y el subtítulo', null]);
    expect(r.turn.summary).toBe('con subtítulo');
    expect(steer.send('tarde')).toBe(false);
  });

  // QA en vivo (#352): spawnAgentCli no recibía stdin y todo turno moría con "stdin is not defined"; los run falsos no pasan por el spawn.
  test('con el spawn real, el mensaje en vuelo llega por stdin y el CLI cierra tras el último resultado', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-spawn-'));
    const bin = join(dir, 'fake-cli.sh');
    writeFileSync(bin, [
      '#!/bin/sh',
      'read first',
      'echo \'{"type":"system","subtype":"init","session_id":"s"}\'',
      'sleep 0.4',
      'echo \'{"type":"result","subtype":"success","result":"uno","session_id":"s"}\'',
      'while read line; do echo \'{"type":"result","subtype":"success","result":"dos","session_id":"s"}\'; done',
    ].join('\n'));
    chmodSync(bin, 0o755);
    const steer = createSteer();
    const pending = runAgent({ dir, system: 'S', prompt: 'P', model: 'sonnet', allowedTools: ['Write'], run: spawnAgentCli, bin, steer }, undefined, [], 0);
    await new Promise((r) => setTimeout(r, 100));
    expect(steer.send('y el subtítulo')).toBe(true);
    const r = await pending;
    expect(r.turn.summary).toBe('dos');
    expect(steer.send('tarde')).toBe(false);
  });

  // QA en vivo: un SIGHUP (129) cortó un T1 a los 345 s y no quedó nada.
  test('si el CLI muere por una señal ajena se reanuda una vez su sesión; si vuelve a morir, el turno sale interrumpido', async () => {
    const prompts: string[] = [];
    const runWith = (deaths: number): RunAgentCli => async (_bin, args, input, _cwd, onLine) => {
      prompts.push(args.includes('--resume') ? input : 'first');
      onLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }));
      if (prompts.length <= deaths) throw new CliInterrupted('claude-code: cortado por SIGHUP');
      onLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'terminé', session_id: 's1' }));
      return 0;
    };
    const o = { dir: '/ws', system: 'S', prompt: 'P', model: 'sonnet', allowedTools: ['Write'] };
    const once = await runAgent({ ...o, run: runWith(1) }, undefined, [], 0);
    expect(once.turns).toBe(2);
    expect(once.turn.interrupted).toBeUndefined();
    expect(once.turn.summary).toBe('terminé');
    expect(prompts[1]).toContain('se cortó desde afuera');
    prompts.length = 0;
    const twice = await runAgent({ ...o, run: runWith(2) }, undefined, [], 0);
    expect(twice.turns).toBe(2);
    expect(twice.turn.interrupted).toBe(true);
  });

  test('si el CLI ya salió el mensaje no se da por entregado aunque el turno siga abierto', async () => {
    const steer = createSteer();
    let answer: boolean | undefined;
    const run: RunAgentCli = async (_bin, _args, _input, _cwd, onLine, _signal, attach) => {
      attach?.(() => false);
      onLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }));
      answer = steer.send('tarde');
      return 0;
    };
    await runAgent({ dir: '/ws', system: 'S', prompt: 'P', model: 'sonnet', allowedTools: ['Write'], run, steer }, undefined, [], 0);
    expect(answer).toBe(false);
  });

  test('un cancel de la persona corta el CLI en curso y no reanuda aunque falten verificaciones', async () => {
    const ctl = new AbortController();
    let calls = 0;
    const run: RunAgentCli = (_bin, _args, _input, _cwd, onLine, signal) => new Promise((resolve) => {
      calls++;
      onLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }));
      signal?.addEventListener('abort', () => resolve(143), { once: true });
      ctl.abort();
    });
    const r = await runAgent({ dir: '/ws', system: 'S', prompt: 'P', model: 'sonnet', allowedTools: ['Write'], run, signal: ctl.signal }, undefined, ['typecheck'], 2);
    expect(calls).toBe(1);
    expect(r.turns).toBe(1);
  });

  test('el stdout crudo del CLI queda en .wt/agent-stream.ndjson con la hora de llegada, y sin workspace no rompe', async () => {
    const run: RunAgentCli = async (_bin, _args, _input, _cwd, onLine) => {
      onLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }));
      onLine('no es json');
      onLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'fin', session_id: 's1' }));
      return 0;
    };
    const dir = mkdtempSync(join(tmpdir(), 'wt-raw-'));
    await runAgent({ dir, system: 'S', prompt: 'P', model: 'sonnet', allowedTools: ['Write'], run }, undefined, [], 0);
    const lines = readFileSync(join(dir, AGENT_STREAM_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l.type ?? l.text)).toEqual(['system', 'no es json', 'result']);
    expect(lines.every((l) => typeof l.wt_at === 'number')).toBe(true);
    const missing = join(tmpdir(), 'wt-raw-no-existe');
    const r = await runAgent({ dir: missing, system: 'S', prompt: 'P', model: 'sonnet', allowedTools: ['Write'], run }, undefined, [], 0);
    expect(r.turn.summary).toBe('fin');
    expect(existsSync(missing)).toBe(false);
  });
});

// Review de ec 2026-10-29: cada result trae solo los tokens de su tramo; el turno que ve el builder es la suma.
test('los tokens del turno suman cada result: varios en un stream y la reanudación', async () => {
  const res = (input: number, output: number) => JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', session_id: 's', usage: { input_tokens: input, output_tokens: output } });
  const run: RunAgentCli = async (_bin, args, _input, _cwd, onLine) => {
    onLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }));
    if (args.includes('--resume')) {
      onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'mcp__wt__typecheck', input: {} }] } }));
      onLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'OK' }] } }));
      onLine(res(100, 10));
    } else {
      onLine(res(1_000, 100));
      onLine(res(2_000, 200));
    }
    return 0;
  };
  const out = await runAgent({ dir: '/ws', system: 'S', prompt: 'P', model: 'sonnet', allowedTools: [], run }, undefined, ['typecheck'], 1);
  expect(out.turns).toBe(2);
  expect(out.turn.usage).toMatchObject({ inputTokens: 3_100, outputTokens: 310 });
});

// QA 2026-11-02: un CLI que muere sin `result` no es una pregunta del agente. Con código distinto de 0 ya era error (con
// stderr); con 0 y sin result se aceptaba y el turno cerraba "Pregunta antes de editar" con 0 archivos.
test('spawnAgentCli: el CLI que sale sin result es error, con su código y stderr', async () => {
  const init = "console.log(JSON.stringify({type:'system',subtype:'init'})); console.error('boom stderr');";
  for (const code of [1, 0]) {
    const lines: string[] = [];
    await expect(spawnAgentCli('bun', ['-e', `${init} process.exit(${code})`], '', tmpdir(), (l) => lines.push(l))).rejects.toThrow(code ? 'salió con 1 — boom stderr' : 'salió sin resultado (código 0) — boom stderr');
    expect(lines).toHaveLength(1);
  }
});
