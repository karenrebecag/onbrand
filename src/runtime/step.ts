// Emisión de pasos (step.start/step.end) como los de v0, compartida por todos los caminos que corren trabajo con log:
// el agente, las ediciones y el cierre. Vivía en runner.ts; salió a su módulo al retirar el render sin agente (C5).

import type { EventLog, StepDetail, StepKind } from './events';

export class StepError extends Error {
  constructor(message: string, readonly detail: StepDetail) {
    super(message);
  }
}

/** Emite un paso con la etiqueta en curso y la de terminado, como los pasos de v0. */
export function step<T>(log: EventLog | undefined, id: string, kind: StepKind, labels: [string, string], run: () => { value: T; detail?: StepDetail }): T {
  log?.emit({ type: 'step.start', stepId: id, kind, label: labels[0] });
  try {
    const { value, detail } = run();
    log?.emit({ type: 'step.end', stepId: id, label: labels[1], status: 'ok', ...(detail ? { detail } : {}) });
    return value;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log?.emit({
      type: 'step.end', stepId: id, label: labels[1], status: 'error',
      ...(e instanceof StepError ? { detail: e.detail } : {}),
      error: { type: 'execution-error', message },
    });
    throw e;
  }
}
