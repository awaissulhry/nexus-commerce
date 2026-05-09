/**
 * L.12.0 — Request context (distributed tracing).
 *
 * Holds a per-async-flow correlation ID (`requestId`) so deep service
 * calls (e.g. recordApiCall inside an Amazon SP-API client) can
 * stamp the same identifier on every log row they produce, giving
 * an operator the ability to ask "show me every API call this one
 * order ingestion made" — Datadog-tier within-process tracing.
 *
 * Two entry points populate the context:
 *
 *   - HTTP requests: a Fastify onRequest hook in apps/api/src/index.ts
 *     wraps the request handler in runWithRequestId(request.id, ...).
 *     Fastify generates request.id automatically (or honours an
 *     incoming x-request-id header).
 *
 *   - Cron ticks: recordCronRun() in cron-observability.ts opens a
 *     fresh context with a generated tickId so per-tick API calls
 *     share a correlation ID.
 *
 * Anything outside an HTTP request or cron tick (manual scripts,
 * one-off migrations, tests) sees `getRequestId()` return undefined,
 * which is fine — recordApiCall stores null in those cases.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

interface RequestContext {
  requestId: string
  source: 'http' | 'cron' | 'manual'
}

const storage = new AsyncLocalStorage<RequestContext>()

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId
}

export function getRequestSource(): 'http' | 'cron' | 'manual' | undefined {
  return storage.getStore()?.source
}

/**
 * Run `fn` with the given context bound. All async paths reachable
 * from `fn` see the same context via `getRequestId()`.
 */
export function runWithRequestId<T>(
  requestId: string,
  source: 'http' | 'cron' | 'manual',
  fn: () => T,
): T {
  return storage.run({ requestId, source }, fn)
}

/**
 * Generate a fresh tick ID for a cron run. Format mirrors what
 * Fastify produces for HTTP requests so logs are uniformly shaped.
 */
export function newTickId(): string {
  return `cron-${randomUUID()}`
}
