import { expect, test } from 'bun:test'
import type { MessageState, Suggestion } from '../src/runtime/event-model'
import { followUpsOf, lateSuggestionsOf, notesOf, questionOf } from '../apps/builder/src/lib/run-state'

const step = (followUps: Suggestion[]) => ({ id: 'transport:section-op', kind: 'action' as const, label: 'Removed section', status: 'ok' as const, output: '', startedAt: 0, detail: { kind: 'action' as const, name: 'section-op', summary: 'x', followUps } })

const pending: Suggestion = { title: 'Quita el enlace a #faq', message: 'Quita el enlace a #faq' }

// El pendiente de una edición directa va como primer chip; si la edición falló no quedó nada guardado que arreglar.
test('los pedidos pendientes salen solo de una edición directa que guardó versión', () => {
  const done: MessageState = { messageId: 'e1', status: 'patch', steps: [step([pending])], text: '' }
  expect(followUpsOf(done)).toEqual([pending])
  expect(followUpsOf({ ...done, status: 'error' })).toEqual([])
  expect(followUpsOf({ ...done, status: 'streaming' })).toEqual([])
  expect(followUpsOf(undefined)).toEqual([])
})

// Ola 1: las sugerencias llegan en el step.end tardío; sin él (haiku falló o log viejo) el builder cae a page.json.
test('las sugerencias tardías mandan y faltan si el paso falló', () => {
  const s = (title: string) => ({ title, message: `${title}.` })
  const late = (status: 'ok' | 'error', followUps?: { title: string; message: string }[]) => ({ id: 'agent:suggestions', kind: 'action' as const, label: 'Siguientes pasos', status, output: '', startedAt: 0, detail: { kind: 'action' as const, name: 'suggestions', summary: 'x', ...(followUps ? { followUps } : {}) } })
  const msg = (steps: MessageState['steps']): MessageState => ({ messageId: 'm1', status: 'stop', steps, text: '' })
  expect(lateSuggestionsOf(msg([late('ok', [s('A'), s('B'), s('C'), s('D')])]))).toEqual([s('A'), s('B'), s('C')])
  expect(lateSuggestionsOf(msg([late('error')]))).toBeNull()
  expect(lateSuggestionsOf(msg([late('ok', [])]))).toBeNull()
  expect(lateSuggestionsOf(msg([]))).toBeNull()
})

// D1: los hechos de la caché porque la fuente no respondió se avisan en el turno, no solo dentro de "Ver pasos".
test('los avisos de un paso del motor salen para el cuerpo del turno; los de una herramienta del agente no', () => {
  const facts = { id: 'transport:facts', kind: 'action' as const, label: 'Leyó datos de la marca', status: 'ok' as const, output: '', startedAt: 0, detail: { kind: 'action' as const, name: 'facts', summary: 'acme@v1', notes: ['La fuente no respondió'] } }
  const child = { ...facts, id: 'agent:t1', parentStepId: 'agent', detail: { ...facts.detail, notes: ['de una tool'] } }
  expect(notesOf({ messageId: 'm1', status: 'stop', steps: [facts, child], text: '' })).toEqual(['La fuente no respondió'])
})

// 78e0030b tras #406: con la pregunta abierta, el builder ofrecía los chips del turno anterior (Franja de logos…).
test('la pregunta del turno da sus opciones como chips; sin pregunta no hay nada que reemplazar', () => {
  const options = [{ title: 'Venta por conversación', message: 'Cambia el titular del hero a: Convierte cada conversación en una venta' }]
  const asked = { id: 'q1', parentStepId: 'agent:write', kind: 'action' as const, label: 'Preguntando', status: 'ok' as const, output: '', startedAt: 0, detail: { kind: 'action' as const, name: 'question', summary: '¿Qué titular?', followUps: options } }
  expect(questionOf({ messageId: 'm2', status: 'stop', steps: [asked], text: '' })).toEqual(options)
  expect(questionOf({ messageId: 'm2', status: 'stop', steps: [], text: '' })).toBeNull()
})
