/**
 * Channel vs Nexus reconciliation report.
 *
 * Queries Amazon SP-API for "what the channel says is true" + queries
 * our DB for "what Nexus thinks is true" + reports drift per metric.
 *
 * Today: Amazon-only (Orders + Inventory). eBay + Shopify are stub
 * surfaces because we don't have meaningful data there.
 *
 * Used by /api/admin/reconciliation/amazon route + the daily cron
 * (future). v1 scope: surface drift; v2 would alert on drift > threshold.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'

interface MetricCompare {
  channel: number | string
  nexus: number | string
  drift: number | string
  driftPct?: number
}

export interface ReconciliationReport {
  generatedAt: string
  marketplaceId: string
  marketplaceCode: string
  window: { from: string; to: string; days: number }
  metrics: {
    orderCount: MetricCompare
    revenue: MetricCompare
    fbaInventoryUnits: MetricCompare
  }
  warnings: string[]
  durationMs: number
}

async function getLwaAccessToken(): Promise<string> {
  const clientId = process.env.AMAZON_LWA_CLIENT_ID
  const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET
  const refreshToken = process.env.AMAZON_REFRESH_TOKEN
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('LWA credentials missing')
  }
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  })
  if (!res.ok) throw new Error(`LWA failed: ${await res.text()}`)
  const data = (await res.json()) as { access_token: string }
  return data.access_token
}

/**
 * Walk SP-API getOrders pages to count orders + sum revenue in window.
 * Uses paginated MaxResultsPerPage=100; capped at 50 pages = 5000 orders
 * (more than enough for monthly recon windows for Xavia's scale).
 */
async function fetchChannelOrderTotals(
  marketplaceId: string,
  from: Date,
  to: Date,
): Promise<{ orderCount: number; revenue: number; pages: number }> {
  const accessToken = await getLwaAccessToken()
  const region = (process.env.AMAZON_REGION ?? 'eu') as string
  const host = `sellingpartnerapi-${region}.amazon.com`

  // SP-API: 2-min skew window
  const minAgo = new Date(Date.now() - 180_000)
  const upperBound = to.getTime() > minAgo.getTime() ? minAgo : to

  let orderCount = 0
  let revenue = 0
  let nextToken: string | undefined
  let pages = 0

  // Cap at 5 pages = ~500 orders to stay inside Railway's HTTP gateway
  // timeout. For high-volume sellers, reduce daysBack to fit.
  while (pages < 5) {
    const params = new URLSearchParams(
      nextToken
        ? { NextToken: nextToken }
        : {
            MarketplaceIds: marketplaceId,
            CreatedAfter: from.toISOString(),
            CreatedBefore: upperBound.toISOString(),
            MaxResultsPerPage: '100',
          },
    )
    const url = `https://${host}/orders/v0/orders?${params.toString()}`
    const res = await fetch(url, {
      headers: { 'x-amz-access-token': accessToken },
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`getOrders ${res.status}: ${body.slice(0, 200)}`)
    }
    const data = (await res.json()) as {
      payload?: {
        Orders?: Array<{
          OrderTotal?: { Amount?: string; CurrencyCode?: string }
          OrderStatus?: string
        }>
        NextToken?: string
      }
    }
    const orders = data.payload?.Orders ?? []
    for (const o of orders) {
      // Skip cancelled like our DB does
      if (o.OrderStatus === 'Canceled' || o.OrderStatus === 'Cancelled') continue
      orderCount++
      const amt = parseFloat(o.OrderTotal?.Amount ?? '0')
      if (Number.isFinite(amt)) revenue += amt
    }
    pages++
    nextToken = data.payload?.NextToken
    if (!nextToken) break
    // SP-API getOrders burst budget is 20 (refilled at 0.0167/s). For
    // single-shot reconciliation we use a short pause and rely on the
    // burst budget rather than waiting a full minute per page.
    await new Promise((r) => setTimeout(r, 2_000))
  }

  return { orderCount, revenue, pages }
}

/**
 * Pull FBA inventory total units for the marketplace.
 *
 * Delegates to AmazonService.fetchFBAInventory — the same battle-tested
 * pager the 15-min inventory cron uses. Earlier raw-fetch impl returned
 * inconsistent numbers (42 vs 432) vs the cron's 432; the cause was
 * subtly different query serialization.
 */
async function fetchChannelFbaInventory(marketplaceId: string): Promise<number> {
  const { AmazonService } = await import('./marketplaces/amazon.service.js')
  const svc = new AmazonService()
  const rows = await svc.fetchFBAInventory({ marketplaceId })
  return rows.reduce((sum, r) => sum + (r.fulfillableQuantity ?? 0), 0)
}

