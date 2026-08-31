// EV.1 — the outbox relay.
//
// Drains EventOutbox into the broker. The ordering of the three steps is the
// whole correctness argument:
//
//   1. claim   SELECT ... FOR UPDATE SKIP LOCKED
//   2. publish push to the broker
//   3. stamp   UPDATE publishedAt
//
// Publish BEFORE stamp, never after. Stamping first and crashing loses the
// event silently; publishing first and crashing republishes it, which is
// visible, bounded, and exactly the at-least-once contract consumers are built
// against. When in doubt, prefer the duplicate over the disappearance.
//
// SKIP LOCKED is what makes this safe to run on every replica at once: two
// relays never claim the same row, and neither blocks waiting for the other.
// That property is why turning on a second API instance needs no coordination.

import { randomUUID } from 'node:crypto'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import type { EventEnvelope } from '@nexus/events'
import type { EventBroker } from './broker.js'

interface OutboxRow {
  id: string
  eventId: string
  type: string
  version: number
  accountId: string | null
  subject: string
  correlationId: string
  causationId: string | null
  source: string
  payload: unknown
  occurredAt: Date
}

function rowToEnvelope(row: OutboxRow): EventEnvelope {
  return {
    id: row.eventId,
    type: row.type,
    version: row.version,
    occurredAt: row.occurredAt.toISOString(),
    accountId: row.accountId,
    subject: row.subject,
    correlationId: row.correlationId,
    causationId: row.causationId,
    source: row.source,
    payload: row.payload,
  }
}

export interface RelayConfig {
  batchSize: number
  /**
   * After this many failures a row stops being claimed. It is quarantined, NOT
   * deleted — a poison row must never block the head of the queue, and must
   * never vanish either. `pendingBlocked` in the stats is how it surfaces.
   */
  maxAttempts: number
  retentionDays: number
}

export function relayConfig(): RelayConfig {
  const int = (name: string, fallback: number) => {
    const raw = Number(process.env[name])
    return Number.isInteger(raw) && raw > 0 ? raw : fallback
  }
  return {
    batchSize: int('EVENT_RELAY_BATCH', 256),
    maxAttempts: int('EVENT_RELAY_MAX_ATTEMPTS', 10),
    retentionDays: int('EVENT_OUTBOX_RETENTION_DAYS', 7),
  }
}

export interface RelayResult {
  claimed: number
  published: number
  failed: number
}

/**
 * One drain pass. Exported so tests can run the relay deterministically
 * instead of waiting on a timer, and so an operator can force a drain.
 */
export async function relayOnce(broker: EventBroker, config: RelayConfig = relayConfig()): Promise<RelayResult> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<OutboxRow[]>`
      SELECT id, "eventId", type, version, "accountId", subject,
             "correlationId", "causationId", source, payload, "occurredAt"
      FROM "EventOutbox"
      WHERE "publishedAt" IS NULL
        AND attempts < ${config.maxAttempts}
      ORDER BY "occurredAt" ASC
      LIMIT ${config.batchSize}
      FOR UPDATE SKIP LOCKED
    `

    if (rows.length === 0) return { claimed: 0, published: 0, failed: 0 }

    const ids = rows.map((r) => r.id)
    try {
      await broker.publish(rows.map(rowToEnvelope))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Not stamped: the rows stay pending and are retried next tick. attempts
      // climbs so a permanently unpublishable row eventually quarantines
      // itself rather than blocking everything behind it.
      await tx.eventOutbox.updateMany({
        where: { id: { in: ids } },
        data: { attempts: { increment: 1 }, lastError: message.slice(0, 500) },
      })
      logger.error('event relay: publish failed, rows left pending', { count: rows.length, error: message })
      return { claimed: rows.length, published: 0, failed: rows.length }
    }

    await tx.eventOutbox.updateMany({
      where: { id: { in: ids } },
      data: { publishedAt: new Date(), lastError: null },
    })
    return { claimed: rows.length, published: rows.length, failed: 0 }
  })
}

/**
 * Delete published rows past the retention window, in bounded chunks.
 * An append-only table on a hot write path is otherwise unbounded — the same
 * class of bug as any cleanup that only runs on a graceful exit.
 */
export async function pruneOutbox(config: RelayConfig = relayConfig()): Promise<number> {
  const cutoff = new Date(Date.now() - config.retentionDays * 86_400_000)
  const deleted = await prisma.$executeRaw`
    DELETE FROM "EventOutbox"
    WHERE id IN (
      SELECT id FROM "EventOutbox"
      WHERE "publishedAt" IS NOT NULL AND "publishedAt" < ${cutoff}
      LIMIT 1000
    )
  `
  return Number(deleted)
}

export async function outboxStats(): Promise<{
  pending: number
  pendingBlocked: number
  oldestPendingAgeMs: number | null
}> {
  const { maxAttempts } = relayConfig()
  const [pending, pendingBlocked, oldest] = await Promise.all([
    prisma.eventOutbox.count({ where: { publishedAt: null, attempts: { lt: maxAttempts } } }),
    prisma.eventOutbox.count({ where: { publishedAt: null, attempts: { gte: maxAttempts } } }),
    prisma.eventOutbox.findFirst({
      where: { publishedAt: null },
      orderBy: { occurredAt: 'asc' },
      select: { occurredAt: true },
    }),
  ])
  return {
    pending,
    pendingBlocked,
    oldestPendingAgeMs: oldest ? Date.now() - oldest.occurredAt.getTime() : null,
  }
}

