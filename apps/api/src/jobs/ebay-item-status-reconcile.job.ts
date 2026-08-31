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

import cron from '../lib/cron/clustered.js'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { ebayAuthService } from '../services/ebay-auth.service.js'
import { getItemListingStatus } from '../services/ebay-trading-api.service.js'
import { listActiveConnections } from '../services/connection-resolver.service.js'

const JOB_NAME = 'ebay-item-status-reconcile'
const ENDED_STATUSES = new Set(['Completed', 'Ended'])
const CALL_SPACING_MS = 300

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function runEbayItemStatusReconcile(): Promise<string> {
  // MAP.3 — one pass PER ACCOUNT. SharedListingMembership carries
  // channelConnectionId (MAP.2a backfilled all 712 rows), so each account's items
  // are selected by attribution rather than by "whatever findFirst returned". The
  // per-account cap is applied per account, so a second store cannot starve the
  // first of its budget. One account's failure never aborts the others.
  const connections = await listActiveConnections('EBAY')
  if (connections.length === 0) return 'no active eBay connection'

  const max = Number(process.env.NEXUS_EBAY_ITEM_RECONCILE_MAX ?? 100)
  let checked = 0
  let ended = 0
  let errors = 0
  let items: Array<{ itemId: string; marketplace: string }> = []
  let totalGroups = 0

  for (const connection of connections) {
    let token: string
    try {
      token = await ebayAuthService.getValidToken(connection.id)
    } catch (err) {
      errors++
      logger.warn(`[${JOB_NAME}] token failed for account — skipped, other accounts continue`, {
        connectionId: connection.id,
        error: err instanceof Error ? err.message : String(err),
      })
      continue
    }

    const groups = await prisma.sharedListingMembership.groupBy({
      by: ['itemId', 'marketplace'],
      where: { status: 'ACTIVE', channelConnectionId: connection.id },
    })
    totalGroups += groups.length
    const forAccount = groups.slice(0, max)
    items = items.concat(forAccount)

    for (const g of forAccount) {
    try {
      const status = await getItemListingStatus(g.itemId, { oauthToken: token, market: g.marketplace })
      checked++
      if (status && ENDED_STATUSES.has(status)) {
        const res = await prisma.sharedListingMembership.updateMany({
          // Scoped to the account whose token reported the status. eBay ItemIDs are
          // globally unique so this is not strictly required today, but a write
          // that names its account cannot later be widened by accident.
          where: {
            marketplace: g.marketplace,
            itemId: g.itemId,
            status: 'ACTIVE',
            channelConnectionId: connection.id,
          },
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
  }
  const summary = `accounts=${connections.length} items=${items.length} checked=${checked} membershipsEnded=${ended} errors=${errors}${totalGroups > items.length ? ` (capped from ${totalGroups})` : ''}`
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
