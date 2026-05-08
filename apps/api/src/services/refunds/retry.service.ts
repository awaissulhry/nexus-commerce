/**
 * R5.3 — failed-refund retry service.
 *
 * Why this exists:
 *   The /refund route's existing failure path marks
 *   Return.refundStatus='CHANNEL_FAILED' and stops. Operators were
 *   left with stale failures: a refund that 502'd at 02:00
 *   sat there until someone manually retried in the morning. The
 *   pre-R5.1 publisher had no retry policy + no audit beyond a
 *   single error message.
 *
 * What this does:
 *   - Finds Returns where refundStatus='CHANNEL_FAILED' AND the
 *     last attempt is older than the per-attempt backoff window.
 *   - Re-runs publishRefundToChannel for each.
 *   - Writes a Refund row (with the canonical PENDING → POSTED|
 *     FAILED|MANUAL_REQUIRED|NOT_IMPLEMENTED transition) and a
 *     RefundAttempt row per call so the audit accumulates.
 *   - On success, projects to Return.refund* cache columns so the
 *     drawer / list see REFUNDED without waiting for R5.1.
 *
 * Backoff (per Return, across all RefundAttempts):
 *   attempt 1 → wait 30m
 *   attempt 2 → wait  2h
 *   attempt 3 → wait  6h
 *   attempt 4 → wait 24h
 *   attempt ≥ 5 → give up, leave CHANNEL_FAILED, surface in
 *                 analytics for operator escalation.
 *
 * The retry counts attempts across all Refund rows for the Return
 * — operators retrying manually + the cron contribute to the same
 * counter, so a manual retry doesn't accidentally double the
 * automatic schedule.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

const BACKOFF_MINUTES_BY_ATTEMPT = [30, 120, 360, 1440] // attempts 1..4
const MAX_ATTEMPTS = 5

export interface RetryDecision {
  ready: boolean
  /** Total attempts already made for this Return. */
  priorAttempts: number
  /** Earliest UTC time the next retry is allowed. null if ready. */
  nextEligibleAt: Date | null
  /** Reason a retry is NOT allowed, when ready=false. */
  reason?: 'max_attempts' | 'backoff' | 'not_failed'
}

/**
 * Decide whether a Return is ready for retry now. Pure-ish: only
 * reads from DB, no writes.
 */
export async function isRetryReady(returnId: string): Promise<RetryDecision> {
  const ret = await prisma.return.findUnique({
    where: { id: returnId },
    select: { refundStatus: true },
  })
  if (!ret || ret.refundStatus !== 'CHANNEL_FAILED') {
    return {
      ready: false,
      priorAttempts: 0,
      nextEligibleAt: null,
      reason: 'not_failed',
    }
  }
  // Count all RefundAttempts across this Return's Refunds. Falls
  // back to 0 when no Refund row exists yet (the legacy /refund
  // path doesn't write Refund rows; the first retry creates the
  // first Refund + Attempt).
  const attempts = await prisma.refundAttempt.findMany({
    where: { refund: { returnId } },
    orderBy: { attemptedAt: 'desc' },
    select: { attemptedAt: true },
  })
  const priorAttempts = attempts.length

  if (priorAttempts >= MAX_ATTEMPTS) {
    return { ready: false, priorAttempts, nextEligibleAt: null, reason: 'max_attempts' }
  }

  // First retry has no prior attempt → ready immediately.
  if (priorAttempts === 0) {
    return { ready: true, priorAttempts, nextEligibleAt: null }
  }

  const lastAt = attempts[0].attemptedAt
  const backoffIdx = Math.min(priorAttempts - 1, BACKOFF_MINUTES_BY_ATTEMPT.length - 1)
  const backoffMs = BACKOFF_MINUTES_BY_ATTEMPT[backoffIdx] * 60_000
  const nextEligibleAt = new Date(lastAt.getTime() + backoffMs)

  if (Date.now() < nextEligibleAt.getTime()) {
    return { ready: false, priorAttempts, nextEligibleAt, reason: 'backoff' }
  }
  return { ready: true, priorAttempts, nextEligibleAt }
}

export interface RetryResult {
  outcome: 'OK' | 'OK_MANUAL_REQUIRED' | 'NOT_IMPLEMENTED' | 'FAILED' | 'SKIPPED'
  reason?: 'max_attempts' | 'backoff' | 'not_failed'
  refundId?: string
  channelRefundId?: string
  channelMessage?: string
  error?: string
  priorAttempts: number
}

/**
 * Retry a single Return's refund. Writes a Refund + RefundAttempt
 * row regardless of outcome; on success, projects to Return cache.
 *
 * `force=true` skips the backoff check (manual button override).
 */
