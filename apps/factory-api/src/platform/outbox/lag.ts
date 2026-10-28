import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { serverClock, type Clock } from '../../core/time'
import { defineCron, type CronJob } from '../../core/cron'
import type { Log, QueueKit } from '../../core/queue'
import { activeTenants, asSystem } from './system'

/**
 * The outbox lag check (plan A1 §3.3 cron "outbox lag check", §5.5; feature PLT-217 "alert when the queue or crons
 * fail"): every minute, on one scheduler replica, it counts per tenant the events still pending (and the oldest one's
 * age) and the DEAD ones, and across the queues the dead letters and the failed jobs. It logs one line: a warning when
 * something needs a person (an event pending longer than `warnAfterMs`, a dead event, a dead letter), info otherwise.
 * The daily system email (a later step) reads the same numbers.
 */

export interface OutboxHealth {
  readonly pending: number
  readonly dead: number
  /** How long the oldest pending event has waited, or null when none is pending. */
  readonly oldestPendingMs: number | null
  readonly deadLetters: number
  readonly failedJobs: number
}

/** The numbers, across every active tenant. */
export async function outboxHealth(database: FactoryDatabase, kit: QueueKit, clock: Clock = serverClock): Promise<OutboxHealth> {
  let pending = 0
  let dead = 0
  let oldest: Date | null = null
  const requestId = `lag-${newId()}`
  for (const tenantId of await activeTenants(database)) {
    const counts = await asSystem(database, tenantId, requestId, async (client) => ({
      pending: await client.outboxEvent.count({ where: { status: 'PENDING' } }),
      dead: await client.outboxEvent.count({ where: { status: 'DEAD' } }),
      oldest: (await client.outboxEvent.aggregate({ where: { status: 'PENDING' }, _min: { occurredAt: true } }))._min.occurredAt,
    }))
    pending += counts.pending
    dead += counts.dead
    if (counts.oldest && (!oldest || counts.oldest < oldest)) oldest = counts.oldest
  }
  const [deadLetters, events, handlers] = await Promise.all([
    kit.queue('dead-letter').getJobCountByTypes('waiting', 'delayed', 'paused', 'prioritized'),
    kit.queue('events').getJobCountByTypes('failed'),
    kit.queue('event-handlers').getJobCountByTypes('failed'),
  ])
  const oldestPendingMs = oldest ? Math.max(0, clock.now().getTime() - oldest.getTime()) : null
  return { pending, dead, oldestPendingMs, deadLetters, failedJobs: events + handlers }
}

/** The scheduler's cron. */
export function outboxLagCron(options: { database: FactoryDatabase; kit: QueueKit; log: Log; clock?: Clock; warnAfterMs?: number }): CronJob {
  const warnAfterMs = options.warnAfterMs ?? 5 * 60_000
  return defineCron({
    name: 'outbox.lag',
    schedule: '* * * * *',
    async run() {
      const health = await outboxHealth(options.database, options.kit, options.clock)
      const late = health.oldestPendingMs !== null && health.oldestPendingMs > warnAfterMs
      if (late || health.dead > 0 || health.deadLetters > 0) options.log.warn({ ...health }, 'outbox needs attention: late or dead events, or dead letters')
      else options.log.info({ ...health }, 'outbox ok')
    },
  })
}
