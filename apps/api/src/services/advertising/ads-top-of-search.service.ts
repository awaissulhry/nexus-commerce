/**
 * AME.11 — Top-of-search placement optimizer.
 *
 * The top-of-search slot (the 2-3 sponsored results above organic) converts
 * best but costs most. This reads each campaign's TOP_OF_SEARCH placement
 * performance and recommends / auto-tunes the placement bid multiplier
 * (PLACEMENT_TOP, 0-900%) to WIN the slot when ROAS allows and ease off when it
 * doesn't — within step + cap guardrails. Writes reuse the LIVE, write-gated
 * updatePlacementBidding (Ads API).
 *
 * Report placement value 'Top of Search on-Amazon' maps to the bidding key
 * 'PLACEMENT_TOP'.
 */
import prisma from '../../db.js'
import { microsToCents } from './ads-metrics-math.js'

const TOP_REPORT_PLACEMENT = 'Top of Search on-Amazon'
const TOP_BID_KEY = 'PLACEMENT_TOP'
const MAX_PCT = 900
const STEP_PCT = 15 // max change per optimisation run (guardrail)

export interface TosRow {
  campaignId: string
  name: string
  marketplace: string | null
  topImpr: number; topClicks: number; topSpendCents: number; topSalesCents: number
  topAcos: number | null
  currentPct: number
  recommendedPct: number
  action: 'raise' | 'lower' | 'keep'
  reason: string
}

export async function analyzeTopOfSearch(opts: { windowDays?: number; marketplace?: string; targetAcos?: number } = {}): Promise<{ windowDays: number; targetAcos: number; rows: TosRow[] }> {
  const windowDays = Math.max(7, Math.min(90, opts.windowDays ?? 30))
  const targetAcos = opts.targetAcos ?? 0.25
  const since = new Date(); since.setUTCDate(since.getUTCDate() - windowDays); since.setUTCHours(0, 0, 0, 0)

  const perf = await prisma.amazonAdsPlacementReport.groupBy({
    by: ['campaignId'],
    where: { placement: TOP_REPORT_PLACEMENT, date: { gte: since } },
    _sum: { impressions: true, clicks: true, costMicros: true, sales7dCents: true, orders7d: true },
  })
  const extIds = perf.map((p) => p.campaignId)
  if (extIds.length === 0) return { windowDays, targetAcos, rows: [] }
  const campaigns = await prisma.campaign.findMany({
    where: { externalCampaignId: { in: extIds }, ...(opts.marketplace ? { marketplace: opts.marketplace } : {}) },
    select: { id: true, name: true, marketplace: true, externalCampaignId: true, dynamicBidding: true },
  })
  const byExt = new Map(campaigns.map((c) => [c.externalCampaignId!, c]))

  const rows: TosRow[] = []
  for (const p of perf) {
    const c = byExt.get(p.campaignId)
    if (!c) continue
    const topSpendCents = microsToCents(p._sum.costMicros)
    const topSalesCents = p._sum.sales7dCents ?? 0
    const topAcos = topSalesCents > 0 ? topSpendCents / topSalesCents : null
    const db = (c.dynamicBidding ?? {}) as { placementBidding?: Array<{ placement: string; percentage: number }> }
    const currentPct = db.placementBidding?.find((x) => x.placement === TOP_BID_KEY)?.percentage ?? 0
    let action: TosRow['action'] = 'keep'
    let recommendedPct = currentPct
    let reason = 'within target'
    if (topSpendCents > 0 && topAcos != null) {
      if (topAcos <= targetAcos * 0.8 && currentPct < MAX_PCT) {
        action = 'raise'; recommendedPct = Math.min(MAX_PCT, currentPct + STEP_PCT); reason = `TOP ACOS ${(topAcos * 100).toFixed(0)}% well under target — capture more top slots`
      } else if (topAcos >= targetAcos * 1.2 && currentPct > 0) {
        action = 'lower'; recommendedPct = Math.max(0, currentPct - STEP_PCT); reason = `TOP ACOS ${(topAcos * 100).toFixed(0)}% over target — ease off`
      }
    } else if (topSpendCents === 0) {
      reason = 'no top-of-search spend in window'
    }
    rows.push({ campaignId: c.id, name: c.name, marketplace: c.marketplace, topImpr: p._sum.impressions ?? 0, topClicks: p._sum.clicks ?? 0, topSpendCents, topSalesCents, topAcos, currentPct, recommendedPct, action, reason })
  }
  rows.sort((a, b) => b.topSpendCents - a.topSpendCents)
  return { windowDays, targetAcos, rows }
}

export async function applyTopOfSearch(campaignId: string, percentage: number): Promise<unknown> {
  const { updatePlacementBidding } = await import('./ads-create.service.js')
  const c = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { dynamicBidding: true } })
  const db = (c?.dynamicBidding ?? {}) as { placementBidding?: Array<{ placement: string; percentage: number }> }
  const others = (db.placementBidding ?? []).filter((x) => x.placement !== TOP_BID_KEY)
  const adjustments = [...others, { placement: TOP_BID_KEY, percentage: Math.max(0, Math.min(MAX_PCT, Math.round(percentage))) }]
  return updatePlacementBidding({ campaignId, adjustments })
}

/** Auto-apply every raise/lower recommendation (within the step/cap guardrails). */
export async function applyTopOfSearchRecommendations(opts: { windowDays?: number; marketplace?: string; targetAcos?: number } = {}): Promise<{ applied: number; rows: TosRow[] }> {
  const { rows } = await analyzeTopOfSearch(opts)
  let applied = 0
  for (const r of rows) {
    if (r.action !== 'keep' && r.recommendedPct !== r.currentPct) {
      await applyTopOfSearch(r.campaignId, r.recommendedPct)
      applied += 1
    }
  }
  return { applied, rows }
}
