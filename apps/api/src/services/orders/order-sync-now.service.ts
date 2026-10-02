/**
 * MCP full control 07 O17 — "sync orders now" for one channel of the caller's business: what the order crons do on
 * their schedule (Amazon every 15 minutes, eBay per connection), run at once. At most once per channel every 10
 * minutes per business: the run is claimed with an AuditLog row ('sync-orders-now', the channel) before anything is
 * read, so a second ask within the window is refused with when it may run again.
 *
 *   - AMAZON: the order cursor of amazon-orders-sync.job (new and changed orders since the latest purchase date on the
 *     active marketplaces; the first time, 30 days back).
 *   - EBAY: every active eBay connection of the business, as ebay-orders-sync.job does.
 *
 * Both read the channel through its client and the gateway; new orders take their stock as on the schedule.
 */

import prisma from '../../db.js'
import { isOwnConnection, listActiveConnections } from '../connection-resolver.service.js'

/** This business's own active accounts of a channel (shared ones excluded). */
export async function ownActiveAccounts(channel: SyncNowChannel) {
  return (await listActiveConnections(channel)).filter(isOwnConnection)
}

export const SYNC_NOW_CHANNELS = ['EBAY', 'AMAZON'] as const
export type SyncNowChannel = (typeof SYNC_NOW_CHANNELS)[number]
export const SYNC_NOW_INTERVAL_MS = 10 * 60_000
const ENTITY = 'OrderSyncNow'

/** When this business last ran a sync-now of the channel, and when it may run again. */
export async function syncNowWindow(channel: SyncNowChannel): Promise<{ lastRunAt: Date | null; nextAllowedAt: Date | null }> {
  const last = await prisma.auditLog.findFirst({
    where: { entityType: ENTITY, entityId: channel, action: 'sync-orders-now' },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  })
  if (!last) return { lastRunAt: null, nextAllowedAt: null }
  const next = new Date(last.createdAt.getTime() + SYNC_NOW_INTERVAL_MS)
  return { lastRunAt: last.createdAt, nextAllowedAt: next > new Date() ? next : null }
}

export type SyncNowResult =
  | { ok: true; channel: SyncNowChannel; accounts: number; ordersFetched: number; ordersCreatedOrUpdated: number; failures: number; errors: string[] }
  | { ok: false; error: string }

const tooSoon = (channel: string, lastRunAt: Date, nextAllowedAt: Date) =>
  `${channel} orders were synced at ${lastRunAt.toISOString().slice(11, 16)} UTC; the next sync now is allowed from ${nextAllowedAt.toISOString().slice(11, 16)} UTC (once every 10 minutes). Nothing was read.`

/** `accountId` (eBay): sync only that connected account; omitted, every active account of the channel. */
export async function syncOrdersNow(channel: SyncNowChannel, who: { userId: string | null; via: string }, accountId?: string): Promise<SyncNowResult> {
  const window = await syncNowWindow(channel)
  if (window.nextAllowedAt) return { ok: false, error: tooSoon(channel, window.lastRunAt!, window.nextAllowedAt) }

  if (channel === 'AMAZON') {
    const { amazonOrdersService, getActiveMarketplaceIdsFromDb } = await import('../amazon-orders.service.js')
    if (!(await amazonOrdersService.isConfigured())) return { ok: false, error: 'Amazon is not connected in this business. Nothing was read.' }
    const claimed = await claim(channel, who)
    if (claimed) return { ok: false, error: claimed }
    const marketplaceIds = await getActiveMarketplaceIdsFromDb()
    const latest = await amazonOrdersService.getLatestPurchaseDate()
    const summary = latest
      ? await amazonOrdersService.syncNewOrders(latest, { marketplaceIds })
      : await amazonOrdersService.syncAllOrders({ daysBack: 30, marketplaceIds })
    return {
      ok: true, channel, accounts: 1, ordersFetched: summary.ordersFetched, ordersCreatedOrUpdated: summary.ordersUpserted,
      failures: summary.ordersFailed + summary.itemsFailed, errors: [],
    }
  }

  // The business's OWN active eBay accounts (an account another business shares is that business's to sync), through
  // the connection resolver (MAP.3: no ambient account lookups).
  const connections = (await ownActiveAccounts('EBAY')).filter((row) => !accountId || row.id === accountId)
  if (connections.length === 0) return { ok: false, error: 'No active eBay account is connected in this business. Nothing was read.' }
  const claimed = await claim(channel, who)
  if (claimed) return { ok: false, error: claimed }
  const { ebayOrdersService } = await import('../ebay-orders.service.js')
  let ordersFetched = 0
  let changed = 0
  let failures = 0
  const errors: string[] = []
  for (const connection of connections) {
    try {
      const result = await ebayOrdersService.syncEbayOrders(connection.id)
      ordersFetched += result.ordersFetched
      changed += result.ordersCreated + result.ordersUpdated
      if (result.status !== 'SUCCESS') {
        failures += 1
        if (result.errors[0]) errors.push(result.errors[0].error.slice(0, 200))
      }
    } catch (error) {
      failures += 1
      errors.push((error instanceof Error ? error.message : String(error)).slice(0, 200))
    }
  }
  return { ok: true, channel, accounts: connections.length, ordersFetched, ordersCreatedOrUpdated: changed, failures, errors }
}

/**
 * The run's claim, written before anything is read so the 10-minute window holds even if the sync fails. Two asks at the
 * same moment take turns on a transaction lock, so the second sees the first's claim. Null when claimed; else why not.
 */
async function claim(channel: SyncNowChannel, who: { userId: string | null; via: string }): Promise<string | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`sync-orders-now:${channel}`}))::text AS locked`
    const last = await tx.auditLog.findFirst({ where: { entityType: ENTITY, entityId: channel, action: 'sync-orders-now' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } })
    if (last && Date.now() - last.createdAt.getTime() < SYNC_NOW_INTERVAL_MS) return tooSoon(channel, last.createdAt, new Date(last.createdAt.getTime() + SYNC_NOW_INTERVAL_MS))
    await tx.auditLog.create({ data: { userId: who.userId, entityType: ENTITY, entityId: channel, action: 'sync-orders-now', metadata: { via: who.via } } })
    return null
  })
}
