import type { FactoryDatabase, Prisma } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import type { Log, QueueKit } from '../../core/queue'
import { serverClock, type Clock } from '../../core/time'
import { activeTenants, asSystem } from './system'

/**
 * The outbox relay (plan A1 §3.3 queue `outbox`; feature PLT-191), run by the worker: it moves committed OutboxEvent
 * rows to BullMQ. For each active tenant, in that tenant's system scope (RLS forced), ONE transaction:
 *
 *   1. picks the due pending rows, oldest first, `FOR UPDATE SKIP LOCKED`: a second relay (another replica) skips the
 *      rows this one holds and takes others, so two relays never publish the same row in the same pass;
 *   2. publishes each to the `events` queue with job id = event id (a repeat after a crash is not a second job);
 *   3. marks each: published → PUBLISHED with publishedAt; failed → attempts + 1, lastError, and nextAttemptAt after an
 *      exponential backoff; after `maxAttempts` failures → DEAD, for a person to look at (the lag cron reports it).
 * The publishes of one pass run side by side, each with a timeout, so a Redis outage costs one timeout per pass, not
 * one per row. The row trigger (…_outbox_guard) lets this transaction change nothing but the delivery state.
 *
 * The relay polls (default every second, at once again after a full batch). A1 also names a PostgreSQL NOTIFY wake-up;
 * it needs a dedicated listening connection the scoped client does not give, so it is left for when polling is too slow.
 */

export interface RelaySettings {
  /** Rows per tenant per pass. */
  readonly batchSize: number
  /** Failed publishes before a row is DEAD. */
  readonly maxAttempts: number
  /** Backoff after the first failure, doubled after each next one, capped at backoffMaxMs. */
  readonly backoffBaseMs: number
  readonly backoffMaxMs: number
  /** Longest wait for one publish. */
  readonly publishTimeoutMs: number
  readonly clock: Clock
}

export const RELAY_SETTINGS: RelaySettings = Object.freeze({
  batchSize: 100,
  maxAttempts: 10,
  backoffBaseMs: 1_000,
  backoffMaxMs: 5 * 60_000,
  publishTimeoutMs: 5_000,
  clock: serverClock,
})

/** Hands one event to the queue. It must be safe to call twice for one event (the job id dedupes). */
export type Publish = (event: EventEnvelope) => Promise<void>

/** Publishes to the `events` queue, job name = the event type, job id = the event id. */
export function queuePublisher(kit: QueueKit): Publish {
  return async (event) => {
    await kit.add('events', event.type, event, { jobId: event.eventId })
  }
}

export interface RelayCounts {
  readonly published: number
  readonly failed: number
  readonly dead: number
  /** A tenant's batch was full: there may be more due rows right now. */
  readonly more: boolean
}

interface PendingRow {
  id: string
  type: string
  version: number
  context: string
  companyId: string | null
  siteId: string | null
  subject: string
  correlationId: string
  causationId: string | null
  source: string
  occurredAt: Date
  payload: unknown
  attempts: number
}

