// QA unidad 3 (docs/notas/siguiente-modulo-builder.md), "freshTscError mudo": en vivo sobre el chat real clonado (main
// b015eb84), replaceImage y sectionOp pasan 13,3-13,7 s entre message.start y el primer evento, el tsc del ws (13,4 s
// medido a mano). Causa: stepAsync (shared.ts:436-442) emite step.start y step.end juntos cuando `fn` ya terminó, así
// que durante el typecheck el builder no tiene ningún paso que pintar. Un paso sin `shown` (siempre visible) emite
// step.start antes de correr `fn`.
import { expect, test } from 'bun:test';
import type { EventBody, EngineEvent } from '../src/runtime/event-model';
import type { EventLog } from '../src/runtime/events';
import { stepAsync } from '../src/runtime/shared';

test('stepAsync emite step.start antes de que termine el trabajo del paso', async () => {
  const seen: string[] = [];
  const log: EventLog = { emit: (body: EventBody) => { seen.push(body.type); return body as unknown as EngineEvent; } };
  let finish!: () => void;
  const gate = new Promise<void>((r) => { finish = r; });
  const step = stepAsync(log, 'transport:replace-image', ['Replacing image', 'Replaced image'], async () => {
    await gate;
    return { value: undefined, detail: { kind: 'action' as const, name: 'replace-image', summary: 'x' } };
  });
  // El trabajo (tsc) todavía corre: el paso ya tiene que verse.
  await Promise.resolve();
  const whileRunning = [...seen];
  finish();
  await step;
  expect(whileRunning).toEqual(['step.start']);
});
