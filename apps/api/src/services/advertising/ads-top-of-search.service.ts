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
import { ACTION_HANDLERS, type ActionResult } from '../automation-rule.service.js'
import { logger } from '../../utils/logger.js'

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
  topIS: number | null // Amazon true top-of-search impression share (0–1), avg over window
  currentPct: number
  recommendedPct: number
  action: 'raise' | 'lower' | 'keep'
  reason: string
}

export async function analyzeTopOfSearch(opts: { windowDays?: number; marketplace?: string; targetAcos?: number; targetIS?: number } = {}): Promise<{ windowDays: number; targetAcos: number; targetIS: number | null; rows: TosRow[] }> {
  const windowDays = Math.max(7, Math.min(90, opts.windowDays ?? 30))
  const targetAcos = opts.targetAcos ?? 0.25
  const targetIS = opts.targetIS ?? null
  const since = new Date(); since.setUTCDate(since.getUTCDate() - windowDays); since.setUTCHours(0, 0, 0, 0)

  const perf = await prisma.amazonAdsPlacementReport.groupBy({
    by: ['campaignId'],
    where: { placement: TOP_REPORT_PLACEMENT, date: { gte: since } },
    _sum: { impressions: true, clicks: true, costMicros: true, sales7dCents: true, orders7d: true },
    _avg: { topOfSearchIS: true },
  })
  const extIds = perf.map((p) => p.campaignId)
  if (extIds.length === 0) return { windowDays, targetAcos, targetIS, rows: [] }
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
    const topIS = p._avg.topOfSearchIS != null ? Number(p._avg.topOfSearchIS) : null
    const db = (c.dynamicBidding ?? {}) as { placementBidding?: Array<{ placement: string; percentage: number }> }
    const currentPct = db.placementBidding?.find((x) => x.placement === TOP_BID_KEY)?.percentage ?? 0
    let action: TosRow['action'] = 'keep'
    let recommendedPct = currentPct
    let reason = 'within target'
    if (topSpendCents > 0 && topAcos != null) {
      if (targetIS != null && topIS != null) {
        // IS-driven, ACOS-bounded: hold the slot for the LEAST cost. Raise only
        // while we're below the impression-share target AND ACOS is in budget;
        // ease off once we're comfortably above target or ACOS runs over.
        const acosInBudget = topAcos <= targetAcos * 1.1
        if (topIS < targetIS && acosInBudget && currentPct < MAX_PCT) {
          action = 'raise'; recommendedPct = Math.min(MAX_PCT, currentPct + STEP_PCT); reason = `TOS IS ${(topIS * 100).toFixed(0)}% below target ${(targetIS * 100).toFixed(0)}% (ACOS ${(topAcos * 100).toFixed(0)}% in budget) — push for top slots`
        } else if (currentPct > 0 && (topIS >= targetIS * 1.1 || topAcos >= targetAcos * 1.2)) {
          action = 'lower'; recommendedPct = Math.max(0, currentPct - STEP_PCT); reason = topIS >= targetIS * 1.1 ? `TOS IS ${(topIS * 100).toFixed(0)}% comfortably above target — ease off for least cost` : `ACOS ${(topAcos * 100).toFixed(0)}% over target — ease off`
        }
      } else if (topAcos <= targetAcos * 0.8 && currentPct < MAX_PCT) {
        action = 'raise'; recommendedPct = Math.min(MAX_PCT, currentPct + STEP_PCT); reason = `TOP ACOS ${(topAcos * 100).toFixed(0)}% well under target — capture more top slots`
      } else if (topAcos >= targetAcos * 1.2 && currentPct > 0) {
        action = 'lower'; recommendedPct = Math.max(0, currentPct - STEP_PCT); reason = `TOP ACOS ${(topAcos * 100).toFixed(0)}% over target — ease off`
      }
    } else if (topSpendCents === 0) {
      reason = 'no top-of-search spend in window'
    }
    rows.push({ campaignId: c.id, name: c.name, marketplace: c.marketplace, topImpr: p._sum.impressions ?? 0, topClicks: p._sum.clicks ?? 0, topSpendCents, topSalesCents, topAcos, topIS, currentPct, recommendedPct, action, reason })
  }
  rows.sort((a, b) => b.topSpendCents - a.topSpendCents)
  return { windowDays, targetAcos, targetIS, rows }
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

// ── Apex D.2 — autonomous Top-of-Search defense ───────────────────────────
// Tune the PLACEMENT_TOP multiplier toward the target so a campaign holds the
// top slot when ROAS allows and eases off when it doesn't. Shared by the
// scheduled cron (top-of-search-defense) and the defend_top_of_search rule
// action. Live writes are clipped (±STEP_PCT, ≤MAX_PCT) AND restricted to
// allowlisted campaigns when allowlistedOnly — placement writes go through
// updatePlacementBidding which hits the write-gate WITHOUT a campaignId, so the
// A.2a per-campaign allowlist (Campaign.liveBidWritesEnabled) is enforced here.
export interface DefendTosResult {
  evaluated: number
  changed: number
  applied: number
  skippedNotAllowlisted: number
  dryRun: boolean
  sample: Array<{ campaign: string; fromPct: number; toPct: number; action: string; reason: string }>
}

export async function defendTopOfSearch(opts: {
  targetAcos?: number
  targetIS?: number
  marketplace?: string
  windowDays?: number
  allowlistedOnly?: boolean
  dryRun?: boolean
} = {}): Promise<DefendTosResult> {
  const { rows } = await analyzeTopOfSearch({ targetAcos: opts.targetAcos, targetIS: opts.targetIS, marketplace: opts.marketplace, windowDays: opts.windowDays })
  const actionable = rows.filter((r) => r.action !== 'keep' && r.recommendedPct !== r.currentPct)
  const sample = actionable.slice(0, 8).map((r) => ({ campaign: r.name, fromPct: r.currentPct, toPct: r.recommendedPct, action: r.action, reason: r.reason }))
  if (opts.dryRun) {
    return { evaluated: rows.length, changed: actionable.length, applied: 0, skippedNotAllowlisted: 0, dryRun: true, sample }
  }
  let allowed: Set<string> | null = null
  if (opts.allowlistedOnly) {
    const ids = actionable.map((r) => r.campaignId)
    allowed = new Set(
      (await prisma.campaign.findMany({ where: { id: { in: ids }, liveBidWritesEnabled: true }, select: { id: true } })).map((c) => c.id),
    )
  }
  let applied = 0
  let skippedNotAllowlisted = 0
  for (const r of actionable) {
    if (allowed && !allowed.has(r.campaignId)) { skippedNotAllowlisted += 1; continue }
    await applyTopOfSearch(r.campaignId, r.recommendedPct)
    applied += 1
  }
  return { evaluated: rows.length, changed: actionable.length, applied, skippedNotAllowlisted, dryRun: false, sample }
}

// Rule action — same engine, allowlist-enforced, dry-run honored from rule meta.
ACTION_HANDLERS.defend_top_of_search = async (action, _context, meta): Promise<ActionResult> => {
  const r = await defendTopOfSearch({
    targetAcos: typeof action.targetAcos === 'number' ? (action.targetAcos as number) : undefined,
    targetIS: typeof action.targetIS === 'number' ? (action.targetIS as number) : undefined,
    marketplace: typeof action.marketplace === 'string' ? (action.marketplace as string) : undefined,
    windowDays: typeof action.windowDays === 'number' ? (action.windowDays as number) : undefined,
    allowlistedOnly: true,
    dryRun: meta.dryRun,
  })
  return { type: action.type, ok: true, output: r }
}

logger.debug('[D.2] defend_top_of_search handler registered')
