/**
 * RT.4 — ItemID-based eBay listing-lifecycle reconcile (Trading lane).
 *
 * The dispatch-time auto-heal (RT.0) ends memberships the moment a push hits
 * an ended listing — but a listing that ends while its pool never changes
 * would keep stale ACTIVE memberships forever. This daily job asks eBay
 * directly: Trading GetItem → SellingStatus.ListingStatus per distinct
 * membership ItemID; 'Completed'/'Ended' marks that item's memberships ENDED.
 *
 * Deliberately NOT the offer-based reconcile (`ebay-status-reconcile`, OFF):
 * Trading-lane listings have no Inventory-API offers, so the offer probe
 * would wrongly flag them REMOVED. This job speaks the lane's own dialect.
 *
 * Fail-closed: only the literal statuses end memberships; GetItem errors
 * (invalid/deleted item ids, code 17) are counted + logged, never acted on.
 * callTradingApi refuses fake-success without NEXUS_EBAY_REAL_API in prod.
 *
 * Gate: default ON; opt out NEXUS_EBAY_ITEM_RECONCILE=0.
 * Schedule: 02:30 UTC daily; override NEXUS_EBAY_ITEM_RECONCILE_SCHEDULE.
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { ebayAuthService } from '../services/ebay-auth.service.js'
import { getItemListingStatus } from '../services/ebay-trading-api.service.js'

const JOB_NAME = 'ebay-item-status-reconcile'
const ENDED_STATUSES = new Set(['Completed', 'Ended'])
const CALL_SPACING_MS = 300

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function runEbayItemStatusReconcile(): Promise<string> {
  const connection = await prisma.channelConnection.findFirst({
    where: { channelType: 'EBAY', isActive: true },
    select: { id: true },
  })
  if (!connection) return 'no active eBay connection'
  const token = await ebayAuthService.getValidToken(connection.id)

  const max = Number(process.env.NEXUS_EBAY_ITEM_RECONCILE_MAX ?? 100)
  const groups = await prisma.sharedListingMembership.groupBy({
    by: ['itemId', 'marketplace'],
    where: { status: 'ACTIVE' },
  })
  const items = groups.slice(0, max)

  let checked = 0
  let ended = 0
  let errors = 0
  for (const g of items) {
    try {
      const status = await getItemListingStatus(g.itemId, { oauthToken: token, market: g.marketplace })
      checked++
      if (status && ENDED_STATUSES.has(status)) {
        const res = await prisma.sharedListingMembership.updateMany({
          where: { marketplace: g.marketplace, itemId: g.itemId, status: 'ACTIVE' },
          data: {
            status: 'ENDED',
            lastError: `reconcile: eBay ListingStatus=${status} (${new Date().toISOString().slice(0, 10)})`,
          },
        })
        ended += res.count
        logger.warn(`[${JOB_NAME}] item ended on eBay — memberships marked ENDED`, {
          itemId: g.itemId, marketplace: g.marketplace, listingStatus: status, memberships: res.count,
        })
      }
    } catch (err) {
      errors++
      logger.warn(`[${JOB_NAME}] GetItem failed — skipped (fail-closed)`, {
        itemId: g.itemId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    await new Promise((r) => setTimeout(r, CALL_SPACING_MS))
  }
  const summary = `items=${items.length} checked=${checked} membershipsEnded=${ended} errors=${errors}${groups.length > max ? ` (capped from ${groups.length})` : ''}`
  logger.info(`[${JOB_NAME}] ${summary}`)
  return summary
}

export function startEbayItemStatusReconcileCron(): void {
  if (process.env.NEXUS_EBAY_ITEM_RECONCILE === '0') {
    logger.info(`${JOB_NAME}: disabled via NEXUS_EBAY_ITEM_RECONCILE=0`)
    return
  }
  if (scheduledTask) return
  const schedule = process.env.NEXUS_EBAY_ITEM_RECONCILE_SCHEDULE ?? '30 2 * * *'
  if (!cron.validate(schedule)) {
    logger.error(`${JOB_NAME}: invalid schedule`, { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    void recordCronRun(JOB_NAME, runEbayItemStatusReconcile).catch((err) =>
      logger.error(`${JOB_NAME} run failed`, {
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  })
  logger.info(`${JOB_NAME} cron: scheduled`, { schedule })
}

export function stopEbayItemStatusReconcileCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}
