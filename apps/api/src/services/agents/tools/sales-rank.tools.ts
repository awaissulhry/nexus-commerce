/**
 * Amazon Best Sellers Rank — Claude's read: sales-rank.
 *
 * The sales-rank feed (services/amazon/sales-rank.service.ts, every 3 hours) stores Amazon's rank of every live Amazon
 * listing: per market, the rank in a sub-category (a browse node such as a jackets node) and in a whole department.
 * This tool answers it for one product family, one SKU or one ASIN: the best ASIN per category in its newest read, each
 * ASIN's newest ranks with when they were read (capturedAt, ageHours, stale) and the trend against the rank as it stood
 * 24 hours and 7 days ago (the newest read at or before then, at most 27 h older, else null; null too when the newest read is stale — a lower
 * rank is better, so a positive change is a climb) and the best rank of each day. A scope with no stored read says so, with when the feed last stored
 * anything at all. 2026-10-10 (AUDIT B1/B2): a newest read older than 27 h is `stale` — Amazon reported no rank since,
 * or the feed did not run — and is never presented as the rank now.
 *
 * Read only and low risk: Nexus's own rows, no marketplace call. Category titles come from Amazon and pass through
 * claude-safe.ts.
 */
import { z } from 'zod'
import prisma from '../../../db.js'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool } from '../tool-types.js'
import { liveProduct } from './live-product.js'
import { safeText } from './claude-safe.js'
import { SALES_RANK_FEED_DEFAULT_SCHEDULE } from '../../amazon/sales-rank-schedule.js'

/** With no product, SKU or ASIN: the business's best-ranked ASINs, this many, over at most this many days. */
const OVERVIEW_ASINS = 50
const OVERVIEW_DAYS = 8
const SCHEDULE_WORDS = `every 3 hours (cron ${SALES_RANK_FEED_DEFAULT_SCHEDULE}, UTC)`

