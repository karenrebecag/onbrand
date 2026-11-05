// Trazas del turno con OpenTelemetry. serve lo carga solo con WT_SPOTLIGHT=1. Cada mensaje es un span raíz (op wt.message)
// y cada step.start/step.end un span hijo, con los tiempos del log, para ver la cascada del T1.
//
// OTel es la instrumentación (no @sentry/bun). Dos destinos, los dos opcionales:
//  - Spotlight local: el sidecar (WT_SPOTLIGHT_URL o 127.0.0.1:8969) solo ingiere envelopes de Sentry, no OTLP (verificado
//    en @spotlightjs/spotlight 4.12: dist/server solo acepta application/x-sentry-envelope). SpotlightExporter arma la
//    transacción Sentry desde los spans OTel de cada traza y la postea. Nada sale de la máquina.
//  - Remoto (deploy): con WT_OTLP_URL, un OTLPTraceExporter manda OTLP/HTTP a un colector. Esto cierra el hueco de
//    observabilidad remota que F3 marcó (obs.trazas): OTLP apunta a cualquier backend (Tempo, Jaeger, Honeycomb).
import { context, trace, type Span, type Tracer, SpanStatusCode } from '@opentelemetry/api';
import { BasicTracerProvider, BatchSpanProcessor, SimpleSpanProcessor, type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace-node';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import type { EngineEvent } from './events';

// Resultado del export sin depender de @opentelemetry/core (transitiva no declarada): SUCCESS es 0.
type ExportResult = { code: number; error?: Error };
const SERVICE = 'onbrand-transport';
const hex = (bytes: number): string => Array.from({ length: bytes }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
const hrToS = (t: [number, number]): number => t[0] + t[1] / 1e9;

/** Convierte los spans OTel de una traza en una transacción Sentry y la postea al sidecar de Spotlight. Agrupa por
 * traceId y vacía la traza cuando cierra su span raíz (el que no tiene padre), que es el último en terminar. */
class SpotlightExporter implements SpanExporter {
  private byTrace = new Map<string, ReadableSpan[]>();
  constructor(private readonly sidecar: string) {}

  export(spans: ReadableSpan[], done: (r: ExportResult) => void): void {
    for (const span of spans) {
      const traceId = span.spanContext().traceId;
      const bucket = this.byTrace.get(traceId) ?? [];
      bucket.push(span);
      this.byTrace.set(traceId, bucket);
      if (!span.parentSpanId) {
        this.byTrace.delete(traceId);
        void this.send(traceId, span, bucket);
      }
    }
    done({ code: 0 });
  }

  private async send(traceId: string, root: ReadableSpan, all: ReadableSpan[]): Promise<void> {
    const sentryStatus = (s: ReadableSpan): string => (s.status.code === SpanStatusCode.ERROR ? 'internal_error' : 'ok');
    const toSpan = (s: ReadableSpan) => ({
      span_id: s.spanContext().spanId,
      parent_span_id: s.parentSpanId,
      trace_id: traceId,
      op: s.attributes['wt.op'] ?? s.name,
      description: s.name,
      start_timestamp: hrToS(s.startTime),
      timestamp: hrToS(s.endTime),
      status: sentryStatus(s),
      data: s.attributes,
    });
    const txn = {
      type: 'transaction',
      event_id: hex(16),
      transaction: root.name,
      start_timestamp: hrToS(root.startTime),
      timestamp: hrToS(root.endTime),
      platform: 'javascript',
      contexts: { trace: { trace_id: traceId, span_id: root.spanContext().spanId, op: root.attributes['wt.op'] ?? root.name, status: sentryStatus(root) } },
      spans: all.filter((s) => s !== root).map(toSpan),
    };
    const envelope = `${JSON.stringify({ sent_at: new Date().toISOString() })}\n${JSON.stringify({ type: 'transaction' })}\n${JSON.stringify(txn)}\n`;
    try {
      await fetch(new URL('/api/0/envelope/', this.sidecar), { method: 'POST', body: envelope, headers: { 'Content-Type': 'application/x-sentry-envelope' } });
    } catch {
      // El sidecar puede no estar arriba: la traza ya quedó en el log ndjson, no se tumba el turno.
    }
  }

  shutdown(): Promise<void> { this.byTrace.clear(); return Promise.resolve(); }
  forceFlush(): Promise<void> { return Promise.resolve(); }
}

// Dueño de tracer y provider: startTelemetry/stopTelemetry, llamados una vez por scripts/serve.ts. Son del proceso porque el
// provider OTel global también lo es; un segundo startTelemetry reemplazaría al primero (D6 decide si hay dos Runtime).
let tracer: Tracer | undefined;
let provider: BasicTracerProvider | undefined;

/** Vacía el buffer del BatchSpanProcessor antes del exit: en un SIGTERM, las trazas de las corridas cortadas (las que más
 * importan en deploy) esperan en buffer y process.exit se las lleva (Arq, 2026-11-03). Lo llama el shutdown de serve. */
export async function stopTelemetry(): Promise<void> {
  try { await provider?.shutdown(); } catch { /* el exit no debe colgarse por el flush */ }
}

export function startTelemetry(): void {
  const processors = [];
  // Spotlight solo con WT_SPOTLIGHT=1 (y su sidecar local). Sin el flag no se postea a 127.0.0.1 aunque haya OTLP remoto.
  if (process.env.WT_SPOTLIGHT === '1') {
    // 127.0.0.1 y no localhost: Bun resuelve localhost a ::1 y el sidecar escucha en IPv4.
    const sidecar = process.env.WT_SPOTLIGHT_URL || 'http://127.0.0.1:8969';
    processors.push(new SimpleSpanProcessor(new SpotlightExporter(sidecar)));
  }
  // Hueco de F3 (obs.trazas remoto): con un colector OTLP, las trazas salen de la máquina. BatchSpanProcessor agrupa en
  // vez de un POST por span. Apagado por defecto (sin WT_OTLP_URL).
  if (process.env.WT_OTLP_URL) processors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url: process.env.WT_OTLP_URL })));
  if (!processors.length) return;
  provider = new BasicTracerProvider({ resource: new Resource({ [ATTR_SERVICE_NAME]: SERVICE }), spanProcessors: processors });
  trace.setGlobalTracerProvider(provider);
  tracer = trace.getTracer(SERVICE);
}

