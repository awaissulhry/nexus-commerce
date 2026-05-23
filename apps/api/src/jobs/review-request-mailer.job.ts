/**
 * SR.4 — Post-purchase review request mailer cron.
 *
 * Runs every 4 hours under NEXUS_ENABLE_REVIEW_INGEST=1.
 *
 * Tick:
 *   1. Schedule any newly-delivered orders that have no ReviewRequest yet
 *      (delegates to review-scheduler.service.ts).
 *   2. Find ReviewRequest rows with status='SCHEDULED' and scheduledFor ≤ now().
 *   3. For non-Amazon channels (eBay, Shopify): send the email template
 *      and mark SENT (or FAILED).
 *   4. For Amazon: fire the Solicitations API call; check the 4-30d window
 *      is still valid first.
 *
 * Amazon Solicitations is still gated by NEXUS_ENABLE_AMAZON_SOLICITATIONS=true
 * (D.7 gate). Non-Amazon email is gated by NEXUS_ENABLE_OUTBOUND_EMAILS=true.
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import {
  schedulePendingOrders,
  buildReviewUrl,
} from '../services/reviews/review-scheduler.service.js'
import { sendReviewRequestEmail } from '../services/reviews/review-request-email.service.js'
import {
  sendAmazonSolicitation,
  isBenignFailure,
  benignSuppressedReason,
} from '../services/reviews/amazon-solicitations.service.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastSummary: string | null = null

// RV.3.3 — App-level retry policy.
// SP-API client retries 429/5xx with 1s/2s/4s backoff per-request. After
// that exhausts, the mailer reschedules at a longer timescale (hours):
//   attempt 0 → on FAILED: nextRetryAt = +4h
//   attempt 1 → on FAILED: nextRetryAt = +8h
//   attempt 2 → on FAILED: nextRetryAt = +16h
//   attempt 3 → terminal: row stays FAILED, no nextRetryAt
const MAX_RETRIES = 3
const BACKOFF_HOURS = [4, 8, 16] as const
function backoffNextRetryAt(attemptCount: number): Date | null {
  if (attemptCount >= MAX_RETRIES) return null
  const hours = BACKOFF_HOURS[attemptCount] ?? 24
  return new Date(Date.now() + hours * 60 * 60 * 1000)
}

interface MailerTickResult {
  scheduled: number
  due: number
  sent: number
  failed: number
  skipped: number
  retried: number
  durationMs: number
}

export async function runReviewMailerOnce(): Promise<MailerTickResult> {
  const startedAt = Date.now()

  // Step 1: schedule newly delivered orders
  const scheduleResult = await schedulePendingOrders()

  // RV.3.3 — pull rows ready for app-level retry back to SCHEDULED before
  // the main due query. nextRetryAt has elapsed and attemptCount < MAX_RETRIES,
  // so we get one more shot. The mailer then processes them as normal SCHEDULED.
  const retriedRows = await prisma.reviewRequest.updateMany({
    where: {
      status: 'FAILED',
      nextRetryAt: { lte: new Date() },
      attemptCount: { lt: MAX_RETRIES },
    },
    data: {
      status: 'SCHEDULED',
      scheduledFor: new Date(),
      nextRetryAt: null,
      errorMessage: null,
    },
  })

  // Step 2: find due requests
  const due = await prisma.reviewRequest.findMany({
    where: {
      status: 'SCHEDULED',
      scheduledFor: { lte: new Date() },
    },
    include: {
      order: {
        select: {
          id: true,
          channel: true,
          channelOrderId: true,
          marketplace: true,
          deliveredAt: true,
          customerEmail: true,
          customerName: true,
          items: {
            take: 1,
            select: {
              product: { select: { name: true, productType: true } },
            },
          },
        },
      },
    },
    take: 200,
  })

  let sent = 0, failed = 0, skipped = 0

  for (const req of due) {
    const order = req.order
    const attemptCount = req.attemptCount + 1
    try {
      if (order.channel === 'AMAZON') {
        // Verify 4-30d window still valid
        const daysSinceDelivery = order.deliveredAt
          ? (Date.now() - order.deliveredAt.getTime()) / (24 * 60 * 60 * 1000)
          : Infinity
        if (daysSinceDelivery < 4 || daysSinceDelivery > 30) {
          await prisma.reviewRequest.update({
            where: { id: req.id },
            data: { status: 'SKIPPED', suppressedReason: `Outside Amazon 4-30d window (${Math.round(daysSinceDelivery)}d)` },
          })
          skipped += 1
          continue
        }
        if (!order.channelOrderId) {
          await prisma.reviewRequest.update({
            where: { id: req.id },
            data: { status: 'SKIPPED', suppressedReason: 'No channelOrderId for Amazon solicitation' },
          })
          skipped += 1
          continue
        }
        const result = await sendAmazonSolicitation({
          amazonOrderId: order.channelOrderId,
          marketplaceCode: order.marketplace ?? 'IT',
        })
        if (result.ok) {
          await prisma.reviewRequest.update({
            where: { id: req.id },
            data: {
              status: 'SENT',
              sentAt: new Date(),
              providerRequestId: result.providerRequestId ?? null,
              attemptCount,
              lastAttemptAt: new Date(),
              nextRetryAt: null,
            },
          })
          sent += 1
        } else if (isBenignFailure(result.errorCode)) {
          // NOT_IMPLEMENTED / UNKNOWN_MARKETPLACE / ALREADY_SOLICITED →
          // SKIPPED, no retry (permanent / config / dup-protect).
          await prisma.reviewRequest.update({
            where: { id: req.id },
            data: {
              status: 'SKIPPED',
              providerResponseCode: result.errorCode ?? null,
              suppressedReason: benignSuppressedReason(result.errorCode),
              attemptCount,
              lastAttemptAt: new Date(),
              nextRetryAt: null,
            },
          })
          skipped += 1
        } else {
          // Genuine failure → schedule a retry if we haven't exhausted attempts.
          const nextRetryAt = backoffNextRetryAt(attemptCount)
          await prisma.reviewRequest.update({
            where: { id: req.id },
            data: {
              status: 'FAILED',
              providerResponseCode: result.errorCode ?? null,
              errorMessage: result.errorMessage ?? result.errorCode ?? 'unknown',
              attemptCount,
              lastAttemptAt: new Date(),
              nextRetryAt,
            },
          })
          failed += 1
        }
      } else {
        // eBay / Shopify — send our own email
        if (!order.customerEmail) {
          await prisma.reviewRequest.update({
            where: { id: req.id },
            data: { status: 'SKIPPED', suppressedReason: 'No customer email on order' },
          })
          skipped += 1
          continue
        }
        const firstProduct = order.items[0]?.product ?? null
        const result = await sendReviewRequestEmail({
          to: order.customerEmail,
          customerName: order.customerName,
          channelOrderId: order.channelOrderId,
          channel: order.channel,
          marketplace: order.marketplace,
          productName: firstProduct?.name ?? null,
          productType: firstProduct?.productType ?? null,
          reviewUrl: buildReviewUrl(order.channel, order.channelOrderId),
          locale: (order.marketplace ?? 'IT').toUpperCase() === 'IT' ? 'it' : 'en',
        })
        if (result.ok) {
          await prisma.reviewRequest.update({
            where: { id: req.id },
            data: {
              status: 'SENT',
              sentAt: new Date(),
              attemptCount,
              lastAttemptAt: new Date(),
              nextRetryAt: null,
            },
          })
          sent += 1
        } else if (result.dryRun) {
          skipped += 1 // stay SCHEDULED in dry-run
        } else {
          const nextRetryAt = backoffNextRetryAt(attemptCount)
          await prisma.reviewRequest.update({
            where: { id: req.id },
            data: {
              status: 'FAILED',
              errorMessage: result.error ?? 'email_send_failed',
              attemptCount,
              lastAttemptAt: new Date(),
              nextRetryAt,
            },
          })
          failed += 1
        }
      }
    } catch (err) {
      logger.warn('[review-mailer] unexpected error processing request', {
        requestId: req.id,
        error: err instanceof Error ? err.message : String(err),
      })
      failed += 1
    }
  }

  const durationMs = Date.now() - startedAt
  lastRunAt = new Date()
  const retried = retriedRows.count
  lastSummary = `scheduled=${scheduleResult.scheduled} retried=${retried} due=${due.length} sent=${sent} failed=${failed} skipped=${skipped} durationMs=${durationMs}`
  return { scheduled: scheduleResult.scheduled, retried, due: due.length, sent, failed, skipped, durationMs }
}

export async function runReviewMailerCron(): Promise<void> {
  try {
    await recordCronRun('review-request-mailer', async () => {
      const result = await runReviewMailerOnce()
      logger.info('review-request-mailer cron: completed', { result })
      return lastSummary ?? 'no-summary'
    })
  } catch (err) {
    logger.error('review-request-mailer cron: failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startReviewMailerCron(): void {
  if (scheduledTask) {
    logger.warn('review-request-mailer cron already started')
    return
  }
  const schedule = process.env.NEXUS_REVIEW_MAILER_SCHEDULE ?? '0 */4 * * *'
  if (!cron.validate(schedule)) {
    logger.error('review-request-mailer cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    void runReviewMailerCron()
  })
  logger.info('review-request-mailer cron: scheduled', { schedule })
}

export function stopReviewMailerCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getReviewMailerStatus(): {
  scheduled: boolean
  lastRunAt: Date | null
  lastSummary: string | null
} {
  return { scheduled: scheduledTask != null, lastRunAt, lastSummary }
}
