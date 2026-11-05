"use client";

import { createContext, useContext, type ReactNode } from "react";
import { effortLabel, type Effort, type ModelMarkId } from "./composer-data";

// Karen (decisión 16, ADR 0017): el composer es de este proyecto. El builder cambia lo visual (marca del modelo, textos) y
// pone contenido propio en tres zonas que el bloque ubica (menú +, chips junto a las herramientas, fila de contexto). Escribir,
// enviar, adjuntar y el estado del envío quedan dentro: una zona recibe contenido, nunca el estado del bloque (Arq, PR 2).

export const DEFAULT_COMPOSER_COPY = {
  messageLabel: "Mensaje",
  enterHint: "Enter envía, Mayúsculas Enter agrega una línea.",
  attachmentsLabel: "Adjuntos",
  attachTip: "Agregar archivos y contexto",
  uploadOption: "Subir archivo",
  driveOption: "Desde Google Drive",
  githubOption: "Desde GitHub",
  searchLabel: "Búsqueda web",
  searchOn: "Búsqueda web activa",
  searchOff: "Buscar en la web al responder",
  thinkingLabel: "Razonamiento extendido",
  thinkingOn: "Razonamiento extendido activo",
  thinkingOff: "Pensar más antes de responder",
  modelAria: (name: string, effort: string) => `Modelo: ${name}, esfuerzo ${effort.toLowerCase()}`,
  effortHead: "Esfuerzo",
  effort: effortLabel,
  effortHint: {
    low: "Respuestas más rápidas",
    medium: "Equilibrado",
    high: "Más cuidadoso",
    xhigh: "Razonamiento más profundo",
    max: "El más completo y el más lento",
  } as Record<Effort, string>,
  send: "Enviar mensaje",
  stop: "Detener",
  sendAfterUploads: "Enviar al terminar las subidas",
  sendOverLimit: "Enviar: el mensaje pasa del límite",
  enhanceTip: "Mejorar el prompt",
  stopEnhanceTip: "Detener la mejora",
  stopEnhanceLabel: "Detener la mejora del prompt",
  enhancing: "Mejorando el prompt",
  enhanced: "Prompt mejorado",
  enhanceFailed: "No se pudo mejorar el prompt",
  dictate: "Dictar",
  insertTranscript: "Insertar la transcripción",
  stopDictation: "Detener el dictado e insertar",
  cancelDictation: "Cancelar el dictado",
  transcribing: "Transcribiendo",
  listening: "Escuchando",
  listeningSimulated: "Escuchando. El dictado es simulado en esta vista previa",
  dictationCancelled: "Dictado cancelado",
  micDenied: "Se negó el acceso al micrófono",
  micFailed: "No se pudo iniciar el micrófono",
  heardNothing: "No se oyó nada",
  transcribeFailed: "No se pudo transcribir la grabación",
  inserted: (sentence: string) => `Insertado: ${sentence}`,
  tooBig: (names: string, limit: string) => `${names} supera el límite de ${limit}`,
  uploadingOne: (name: string) => `Subiendo ${name}`,
  uploadingMany: (n: number) => `Subiendo ${n} archivos`,
  uploadFailed: "La subida falló",
  uploadError: (name: string, reason: string) => `${name}: ${reason}`,
  uploadPercent: (percent: number) => `Subiendo ${percent}%`,
  overSize: (limit: string) => `Pasa de ${limit}`,
  pastedImage: "Imagen pegada",
  imageMeta: "Imagen",
  fileMeta: "Archivo",
  pastedText: "Texto pegado",
  pastedLines: (lines: number) => `${lines} ${lines === 1 ? "línea" : "líneas"}`,
  pastedAnnounce: (lines: number) => `Texto largo agregado como adjunto, ${lines} líneas`,
  cancelUpload: (name: string) => `Cancelar la subida de ${name}`,
  remove: (name: string) => `Quitar ${name}`,
  uploadCancelled: (name: string) => `Subida de ${name} cancelada`,
  removed: (name: string) => `${name} quitado`,
  commandAdded: (token: string) => `Comando ${token} agregado`,
  contextAdded: (label: string) => `${label} agregado como contexto`,
  charsLeft: (n: string) => `Quedan ${n} caracteres`,
  charsOver: (max: string) => `Supera el límite de ${max} caracteres. Acorta el mensaje para enviarlo`,
  limitOverDetail: (n: string) => `${n} caracteres de más`,
  limitLeftDetail: (left: string, max: string) => `Quedan ${left} de ${max} caracteres`,
  limitOverShort: (n: string) => `${n} de más`,
  limitLeftShort: (n: string) => `${n} restantes`,
  commandsLabel: "Comandos",
  filesDocsLabel: "Archivos y documentos",
  noMatch: (query: string) => `Ningún archivo o documento coincide con “${query}”`,
};

export type ComposerCopy = typeof DEFAULT_COMPOSER_COPY;

/** Lo que el host cambia o agrega; sin slot, el default del proyecto. Las zonas reciben contenido, no estado del bloque. */
export interface ComposerSlots {
  /** Ítems propios en el menú +, bajo su separador. */
  menu?: ReactNode;
  /** Chips junto a los toggles de herramientas. */
  chips?: ReactNode;
  /** Fila sobre el mensaje con lo que el próximo envío toma como contexto (una pantalla, una selección). */
  context?: ReactNode;
  /** La marca de un modelo en el chip y en el menú. */
  mark?: (mark: ModelMarkId) => ReactNode;
  copy?: Partial<ComposerCopy>;
}

export interface ResolvedComposerSlots {
  menu?: ReactNode;
  chips?: ReactNode;
  context?: ReactNode;
  mark?: (mark: ModelMarkId) => ReactNode;
  copy: ComposerCopy;
}

export const resolveComposerSlots = (slots?: ComposerSlots): ResolvedComposerSlots =>
  ({ ...slots, copy: slots?.copy ? { ...DEFAULT_COMPOSER_COPY, ...slots.copy } : DEFAULT_COMPOSER_COPY });

export const ComposerSlotsContext = createContext<ResolvedComposerSlots>({ copy: DEFAULT_COMPOSER_COPY });
export const useComposerSlots = (): ResolvedComposerSlots => useContext(ComposerSlotsContext);
