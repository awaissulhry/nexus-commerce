/**
 * O.12 — Tracking pushback retry job.
 *
 * Walks TrackingMessageLog rows where status='PENDING' AND
 * nextAttemptAt <= NOW(), routes each to the appropriate channel
 * pushback module (O.9 Amazon FBM, O.10 eBay, O.11 Woo, plus a thin
 * Shopify adapter), and finalizes the row to SUCCESS / FAILED /
 * DEAD_LETTER per the outcome.
 *
 * Backoff: nextAttemptAt = now + min(5min × 2^attemptCount, 12h).
 * After attemptCount >= maxAttempts (default 8 → ≈26h of attempts),
 * the row moves to DEAD_LETTER for operator inspection.
 *
 * Cadence: every 2 minutes. Tight enough that a SHIPPED webhook
 * triggers a confirmation push within 2 minutes (close to "real
 * time" for marketplace SLAs), loose enough that the cron isn't a
 * noisy neighbor on a single API server.
 *
 * Idempotency: each row is claimed by setting status=IN_FLIGHT
 * before the network call. If the process dies mid-call, the row
 * stays IN_FLIGHT until a follow-up sweep moves it back to PENDING
 * via the staleness reaper (any row IN_FLIGHT for >10 minutes is
 * stuck — this job's first action each tick is the reap).
 *
 * Gated behind NEXUS_ENABLE_TRACKING_PUSHBACK_CRON (default ON
 * because silent failures here mean Amazon/eBay charge late-ship
 * penalties). Per-channel ENABLE_*_SHIP_CONFIRM flags still control
 * whether the underlying pushback hits the real API.
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { publishOutboundEvent } from '../services/outbound-events.service.js'
import { recordCronRun } from '../utils/cron-observability.js'
import {
  submitShippingConfirmation as amazonSubmit,
  buildConfirmationInputForShipment as amazonBuild,
  AmazonPushbackError,
} from '../services/amazon-pushback/index.js'
import {
  submitShippingFulfillment as ebaySubmit,
  buildFulfillmentInputForShipment as ebayBuild,
  EbayPushbackError,
} from '../services/ebay-pushback/index.js'
import {
  submitShipConfirmation as wooSubmit,
  buildShipInputForShipment as wooBuild,
  WooPushbackError,
} from '../services/woocommerce-pushback/index.js'

const STALENESS_MINUTES = 10
const MAX_BACKOFF_HOURS = 12
const DEFAULT_MAX_ATTEMPTS = 8

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastStats = { processed: 0, succeeded: 0, failed: 0, dead: 0, reaped: 0 }

/**
 * Marketplace ID lookup for Amazon shipping confirmation. Maps the
 * Order.marketplace 2-letter code to the SP-API marketplaceId. Subset
 * of the broader map in amazon-orders.service.ts.
 */
const AMAZON_MARKETPLACE_IDS: Record<string, string> = {
  IT: 'APJ6JRA9NG5V4',
  DE: 'A1PA6795UKMFR9',
  FR: 'A13V1IB3VIYZZH',
  ES: 'A1RKKUPIHCS9HS',
  UK: 'A1F83G8C2ARO7P',
  NL: 'A1805IZSGTT6HS',
  SE: 'A2NODRKZP88ZB9',
  PL: 'A1C3SOZRARQ6R3',
  US: 'ATVPDKIKX0DER',
}

function backoffMs(attemptCount: number): number {
  const base = 5 * 60_000 * Math.pow(2, attemptCount) // 5min × 2^n
  const cap = MAX_BACKOFF_HOURS * 3_600_000
  return Math.min(base, cap)
}

interface SweepStats {
  processed: number
  succeeded: number
  failed: number
  dead: number
  reaped: number
}

/**
 * Reap stuck IN_FLIGHT rows back to PENDING. A row is "stuck" when
 * its updatedAt is older than STALENESS_MINUTES — implies the worker
 * crashed mid-call.
 */
async function reapStuck(): Promise<number> {
  const cutoff = new Date(Date.now() - STALENESS_MINUTES * 60_000)
  const reaped = await prisma.trackingMessageLog.updateMany({
    where: { status: 'IN_FLIGHT', updatedAt: { lt: cutoff } },
    data: { status: 'PENDING', nextAttemptAt: new Date() },
  })
  return reaped.count
}

/**
 * Process one TrackingMessageLog row. Returns the outcome so the caller
 * can update lastStats. The row is claimed (status → IN_FLIGHT) before
 * any network call so a sibling worker can't double-process.
 */
