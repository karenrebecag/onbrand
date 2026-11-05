// El DS de un chat: el pin de su versión HEAD contra el que publica el registry, y el skill de cada uno (C3, #852).
import type { Version } from './run-client'

const shortPin = (pin: string) => pin.slice(0, 8)

/** "a1b2c3d4 → e5f6a7b8" de una versión de "Actualizar DS"; sin pin previo (chat anterior al pin) solo el destino. */
export function dsChangeOf(v: Pick<Version, 'updatedDs'>): string | null {
  const ds = v.updatedDs
  if (!ds || typeof ds.to !== 'string' || !ds.to) return null
  return typeof ds.from === 'string' && ds.from ? `${shortPin(ds.from)} → ${shortPin(ds.to)}` : `→ ${shortPin(ds.to)}`
}

/** C3: el DS fijado en la versión HEAD y el que hoy publica el registry (GET /chats `ds`, #633). Sin registry no viene.
 * `skill`/`latestSkill` (#852): el DS del chat y el del perfil; si difieren, Actualizar DS no aplica (el POST responde 409). */
export interface ChatDs { pin?: string; latest?: string; skill?: string; latestSkill?: string }
export function threadDs(thread: { ds?: unknown }): ChatDs | null {
  const v = thread.ds
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  const pin = typeof r.pin === 'string' && r.pin ? r.pin : undefined
  const latest = typeof r.latest === 'string' && r.latest ? r.latest : undefined
  const str = (k: 'skill' | 'latestSkill') => (typeof r[k] === 'string' && r[k] ? { [k]: r[k] as string } : {})
  return pin || latest ? { ...(pin ? { pin } : {}), ...(latest ? { latest } : {}), ...str('skill'), ...str('latestSkill') } : null
}
/** Lo que se pinta: el pin corto y, solo si el registry publica otro del mismo DS, el corto del nuevo. Un chat sin pin
 * (anterior al pin) con latest también puede actualizarse. */
export function dsStatus(ds: ChatDs | null | undefined): { pin: string | null; update: string | null; blocked?: true } | null {
  if (!ds) return null
  // `blocked`: el chat es de otro DS que el del perfil (QA #858: un chat de Arc con el core en base); el POST daría 409, así
  // que el menú no ofrece Actualizar DS en absoluto, no solo el aviso de "disponible".
  const blocked = ds.skill !== undefined && ds.latestSkill !== undefined && ds.skill !== ds.latestSkill
  const update = ds.latest && ds.latest !== ds.pin && !blocked ? shortPin(ds.latest) : null
  return { pin: ds.pin ? shortPin(ds.pin) : null, update, ...(blocked ? { blocked: true as const } : {}) }
}
