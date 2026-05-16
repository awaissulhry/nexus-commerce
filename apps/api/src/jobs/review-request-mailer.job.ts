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

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastSummary: string | null = null

// Mirror of sendAmazonSolicitation from orders-reviews.routes.ts.
// Amazon Solicitations API — productReviewAndSellerFeedback endpoint.
async function fireAmazonSolicitation(
  amazonOrderId: string,
  marketplaceCode: string,
): Promise<{ ok: boolean; providerRequestId?: string; errorCode?: string }> {
  if (process.env.NEXUS_ENABLE_AMAZON_SOLICITATIONS !== 'true') {
    logger.info('[review-mailer] Amazon solicitation dry-run', { amazonOrderId })
    return { ok: false, errorCode: 'DRY_RUN' }
  }
  const marketplaceIdMap: Record<string, string> = {
    IT: 'APJ6JRA9NG5V4', DE: 'A1PA6795UKMFR9', FR: 'A13V1IB3VIYZZH', ES: 'A1RKKUPIHCS9HS',
    UK: 'A1F83G8C2ARO7P', GB: 'A1F83G8C2ARO7P', US: 'ATVPDKIKX0DER',
    NL: 'A1805IZSGTT6HS', PL: 'A1C3SOZRARQ6R3', SE: 'A2NODRKZP88ZB9',
  }
  const marketplaceId = marketplaceIdMap[marketplaceCode.toUpperCase()] ?? null
  if (!marketplaceId) return { ok: false, errorCode: 'UNKNOWN_MARKETPLACE' }
  try {
    const { amazonSpApiClient } = await import('../clients/amazon-sp-api.client.js')
    await amazonSpApiClient.request(
      'POST',
      `/solicitations/v1/orders/${encodeURIComponent(amazonOrderId)}/solicitations/productReviewAndSellerFeedback`,
      { query: { marketplaceIds: marketplaceId }, label: 'reviewMailer:solicitation' },
    )
    return { ok: true }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, errorCode: msg.slice(0, 100) }
  }
}

interface MailerTickResult {
  scheduled: number
  due: number
  sent: number
  failed: number
  skipped: number
  durationMs: number
}

export async function runReviewMailerOnce(): Promise<MailerTickResult> {
  const startedAt = Date.now()

  // Step 1: schedule newly delivered orders
  const scheduleResult = await schedulePendingOrders()

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
        const result = await fireAmazonSolicitation(
          order.channelOrderId,
          order.marketplace ?? 'IT',
        )
        if (result.ok) {
          await prisma.reviewRequest.update({
            where: { id: req.id },
            data: { status: 'SENT', sentAt: new Date(), providerRequestId: result.providerRequestId ?? null },
          })
          sent += 1
        } else {
          if (result.errorCode === 'DRY_RUN') {
            // Leave as SCHEDULED in dry-run — don't mark FAILED
            skipped += 1
          } else {
            await prisma.reviewRequest.update({
              where: { id: req.id },
              data: { status: 'FAILED', providerResponseCode: result.errorCode, errorMessage: result.errorCode },
            })
            failed += 1
          }
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
            data: { status: 'SENT', sentAt: new Date() },
          })
          sent += 1
        } else if (result.dryRun) {
          skipped += 1 // stay SCHEDULED in dry-run
        } else {
          await prisma.reviewRequest.update({
            where: { id: req.id },
            data: { status: 'FAILED', errorMessage: result.error ?? 'email_send_failed' },
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
  lastSummary = `scheduled=${scheduleResult.scheduled} due=${due.length} sent=${sent} failed=${failed} skipped=${skipped} durationMs=${durationMs}`
  return { scheduled: scheduleResult.scheduled, due: due.length, sent, failed, skipped, durationMs }
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
