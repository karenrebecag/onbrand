// POST /chats del Runtime local (docs/spec/orquestador-enrutamiento.md §3.1, decisión de orq y Arq del 2026-11-05): el builder
// pide un chat igual que detrás del orquestador, pero el índice local es por mensaje y un chat nace con su primera corrida. La
// reserva solo aparta el id para un dueño hasta esa corrida; no escribe el índice.
// HACK: reservas solo en memoria; un reinicio las pierde y la primera corrida da 404 (el builder repite POST /chats). Persistirlas
// si el builder local necesita sobrevivir a un reinicio.

import { randomUUID } from 'node:crypto';

/** Mismos topes que el orquestador (routes.ts): 10 por minuto y 100 por dueño. */
export const RESERVATIONS_PER_MINUTE = 10;
export const MAX_RESERVATIONS = 100;

export interface Reservation { readonly chatId: string; readonly owner: string; readonly title: string; readonly createdAt: number }

export type ReserveResult = { ok: true; chatId: string } | { ok: false; code: 'rate-limited' | 'chat-limit' };

export interface ChatReservationsDeps {
  /** ¿Ya hay un mensaje con ese id? Un id que choca se descarta y se sortea otro. */
  readonly exists: (id: string) => boolean;
  readonly now?: () => number;
  readonly newId?: () => string;
}

export function createChatReservations(deps: ChatReservationsDeps) {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  let byId = new Map<string, Reservation>();
  let created = new Map<string, readonly number[]>();

  const ofOwner = (owner: string): Reservation[] => [...byId.values()].filter((r) => r.owner === owner);

  return {
    reserve(owner: string, title: string): ReserveResult {
      const t = now();
      const recent = (created.get(owner) ?? []).filter((x) => t - x < 60_000);
      if (recent.length >= RESERVATIONS_PER_MINUTE) return { ok: false, code: 'rate-limited' };
      if (ofOwner(owner).length >= MAX_RESERVATIONS) return { ok: false, code: 'chat-limit' };
      let chatId = newId();
      while (deps.exists(chatId) || byId.has(chatId)) chatId = newId();
      byId = new Map(byId).set(chatId, { chatId, owner, title: title.slice(0, 200), createdAt: t });
      created = new Map(created).set(owner, [...recent, t]);
      return { ok: true, chatId };
    },
    /** ¿Es una reserva de este dueño? Uno ajeno o no reservado da false sin distinguir cuál (el router responde 404 igual). */
    owns(owner: string, chatId: string): boolean {
      return byId.get(chatId)?.owner === owner;
    },
    /** Consume la reserva en el mismo tick en que se comprueba: de dos primeras corridas concurrentes solo una la obtiene. */
    consume(owner: string, chatId: string): Reservation | undefined {
      const r = byId.get(chatId);
      if (!r || r.owner !== owner) return undefined;
      const next = new Map(byId);
      next.delete(chatId);
      byId = next;
      return r;
    },
    /** Devuelve una reserva consumida cuya primera corrida no arrancó (400, 503): el id sigue usable. */
    restore(r: Reservation): void {
      if (!deps.exists(r.chatId)) byId = new Map(byId).set(r.chatId, r);
    },
    list(owner: string): readonly Reservation[] {
      return ofOwner(owner);
    },
  };
}

export type ChatReservations = ReturnType<typeof createChatReservations>;
