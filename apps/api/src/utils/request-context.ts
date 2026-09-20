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
 *
 * ── P3.6: `requestId` is a RUN id, and `traceId` is a CHANGE id ──────────────
 *
 * They are two different facts and they need two names.
 *
 * `requestId` correlates everything one PROCESS RUN did. For a cron that is one
 * tick, and a tick can be enormous: measured 2026-09-20, one `requestId` covers
 * **1,243 calls**. That is the right answer to "what did this run do" and the
 * wrong answer to "what happened to my change".
 *
 * `traceId` follows ONE change from the operator's click to the channel's answer.
 * It is minted on the HTTP request that made the change, stored on the
 * `OutboundSyncQueue` row (which is where the old trace died — the row carried no
 * id, so the worker's tick id took over), and re-bound by the worker so the
 * gateway call is stamped with it.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

interface RequestContext {
  requestId: string
  source: 'http' | 'cron' | 'manual'
  /** P3.6 — the CHANGE this flow belongs to, where there is one. */
  traceId?: string
}

const storage = new AsyncLocalStorage<RequestContext>()

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId
}

export function getRequestSource(): 'http' | 'cron' | 'manual' | undefined {
  return storage.getStore()?.source
}

/**
 * P3.6 — the id of the CHANGE this flow belongs to.
 *
 * Falls back to `requestId` on an HTTP request: a change made directly in a request,
 * with no queue row in between, IS that request. It does NOT fall back on a cron,
 * because a tick id shared by 1,243 calls would make every one of them look like the
 * same change — worse than admitting there is no trace.
 */
export function getTraceId(): string | undefined {
  const ctx = storage.getStore()
  if (!ctx) return undefined
  return ctx.traceId ?? (ctx.source === 'http' ? ctx.requestId : undefined)
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
 * P3.6 — run `fn` with a change's trace bound, keeping the surrounding run id.
 *
 * This is the hop the trace used to die at. The worker picks a queue row off the
 * table inside its own cron tick; binding the row's `traceId` here means the channel
 * call it makes is stamped with the CHANGE's id as well as the tick's, so
 * "what happened to my edit" and "what did this tick do" are both answerable.
 */
export function runWithTraceId<T>(traceId: string | null | undefined, fn: () => T): T {
  const ctx = storage.getStore()
  if (!traceId) return fn()
  return storage.run(
    { requestId: ctx?.requestId ?? traceId, source: ctx?.source ?? 'manual', traceId },
    fn,
  )
}

/**
 * Generate a fresh tick ID for a cron run. Format mirrors what
 * Fastify produces for HTTP requests so logs are uniformly shaped.
 */
export function newTickId(): string {
  return `cron-${randomUUID()}`
}
