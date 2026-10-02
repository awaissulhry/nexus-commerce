/**
 * MCP full control 08 S5 — the price history read, out of the route, so the pricing page and Claude's price-explain
 * read the same thing. The function is the body of its route, moved as it was (pricing-read.vitest.test.ts holds the
 * route's answers): the route keeps its 400 for a missing product and its error handling.
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'

/**
 * GET /api/pricing/price-history — a product's price changes, newest first (100 by default, 500 at most), and per
 * channel and market the series of prices, oldest first. The caller names the product (productId or sku).
 */
export async function readPriceHistory(q: {
  productId?: string
  sku?: string
  channel?: string
  marketplace?: string
  from?: string
  to?: string
  limit?: string
}) {
  const where: Prisma.PriceChangeEventWhereInput = {}
  if (q.productId) where.productId = q.productId
  if (q.sku) where.sku = q.sku
  if (q.channel) where.channel = q.channel.toUpperCase()
  if (q.marketplace) where.marketplace = q.marketplace.toUpperCase()
  if (q.from || q.to) {
    const changedAt: Prisma.DateTimeFilter = {}
    if (q.from) changedAt.gte = new Date(q.from)
    if (q.to) changedAt.lte = new Date(q.to)
    where.changedAt = changedAt
  }

  const limit = Math.min(parseInt(q.limit ?? '100', 10) || 100, 500)

  const rows = await prisma.priceChangeEvent.findMany({
    where,
    orderBy: { changedAt: 'desc' },
    take: limit,
  })

  // Per-coordinate sparkline series, oldest→newest so the chart reads
  // left-to-right. CLEARs (newPrice null) are skipped as points but
  // still appear in the events list below.
  const seriesMap = new Map<
    string,
    { channel: string; marketplace: string; points: Array<{ t: Date; price: number }> }
  >()
  for (const e of [...rows].reverse()) {
    if (e.newPrice == null) continue
    const key = `${e.channel}|${e.marketplace}`
    let s = seriesMap.get(key)
    if (!s) {
      s = { channel: e.channel, marketplace: e.marketplace, points: [] }
      seriesMap.set(key, s)
    }
    s.points.push({ t: e.changedAt, price: Number(e.newPrice) })
  }

  return {
    count: rows.length,
    events: rows.map((e) => ({
      id: e.id,
      channel: e.channel,
      marketplace: e.marketplace,
      fulfillmentMethod: e.fulfillmentMethod,
      oldPrice: e.oldPrice == null ? null : Number(e.oldPrice),
      newPrice: e.newPrice == null ? null : Number(e.newPrice),
      currency: e.currency,
      source: e.source,
      reason: e.reason,
      ruleId: e.ruleId,
      actor: e.actor,
      changedAt: e.changedAt,
    })),
    series: [...seriesMap.values()],
  }
}
