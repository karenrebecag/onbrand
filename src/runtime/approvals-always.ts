// Dueño del "siempre" de las tools de gasto (ADR 0014 reglas 2-3: un dueño por estado persistente; Approvals lo lee y lo
// escribe solo por aquí). La llave es (dueño, tool): el "siempre" de una persona no aprueba a otra.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { LOCAL_OWNER } from './session';

export class AlwaysStore {
  private byOwner = new Map<string, Set<string>>();

  /** `isSpend`: solo tools de gasto; un archivo editado a mano no puede autoaprobar otra cosa. `path`: con archivo
   * sobrevive al reinicio, como el de Lovable (app-lazy-surfaces-DDSyLDbh :1835-1871). */
  constructor(private isSpend: (tool: string) => boolean, private path?: string) {
    let saved: { tools?: unknown; owners?: unknown } | null | undefined;
    try {
      saved = path && existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as typeof saved) : undefined;
    } catch (e) {
      // Un archivo ilegible no puede tumbar el arranque del transport; falla cerrado: sin "siempre", se vuelve a preguntar.
      console.error(`[approvals] ${path} ilegible, se pregunta de nuevo: ${e instanceof Error ? e.message : String(e)}`);
    }
    // `tools` es el formato de antes de existir dueños: pertenece al implícito, así un archivo viejo sigue valiendo.
    this.load(LOCAL_OWNER, saved?.tools);
    const owners = saved?.owners;
    if (owners && typeof owners === 'object' && !Array.isArray(owners)) for (const [owner, tools] of Object.entries(owners)) this.load(owner, tools);
  }

  private load(owner: string, tools: unknown): void {
    const spend = Array.isArray(tools) ? tools.filter((t): t is string => typeof t === 'string' && this.isSpend(t)) : [];
    if (spend.length) this.byOwner.set(owner, new Set(spend));
  }

  has(owner: string, tool: string): boolean {
    return this.byOwner.get(owner)?.has(tool) ?? false;
  }

  add(owner: string, tool: string): void {
    this.byOwner.set(owner, (this.byOwner.get(owner) ?? new Set<string>()).add(tool));
  }

  /** true si había algo que quitar. */
  delete(owner: string, tool: string): boolean {
    return this.byOwner.get(owner)?.delete(tool) ?? false;
  }

  tools(owner: string): string[] {
    return [...(this.byOwner.get(owner) ?? [])].sort();
  }

  persist(): void {
    if (!this.path) return;
    const owners: Record<string, string[]> = {};
    for (const owner of this.byOwner.keys()) if (owner !== LOCAL_OWNER && this.tools(owner).length) owners[owner] = this.tools(owner);
    // temp + rename: un corte a mitad no deja un JSON truncado que al arrancar perdería todos los "siempre".
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ tools: this.tools(LOCAL_OWNER), ...(Object.keys(owners).length ? { owners } : {}) }));
    renameSync(tmp, this.path);
  }
}