// ── the loop ────────────────────────────────────────────────────────────────
//
// ADAPTIVE, not a fixed 1s interval. The first production deploy showed why:
// the relay ticked once a second against an empty table forever — 86,400
// queries and ~172,000 log lines a day to discover, over and over, that there
// was nothing to do. Invisible locally, where it only ever ran for the few
// seconds a test took.
//
// An empty tick doubles the delay up to a cap; any tick that publishes resets
// to the base. That alone would trade latency for quiet, so it is paired with
// notifyPublished(): a publisher tells the relay a row is coming, and the
// relay serves the next few ticks at full speed.
//
// 🔴 THE COMMIT RACE is why that is a COUNTER and not a boolean. publishEvent
// runs INSIDE the caller's transaction, so at the moment it fires the row is
// not visible to the relay's own connection yet. A single fast tick would look
// at an uncommitted row, find nothing, and back off again — with the event
// sitting there. Several fast ticks span the commit instead.
//
// Net effect: an event published by this process is still drained within ~1s,
// while an idle relay settles to one query every 10s. What it does NOT cover
// is a row published by ANOTHER replica, which waits up to the cap — acceptable
// because the latency-critical path (SSE refresh hints) bypasses the outbox
// entirely via the ephemeral lane, and the durable consumers are not
// latency-critical.

const BASE_INTERVAL_MS = 1_000
const MAX_IDLE_INTERVAL_MS = 10_000
/** Fast ticks granted after a publish — enough to span the caller's commit. */
const FAST_TICKS_AFTER_PUBLISH = 5

let timer: NodeJS.Timeout | null = null
let running = false
let ticking = false
let pruneCounter = 0
let currentDelayMs = BASE_INTERVAL_MS
let fastTicksRemaining = 0

/**
 * PURE. The next delay, given the last tick's outcome.
 * Exported so the backoff is testable without waiting on real timers —
 * otherwise the only way to know it works is to watch production logs again.
 */
export function nextDelayMs(current: number, published: number, fastTicks: number): number {
  if (published > 0 || fastTicks > 0) return BASE_INTERVAL_MS
  return Math.min(current * 2, MAX_IDLE_INTERVAL_MS)
}

/**
 * Tell the relay a row was just written, so it serves the next few ticks at
 * full speed. Safe to call from inside a transaction — see the commit race
 * above. Cheap by design: it sets a counter and returns.
 */
export function notifyPublished(): void {
  fastTicksRemaining = FAST_TICKS_AFTER_PUBLISH
  currentDelayMs = BASE_INTERVAL_MS
}

/** Current delay, for tests and diagnostics. */
export function relayDelayMs(): number {
  return currentDelayMs
}

export function startRelay(broker: EventBroker, intervalMs = BASE_INTERVAL_MS): () => void {
  if (running) return stopRelay
  running = true
  currentDelayMs = intervalMs
  const config = relayConfig()
  logger.info('event relay: started', {
    broker: broker.name,
    baseIntervalMs: intervalMs,
    maxIdleIntervalMs: MAX_IDLE_INTERVAL_MS,
    batchSize: config.batchSize,
    relayId: randomUUID().slice(0, 8),
  })

  const schedule = (delay: number) => {
    if (!running) return
    timer = setTimeout(tick, delay)
    // Never hold the process open for the relay alone.
    timer.unref?.()
  }

  const tick = () => {
    // A tick that overruns must not stack another on top of it — two
    // overlapping drains are safe (SKIP LOCKED) but pointless, and they
    // multiply connections under exactly the load where that hurts.
    if (ticking) {
      schedule(currentDelayMs)
      return
    }
    ticking = true
    void relayOnce(broker, config)
      .then(async (result) => {
        if (result.published > 0) {
          logger.debug('event relay: drained', result)
        }
        currentDelayMs = nextDelayMs(currentDelayMs, result.published, fastTicksRemaining)
        if (result.published === 0 && fastTicksRemaining > 0) fastTicksRemaining--
        if (result.published > 0) fastTicksRemaining = 0

        // Prune on a wall-clock cadence rather than a tick count: with an
        // adaptive interval, "every 300 ticks" is no longer a fixed period.
        if (++pruneCounter % 60 === 0) {
          const deleted = await pruneOutbox(config)
          if (deleted > 0) logger.debug('event relay: pruned published rows', { deleted })
        }
      })
      .catch((error) => {
        logger.error('event relay: tick failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => {
        ticking = false
        schedule(currentDelayMs)
      })
  }

  schedule(currentDelayMs)
  return stopRelay
}

export function stopRelay(): void {
  running = false
  if (timer) clearTimeout(timer)
  timer = null
  currentDelayMs = BASE_INTERVAL_MS
  fastTicksRemaining = 0
}