/**
 * Generate a reconciliation report for the given window + marketplace.
 */
export async function reconcileAmazon(opts: {
  marketplaceId?: string
  daysBack?: number
} = {}): Promise<ReconciliationReport> {
  const t0 = Date.now()
  const marketplaceId = opts.marketplaceId ?? process.env.AMAZON_MARKETPLACE_ID ?? 'APJ6JRA9NG5V4'
  const daysBack = opts.daysBack ?? 30
  const to = new Date()
  const from = new Date(to.getTime() - daysBack * 24 * 60 * 60 * 1000)
  const warnings: string[] = []

  // Map marketplaceId → 2-letter code
  const marketplaceRow = await prisma.marketplace.findFirst({
    where: { channel: 'AMAZON', marketplaceId },
    select: { code: true },
  })
  const marketplaceCode = marketplaceRow?.code ?? marketplaceId.slice(0, 6)

  // ── Channel side (SP-API) ────────────────────────────────────────
  let channelOrders = 0
  let channelRevenue = 0
  let channelInventory = 0
  try {
    const totals = await fetchChannelOrderTotals(marketplaceId, from, to)
    channelOrders = totals.orderCount
    channelRevenue = totals.revenue
    if (totals.pages >= 5) {
      warnings.push('channel order pagination hit 5-page cap (~500 orders); use a shorter daysBack window for full coverage')
    }
  } catch (err) {
    warnings.push(`channel getOrders failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  try {
    channelInventory = await fetchChannelFbaInventory(marketplaceId)
  } catch (err) {
    warnings.push(`channel FBA inventory failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // ── Nexus side (DB) ──────────────────────────────────────────────
  const dbOrders = await prisma.order.aggregate({
    where: {
      channel: 'AMAZON',
      marketplace: marketplaceCode,
      status: { not: 'CANCELLED' },
      purchaseDate: { gte: from, lte: to },
    },
    _count: { _all: true },
    _sum: { totalPrice: true },
  })

  const dbOrderCount = dbOrders._count._all
  const dbRevenue = Number(dbOrders._sum.totalPrice ?? 0)

  // FBA inventory in Nexus: SUM(StockLevel.quantity) JOINed to StockLocation
  // where code matches Amazon FBA pool (the code column carries the
  // operator-facing identifier like 'AMAZON-EU-FBA').
  const dbInventory = await prisma.$queryRaw<Array<{ total: bigint }>>`
    SELECT COALESCE(SUM(sl."quantity"), 0)::bigint AS total
    FROM "StockLevel" sl
    JOIN "StockLocation" loc ON loc.id = sl."locationId"
    WHERE loc."type" = 'AMAZON_FBA'
       OR loc."code" LIKE 'AMAZON-%FBA%'
  `
  const dbInventoryUnits = Number(dbInventory[0]?.total ?? 0)

  // ── Compose report ───────────────────────────────────────────────
  const driftPct = (channel: number, nexus: number): number => {
    if (channel === 0 && nexus === 0) return 0
    if (channel === 0) return 100
    return ((nexus - channel) / channel) * 100
  }

  const report: ReconciliationReport = {
    generatedAt: new Date().toISOString(),
    marketplaceId,
    marketplaceCode,
    window: {
      from: from.toISOString(),
      to: to.toISOString(),
      days: daysBack,
    },
    metrics: {
      orderCount: {
        channel: channelOrders,
        nexus: dbOrderCount,
        drift: dbOrderCount - channelOrders,
        driftPct: Number(driftPct(channelOrders, dbOrderCount).toFixed(2)),
      },
      revenue: {
        channel: Number(channelRevenue.toFixed(2)),
        nexus: Number(dbRevenue.toFixed(2)),
        drift: Number((dbRevenue - channelRevenue).toFixed(2)),
        driftPct: Number(driftPct(channelRevenue, dbRevenue).toFixed(2)),
      },
      fbaInventoryUnits: {
        channel: channelInventory,
        nexus: dbInventoryUnits,
        drift: dbInventoryUnits - channelInventory,
        driftPct: Number(driftPct(channelInventory, dbInventoryUnits).toFixed(2)),
      },
    },
    warnings,
    durationMs: Date.now() - t0,
  }

  logger.info('[channel-reconciliation] complete', {
    marketplaceId,
    orderDriftPct: report.metrics.orderCount.driftPct,
    revenueDriftPct: report.metrics.revenue.driftPct,
    inventoryDriftPct: report.metrics.fbaInventoryUnits.driftPct,
    warnings: warnings.length,
  })

  return report
}
