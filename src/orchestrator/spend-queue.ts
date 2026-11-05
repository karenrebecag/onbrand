// Cola de ajustes de gasto por dueño: encola y hace flush serializado contra el índice. Extraído de gateway-proxy.ts (B1);
// los cuerpos de enqueue y flush no cambian. Falla cerrado: mientras un dueño tenga un ajuste sin registrar, no se le atiende.

import type { ChatIndex, TokenUsage } from './chat-index';

// `id` viaja en cada reintento: el índice lo recuerda y un write ambiguo que sí se aplicó no se suma dos veces.
// `day`: el día UTC en que se reservó; la liquidación cae en ese contador aunque el cierre llegue después de medianoche.
export type Entry = { id: string; delta: number; tokens?: { model: string; usage: TokenUsage }; day?: string };

export interface SpendQueueDeps {
  readonly index: Pick<ChatIndex, 'adjustSpend'>;
  /** Intentos de adjustSpend por gasto antes de bloquear al dueño. */
  readonly attempts: number;
  /** Espera antes del reintento número `attempt`. */
  readonly sleep: (attempt: number) => Promise<void>;
  /** Un fallo al contar el gasto no puede romper la respuesta ya entregada, pero tampoco callarse. */
  readonly fail: (what: string, e: unknown) => void;
}

export interface SpendQueue {
  /** Ajustes sin registrar por dueño; `has(owner)` dice si hay que reintentar antes de atenderlo. */
  readonly pending: Map<string, Entry[]>;
  readonly enqueue: (owner: string, e: Entry) => void;
  readonly flush: (owner: string) => Promise<boolean>;
}

export function createSpendQueue(deps: SpendQueueDeps): SpendQueue {
  const { attempts, sleep, fail } = deps;
  // HACK: en memoria de la instancia; otra instancia no lo sabe. Persistirlo en el índice cuando se midan pérdidas reales de addSpend.
  const pending = new Map<string, Entry[]>();
  const chains = new Map<string, Promise<boolean>>();

  /** Un solo array por dueño, mutado con push: reemplazarlo mientras un flush lo recorre perdería las entradas de la otra request. */
  function enqueue(owner: string, e: Entry): void {
    const list = pending.get(owner);
    if (list) list.push(e);
    else pending.set(owner, [e]);
  }

  /** Serializa por dueño: dos flush a la vez sumarían dos veces la misma entrada. */
  function flush(owner: string): Promise<boolean> {
    const prev = chains.get(owner) ?? Promise.resolve(true);
    const next = prev.catch(() => true).then(async () => {
      try {
        const list = pending.get(owner);
        for (let attempt = 0; list?.length; attempt++) {
          const e = list[0]!;
          try {
            await deps.index.adjustSpend(owner, e.delta, e.tokens, e.id, e.day);
            list.shift();
            attempt = -1;
          } catch (err) {
            fail('no se pudo sumar el gasto', err);
            if (attempt + 1 >= attempts) return false;
            try { await sleep(attempt); } catch { /* reintenta sin espera */ }
          }
        }
        // Solo si nadie sustituyó ni añadió nada mientras se esperaba el blob.
        if (list && pending.get(owner) === list && list.length === 0) pending.delete(owner);
        return true;
      } catch (err) {
        fail('flush del gasto', err);
        return false;
      }
    });
    chains.set(owner, next);
    void next.then(() => { if (chains.get(owner) === next) chains.delete(owner); });
    return next;
  }

  return { pending, enqueue, flush };
}
