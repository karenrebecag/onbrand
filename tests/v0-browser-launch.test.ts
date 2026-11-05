import { describe, expect, test } from 'bun:test';
import type { Browser } from 'playwright';
import { browse, launchBrowser } from '../src/runtime/browser';

const fake = {} as Browser;

describe('browser: launch', () => {
  // QA, chat 97fd95dc: un launch colgado se llevó 180 s del turno y el siguiente arrancó bien.
  test('un launch que falla se reintenta una vez con timeout corto', async () => {
    const seen: number[] = [];
    let calls = 0;
    const b = await launchBrowser(async (o) => { seen.push(o.timeout); if (++calls === 1) throw new Error('launch: Timeout 30000ms exceeded'); return fake; });
    expect(b).toBe(fake);
    expect(seen).toEqual([30_000, 30_000]);
  });

  test('dos fallos dan un error con ambas causas', async () => {
    await expect(launchBrowser(async () => { throw new Error('launch: Timeout 30000ms exceeded\nstack'); })).rejects.toThrow(/2 intentos: launch: Timeout 30000ms exceeded \| launch: Timeout 30000ms exceeded$/);
  });
});

describe('browser: tope por llamada', () => {
  // gen3: una llamada a browser se quedó más de 810 s solo con heartbeats. Los Browser falsos no tienen process(), como
  // el real de chromium.launch(): el falso que lo tenía tapó el TypeError que tumbó el transport (bench a77b6e3).
  test('una carga colgada vence el tope, cierra chromium y dice en qué paso quedó', async () => {
    const closed: unknown[] = [];
    const hung = {
      newPage: async () => ({ on: () => {}, goto: () => new Promise(() => {}) }),
      close: async (o?: unknown) => { closed.push(o); },
    } as unknown as Browser;
    await expect(browse({ url: 'http://127.0.0.1:1/', viewport: 375, full: true, actions: [] }, { launch: async () => hung, deadlineMs: 50 })).rejects.toThrow(/sin resultado en 0 s \(paso: goto\)/);
    expect(closed[0]).toEqual({ reason: 'browser: tope vencido' });
  });

  test('un close que lanza o rechaza al vencer el tope no tumba el proceso: la tool devuelve su error', async () => {
    for (const close of [() => { throw new Error('sync'); }, async () => { throw new Error('async'); }]) {
      const hung = { newPage: async () => ({ on: () => {}, goto: () => new Promise(() => {}) }), close } as unknown as Browser;
      await expect(browse({ url: 'http://127.0.0.1:1/', viewport: 375, full: true, actions: [] }, { launch: async () => hung, deadlineMs: 20 })).rejects.toThrow(/sin resultado/);
    }
    await new Promise((r) => setTimeout(r, 30));
  });

  test('un launch que llega después del tope no deja chromium huérfano', async () => {
    let closed = false;
    const late = { close: async () => { closed = true; } } as unknown as Browser;
    await expect(browse({ url: 'http://127.0.0.1:1/', viewport: 375, full: true, actions: [] }, { launch: () => new Promise((r) => setTimeout(() => r(late), 80)), deadlineMs: 20 })).rejects.toThrow(/paso: launch/);
    await new Promise((r) => setTimeout(r, 120));
    expect(closed).toBe(true);
  });
});