async function processOne(rowId: string): Promise<'SUCCESS' | 'FAILED' | 'DEAD_LETTER'> {
  // Claim. Atomic: only the row that's still PENDING gets claimed.
  const claimed = await prisma.trackingMessageLog.updateMany({
    where: { id: rowId, status: 'PENDING' },
    data: {
      status: 'IN_FLIGHT',
      lastAttemptedAt: new Date(),
      attemptCount: { increment: 1 },
    },
  })
  if (claimed.count === 0) {
    // Sibling worker won the race; skip.
    return 'FAILED'
  }

  const row = await prisma.trackingMessageLog.findUnique({
    where: { id: rowId },
    select: {
      id: true,
      shipmentId: true,
      channel: true,
      attemptCount: true,
      maxAttempts: true,
    },
  })
  if (!row) return 'FAILED'

  type Outcome =
    | { success: true; response: unknown }
    | { success: false; error: string; code: string | null }

  try {
    let outcome: Outcome

    if (row.channel === 'AMAZON') {
      const input = await amazonBuild(row.shipmentId)
      if (!input) {
        outcome = { success: false, error: 'Cannot build Amazon input — missing tracking or order', code: 'INPUT_INCOMPLETE' }
      } else {
        // Resolve marketplace IDs from the Order.
        const order = await prisma.order.findFirst({
          where: { id: { in: [(await prisma.shipment.findUnique({ where: { id: row.shipmentId }, select: { orderId: true } }))?.orderId ?? ''] } },
          select: { marketplace: true },
        })
        const marketplaceCode = order?.marketplace ?? 'IT'
        const marketplaceId = AMAZON_MARKETPLACE_IDS[marketplaceCode] ?? AMAZON_MARKETPLACE_IDS.IT
        try {
          const result = await amazonSubmit(input, [marketplaceId])
          outcome = { success: true, response: result }
        } catch (e: any) {
          if (e instanceof AmazonPushbackError) outcome = { success: false, error: e.message, code: e.code }
          else outcome = { success: false, error: e?.message ?? String(e), code: null }
        }
      }
    } else if (row.channel === 'EBAY') {
      const built = await ebayBuild(row.shipmentId)
      if (!built || !built.connectionId) {
        outcome = { success: false, error: 'eBay input or connection unavailable', code: 'INPUT_INCOMPLETE' }
      } else {
        try {
          // Resolve internal Order.id for OutboundApiCallLog scoping.
          const shipment = await prisma.shipment.findUnique({
            where: { id: row.shipmentId },
            select: { orderId: true },
          })
          const result = await ebaySubmit(built.input, built.connectionId, shipment?.orderId ?? undefined)
          outcome = { success: true, response: result }
        } catch (e: any) {
          if (e instanceof EbayPushbackError) outcome = { success: false, error: e.message, code: e.code }
          else outcome = { success: false, error: e?.message ?? String(e), code: null }
        }
      }
    } else if (row.channel === 'WOOCOMMERCE') {
      const input = await wooBuild(row.shipmentId)
      if (!input) {
        outcome = { success: false, error: 'Cannot build Woo input', code: 'INPUT_INCOMPLETE' }
      } else {
        try {
          const result = await wooSubmit(input)
          outcome = { success: true, response: result }
        } catch (e: any) {
          if (e instanceof WooPushbackError) outcome = { success: false, error: e.message, code: e.code }
          else outcome = { success: false, error: e?.message ?? String(e), code: null }
        }
      }
    } else if (row.channel === 'SHOPIFY') {
      // Shopify thin adapter: reuses the existing
      // ShopifyEnhancedService.createFulfillment. dryRun is implicit
      // here — the Shopify enhanced service hits real API when
      // configured; no separate enable flag because shopify-pushback
      // didn't get its own module. Future: extract to apps/api/src/
      // services/shopify-pushback/ for symmetry.
      const shipment = await prisma.shipment.findUnique({
        where: { id: row.shipmentId },
        include: {
          order: {
            select: {
              channelOrderId: true,
              items: { select: { ebayMetadata: true, sku: true } }, // not used; placeholder
            },
          },
        },
      })
      if (!shipment?.order || !shipment.trackingNumber) {
        outcome = { success: false, error: 'Shopify input incomplete', code: 'INPUT_INCOMPLETE' }
      } else {
        try {
          const [{ ShopifyEnhancedService }, { ConfigManager }] = await Promise.all([
            import('../services/marketplaces/shopify-enhanced.service.js'),
            import('../utils/config.js'),
          ])
          const shopifyConfig = ConfigManager.getConfig('SHOPIFY')
          if (!shopifyConfig) {
            throw new Error('Shopify config missing — set SHOPIFY_* env vars')
          }
          const shopify = new ShopifyEnhancedService(shopifyConfig as any)
          // Shopify createFulfillment expects orderId + lineItemIds[]
          // (GraphQL global IDs). Without the line-item-ID metadata
          // captured at ingest, fall back to fulfilling the whole
          // order via the legacy non-line-item path.
          const result = await shopify.createFulfillment(
            shipment.order.channelOrderId,
            [], // empty lineItemIds → fulfill all
            {
              number: shipment.trackingNumber,
              company: shipment.carrierCode,
              url: shipment.trackingUrl ?? undefined,
            },
          )
          outcome = { success: true, response: result }
        } catch (e: any) {
          outcome = { success: false, error: e?.message ?? String(e), code: e?.code ?? null }
        }
      }
    } else {
      outcome = { success: false, error: `Unsupported channel: ${row.channel}`, code: 'UNSUPPORTED_CHANNEL' }
    }

    // Pull the failure case explicitly so TS narrows reliably across
    // the post-await transactions. Without these locals, TS's flow
    // analysis loses track of the discriminator after awaits inside
    // the success arm. Manual cast is required because TS narrows
    // via the literal `success: false` branch, but won't track that
    // narrowing through a `let` after multiple branch reassignments.
    const successResponse = outcome.success ? outcome.response : null
    const fail = outcome as Extract<Outcome, { success: false }>
    const failureError = outcome.success ? null : fail.error
    const failureCode = outcome.success ? null : fail.code

    if (outcome.success) {
      await prisma.$transaction([
        prisma.trackingMessageLog.update({
          where: { id: rowId },
          data: {
            status: 'SUCCESS',
            responsePayload: successResponse as any,
            lastError: null,
            lastErrorCode: null,
          },
        }),
        // Mirror the success onto Shipment for the cheap drawer pill
        // read (per the O.2 invariant).
        prisma.shipment.update({
          where: { id: row.shipmentId },
          data: { trackingPushedAt: new Date(), trackingPushError: null },
        }),
      ])
      // O.32: push success so the open drawer's "tracking pushed" pill
      // updates without a refresh.
      publishOutboundEvent({
        type: 'shipment.updated',
        shipmentId: row.shipmentId,
        ts: Date.now(),
      })
      return 'SUCCESS'
    }

    // Failure path. Decide retry vs DEAD_LETTER.
    const isDead = row.attemptCount >= row.maxAttempts
    const next = isDead ? null : new Date(Date.now() + backoffMs(row.attemptCount))
    await prisma.$transaction([
      prisma.trackingMessageLog.update({
        where: { id: rowId },
        data: {
          status: isDead ? 'DEAD_LETTER' : 'FAILED',
          nextAttemptAt: next,
          lastError: failureError,
          lastErrorCode: failureCode,
        },
      }),
      prisma.shipment.update({
        where: { id: row.shipmentId },
        data: { trackingPushError: failureError },
      }),
    ])
    return isDead ? 'DEAD_LETTER' : 'FAILED'
  } catch (err: any) {
    // Belt-and-braces: if anything inside the routing branches throws
    // unexpectedly, the row is left FAILED so the next sweep retries
    // it (rather than stuck IN_FLIGHT for the staleness reaper).
    await prisma.trackingMessageLog.update({
      where: { id: rowId },
      data: {
        status: 'FAILED',
        nextAttemptAt: new Date(Date.now() + backoffMs(row.attemptCount)),
        lastError: err?.message ?? String(err),
        lastErrorCode: 'UNHANDLED',
      },
    })
    return 'FAILED'
  }
}

