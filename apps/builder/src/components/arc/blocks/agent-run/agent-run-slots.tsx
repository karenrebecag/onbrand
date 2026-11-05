"use client";

import { createContext, useContext, type ReactNode } from "react";
import { Eye, FileDiff, FilePen, FileText, ImageIcon, ListTodo, PencilLine, Search, Sparkle, SquareTerminal } from "lucide-react";
import type { RunStatus, StepMark, ToolApproval } from "./agent-run-types";
import { GithubMark, NpmMark, TypescriptMark } from "./agent-run-marks";
import styles from "./agent-run.module.css";

// Karen (decisión 16, ADR 0017): el bloque es de este proyecto y el builder lo adapta solo en lo visual. Datos, tipos,
// contrato de eventos y handlers quedan dentro; un slot cambia marcas, iconos y textos, como la tarjeta de aprobación de
// v0 compone sus partes alrededor de una lógica fija (deob/v0-layers/deobfuscated.js:36400-36478).

const LUCIDE = { think: Sparkle, read: FileText, search: Search, edit: FilePen, terminal: SquareTerminal, review: FileDiff } as const;

function DefaultStepIcon({ mark }: { mark: StepMark }) {
  if (mark === "npm") return <NpmMark className={styles.brandMark} data-brand="npm" aria-hidden="true" />;
  if (mark === "typescript") return <TypescriptMark className={styles.brandMark} data-brand="typescript" aria-hidden="true" />;
  if (mark === "github") return <GithubMark className={styles.brandMark} aria-hidden="true" />;
  const Icon = LUCIDE[mark];
  return <Icon size={16} strokeWidth={1.75} aria-hidden="true" />;
}

const KIND = {
  read: { icon: Eye, label: "Lectura" },
  write: { icon: PencilLine, label: "Escritura" },
  spend: { icon: ImageIcon, label: "Usa créditos" },
  plan: { icon: ListTodo, label: "Plan" },
} as const;

/** Un kind que este cliente no conoce se trata como escritura: ante la duda se pregunta, y la tarjeta no revienta. */
export const kindInfo = (kind: string) => KIND[kind as keyof typeof KIND] ?? KIND.write;

const defaultKind = (kind: ToolApproval["kind"]) => {
  const { icon: Icon, label } = kindInfo(kind);
  return { label, icon: <Icon size={14} strokeWidth={1.75} aria-hidden="true" /> };
};

const isEdit = (toolName: string) => toolName.endsWith("edit_image");
const TIMEOUT_TEXT = "Venció sin respuesta: se omitió";

