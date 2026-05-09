/**
 * L.26.0 — OpenTelemetry SDK initialization.
 *
 * Opt-in tracing pipeline. When NEXUS_OTEL_ENABLED=1 and
 * OTEL_EXPORTER_OTLP_ENDPOINT is set, this module wires:
 *
 *   - A NodeSDK instance with a Resource describing the service
 *   - OTLP/HTTP exporter pointing at the configured endpoint
 *     (Honeycomb, Datadog Agent, OTel Collector, etc.)
 *   - Manual span helpers used by recordApiCall + recordCronRun
 *
 * Standard OTel env vars are honoured:
 *   OTEL_EXPORTER_OTLP_ENDPOINT       e.g. https://api.honeycomb.io
 *   OTEL_EXPORTER_OTLP_HEADERS        e.g. x-honeycomb-team=KEY
 *   OTEL_SERVICE_NAME                 defaults to NEXUS_TRACE_SERVICE_NAME
 *                                     or "nexus-api"
 *
 * No-op when NEXUS_OTEL_ENABLED is not '1' — the helpers below
 * return immediately without creating spans, so production where
 * the env isn't set has zero overhead.
 *
 * Coexists with L.21.0's stdout trace log: both can run
 * simultaneously (NEXUS_TRACE_LOG=1 + NEXUS_OTEL_ENABLED=1) for
 * dual-pipeline ingestion during a migration.
 */

import { trace, type Span, type Tracer, SpanStatusCode } from '@opentelemetry/api'

let initialized = false
let tracer: Tracer | null = null

/**
 * Initialise the SDK. Idempotent — safe to call multiple times.
 *
 * Returns true if the SDK was started, false if disabled or the
 * env is incomplete.
 */
export async function initOtel(): Promise<boolean> {
  if (initialized) return true
  if (process.env.NEXUS_OTEL_ENABLED !== '1') return false

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  if (!endpoint) {
    // eslint-disable-next-line no-console
    console.warn(
      '[otel] NEXUS_OTEL_ENABLED=1 but OTEL_EXPORTER_OTLP_ENDPOINT is not set — skipping init',
    )
    return false
  }

  try {
    // Dynamic imports keep the SDK out of the boot path when
    // disabled — avoids ~5 MB of unnecessary module graph load.
    const { NodeSDK } = await import('@opentelemetry/sdk-node')
    const { OTLPTraceExporter } = await import(
      '@opentelemetry/exporter-trace-otlp-http'
    )
    const { resourceFromAttributes } = await import('@opentelemetry/resources')
    const semconv = await import('@opentelemetry/semantic-conventions')

    const serviceName =
      process.env.OTEL_SERVICE_NAME ??
      process.env.NEXUS_TRACE_SERVICE_NAME ??
      'nexus-api'

    const sdk = new NodeSDK({
      traceExporter: new OTLPTraceExporter({
        url: `${endpoint.replace(/\/$/, '')}/v1/traces`,
      }),
      resource: resourceFromAttributes({
        [semconv.ATTR_SERVICE_NAME]: serviceName,
      }),
    })

    sdk.start()
    initialized = true
    tracer = trace.getTracer(serviceName)
    // eslint-disable-next-line no-console
    console.log('[otel] SDK initialised', { serviceName, endpoint })
    return true
  } catch (err) {
    // Initialisation failure must not crash the API.
    // eslint-disable-next-line no-console
    console.error('[otel] init failed', err)
    return false
  }
}

/**
 * Run `fn` inside an OTel span. No-op (just runs `fn`) when the SDK
 * is disabled.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean | null | undefined>,
  fn: (span: Span | null) => Promise<T>,
): Promise<T> {
  if (!tracer) {
    return fn(null)
  }
  return tracer.startActiveSpan(name, async (span) => {
    try {
      // Filter null/undefined and assign typed attributes.
      for (const [k, v] of Object.entries(attributes)) {
        if (v !== null && v !== undefined) {
          span.setAttribute(k, v as string | number | boolean)
        }
      }
      const result = await fn(span)
      span.setStatus({ code: SpanStatusCode.OK })
      return result
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      })
      span.recordException(err as Error)
      throw err
    } finally {
      span.end()
    }
  })
}
