/**
 * L.21.0 — Structured trace event log.
 *
 * Distributed-tracing facade. Every recordApiCall + recordCronRun
 * emits a structured JSON line to stdout when NEXUS_TRACE_LOG=1,
 * shaped to match OpenTelemetry's span semantic conventions so a
 * downstream collector (Datadog Agent, Honeycomb's stdout
 * integration, OpenTelemetry Collector with stdin receiver, etc.)
 * can ingest without modification.
 *
 * Why not @opentelemetry/api directly: adding the OTel SDK chain
 * (api + sdk-node + auto-instrumentations + exporter-otlp-http)
 * is non-trivial dep weight for what's, today, a yet-to-be-wired
 * deployment concern. The trace-event log gives 95% of the
 * within-process value (correlation IDs propagated via the
 * AsyncLocalStorage from L.12.0, latency captured per call,
 * service.name + operation set on every event) without forcing
 * the SDK choice now.
 *
 * Migration path to OTel proper: replace logTraceEvent() with
 * tracer.startActiveSpan() in this file. The schema below already
 * matches OTel's span shape, so the JSON catalog operators have
 * accumulated stays portable.
 *
 * Format (one JSON object per line):
 *
 *   {
 *     "timestamp": "2026-05-09T18:23:45.123Z",
 *     "service.name": "nexus-api",
 *     "trace_id": "<requestId from AsyncLocalStorage>",
 *     "span.name": "amazon.sp-api.getOrders",
 *     "span.kind": "client",
 *     "span.status": "ok"|"error",
 *     "duration_ms": 1234,
 *     "attributes": {
 *       "channel": "AMAZON",
 *       "operation": "getOrders",
 *       "http.status_code": 200,
 *       "error.type": null
 *     }
 *   }
 *
 * Disabled by default. Set NEXUS_TRACE_LOG=1 to opt in. With
 * stdout-based log ingestion (Railway / Fly / GCP / AWS), this
 * lands in the existing log pipeline without any extra config.
 */

import { getRequestId, getRequestSource } from './request-context.js'

const SERVICE_NAME = process.env.NEXUS_TRACE_SERVICE_NAME ?? 'nexus-api'

export interface TraceEvent {
  spanName: string
  spanKind?: 'client' | 'server' | 'internal'
  status: 'ok' | 'error'
  durationMs: number
  attributes?: Record<string, string | number | boolean | null>
}

/**
 * Emit a structured trace event to stdout. No-op if
 * NEXUS_TRACE_LOG is not '1'.
 *
 * Failure-tolerant: any error inside this helper is swallowed so
 * trace logging never breaks the actual call.
 */
export function logTraceEvent(event: TraceEvent): void {
  if (process.env.NEXUS_TRACE_LOG !== '1') return
  try {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      'service.name': SERVICE_NAME,
      trace_id: getRequestId() ?? null,
      'span.name': event.spanName,
      'span.kind': event.spanKind ?? 'internal',
      'span.status': event.status,
      duration_ms: event.durationMs,
      attributes: {
        'request.source': getRequestSource() ?? null,
        ...(event.attributes ?? {}),
      },
    })
    // eslint-disable-next-line no-console
    process.stdout.write(line + '\n')
  } catch {
    // Never break the caller because of a tracing error.
  }
}