const salesRank: AgentTool = {
  name: 'sales-rank',
  title: 'Amazon Best Sellers Rank',
  category: 'insights',
  description:
    'Amazon\'s Best Sellers Rank of this business\'s products, as Nexus reads it from Amazon every 3 hours (Catalog '
    + 'Items salesRanks) for every live Amazon listing: per market, the rank in each sub-category (a browse node) and in '
    + 'the whole department. Name a product (a family parent covers its variations), a SKU or an ASIN, optionally one '
    + 'market (IT, DE, …); name none for the business\'s 50 best-ranked ASINs in their newest reads (no daily history). Answers the best ASIN per category (bestPerCategory: rank, which ASIN, '
    + 'capturedAt = when Nexus read it from Amazon, ageHours, stale, change against the rank as it stood 24 h and 7 days ago — the newest stored read at or before then, at most 27 h older '
    + '(a rank is stored when it changes and once a day), else null, and null when stale; a lower rank is better, so a positive change is a climb), and each ASIN\'s newest ranks (capturedAt, ageHours, stale; the reads compared, '
    + 'rank24hAgoAt / rank7dAgoAt) with the best rank of each UTC day over the window (default 14 days, at most 90). stale = the newest read is older than '
    + '27 h: Amazon reported no rank since, or the feed did not run — the rank is the last one Amazon reported, not the rank now; say so. Stored reads only: a '
    + 'read is kept when a rank changed, plus one a day. Read only.',
  input: z.object({
    productId: z.string().trim().min(1).max(64).optional().describe('a Nexus product id: a family parent covers every variation'),
    sku: z.string().trim().min(1).max(100).optional().describe('instead of productId: the product\'s SKU in this business'),
    asin: z.string().trim().min(10).max(10).optional().describe('instead of a product: one ASIN'),
    market: z.string().trim().min(2).max(20).optional().describe('only this Amazon market code (IT, DE, FR, ES, …); omitted, every market'),
    days: z.coerce.number().int().min(1).max(90).optional().describe('the history window in days (default 14, max 90)'),
  }),
  requires: [F.analyticsView],
  riskTier: 'low',
  readOnly: true,
  handler: async (args) => {
    const service = await import('../../amazon/sales-rank.service.js')
    const days = Math.min(Math.max(Number(args.days) || service.SALES_RANK_DEFAULT_DAYS, 1), service.SALES_RANK_MAX_DAYS)
    const market = typeof args.market === 'string' && args.market.trim() ? args.market.trim().toUpperCase() : undefined
    const now = new Date()

    let scope: { productIds?: string[]; asin?: string; product?: { productId: string; sku: string; variations: number }; overview?: true }
    const id = typeof args.productId === 'string' ? args.productId.trim() : ''
    const sku = typeof args.sku === 'string' ? args.sku.trim() : ''
    if (typeof args.asin === 'string' && args.asin.trim()) {
      scope = { asin: args.asin.trim().toUpperCase() }
    } else if (!id && !sku) {
      scope = { overview: true }
    } else {
      const product = await prisma.product.findFirst({
        where: id ? liveProduct(id) : { sku, deletedAt: null },
        select: { id: true, sku: true },
      })
      if (!product) return { ok: false, error: 'Product not found' }
      const children = await prisma.product.findMany({ where: { parentId: product.id, deletedAt: null }, select: { id: true } })
      scope = { productIds: [product.id, ...children.map((c) => c.id)], product: { productId: product.id, sku: product.sku, variations: children.length } }
    }

    // The overview reads 8 days at most: enough for the 24-hour and 7-day trend of every ASIN, without its daily history.
    const window = scope.overview ? Math.min(days, OVERVIEW_DAYS) : days
    const reads = await service.loadSalesRankReads({ productIds: scope.productIds, asin: scope.asin, market, days: window, now })
    const scopeOut = { ...(scope.product ?? (scope.asin ? { asin: scope.asin } : { every: 'every live Amazon listing of the business' })), market: market ?? 'every market', days: window }
    if (!reads.length) {
      const newest = await service.newestSalesRankRead()
      return {
        ok: true,
        data: {
          scope: scopeOut,
          bestPerCategory: [],
          asins: [],
          hint: newest
            ? `No rank stored for this scope in the last ${days} days. The feed last stored a rank in this business at ${newest.toISOString()}: Amazon may report no rank for these ASINs (no recent sale), or their listings are not live on Amazon.`
            : `No rank stored yet in this business: the sales-rank feed reads Amazon ${SCHEDULE_WORDS}; the first read lands after the next run.`,
        },
      }
    }
    const summary = service.summariseSalesRank(reads, now)
    const staleCount = summary.asins.filter((a) => a.stale).length
    const title = (t: string) => safeText(t, 120)
    return {
      ok: true,
      data: {
        scope: scopeOut,
        bestPerCategory: summary.bestPerCategory.map((b) => ({ ...b, title: title(b.title) })),
        asins: scope.overview
          ? summary.asins.slice(0, OVERVIEW_ASINS).map((a) => ({ ...a, categories: a.categories.map(({ history: _history, ...c }) => ({ ...c, title: title(c.title) })) }))
          : summary.asins.map((a) => ({ ...a, categories: a.categories.map((c) => ({ ...c, title: title(c.title) })) })),
        ...(scope.overview && summary.asins.length > OVERVIEW_ASINS ? { more: summary.asins.length - OVERVIEW_ASINS } : {}),
        note: `Amazon's Best Sellers Rank: 1 is the best seller. Each rank is the one in the ASIN's newest stored read, taken at capturedAt (UTC; ageHours old). stale = that read is older than ${service.SALES_RANK_STALE_HOURS} h: Amazon reported no rank since, or the feed did not run, so it is the last rank Amazon reported, not the rank now. change24h / change7d = the rank as it stood 24 h / 7 days ago — the newest stored read at or before then (rank24hAgoAt / rank7dAgoAt), at most ${service.SALES_RANK_STALE_HOURS} h older (a rank is stored when it changes and once a day, so it still held then) — minus the newest rank (positive = climbed); null when there is a gap (no read that recent) or the newest read is stale — never 0 for "unknown". The feed reads Amazon ${SCHEDULE_WORDS}.`,
        ...(staleCount ? { staleAsins: staleCount } : {}),
      },
    }
  },
}

export const SALES_RANK_TOOLS: AgentTool[] = [salesRank]