// Dueño de roots, steps y closed: traceEvent (el sink de events.ts), del proceso. Se llavean por messageId; roots y steps se
// sueltan al cerrar el mensaje y closed tiene tope. Si dos Runtime repitieran messageId se mezclarían (D6).
const roots = new Map<string, { span: Span; start: number }>();
const steps = new Map<string, Span>();
// Mensajes ya cerrados: un evento tardío del mismo id (p. ej. un delta tras settled) no abre un root nuevo que nunca cierra.
const closed = new Set<string>();
const key = (messageId: string, stepId: string) => `${messageId}\u0000${stepId}`;

function rootOf(e: EngineEvent): Span {
  const found = roots.get(e.messageId);
  if (found) return found.span;
  const span = tracer!.startSpan(`message ${e.messageId}`, { startTime: e.at, attributes: { 'wt.op': 'wt.message' } });
  roots.set(e.messageId, { span, start: e.at });
  return span;
}

function closeMessage(e: EngineEvent): void {
  for (const [k, span] of steps) {
    if (!k.startsWith(`${e.messageId}\u0000`)) continue;
    span.end(e.at);
    steps.delete(k);
  }
  roots.get(e.messageId)?.span.end(e.at);
  roots.delete(e.messageId);
  closed.add(e.messageId);
  // Tope para no crecer sin fin en un proceso largo: suelta el más viejo (el Set conserva orden de inserción).
  if (closed.size > 4096) closed.delete(closed.values().next().value as string);
}

export function traceEvent(e: EngineEvent): void {
  if (!tracer || closed.has(e.messageId)) return;
  const root = rootOf(e);
  const ev = e as EngineEvent & { stepId?: string; parentStepId?: string; label?: string; status?: string; kind?: string };
  if (ev.type === 'step.start' && ev.stepId) {
    const parent = (ev.parentStepId && steps.get(key(e.messageId, ev.parentStepId))) || root;
    const ctx = trace.setSpan(context.active(), parent);
    const span = tracer.startSpan(ev.label || ev.stepId, { startTime: e.at, attributes: { 'wt.op': `wt.${ev.kind ?? 'step'}` } }, ctx);
    steps.set(key(e.messageId, ev.stepId), span);
  } else if (ev.type === 'step.end' && ev.stepId) {
    const span = steps.get(key(e.messageId, ev.stepId));
    if (!span) return;
    if (ev.status === 'error') span.setStatus({ code: SpanStatusCode.ERROR, message: ev.label ?? 'error' });
    if (ev.label) span.setAttribute('wt.result', ev.label);
    span.end(e.at);
    steps.delete(key(e.messageId, ev.stepId));
  } else if (ev.type === 'message.end') {
    const r = roots.get(e.messageId);
    if (r) root.setAttribute('wt.version_at_s', (e.at - r.start) / 1000);
  } else if (ev.type === 'settled') {
    closeMessage(e);
  }
}
