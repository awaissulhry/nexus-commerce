/**
 * P2.1 — the inbound retry worker.
 *
 * CX.4a gave the inbound ledger every column a retry needs and wired none of them:
 * `nextAttemptAt` was null on all 5,256 rows, `status = 'dlq'` had never been written,
 * and a failed event simply sat at `failed` forever. An operator could see that
 * something had gone wrong and had no way to make it go right again.
 *
 * This job is the other half. Every minute it takes the events whose time has come and
 * runs each one through the handler that first received it, using nothing but the
 * payload stored on the row. Three things can happen:
 *
 *   - it works        → `done`, and the row is finished
 *   - it fails again  → `failed` with a longer backoff, or `dlq` once the attempts run out
 *   - nothing can run it → `dlq` straight away, with that as the reason
 *
 * The third case matters. Only the channels with a re-runnable handler are in the
 * replay registry; an Amazon SQS notification is handled inside the poll loop and
 * cannot be re-run from its payload alone. Retrying those five times would spend eight
 * hours arriving at the same answer, so they are dead-lettered on the first sweep with
 * a reason that names exactly what is missing.
 *
 * Every event is handled INSIDE its own workspace, read from the row. The sweep itself
 * reads across all of them, because it runs as the platform rather than as a member.
 *
 * Cadence: every minute. The backoff decides when an event is actually due; a tight
 * cadence only decides how soon after that moment the worker notices.
 *
 * Gated behind NEXUS_ENABLE_INBOUND_RETRY_CRON, default ON — an inbound ledger that
 * does not retry is the state this package exists to end.
 */

import cron from '../lib/cron/clustered.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { withIngressWorkspace } from '../lib/workspace-ingress.js'
import { completeInbound, deadLetterInbound, dueInboundEvents, isVerifiedInbound } from '../services/cx/ingress/ledger.js'
import { canReplayInbound, inboundHandlerFor } from '../services/cx/ingress/handlers.js'

const BATCH = 50

export interface InboundRetryStats {
  due: number
  succeeded: number
  failed: number
  unreplayable: number
}

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastStats: InboundRetryStats = { due: 0, succeeded: 0, failed: 0, unreplayable: 0 }

/** One sweep. Exported so a test can run it without a scheduler. */
export async function runInboundRetrySweep(now: Date = new Date()): Promise<InboundRetryStats> {
  const stats: InboundRetryStats = { due: 0, succeeded: 0, failed: 0, unreplayable: 0 }
  const events = await dueInboundEvents(BATCH, now)
  stats.due = events.length

  for (const event of events) {
    if (!isVerifiedInbound(event)) {
      await withIngressWorkspace(event.workspaceId, () =>
        deadLetterInbound(event.id, 'This delivery has no successful verification record and cannot be replayed.'),
      )
      stats.unreplayable++
      continue
    }
    // Checked before the workspace is entered and before anything is loaded: an event
    // nothing can replay must not consume an attempt, and must not look like a
    // handler that threw.
    if (!canReplayInbound(event.channel, event.eventType)) {
      await withIngressWorkspace(event.workspaceId, () =>
        deadLetterInbound(
          event.id,
          `No replay handler is registered for ${event.channel}/${event.eventType}. This event needs an operator.`,
        ),
      )
      stats.unreplayable++
      continue
    }

    try {
      await withIngressWorkspace(event.workspaceId, async () => {
        const handler = await inboundHandlerFor(event.channel, event.eventType)
        // canReplayInbound just said yes, so a null here means the registry and the
        // module disagree — a wrong export name. Say so rather than reporting the
        // TypeError that calling null would raise.
        if (!handler) throw new Error(`The replay registry lists ${event.channel}/${event.eventType} but its handler could not be loaded.`)
        // The account comes from the LEDGER ROW, not from the payload and not from a
        // lookup: the stored payload is the channel's own body and names no Nexus
        // account, and deducing one means "the only connected account" — the ambient
        // resolution the MAP.3 ratchet forbids.
        await handler(event.payload, { connectionId: event.connectionId, eventType: event.eventType, channel: event.channel })
        await completeInbound(event.id, true)
      })
      stats.succeeded++
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // `completeInbound` decides between another backoff and dead letters; it is the
      // one place that knows the attempt budget.
      await withIngressWorkspace(event.workspaceId, () => completeInbound(event.id, false, message))
      stats.failed++
      logger.warn('[inbound-retry] replay failed', { id: event.id, channel: event.channel, eventType: event.eventType, error: message })
    }
  }

  lastRunAt = now
  lastStats = stats
  return stats
}

export function startInboundRetryCron(): void {
  if (scheduledTask) {
    logger.warn('inbound-retry cron already started — skipping')
    return
  }
  if (process.env.NEXUS_ENABLE_INBOUND_RETRY_CRON === '0') {
    logger.info('inbound-retry cron disabled via env')
    return
  }
  const schedule = process.env.NEXUS_INBOUND_RETRY_SCHEDULE ?? '* * * * *'
  if (!cron.validate(schedule)) {
    logger.error('inbound-retry cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, async () => {
    await recordCronRun('inbound-retry', async () => {
      const stats = await runInboundRetrySweep()
      return `due=${stats.due} succeeded=${stats.succeeded} failed=${stats.failed} unreplayable=${stats.unreplayable}`
    }).catch((err) => {
      logger.error('inbound-retry cron: failure', { error: err instanceof Error ? err.message : String(err) })
    })
  })
  logger.info('inbound-retry cron started', { schedule })
}

export function inboundRetryStatus() {
  return { running: !!scheduledTask, lastRunAt, lastStats }
}