export const DEFAULT_COPY = {
  status: { idle: "Listo para empezar", working: "Trabajando", waiting: "Esperándote", done: "Listo", stopped: "Detenido" } as Record<RunStatus, string>,
  restart: "Repetir la corrida",
  workedFor: (clock: string) => `Worked for ${clock}`,
  stepCount: (n: number, total: string) => `${n} ${n === 1 ? "paso" : "pasos"} · ${total}`,
  stepsLabel: "Pasos",
  ready: "El agente está listo para empezar.",
  startRun: "Start run",
  resultLabel: "Resultado",
  stoppedLabel: "Corrida detenida",
  turnOver: "El turno ya terminó.",
  prFailed: "No se pudo abrir el pull request. Inténtalo de nuevo.",
  announceWaiting: (files: number) => `Esperándote. Revisa los cambios en ${files} archivos y apruébalos o recházalos.`,
  announceDone: (total: string, tests?: { passed: number; total: number }) => `Listo en ${total}.${tests ? ` ${tests.passed} de ${tests.total} tests pasaron.` : ""}`,
  announceStopped: (total: string) => `Detenido en ${total}.`,
  review: "Revisar",
  returned: "Devuelto",
  progressOf: "of",
  filesChanged: (n: number) => (n === 1 ? "archivo cambiado" : "archivos cambiados"),
  filesLabel: "Archivos cambiados",
  checksLabel: "Verificaciones",
  testsPassed: (passed: number, total: number) => `${passed} de ${total} tests pasaron`,
  prOpen: "Open pull request",
  prOpening: "Opening",
  prOpened: (n?: number) => `PR #${n ?? ""} opened`,
  stoppedSummary: "El cambio se devolvió dos veces y el agente se detuvo. No se escribió ningún archivo.",
  repeat: "Repetir",
  wantsToUse: "quiere usar",
  loadingApproval: "Cargando la aprobación…",
  alreadyDecided: "Ya decidida: esta aprobación se respondió antes.",
  spendTitle: (toolName: string) => (isEdit(toolName) ? "¿Editar la imagen?" : "¿Generar una imagen?"),
  spendNote: (toolName: string) => `${isEdit(toolName) ? "Solo esta edición." : "Solo esta imagen."} La próxima vez se vuelve a preguntar. Usa créditos de imagen.`,
  writeNote: (app: string) => `Nada cambia en ${app} hasta que lo permitas.`,
  waitingNote: "El agente espera tu respuesta.",
  viewRequest: "Ver pedido",
  args: "Argumentos",
  noArgs: "sin argumentos",
  alwaysFailed: "No se pudo guardar el permiso. Reintenta o permite solo esta vez.",
  sendingSkip: "Avisando que se omite",
  sendingAllow: "Enviando tu permiso",
  skip: "Omitir",
  allowAlways: "Permitir siempre",
  allowOnce: "Permitir esta vez",
  allow: "Permitir",
  askAgainDone: "La próxima vez se vuelve a preguntar.",
  allowedAlways: "Permitido siempre",
  askEachTime: "Preguntar cada vez",
  allowed: "Permitido",
  skipped: "Omitido",
  timedOut: TIMEOUT_TEXT,
  plan: "Plan",
  planToApprove: "Plan para aprobar",
  planReady: "Plan listo para revisar",
  planNoChanges: "Sin cambios todavía",
  planEdited: "Con tus cambios guardados.",
  showPlan: "Ver plan",
  hidePlan: "Ocultar plan",
  loadingPlan: "Cargando el plan…",
  noPlanText: "Sin texto del plan",
  rejectLabel: "Qué cambiarías (opcional)",
  rejectPlaceholder: "Ej.: sin sección de precios, hero más corto",
  rejecting: "Rechazando el plan…",
  sendingApproval: "Enviando tu aprobación…",
  closingPlan: "El agente está cerrando el plan…",
  editNote: "Al guardar, se construye con tus cambios.",
  rejectNote: "El agente no construye nada. Tu nota va al próximo plan.",
  reject: "Rechazar",
  edit: "Editar",
  approve: "Aprobar",
  cancel: "Cancelar",
  saveApprove: "Guardar y aprobar",
  rejectPlan: "Rechazar plan",
  approvedEdited: "Aprobado con tus cambios",
  approved: "Aprobado",
  cancelledByMessage: "Cancelado por mensaje nuevo",
  stoppedWithoutBuild: "Detenido sin construir",
  rejected: "Rechazado",
};

export type AgentRunCopy = typeof DEFAULT_COPY;

/** Lo visual que el host cambia; sin slot, el default del proyecto. */
export interface AgentRunSlots {
  /** El icono de un paso por su marca. */
  mark?: (mark: StepMark) => ReactNode;
  /** La etiqueta e icono del tipo de una aprobación. */
  kind?: (kind: ToolApproval["kind"]) => { label: string; icon: ReactNode };
  /** La marca del modelo en la cabecera; manda sobre `model.mark`. */
  model?: ReactNode;
  copy?: Partial<AgentRunCopy>;
}

export interface ResolvedSlots {
  mark: (mark: StepMark) => ReactNode;
  kind: (kind: ToolApproval["kind"]) => { label: string; icon: ReactNode };
  model?: ReactNode;
  copy: AgentRunCopy;
}

export const defaultSlots: ResolvedSlots = { mark: (mark) => <DefaultStepIcon mark={mark} />, kind: defaultKind, copy: DEFAULT_COPY };

export const resolveSlots = (slots?: AgentRunSlots): ResolvedSlots => (slots ? {
  mark: slots.mark ?? defaultSlots.mark,
  kind: slots.kind ?? defaultSlots.kind,
  model: slots.model,
  copy: slots.copy ? { ...DEFAULT_COPY, ...slots.copy } : DEFAULT_COPY,
} : defaultSlots);

export const RunSlotsContext = createContext<ResolvedSlots>(defaultSlots);
export const useRunSlots = (): ResolvedSlots => useContext(RunSlotsContext);
