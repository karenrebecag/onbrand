import { describe, expect, test } from 'bun:test';
import { claudeCodeInfer, type RunCli } from '../src/copygen/claude-code-transport';
import { llmCopyGenerator, type PageContentRequest } from '../src/copygen/generator';

const req: PageContentRequest = {
  inputJson: JSON.stringify({ sections: [{ section_id: 'section_0' }] }),
  language: 'Spanish',
  languageLOTE: 'Spanish',
};

describe('transporte CLI de Claude Code (sin key)', () => {
  test('invoca `claude -p` con el system prompt y manda el inputJson por stdin', async () => {
    let seen: { bin: string; args: string[]; input: string } | undefined;
    const run: RunCli = async (bin, args, input) => {
      seen = { bin, args, input };
      return '{"sections":[{"section_id":"section_0","real_text_fields":[{"id":1,"text":"Hola"}]}]}';
    };
    const gen = llmCopyGenerator(claudeCodeInfer({ run, model: 'sonnet' }));
    const out = await gen.generate(req);
    expect(seen?.bin).toBe('claude');
    expect(seen?.args.slice(0, 4)).toEqual(['-p', '--model', 'sonnet', '--append-system-prompt']);
    expect(seen?.args[4]).toContain('in Spanish');
    expect(seen?.input).toBe(req.inputJson);
    expect(out.sections[0].real_text_fields[0].text).toBe('Hola');
  });

  test('tolera texto alrededor del JSON en el stdout', async () => {
    const run: RunCli = async () => 'Aquí tienes: {"sections":[{"section_id":"section_0","real_text_fields":[]}]} listo';
    const infer = claudeCodeInfer({ run });
    const out = await infer('page-content-1', req);
    expect((out as { sections: unknown[] }).sections.length).toBe(1);
  });

  test('un stdout sin objeto JSON lanza', async () => {
    const run: RunCli = async () => 'sin json aquí';
    await expect(claudeCodeInfer({ run })('page-content-1', req)).rejects.toThrow('objeto JSON');
  });
});
