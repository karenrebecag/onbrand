import { describe, expect, test } from 'bun:test';
import { buildSystemPrompt, claudeCopyGeneratorFromEnv, claudeInfer } from '../src/copygen/claude-transport';
import { llmCopyGenerator, type PageContentRequest } from '../src/copygen/generator';

const req: PageContentRequest = {
  inputJson: JSON.stringify({ sections: [{ section_id: 'section_0' }] }),
  language: 'Spanish',
  languageLOTE: 'Spanish',
};

describe('transporte Claude para la frontera CopyGenerator', () => {
  test('sin ANTHROPIC_API_KEY no se construye (el runner cae al determinista)', () => {
    expect(claudeCopyGeneratorFromEnv({})).toBeUndefined();
    expect(claudeCopyGeneratorFromEnv({ ANTHROPIC_API_KEY: 'sk-x' })?.id).toBe('llm');
  });

  test('el system prompt fija idioma, presupuesto y la forma JSON exacta de salida', () => {
    const sys = buildSystemPrompt(req);
    expect(sys).toContain('in Spanish');
    expect(sys).toContain('max length');
    expect(sys).toContain('"sections":[{"section_id":"section_0","real_text_fields":[{"id":1,"text":"..."}]}]');
  });

  test('claudeInfer manda inputJson como mensaje de usuario y parsea el texto de la respuesta', async () => {
    let sentBody: unknown;
    const fakeFetch = (async (_url: string, init?: { body?: string }) => {
      sentBody = JSON.parse(init?.body ?? '{}');
      return {
        ok: true,
        json: async () => ({ content: [{ type: 'text', text: 'listo: {"sections":[{"section_id":"section_0","real_text_fields":[{"id":1,"text":"Hola"}]}]}' }] }),
      } as Response;
    }) as unknown as typeof fetch;
    const gen = llmCopyGenerator(claudeInfer({ apiKey: 'sk-x', fetchImpl: fakeFetch }));
    const out = await gen.generate(req);
    expect((sentBody as { messages: { content: string }[] }).messages[0].content).toBe(req.inputJson);
    expect(out.sections[0].real_text_fields[0].text).toBe('Hola');
  });

  test('un status no-ok lanza sin filtrar el cuerpo (puede traer eco de la key)', async () => {
    const fakeFetch = (async () => ({ ok: false, status: 401, json: async () => ({}) } as Response)) as unknown as typeof fetch;
    const infer = claudeInfer({ apiKey: 'sk-x', fetchImpl: fakeFetch });
    await expect(infer('page-content-1', req)).rejects.toThrow('401');
  });
});
