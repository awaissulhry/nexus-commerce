/**
 * AX2.6 — Share of Voice + impression-share intelligence.
 *
 * Amazon's true "impression share" needs the topOfSearchImpressionShare /
 * search-term-impression-share report columns, which only populate under a
 * live report subscription. This service derives the genuinely-computable
 * signals from the search-term data we already ingest (AmazonAdsSearchTerm):
 *
 *  - Within-account Share of Voice: each query's impressions as a share of
 *    all tracked impressions — the queries we dominate vs barely touch.
 *  - Cannibalization: queries where ≥2 of our own campaigns compete, with
 *    the leading campaign's internal share.
 *  - Lost-IS proxies (clearly labelled, not Amazon's metric):
 *      • "outbid" — high CPC + low impressions relative to clicks → likely
 *        losing the auction; opportunity to raise the bid.
 *      • "weak-relevance" — high impressions + low CTR → we show but don't
 *        win the click; creative / match-type opportunity.
 *
 * Read-only; no writes. Powers the Share-of-Voice cockpit tab + CSV.
 */

import prisma from '../../db.js'

export interface SovRow {
  query: string
  impressions: number
  clicks: number
  costCents: number
  orders: number
  ctr: number | null
  cvr: number | null
  cpcCents: number | null
  sovPct: number // share of total tracked impressions
  campaignCount: number // distinct campaigns competing for this query
  topCampaignSharePct: number // leading campaign's share of the query's impressions
  cannibalized: boolean
  flag: 'outbid' | 'weak-relevance' | null
}
export interface SovResult {
  windowDays: number
  totalImpressions: number
  queries: number
  rows: SovRow[]
  summary: { cannibalizedQueries: number; outbidQueries: number; weakRelevanceQueries: number }
}

export async function analyzeShareOfVoice(opts: { windowDays?: number; marketplace?: string; limit?: number } = {}): Promise<SovResult> {
  const windowDays = opts.windowDays ?? 30
  const limit = opts.limit ?? 200
  const since = new Date(Date.now() - windowDays * 86_400_000)
  const where: { date: { gte: Date }; marketplace?: string } = { date: { gte: since } }
  if (opts.marketplace) where.marketplace = opts.marketplace

  const terms = await prisma.amazonAdsSearchTerm.findMany({
    where,
    select: { query: true, campaignId: true, impressions: true, clicks: true, costMicros: true, orders7d: true },
  })

  // Aggregate per query, tracking per-campaign impressions for cannibalization.
  const agg = new Map<string, { impr: number; clicks: number; cost: number; orders: number; byCampaign: Map<string, number> }>()
  let totalImpressions = 0
  for (const t of terms) {
    const q = (t.query || '').trim()
    if (!q) continue
    let a = agg.get(q)
    if (!a) { a = { impr: 0, clicks: 0, cost: 0, orders: 0, byCampaign: new Map() }; agg.set(q, a) }
    a.impr += t.impressions
    a.clicks += t.clicks
    a.cost += Number(t.costMicros) / 10_000 // micros → cents
    a.orders += t.orders7d ?? 0
    a.byCampaign.set(t.campaignId, (a.byCampaign.get(t.campaignId) ?? 0) + t.impressions)
    totalImpressions += t.impressions
  }

  // Median CPC across queries (with clicks) for the outbid heuristic.
  const cpcs: number[] = []
  for (const a of agg.values()) if (a.clicks > 0) cpcs.push(a.cost / a.clicks)
  cpcs.sort((x, y) => x - y)
  const medianCpc = cpcs.length ? cpcs[Math.floor(cpcs.length / 2)] : 0
  // Median CTR for the weak-relevance heuristic.
  const ctrs: number[] = []
  for (const a of agg.values()) if (a.impr > 0) ctrs.push(a.clicks / a.impr)
  ctrs.sort((x, y) => x - y)
  const medianCtr = ctrs.length ? ctrs[Math.floor(ctrs.length / 2)] : 0

  let cannibalizedQueries = 0, outbidQueries = 0, weakRelevanceQueries = 0
  const rows: SovRow[] = []
  for (const [query, a] of agg) {
    const ctr = a.impr > 0 ? a.clicks / a.impr : null
    const cvr = a.clicks > 0 ? a.orders / a.clicks : null
    const cpcCents = a.clicks > 0 ? a.cost / a.clicks : null
    const topShare = a.impr > 0 ? Math.max(...a.byCampaign.values()) / a.impr : 0
    const campaignCount = a.byCampaign.size
    const cannibalized = campaignCount >= 2
    // outbid: above-median CPC but below-median impressions among clicked queries.
    const outbid = cpcCents != null && medianCpc > 0 && cpcCents > medianCpc * 1.25 && a.impr < (totalImpressions / Math.max(1, agg.size))
    // weak-relevance: meaningful impressions but CTR well under median.
    const weak = a.impr >= 50 && ctr != null && medianCtr > 0 && ctr < medianCtr * 0.5
    const flag: SovRow['flag'] = outbid ? 'outbid' : weak ? 'weak-relevance' : null
    if (cannibalized) cannibalizedQueries++
    if (flag === 'outbid') outbidQueries++
    if (flag === 'weak-relevance') weakRelevanceQueries++
    rows.push({
      query, impressions: a.impr, clicks: a.clicks, costCents: Math.round(a.cost), orders: a.orders,
      ctr, cvr, cpcCents: cpcCents != null ? Math.round(cpcCents) : null,
      sovPct: totalImpressions > 0 ? a.impr / totalImpressions : 0,
      campaignCount, topCampaignSharePct: topShare, cannibalized, flag,
    })
  }
  rows.sort((x, y) => y.impressions - x.impressions)
  return {
    windowDays, totalImpressions, queries: rows.length,
    rows: rows.slice(0, limit),
    summary: { cannibalizedQueries, outbidQueries, weakRelevanceQueries },
  }
}