/** The backoff before the next try after `failures` failed attempts (1, 2, 3 …). */
export function backoffMs(failures: number, settings: Pick<RelaySettings, 'backoffBaseMs' | 'backoffMaxMs'>): number {
  return Math.min(settings.backoffMaxMs, settings.backoffBaseMs * 2 ** Math.max(0, failures - 1))
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

const envelopeOf = (tenantId: string, row: PendingRow): EventEnvelope => ({
  eventId: row.id,
  type: row.type,
  version: row.version,
  context: row.context,
  tenantId,
  companyId: row.companyId,
  siteId: row.siteId,
  subject: row.subject,
  correlationId: row.correlationId,
  causationId: row.causationId,
  source: row.source,
  occurredAt: toUtcIso(row.occurredAt),
  payload: row.payload,
})

/** One pass over one tenant's outbox. */
export async function relayTenant(database: FactoryDatabase, tenantId: string, publish: Publish, settings: RelaySettings = RELAY_SETTINGS): Promise<RelayCounts> {
  const now = settings.clock.now()
  return asSystem(database, tenantId, `relay-${newId()}`, (client) =>
    client.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<PendingRow[]>`
          SELECT "id", "type", "version", "context", "companyId", "siteId", "subject", "correlationId", "causationId",
                 "source", "occurredAt", "payload", "attempts"
          FROM "OutboxEvent"
          WHERE "status" = 'PENDING' AND "nextAttemptAt" <= ${now}
          ORDER BY "id"
          LIMIT ${settings.batchSize}
          FOR UPDATE SKIP LOCKED`
        if (rows.length === 0) return { published: 0, failed: 0, dead: 0, more: false }

        const outcomes = await Promise.allSettled(rows.map((row) => withTimeout(publish(envelopeOf(tenantId, row)), settings.publishTimeoutMs)))
        const published = rows.filter((_, index) => outcomes[index]!.status === 'fulfilled').map((row) => row.id)
        if (published.length > 0) {
          await tx.outboxEvent.updateMany({
            where: { id: { in: published } },
            data: { status: 'PUBLISHED', publishedAt: now, attempts: { increment: 1 }, lastError: null },
          })
        }
        let dead = 0
        for (const [index, outcome] of outcomes.entries()) {
          if (outcome.status === 'fulfilled') continue
          const row = rows[index]!
          const attempts = row.attempts + 1
          const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
          const data: Prisma.OutboxEventUpdateManyMutationInput = {
            attempts,
            lastError: reason.slice(0, 1_000),
            nextAttemptAt: new Date(now.getTime() + backoffMs(attempts, settings)),
          }
          if (attempts >= settings.maxAttempts) {
            data.status = 'DEAD'
            dead++
          }
          await tx.outboxEvent.updateMany({ where: { id: row.id }, data })
        }
        return { published: published.length, failed: rows.length - published.length, dead, more: rows.length === settings.batchSize }
      },
      { maxWait: 5_000, timeout: settings.publishTimeoutMs + 10_000 },
    ),
  )
}

/** One pass over every active tenant. A tenant that fails is logged and the pass goes on. */
export async function relayOnce(database: FactoryDatabase, publish: Publish, settings: RelaySettings = RELAY_SETTINGS, log?: Log): Promise<RelayCounts> {
  let published = 0
  let failed = 0
  let dead = 0
  let more = false
  for (const tenantId of await activeTenants(database)) {
    try {
      const counts = await relayTenant(database, tenantId, publish, settings)
      published += counts.published
      failed += counts.failed
      dead += counts.dead
      more ||= counts.more
      if (counts.dead > 0) log?.error({ tenantId, dead: counts.dead }, 'outbox: events went DEAD after their last publish attempt')
    } catch (error) {
      log?.error({ tenantId, err: error }, 'outbox relay pass failed for a tenant')
    }
  }
  return { published, failed, dead, more }
}

export interface RelayLoop {
  /** Stops after the pass that is running. */
  stop(): Promise<void>
}

/** The worker's loop: a pass, then a pause of `pollMs` (none after a full batch), until stopped. */
export function startRelay(options: { database: FactoryDatabase; publish: Publish; log: Log; pollMs?: number; settings?: RelaySettings }): RelayLoop {
  const pollMs = options.pollMs ?? 1_000
  let stopped = false
  let wake: (() => void) | undefined
  const loop = (async () => {
    while (!stopped) {
      let more = false
      try {
        more = (await relayOnce(options.database, options.publish, options.settings, options.log)).more
      } catch (error) {
        options.log.error({ err: error }, 'outbox relay pass failed')
      }
      if (stopped) break
      if (!more) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, pollMs)
          wake = () => {
            clearTimeout(timer)
            resolve()
          }
        })
        wake = undefined
      }
    }
  })()
  return {
    async stop() {
      stopped = true
      wake?.()
      await loop
    },
  }
}