export async function retryRefund(
  returnId: string,
  opts: { force?: boolean; actor?: string | null } = {},
): Promise<RetryResult> {
  const decision = await isRetryReady(returnId)
  if (!decision.ready && !opts.force) {
    return {
      outcome: 'SKIPPED',
      reason: decision.reason,
      priorAttempts: decision.priorAttempts,
    }
  }

  const ret = await prisma.return.findUnique({
    where: { id: returnId },
    select: {
      channel: true,
      currencyCode: true,
      refundCents: true,
      reason: true,
    },
  })
  if (!ret || !ret.refundCents || ret.refundCents <= 0) {
    return {
      outcome: 'FAILED',
      error: 'Return missing refundCents — cannot retry without an amount',
      priorAttempts: decision.priorAttempts,
    }
  }

  // 1) Create a Refund row in PENDING state — this row decorates
  //    the retry attempt regardless of outcome, so the audit log
  //    accumulates even on failure.
  const refund = await prisma.refund.create({
    data: {
      returnId,
      amountCents: ret.refundCents,
      currencyCode: ret.currencyCode || 'EUR',
      kind: 'CASH',
      reason: ret.reason ?? null,
      channel: ret.channel,
      channelStatus: 'PENDING',
      actor: opts.actor ?? null,
      notes: opts.force ? 'Manual retry' : 'Auto retry',
    },
  })

  // 2) Call the publisher.
  const t0 = Date.now()
  const { publishRefundToChannel } = await import('./refund-publisher.service.js')
  const publish = await publishRefundToChannel({
    returnId,
    reasonText: ret.reason ?? undefined,
    actor: opts.actor ?? undefined,
  })
  const durationMs = Date.now() - t0

  // 3) Record the attempt.
  await prisma.refundAttempt.create({
    data: {
      refundId: refund.id,
      outcome: publish.outcome,
      channelRefundId: publish.channelRefundId ?? null,
      errorMessage: publish.error ?? null,
      durationMs,
      rawResponse: {
        outcome: publish.outcome,
        channelRefundId: publish.channelRefundId ?? null,
        channelMessage: publish.channelMessage ?? null,
      } as any,
    },
  })

  // 4) Update the Refund row from the publish result.
  const channelStatus =
    publish.outcome === 'FAILED' ? 'FAILED' :
    publish.outcome === 'NOT_IMPLEMENTED' ? 'NOT_IMPLEMENTED' :
    publish.outcome === 'OK_MANUAL_REQUIRED' ? 'MANUAL_REQUIRED' :
    'POSTED'
  await prisma.refund.update({
    where: { id: refund.id },
    data: {
      channelStatus: channelStatus as any,
      channelRefundId: publish.channelRefundId ?? null,
      channelError: publish.outcome === 'FAILED' ? (publish.error ?? 'Unknown channel error') : null,
      channelPostedAt: publish.outcome === 'OK' ? new Date() : null,
    },
  })

  // 5) Project to Return cache columns. On success → REFUNDED.
  //    On failure → keep CHANNEL_FAILED + record latest error.
  if (publish.outcome === 'FAILED') {
    await prisma.return.update({
      where: { id: returnId },
      data: {
        refundStatus: 'CHANNEL_FAILED',
        channelRefundError: publish.error ?? 'Unknown channel error',
        version: { increment: 1 },
      },
    })
  } else {
    await prisma.return.update({
      where: { id: returnId },
      data: {
        status: 'REFUNDED',
        refundStatus: 'REFUNDED',
        refundedAt: new Date(),
        channelRefundId: publish.channelRefundId ?? null,
        channelRefundedAt: publish.outcome === 'OK' ? new Date() : null,
        channelRefundError: null,
        version: { increment: 1 },
      },
    })
  }

  // 6) AuditLog attribution.
  try {
    await prisma.auditLog.create({
      data: {
        userId: opts.actor ?? null,
        ip: null,
        entityType: 'Return',
        entityId: returnId,
        action: opts.force ? 'refund-retry-manual' : 'refund-retry-auto',
        metadata: {
          refundId: refund.id,
          attemptNumber: decision.priorAttempts + 1,
          channelOutcome: publish.outcome,
          channelRefundId: publish.channelRefundId ?? null,
          durationMs,
        } as any,
      },
    })
  } catch (err) {
    logger.warn('refund-retry: audit write failed (non-fatal)', { err })
  }

  return {
    outcome: publish.outcome,
    refundId: refund.id,
    channelRefundId: publish.channelRefundId,
    channelMessage: publish.channelMessage,
    error: publish.error,
    priorAttempts: decision.priorAttempts + 1,
  }
}

/**
 * Sweep: find all Returns ready for retry and process them
 * sequentially. Caller controls the concurrency by setting `limit`
 * — default 25 per tick keeps the cron's wall time bounded even
 * when a backlog has accumulated. Channels rate-limit us anyway,
 * so serial is the right shape.
 */
export async function processRetryQueue(limit = 25): Promise<{
  scanned: number
  retried: number
  succeeded: number
  failed: number
  skipped: number
  givenUp: number
}> {
  const counters = { scanned: 0, retried: 0, succeeded: 0, failed: 0, skipped: 0, givenUp: 0 }

  // Pull a wider window than `limit` to give the per-row eligibility
  // check room to filter — some rows in CHANNEL_FAILED will be in
  // backoff and skipped.
  const candidates = await prisma.return.findMany({
    where: { refundStatus: 'CHANNEL_FAILED' },
    select: { id: true },
    orderBy: { updatedAt: 'asc' }, // oldest-failure-first
    take: limit * 4,
  })

  for (const c of candidates) {
    if (counters.retried >= limit) break
    counters.scanned++
    const decision = await isRetryReady(c.id)
    if (!decision.ready) {
      if (decision.reason === 'max_attempts') counters.givenUp++
      else counters.skipped++
      continue
    }
    counters.retried++
    try {
      const r = await retryRefund(c.id, { actor: 'refund-retry-cron' })
      if (r.outcome === 'FAILED') counters.failed++
      else if (r.outcome === 'SKIPPED') counters.skipped++
      else counters.succeeded++
    } catch (err) {
      counters.failed++
      logger.warn('refund-retry: per-return retry failed', {
        returnId: c.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  logger.info('refund-retry: sweep complete', counters)
  return counters
}