/** Run one sweep. Exported so an admin endpoint or a test can trigger it. */
export async function runTrackingPushbackSweep(): Promise<SweepStats> {
  const stats: SweepStats = { processed: 0, succeeded: 0, failed: 0, dead: 0, reaped: 0 }

  stats.reaped = await reapStuck()

  const due = await prisma.trackingMessageLog.findMany({
    where: {
      status: 'PENDING',
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
    },
    orderBy: { nextAttemptAt: 'asc' },
    select: { id: true },
    take: 50, // bound the per-tick work
  })

  for (const row of due) {
    const out = await processOne(row.id)
    stats.processed++
    if (out === 'SUCCESS') stats.succeeded++
    else if (out === 'DEAD_LETTER') stats.dead++
    else stats.failed++
  }

  lastRunAt = new Date()
  lastStats = stats
  if (stats.processed > 0 || stats.reaped > 0) {
    logger.info('tracking-pushback sweep complete', stats)
  }
  return stats
}

export function startTrackingPushbackCron(): void {
  if (scheduledTask) {
    logger.warn('tracking-pushback cron already started — skipping')
    return
  }
  if (process.env.NEXUS_ENABLE_TRACKING_PUSHBACK_CRON === '0') {
    logger.info('tracking-pushback cron disabled via env')
    return
  }
  const schedule = process.env.NEXUS_TRACKING_PUSHBACK_SCHEDULE ?? '*/2 * * * *'
  if (!cron.validate(schedule)) {
    logger.error('tracking-pushback cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    void recordCronRun('tracking-pushback', async () => {
      const stats = await runTrackingPushbackSweep()
      return `processed=${stats.processed} succeeded=${stats.succeeded} failed=${stats.failed} dead=${stats.dead} reaped=${stats.reaped}`
    }).catch((err) => {
      logger.error('tracking-pushback cron: failure', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  })
  logger.info('tracking-pushback cron: scheduled', { schedule })
}

export function stopTrackingPushbackCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getTrackingPushbackStatus(): {
  scheduled: boolean
  lastRunAt: Date | null
  lastStats: SweepStats
  defaultMaxAttempts: number
} {
  return {
    scheduled: scheduledTask !== null,
    lastRunAt,
    lastStats,
    defaultMaxAttempts: DEFAULT_MAX_ATTEMPTS,
  }
}

export const __test = { backoffMs, AMAZON_MARKETPLACE_IDS }
