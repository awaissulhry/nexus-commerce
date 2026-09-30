import prisma from '../db.js'
import { runProfileTimer } from '../lib/cron/workspace-timer.js'
import { logger } from '../utils/logger.js'
import { getShopifyPublishMode } from '../services/shopify-publish-gate.service.js'
import { syncColourProducts } from '../services/shopify/colour-products/sync.service.js'
import { claimColourSync, ensureColourSync, finishColourSync, inColourSync } from '../services/shopify/colour-products/sync-work.js'

/** The five-minute backstop sees every confirmed store and alias, even if the family has no manual link settings. */
export async function queueColourChecks() {
  const rows = await prisma.shopifyColourProduct.findMany({ where: { state: 'LINKED', shopifyProductId: { not: null },
    channelConnection: { isActive: true, connectionMetadata: { path: ['shopifyColourProducts', 'enabled'], equals: true } } },
    distinct: ['familyId', 'channelConnectionId', 'marketplace', 'aliasKey'],
    select: { familyId: true, channelConnectionId: true, marketplace: true, aliasKey: true } })
  for (const row of rows) {
    const work = await ensureColourSync({ ...row, accountId: row.channelConnectionId })
    // A pending run already reads the current store; a sweep must not keep moving its debounce deadline.
    await prisma.shopifyColourSync.updateMany({ where: { id: work.id, dueAt: null }, data: { dueAt: new Date(), revision: { increment: 1 } } })
  }
  return rows.length
}

/** Test this handler directly. Starting the whole worker also starts unrelated queue consumers. */
export async function processColourSyncs(limit = 25) {
  if (getShopifyPublishMode() !== 'live') return { claimed: 0, done: 0, failed: 0 }
  const now = new Date(), result = { claimed: 0, done: 0, failed: 0 }
  const rows = await prisma.shopifyColourSync.findMany({ where: { dueAt: { lte: now }, OR: [{ leaseToken: null }, { leaseUntil: { lt: now } }] },
    orderBy: [{ dueAt: 'asc' }, { id: 'asc' }], take: limit, select: { id: true } })
  for (const row of rows) {
    const claim = await claimColourSync(row.id, true)
    if (!claim) continue
    result.claimed++
    try {
      await inColourSync(claim, () => syncColourProducts(claim.familyId, { accountId: claim.channelConnectionId, market: claim.marketplace, aliasKey: claim.aliasKey }))
      await finishColourSync(claim, true)
      result.done++
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await finishColourSync(claim, false, message)
      logger.warn('Shopify colour sync remains pending', { familyId: claim.familyId, accountId: claim.channelConnectionId, aliasKey: claim.aliasKey, error: message })
      result.failed++
    }
  }
  return result
}

/** Same durable-work pattern as stock-pool tasks: fast while busy, slower when quiet, with workspace timer leases. */
export function startShopifyColourSyncWorker() {
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, running: Promise<void> | undefined
  const tick = () => {
    let busy = false
    running = runProfileTimer('shopify-colour-sync', async () => { busy = (await processColourSyncs()).claimed > 0 || busy }, 2_000)
      .catch(error => logger.error('Shopify colour sync poll failed', { error: String(error) }))
      .then(() => { if (!stopped) { timer = setTimeout(tick, busy ? 2_000 : 10_000); timer.unref?.() } })
  }
  timer = setTimeout(tick, 2_000); timer.unref?.()
  return async () => { stopped = true; if (timer) clearTimeout(timer); await running }
}
