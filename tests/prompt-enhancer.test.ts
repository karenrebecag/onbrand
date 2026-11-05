import { describe, expect, test } from 'bun:test';
import { cliTextStream, createEnhancer, enhancerInput, type TextStream } from '../src/runtime/prompt-enhancer';

const tick = () => new Promise((r) => setTimeout(r, 0));

// Entrega los chunks de a uno, esperando una señal externa entre cada uno.
function gatedStream(chunks: string[]) {
  const seen: string[] = [];
  let release: () => void = () => {};
  const stream: TextStream = async function* (prompt, signal) {
    seen.push(prompt);
    for (const c of chunks) {
      await new Promise<void>((r) => (release = r));
      if (signal.aborted) return;
      yield c;
    }
  };
  return { stream, seen, next: async () => { release(); await tick(); } };
}

describe('enhancer de prompt', () => {
  test('acumula los chunks, manda el prompt citado tras el system y no acepta otro rewrite en curso', async () => {
    const g = gatedStream(['Una landing', ' para un café.']);
    const e = createEnhancer(g.stream);
    const parts: string[] = [];
    let done: string | undefined;
    e.rewrite('café', (t) => parts.push(t), (t) => (done = t));
    e.rewrite('otro', () => parts.push('no'));
    await tick();
    expect(g.seen).toEqual([enhancerInput('café')]);
    expect(enhancerInput('café').endsWith('Now enhance this prompt:\n"café"')).toBe(true);
    await g.next();
    await g.next();
    await g.next();
    expect(parts).toEqual(['Una landing', 'Una landing para un café.']);
    expect(done).toBe('Una landing para un café.');
    expect(e.isRewriting()).toBe(false);
  });

  test('cancel corta el stream: no llegan más chunks ni onDone, y se puede volver a pedir', async () => {
    const g = gatedStream(['a', 'b']);
    const e = createEnhancer(g.stream);
    const parts: string[] = [];
    let done = false;
    e.rewrite('café', (t) => parts.push(t), () => (done = true));
    await tick();
    await g.next();
    e.cancel();
    await g.next();
    await g.next();
    expect(parts).toEqual(['a']);
    expect(done).toBe(false);
    expect(e.isRewriting()).toBe(false);
    e.rewrite('', () => parts.push('vacío'));
    expect(e.isRewriting()).toBe(false);
  });
});

describe('cliTextStream', () => {
  test('el core mejora el prompt con claude -p, sin clave de gateway', async () => {
    const calls: { bin: string; args: string[]; input: string }[] = [];
    const prev = { key: process.env.AI_GATEWAY_API_KEY, oidc: process.env.VERCEL_OIDC_TOKEN };
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;
    try {
      const stream = cliTextStream({
        bin: 'claude',
        model: 'haiku',
        run: async (bin, args, input) => {
          calls.push({ bin, args, input });
          return '  prompt mejorado\n';
        },
      });
      const out: string[] = [];
      for await (const c of stream('landing de panadería', new AbortController().signal)) out.push(c);
      expect(out).toEqual(['prompt mejorado']);
      expect(calls[0].input).toBe('landing de panadería');
      expect(calls[0].args).toEqual(['-p', '--model', 'haiku', '--strict-mcp-config', '--setting-sources', 'project']);
    } finally {
      if (prev.key !== undefined) process.env.AI_GATEWAY_API_KEY = prev.key;
      if (prev.oidc !== undefined) process.env.VERCEL_OIDC_TOKEN = prev.oidc;
    }
  });
});
