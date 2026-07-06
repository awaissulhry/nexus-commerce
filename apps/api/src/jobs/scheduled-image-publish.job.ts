/**
 * PB.10 — Scheduled image publish cron.
 *
 * Picks PENDING ScheduledImagePublish rows where scheduledFor <= now
 * and fires the matching channel publish endpoint inline (we call
 * the publish services directly to avoid extra HTTP overhead). Mirrors
 * the scheduled-wizard-publish.job.ts pattern.
 *
 * Tick cadence: every 60s. Default-OFF behind
 * NEXUS_ENABLE_SCHEDULED_IMAGE_PUBLISH=1 — scheduled publishes hit
 * real channel adapters, so a misconfigured cron in dev would
 * republish real listings. Operator opts in deliberately.
 *
 * Per-row failure: caught, recorded on the row (status='FAILED',
 * fireError); cron continues through other rows.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { submitAmazonImageFeed } from '../services/images/amazon-image-feed.service.js'
// FFP.7 — the Trading-API path (publishEbayImages) is a permanent no-op for
// Inventory-listed products (ebayItemId is null); use the real Inventory push.
import { publishEbayImagesViaInventory } from '../services/images/ebay-inventory-image-publish.service.js'
import { publishShopifyImages } from '../services/images/shopify-image-publish.service.js'

const TICK_INTERVAL_MS = 60 * 1000
const FIRE_RESULT_MAX_BYTES = 4 * 1024

let cronTimer: NodeJS.Timeout | null = null

const AMAZON_MARKETS = ['IT', 'DE', 'FR', 'ES', 'UK'] as const

export async function runScheduledImagePublishOnce(): Promise<string> {
  const now = new Date()
  const due = await prisma.scheduledImagePublish.findMany({
    where: { status: 'PENDING', scheduledFor: { lte: now } },
    orderBy: [{ scheduledFor: 'asc' }],
    take: 25,
  })

  if (due.length === 0) return 'no PENDING schedules due'

  let fired = 0
  let failed = 0
  for (const row of due) {
    const result = await fireOneSchedule(row.id)
    if (result === 'fired') fired += 1
    else if (result === 'failed') failed += 1
  }

  return `due=${due.length} fired=${fired} failed=${failed}`
}

async function fireOneSchedule(scheduleId: string): Promise<'fired' | 'failed'> {
  try {
    const schedule = await prisma.scheduledImagePublish.findUnique({
      where: { id: scheduleId },
    })
    if (!schedule || schedule.status !== 'PENDING') return 'fired'

    const channel = schedule.channel
    const marketplace = schedule.marketplace
    const productId = schedule.productId

    let result: unknown

    if (channel === 'AMAZON') {
      // Amazon: walk marketplace list. 'ALL' loops all 5; specific
      // market fires just that one.
      const markets = marketplace === 'ALL' || !marketplace
        ? AMAZON_MARKETS
        : [marketplace as typeof AMAZON_MARKETS[number]]
      const perMarket: Array<{ marketplace: string; ok: boolean; jobId?: string; error?: string }> = []
      for (const m of markets) {
        try {
          const out = await submitAmazonImageFeed({
            productId,
            marketplace: m,
          })
          perMarket.push({ marketplace: m, ok: true, jobId: out.jobId })
        } catch (err) {
          perMarket.push({
            marketplace: m,
            ok: false,
            error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
          })
        }
      }
      result = { channel, perMarket }
    } else if (channel === 'EBAY') {
      const out = await publishEbayImagesViaInventory(productId)
      result = { channel, ...out }
    } else if (channel === 'SHOPIFY') {
      const out = await publishShopifyImages(productId)
      result = { channel, ...out }
    } else {
      await markFailed(scheduleId, `Unknown channel: ${channel}`)
      return 'failed'
    }

    const json = JSON.stringify(result)
    const trimmed =
      json.length > FIRE_RESULT_MAX_BYTES
        ? { channel, truncated: true }
        : result

    await prisma.scheduledImagePublish.update({
      where: { id: scheduleId },
      data: {
        status: 'FIRED',
        firedAt: new Date(),
        fireResult: trimmed as object,
      },
    })

    return 'fired'
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message.slice(0, 500)
        : String(err).slice(0, 500)
    await markFailed(scheduleId, message)
    return 'failed'
  }
}

async function markFailed(scheduleId: string, message: string): Promise<void> {
  try {
    await prisma.scheduledImagePublish.update({
      where: { id: scheduleId },
      data: {
        status: 'FAILED',
        firedAt: new Date(),
        fireError: message,
      },
    })
  } catch {
    // Best-effort; cron carries on.
  }
}

export function startScheduledImagePublishCron(): void {
  if (cronTimer) return
  if (process.env.NEXUS_ENABLE_SCHEDULED_IMAGE_PUBLISH !== '1') {
    logger.info(
      'scheduled-image-publish: disabled (set NEXUS_ENABLE_SCHEDULED_IMAGE_PUBLISH=1 to enable)',
    )
    return
  }
  cronTimer = setInterval(() => {
    void (async () => {
      try {
        const summary = await runScheduledImagePublishOnce()
        if (summary !== 'no PENDING schedules due') {
          logger.info(`scheduled-image-publish: tick — ${summary}`)
        }
      } catch (err) {
        logger.warn(
          'scheduled-image-publish: tick failed',
          { err: err instanceof Error ? err.message : String(err) },
        )
      }
    })()
  }, TICK_INTERVAL_MS)
  logger.info(`scheduled-image-publish: cron started (interval ${TICK_INTERVAL_MS}ms)`)
}

export function stopScheduledImagePublishCron(): void {
  if (cronTimer) {
    clearInterval(cronTimer)
    cronTimer = null
  }
}
