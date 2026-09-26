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
 * Every event is handled inside its stored workspace. The cron wrapper visits active
 * profiles; each selection remains scoped to that profile. eBay has a separate
 * four-receipt batch and owns its claim/completion protocol.
 *
 * Cadence: every minute. The backoff decides when an event is actually due; a tight
 * cadence only decides how soon after that moment the worker notices.
 *
 * Gated behind NEXUS_ENABLE_INBOUND_RETRY_CRON, default ON — an inbound ledger that
 * does not retry is the state this package exists to end.
 */

import cron, { schedulePlatform } from '../lib/cron/clustered.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { withIngressWorkspace } from '../lib/workspace-ingress.js'
import { deadLetterInbound, dueInboundEvents, InboundDeferred, isVerifiedInbound } from '../services/cx/ingress/ledger.js'
import { canReplayInbound, inboundHandlerFor } from '../services/cx/ingress/handlers.js'
import { dueEbayInboundEvents, processEbayInbound, ebayInboundProcessingEnabled } from '../services/cx/ingress/ebay-processing.js'
import { claimInbound, inboundDatabaseNow, runWithInboundClaim } from '../services/cx/ingress/claims.js'

const BATCH = 50

export interface InboundRetryStats {
  due: number
  succeeded: number
  failed: number
  unreplayable: number
  deferred: number
  skipped: number
}

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let deletionReviewTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastStats: InboundRetryStats = { due: 0, succeeded: 0, failed: 0, unreplayable: 0, deferred: 0, skipped: 0 }

/** One sweep. Exported so a test can run it without a scheduler. */
export async function runInboundRetrySweep(now?: Date): Promise<InboundRetryStats> {
  now ??= await inboundDatabaseNow()
  const stats: InboundRetryStats = { due: 0, succeeded: 0, failed: 0, unreplayable: 0, deferred: 0, skipped: 0 }
  // One owner per row type: verified eBay receipts go only to the eBay processor (its own
  // leases); every other due row goes only to the generic claimant below.
  const [events, ebayEvents] = await Promise.all([dueInboundEvents(BATCH, now, { excludeVerifiedEbay: true }), dueEbayInboundEvents()])
  stats.due = events.length + ebayEvents.length

  // At most four remote inspections per profile/sweep; claims fence overlapping
  // workers. Each receipt owns its completion, so never call the legacy finisher.
  const ebayWork = Promise.all(ebayEvents.map(event => withIngressWorkspace(event.workspaceId, async () => {
    try {
      const outcome = await processEbayInbound(event.id)
      if (outcome.kind === 'done') stats.succeeded++
      else if (outcome.kind === 'retry') stats.failed++
      else if (outcome.kind === 'dead_letter') stats.unreplayable++
      else if (outcome.kind === 'deferred') stats.deferred++
      else stats.skipped++
    } catch {
      stats.failed++
      logger.warn('[inbound-retry] stored eBay processing could not persist its outcome', { id: event.id })
    }
  })))

  for (const event of events) {
    if (!isVerifiedInbound(event) || (event.channel === 'EBAY' && event.verifiedBy !== 'ebay_ecdsa')) {
      await withIngressWorkspace(event.workspaceId, () =>
        deadLetterInbound(event.id, 'This delivery has no successful verification record and cannot be replayed.'),
      )
      stats.unreplayable++
      continue
    }
    if (event.channel === 'EBAY') { stats.skipped++; continue }
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
      const ran = await withIngressWorkspace(event.workspaceId, async () => {
        // Claimed at the database's current time, not the sweep's start: a slow batch
        // would otherwise hand later events a lease that has already expired.
        const claim = await claimInbound(event.id)
        if (!claim) return false // another worker holds it, or it changed since it was selected
        await runWithInboundClaim(claim, async (stored, signal) => {
          const handler = await inboundHandlerFor(stored.channel, stored.eventType)
          // canReplayInbound just said yes, so a null here means the registry and the
          // module disagree — a wrong export name. Say so rather than reporting the
          // TypeError that calling null would raise.
          if (!handler) throw new Error(`The replay registry lists ${event.channel}/${event.eventType} but its handler could not be loaded.`)
          // The account and payload come from the CLAIMED LEDGER ROW, not from the
          // selection above and not from a lookup: the stored payload is the channel's
          // own body and names no Nexus account, and deducing one means "the only
          // connected account" — the ambient resolution the MAP.3 ratchet forbids.
          signal.throwIfAborted()
          await handler(stored.payload, { connectionId: stored.connectionId, eventType: stored.eventType, channel: stored.channel, signal })
        })
        return true
      })
      if (ran) stats.succeeded++
    } catch (error) {
      // The claim rescheduled the event without spending an attempt (a sign-in hold).
      if (error instanceof InboundDeferred) { stats.deferred++; continue }
      const message = error instanceof Error ? error.message : String(error)
      // The claim owner has scheduled retry or dead-lettered the exhausted attempt.
      stats.failed++
      logger.warn('[inbound-retry] replay failed', { id: event.id, channel: event.channel, eventType: event.eventType, error: message })
    }
  }

  await ebayWork
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
      return `due=${stats.due} succeeded=${stats.succeeded} failed=${stats.failed} unreplayable=${stats.unreplayable} deferred=${stats.deferred} skipped=${stats.skipped}`
    }).catch((err) => {
      logger.error('inbound-retry cron: failure', { error: err instanceof Error ? err.message : String(err) })
    })
  })
  // eBay deletion notices are acknowledged at storage and reviewed here, later. They belong to no
  // business yet, so one platform tick reviews them — never once per profile. Dormant unless the
  // privacy review switch is exactly 1 (the review itself checks it again).
  deletionReviewTask = schedulePlatform(schedule, async () => {
    if (process.env.NEXUS_ENABLE_EBAY_PRIVACY_REVIEW !== '1') return
    await recordCronRun('ebay-deletion-review', async () => {
      const { reviewPendingEbayDeletions } = await import('../services/cx/ingress/ebay-erasure-review.js')
      const result = await reviewPendingEbayDeletions()
      return result.kind === 'held' ? 'held' : `claimed=${result.claimed} reviewed=${result.reviewed} unsupported=${result.unsupported} failed=${result.failed}`
    }).catch((err) => {
      logger.error('ebay-deletion-review cron: failure', { error: err instanceof Error ? err.message : String(err) })
    })
  })
  logger.info('inbound-retry cron started', { schedule, ebayProcessingEnabled: ebayInboundProcessingEnabled() })
}

export function inboundRetryStatus() {
  return { running: !!scheduledTask, deletionReviewScheduled: !!deletionReviewTask, lastRunAt, lastStats }
}
