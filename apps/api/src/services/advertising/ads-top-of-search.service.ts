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
  status: string // RC2.T4 — so the hold-loop can skip dayparting-paused campaigns
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
    select: { id: true, name: true, marketplace: true, externalCampaignId: true, dynamicBidding: true, status: true },
  })
  const byExt = new Map(campaigns.map((c) => [c.externalCampaignId!, c]))

  const rows: TosRow[] = []
  for (const p of perf) {
    const c = byExt.get(p.campaignId)
    if (!c) continue
    const topSpendCents = microsToCents(p._sum.costMicros)
    const topSalesCents = p._sum.sales7dCents ?? 0
    // C4 — spend with ZERO attributed sales is effectively INFINITE ACOS (burning money for
    // nothing), NOT "no signal". Returning null here let the controller treat it as ACOS-ok and
    // RAISE the bid. Use an over-any-cap sentinel so the loop eases off instead. Truly no spend
    // (0/0) stays null = genuinely no signal.
    const topAcos = topSalesCents > 0 ? topSpendCents / topSalesCents : (topSpendCents > 0 ? 9.99 : null)
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
    rows.push({ campaignId: c.id, name: c.name, marketplace: c.marketplace, topImpr: p._sum.impressions ?? 0, topClicks: p._sum.clicks ?? 0, topSpendCents, topSalesCents, topAcos, topIS, currentPct, recommendedPct, action, reason, status: c.status })
  }
  rows.sort((a, b) => b.topSpendCents - a.topSpendCents)
  return { windowDays, targetAcos, targetIS, rows }
}

const REST_BID_KEY = 'PLACEMENT_REST_OF_SEARCH'
const clampPct = (p: number) => Math.max(0, Math.min(MAX_PCT, Math.round(p)))

// PP — generic: set ONE placement's bias, preserving the others.
export async function applyPlacementBias(campaignId: string, placement: string, percentage: number): Promise<unknown> {
  const { updatePlacementBidding } = await import('./ads-create.service.js')
  const c = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { dynamicBidding: true } })
  const db = (c?.dynamicBidding ?? {}) as { placementBidding?: Array<{ placement: string; percentage: number }> }
  const others = (db.placementBidding ?? []).filter((x) => x.placement !== placement)
  const adjustments = [...others, { placement, percentage: clampPct(percentage) }]
  return updatePlacementBidding({ campaignId, adjustments })
}

// PP — set the ACTIVE search placement to `percentage` AND zero the OTHER search
// placement (Top ↔ Rest are mutually exclusive search positions); Product-page bias is
// left untouched. This is the rank engine's lever: a Rest-of-Search target drives Rest
// and drops Top; an Own-Top target drives Top and drops Rest.
// Pure (unit-tested): active search placement = pct, the OTHER search placement = 0
// (Top ↔ Rest are mutually exclusive), non-search placements (Product) preserved. A
// non-search placement just sets itself and preserves everything else.
export function buildSearchPlacementAdjustments(existing: Array<{ placement: string; percentage: number }>, placement: string, percentage: number): Array<{ placement: string; percentage: number }> {
  const pct = clampPct(percentage)
  if (placement !== TOP_BID_KEY && placement !== REST_BID_KEY) {
    return [...(existing ?? []).filter((x) => x.placement !== placement), { placement, percentage: pct }]
  }
  const other = placement === TOP_BID_KEY ? REST_BID_KEY : TOP_BID_KEY
  const preserved = (existing ?? []).filter((x) => x.placement !== TOP_BID_KEY && x.placement !== REST_BID_KEY)
  return [...preserved, { placement, percentage: pct }, { placement: other, percentage: 0 }]
}

// BL — blended multi-placement writer lives in the pure ads-placement-math module
// (no DB → unit-testable). Re-exported here so existing import sites resolve unchanged.
export { buildBlendedAdjustments, MANAGED_PLACEMENTS } from './ads-placement-math.js'

export async function setSearchPlacement(campaignId: string, placement: string, percentage: number): Promise<unknown> {
  const { updatePlacementBidding } = await import('./ads-create.service.js')
  const c = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { dynamicBidding: true } })
  const db = (c?.dynamicBidding ?? {}) as { placementBidding?: Array<{ placement: string; percentage: number }> }
  return updatePlacementBidding({ campaignId, adjustments: buildSearchPlacementAdjustments(db.placementBidding ?? [], placement, percentage) })
}

// Back-compat wrapper for the Top-of-Search recommendation / manual paths.
export async function applyTopOfSearch(campaignId: string, percentage: number): Promise<unknown> {
  return applyPlacementBias(campaignId, TOP_BID_KEY, percentage)
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
  skippedPaused: number // RC2.T4 — raises skipped because dayparting paused the campaign
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
  // RC2.T4 — respect dayparting: never RAISE top-of-search on a campaign that is
  // currently PAUSED (dayparting pauses dead windows; pushing the slot then just
  // queues more spend for when it un-pauses). Easing off (lower) still applies.
  const candidate = rows.filter((r) => r.action !== 'keep' && r.recommendedPct !== r.currentPct)
  const skippedPaused = candidate.filter((r) => r.action === 'raise' && r.status === 'PAUSED').length
  const actionable = candidate.filter((r) => !(r.action === 'raise' && r.status === 'PAUSED'))
  const sample = actionable.slice(0, 8).map((r) => ({ campaign: r.name, fromPct: r.currentPct, toPct: r.recommendedPct, action: r.action, reason: r.reason }))
  if (opts.dryRun) {
    return { evaluated: rows.length, changed: actionable.length, applied: 0, skippedNotAllowlisted: 0, skippedPaused, dryRun: true, sample }
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
  return { evaluated: rows.length, changed: actionable.length, applied, skippedNotAllowlisted, skippedPaused, dryRun: false, sample }
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
