// EV.1 — ambient correlation.
//
// Without this, every publish site would mint its own correlationId and every
// event would be its own chain — the field would be present, populated, and
// completely useless. The whole value of correlationId is that a webhook and
// the six channel writes it eventually caused share one, so `WHERE
// correlation_id = ...` reconstructs the incident.
//
// AsyncLocalStorage propagates it through awaits without threading a parameter
// through every service signature. A publish outside any context (a cron tick,
// a boot task) still gets a fresh id — it is genuinely the root of its own
// chain, which is the honest answer rather than a missing value.

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

export interface CorrelationContext {
  correlationId: string
  /** The event currently being handled, if any — becomes the next event's causationId. */
  causationId: string | null
}

const storage = new AsyncLocalStorage<CorrelationContext>()

export function withCorrelation<T>(context: Partial<CorrelationContext>, fn: () => T): T {
  return storage.run(
    {
      correlationId: context.correlationId ?? currentCorrelationId() ?? randomUUID(),
      causationId: context.causationId ?? null,
    },
    fn,
  )
}

export function currentCorrelationId(): string | null {
  return storage.getStore()?.correlationId ?? null
}

export function currentCausationId(): string | null {
  return storage.getStore()?.causationId ?? null
}

/** Snapshot for a publish. Roots a new chain when there is no ambient context. */
export function correlationForPublish(): CorrelationContext {
  const store = storage.getStore()
  return {
    correlationId: store?.correlationId ?? randomUUID(),
    causationId: store?.causationId ?? null,
  }
}
