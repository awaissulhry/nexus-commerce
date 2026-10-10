/**
 * AX2.6 — our own search-term impression mix + overlap / outbid checks (historically "Share of Voice").
 *
 * 🔴 NOTHING HERE IS A SHARE OF VOICE OR A MARKET SHARE (2026-10-10, AUDIT B6 / T6). It reads only OUR search-term
 * report (AmazonAdsSearchTerm) — no other advertiser's impressions are in it. Amazon's own shares are elsewhere:
 * top-of-search impression share per campaign comes from the Ads API campaign report (its `topOfSearchImpressionShare`
 * column, read by ads-tos-is-ingest and the campaign report on request — no subscription involved), and a query's
 * market share comes from Brand Analytics Search Query Performance (share-of-voice.service.ts). Amazon reports no
 * impression share per search term. (This header used to say the share columns "only populate under a live report
 * subscription" — that was never true.)
 *
 * What it computes, all from our own search terms, all Nexus's own arithmetic:
 *  - impressionMixPct (was `sovPct`): a query's impressions ÷ ALL our search-term impressions in the window and
 *    scope — our own impression mix, a fraction 0..1 despite the name. Null when there are no impressions to divide by.
 *  - Overlap: queries where ≥2 of our own campaigns compete, with the leading campaign's internal share.
 *  - Heuristic flags (Nexus's, not Amazon's metric):
 *      • "outbid" — high CPC + low impressions relative to clicks → likely
 *        losing the auction; opportunity to raise the bid.
 *      • "weak-relevance" — high impressions + low CTR → we show but don't
 *        win the click; creative / match-type opportunity.
 *
 * Read-only; no writes. Read by GET /advertising/share-of-voice, the recommendations feed (outbid / overlap lines) and
 * the SOV_BID rule's campaign concentration.
 */

import prisma from '../../db.js'

/** Said wherever `impressionMixPct` travels, so no reader takes it for a market share. */
export const IMPRESSION_MIX_NOTE =
  'impressionMixPct is our own impression mix (our search-term impressions only), not a market share: a query\'s impressions ÷ all our search-term impressions in this window and scope, a fraction 0..1. Computed by Nexus from our Amazon search-term report.'

export interface SovRow {
  query: string
  impressions: number
  clicks: number
  costCents: number
  orders: number
  ctr: number | null
  cvr: number | null
  cpcCents: number | null
  /** Our own impression mix (fraction 0..1): this query's impressions ÷ all our search-term impressions in the window
   *  and scope. NOT a market share or share of voice. Null when there were no impressions to divide by. */
  impressionMixPct: number | null
  campaignCount: number // distinct campaigns competing for this query
  /** The leading campaign's share of this query's impressions (fraction 0..1). Null when the query had no impressions
   *  to divide by — no reading, never 0 (a 0 would satisfy "Campaign Concentration < 60%"). */
  topCampaignSharePct: number | null
  cannibalized: boolean
  flag: 'outbid' | 'weak-relevance' | null
}
export interface SovResult {
  windowDays: number
  /** What impressionMixPct is (IMPRESSION_MIX_NOTE). */
  note: string
  totalImpressions: number
  queries: number
  rows: SovRow[]
  summary: { cannibalizedQueries: number; outbidQueries: number; weakRelevanceQueries: number }
}

/**
 * C5 (2026-10-10) — `campaignIds` (optional): only these campaigns' search terms (Amazon's campaign ids, as
 * AmazonAdsSearchTerm keeps them) — the recommendations feed reads one market's enabled campaigns. Absent: every campaign,
 * as before.
 */
export async function analyzeShareOfVoice(opts: { windowDays?: number; marketplace?: string; limit?: number; campaignIds?: readonly string[] } = {}): Promise<SovResult> {
  const windowDays = opts.windowDays ?? 30
  const limit = opts.limit ?? 200
  const since = new Date(Date.now() - windowDays * 86_400_000)
  const where: { date: { gte: Date }; marketplace?: string; campaignId?: { in: string[] } } = { date: { gte: since } }
  if (opts.marketplace) where.marketplace = opts.marketplace
  if (opts.campaignIds) where.campaignId = { in: [...opts.campaignIds] }

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
    const topShare = a.impr > 0 ? Math.max(...a.byCampaign.values()) / a.impr : null
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
      impressionMixPct: totalImpressions > 0 ? a.impr / totalImpressions : null,
      campaignCount, topCampaignSharePct: topShare, cannibalized, flag,
    })
  }
  rows.sort((x, y) => y.impressions - x.impressions)
  return {
    windowDays, note: IMPRESSION_MIX_NOTE, totalImpressions, queries: rows.length,
    rows: rows.slice(0, limit),
    summary: { cannibalizedQueries, outbidQueries, weakRelevanceQueries },
  }
}
