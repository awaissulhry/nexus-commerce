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
  /** I11 — native currency for this marketplace (e.g. IT=EUR, UK=GBP). */
  currency: string
  window: { from: string; to: string; days: number }
  metrics: {
    orderCount: MetricCompare
    revenue: MetricCompare
    fbaInventoryUnits: MetricCompare
  }
  warnings: string[]
  durationMs: number
}

/** I11 — fan-out report across every active Amazon marketplace.
 *  Each per-marketplace report stands alone in its native currency;
 *  totals are intentionally NOT mixed across currencies. */
export interface MultiMarketplaceReconciliationReport {
  generatedAt: string
  window: { from: string; to: string; days: number }
  marketplaces: ReconciliationReport[]
  /** I11 — currency cross-check: for each native currency, sum
   *  of per-marketplace channel revenue, Nexus revenue, and drift.
   *  If any drift is non-zero the operator has a per-marketplace
   *  divergence to investigate. */
  byCurrency: Array<{
    currency: string
    marketplaces: string[]
    channelRevenue: number
    nexusRevenue: number
    drift: number
    driftPct: number
  }>
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
          AmazonOrderId?: string
          MarketplaceId?: string
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
      // Pan-EU FBA fix: SP-API's MarketplaceIds filter is *permissive* — it
      // returns orders where the seller has listings visible in that
      // marketplace, NOT only orders actually placed there. For Pan-EU
      // sellers, a single IT order will appear when querying any of
      // IT/DE/FR/ES/NL. Without this strict-match filter, the recon
      // counts inflate per-marketplace by counting the same orders
      // multiple times. Verified empirically 2026-05-21: all of Xavia's
      // 2,410 historical orders have raw.MarketplaceId=APJ6JRA9NG5V4 (IT),
      // yet the un-filtered count reported DE=40 / FR=19 / ES=3 — those
      // are phantom Pan-EU visibility duplicates, not real DE/FR/ES sales.
      if (o.MarketplaceId && o.MarketplaceId !== marketplaceId) continue
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

  // Map marketplaceId → 2-letter code + native currency.
  // I11 — currency travels with the report so per-currency cross-checks
  // can group correctly downstream (IT=EUR, UK=GBP, US=USD, etc.).
  const marketplaceRow = await prisma.marketplace.findFirst({
    where: { channel: 'AMAZON', marketplaceId },
    select: { code: true, currency: true },
  })
  const marketplaceCode = marketplaceRow?.code ?? marketplaceId.slice(0, 6)
  const currency = marketplaceRow?.currency ?? 'EUR'

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
    currency,
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

/**
 * I11 — fan out reconciliation across every active Amazon marketplace
 * the operator is connected to.
 *
 * Per-marketplace reports are run sequentially (not in parallel) because
 * SP-API rate limits are per-account and bursting all 5 markets at once
 * burns the burst budget before any single one finishes. Each report
 * runs to completion (warnings collected on failure rather than abort)
 * so a single bad-credential marketplace doesn't poison the whole run.
 *
 * The byCurrency rollup groups marketplaces sharing a native currency
 * (EU markets all = EUR, UK = GBP, US/MX/CA = USD/MXN/CAD individually)
 * so the operator can verify that the EUR total drift across IT+DE+FR+
 * ES+NL+SE+PL aligns with what they'd expect from per-marketplace
 * Seller Central downloads.
 */
export async function reconcileAllAmazonMarketplaces(opts: {
  daysBack?: number
} = {}): Promise<MultiMarketplaceReconciliationReport> {
  const t0 = Date.now()
  const daysBack = opts.daysBack ?? 30
  const to = new Date()
  const from = new Date(to.getTime() - daysBack * 24 * 60 * 60 * 1000)
  const warnings: string[] = []

  // Pull active Amazon marketplaces. Operator may be connected to
  // multiple (IT primary + DE/FR/ES/NL secondary, etc).
  const marketplaces = await prisma.marketplace.findMany({
    where: { channel: 'AMAZON', marketplaceId: { not: null } },
    select: { marketplaceId: true, code: true, currency: true },
    orderBy: { code: 'asc' },
  })

  const reports: ReconciliationReport[] = []
  for (const mk of marketplaces) {
    if (!mk.marketplaceId) continue
    try {
      const report = await reconcileAmazon({
        marketplaceId: mk.marketplaceId,
        daysBack,
      })
      reports.push(report)
    } catch (err) {
      warnings.push(
        `marketplace ${mk.code ?? mk.marketplaceId} failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // I11 — per-currency cross-check. Sum per-marketplace channel + Nexus
  // revenue within each native currency bucket; never mix currencies.
  const currencyMap = new Map<
    string,
    { marketplaces: string[]; channelRevenue: number; nexusRevenue: number }
  >()
  for (const r of reports) {
    const slot = currencyMap.get(r.currency) ?? {
      marketplaces: [],
      channelRevenue: 0,
      nexusRevenue: 0,
    }
    slot.marketplaces.push(r.marketplaceCode)
    slot.channelRevenue += Number(r.metrics.revenue.channel) || 0
    slot.nexusRevenue += Number(r.metrics.revenue.nexus) || 0
    currencyMap.set(r.currency, slot)
  }
  const byCurrency = [...currencyMap.entries()].map(([currency, slot]) => {
    const drift = slot.nexusRevenue - slot.channelRevenue
    const driftPct =
      slot.channelRevenue === 0
        ? slot.nexusRevenue === 0
          ? 0
          : 100
        : (drift / slot.channelRevenue) * 100
    return {
      currency,
      marketplaces: slot.marketplaces,
      channelRevenue: Math.round(slot.channelRevenue * 100) / 100,
      nexusRevenue: Math.round(slot.nexusRevenue * 100) / 100,
      drift: Math.round(drift * 100) / 100,
      driftPct: Math.round(driftPct * 100) / 100,
    }
  })

  logger.info('[channel-reconciliation/all] complete', {
    marketplaceCount: reports.length,
    currencyCount: byCurrency.length,
    warnings: warnings.length,
    durationMs: Date.now() - t0,
  })

  return {
    generatedAt: new Date().toISOString(),
    window: {
      from: from.toISOString(),
      to: to.toISOString(),
      days: daysBack,
    },
    marketplaces: reports,
    byCurrency,
    warnings,
    durationMs: Date.now() - t0,
  }
}
