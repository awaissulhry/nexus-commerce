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
import { microsToCents } from '../ads-core/metrics-math.js'
import { ACTION_HANDLERS, type ActionResult } from '../automation-rule.service.js'
import { logger } from '../../utils/logger.js'
import { nothingHeld, type EngineGuard } from './ads-engine-guard.js'
import { settledBounds, settledLag, settledWhere } from './ads-settled-window.js'
import { settledWindowBounds, type SettledLag } from '@nexus/shared/data-vintage'
import type { AdWriteEvidence } from './ads-evidence.js'
import { brainOwnedCampaignIds } from './bid-brain/live.js'
import { brainSkipsOutput, readLeverHolds, type LeverSkip, type LeverHeld } from './brain/engine-skips.js'

const TOP_REPORT_PLACEMENT = 'Top of Search on-Amazon'
const TOP_BID_KEY = 'PLACEMENT_TOP'
const MAX_PCT = 900
const STEP_PCT = 15 // max change per optimisation run (guardrail)

/**
 * A1 (2026-10-10, Amazon's visibility numbers honest everywhere) — what a Top-of-Search step may rest on.
 *
 * The defense runs every 30 minutes, but its numbers are campaign × day and its window is settled (it ends at the
 * attribution lag), so they change once a day. It used to step ±15 points on EVERY run from the same reading — up to
 * 48 steps a day on one number — with a plain (unweighted) mean of the IS, no count of the days that carry one, no
 * check of how old the newest one is, and with a target IS set but none reported it fell back to ACoS alone without
 * saying so. Now:
 *   · the IS is impression-weighted over the window's settled days that carry Amazon's reading (`weightedIS`, the
 *     one rule placement-grid.service.ts and the campaign list use);
 *   · under a target IS a campaign moves only with ≥ TOS_IS_MIN_DAYS such days, the newest at most
 *     TOS_IS_MAX_LAG_DAYS before the window's last settled day (a settled window ends a week or more before today by
 *     design, so the age is measured from its end); otherwise it holds and says which of the three is missing;
 *   · without a target IS it decides on top-of-search ACoS alone, as before, and says so ("ACoS only: no target IS set");
 *   · a writer (the cron, `defend_top_of_search`, the TOS optimizer) steps a campaign only when a settled day newer than
 *     the one its own last step rested on exists (`newDayGate`; the day is kept as `evidence.dataDay` on the write);
 *   · every reason names the window, the days with a reading and the newest data day.
 */
/** The fewest settled days that must carry Amazon's top-of-search IS before a target IS may move a campaign. */
export const TOS_IS_MIN_DAYS = 5
/** The newest IS reading may sit at most this many days before the window's last settled day. */
export const TOS_IS_MAX_LAG_DAYS = 3
/** The cron's (and the TOS optimizer's) own actor; a rule writes as `automation:<ruleId>`. */
export const TOS_ACTOR = 'automation:tos-optimizer'

const DAY_MS = 86_400_000
const isoDay = (d: Date) => d.toISOString().slice(0, 10)
const dayGap = (later: string, earlier: string) => Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / DAY_MS)
const pct0 = (f: number) => `${(f * 100).toFixed(0)}%`

export interface TosRow {
  campaignId: string
  name: string
  marketplace: string | null
  topImpr: number; topClicks: number; topSpendCents: number; topSalesCents: number
  topAcos: number | null
  /**
   * The campaign's top-of-search impression share as Amazon reports it per campaign and day (0–1), impression-weighted
   * by Nexus over the settled days of the window that carry a reading; null when none does.
   */
  topIS: number | null
  /** A1 — how many settled days of the window carry that reading, and the newest of them (YYYY-MM-DD; null: none). */
  topISDays: number
  topISNewest: string | null
  /** A1 — the settled data day a step rests on: the newest IS day under a target IS, else the newest top-of-search day. */
  dataDay: string | null
  /** A1 — a target IS is set but the IS is missing, on too few days, or too old: the row holds and its reason says which. */
  hold?: 'no-is' | 'thin-is' | 'stale-is'
  currentPct: number
  recommendedPct: number
  action: 'raise' | 'lower' | 'keep'
  reason: string
  status: string // RC2.T4 — so the hold-loop can skip paused campaigns
}

/** A1 — one campaign's facts over the settled window, for the pure decision below. */
export interface TosDecisionInput {
  topSpendCents: number
  topSalesCents: number
  topAcos: number | null
  currentPct: number
  targetAcos: number
  targetIS: number | null
  /** Impression-weighted top-of-search IS of the days with a reading (0–1); null: none. */
  is: number | null
  isDays: number
  isNewest: string | null
  /** The newest settled day with top-of-search data at all (YYYY-MM-DD); null: none. */
  newestDay: string | null
  window: { since: string; until: string; days: number }
}

export type TosDecision = Pick<TosRow, 'action' | 'recommendedPct' | 'reason' | 'dataDay' | 'hold'>

/** A1 — the whole Top-of-Search decision for one campaign. Pure. */
export function decideTopOfSearch(i: TosDecisionInput): TosDecision {
  const win = `the ${i.window.days} settled days ${i.window.since}…${i.window.until}`
  const raise = () => Math.min(MAX_PCT, i.currentPct + STEP_PCT)
  const lower = () => Math.max(0, i.currentPct - STEP_PCT)
  const acosWords = i.topSalesCents > 0 && i.topAcos != null ? `top-of-search ACoS ${pct0(i.topAcos)}` : 'top-of-search spend with no attributed sales'
  if (i.targetIS != null) {
    const dataDay = i.isNewest
    const keep = (reason: string, hold?: TosRow['hold']): TosDecision => ({ action: 'keep', recommendedPct: i.currentPct, reason, dataDay, ...(hold ? { hold } : {}) })
    if (i.topSpendCents === 0 || i.topAcos == null) return keep(`no top-of-search spend in ${win}`)
    const target = pct0(i.targetIS)
    if (i.is == null || i.isDays === 0) return keep(`held: target top-of-search IS ${target} is set, but Amazon reported no top-of-search IS for this campaign in ${win}`, 'no-is')
    if (i.isDays < TOS_IS_MIN_DAYS) return keep(`held: only ${i.isDays} of ${win} carry Amazon's top-of-search IS (newest ${i.isNewest}); at least ${TOS_IS_MIN_DAYS} are needed before the target IS ${target} moves the campaign`, 'thin-is')
    const lag = i.isNewest ? dayGap(i.window.until, i.isNewest) : Number.POSITIVE_INFINITY
    if (lag > TOS_IS_MAX_LAG_DAYS) return keep(`held: the newest top-of-search IS reading (${i.isNewest}) is ${lag} days before the window's last settled day ${i.window.until}; at most ${TOS_IS_MAX_LAG_DAYS} are allowed`, 'stale-is')
    const is = i.is
    const isWords = `the campaign's top-of-search IS (Amazon's, per day) ${pct0(is)}, weighted by impressions over ${i.isDays} of ${win} with a reading, newest ${i.isNewest}`
    // IS-driven, ACOS-bounded: hold the slot for the LEAST cost. Raise only while we're below the impression-share
    // target AND ACOS is in budget; ease off once we're comfortably above target or ACOS runs over.
    const acosInBudget = i.topAcos <= i.targetAcos * 1.1
    if (is < i.targetIS && acosInBudget && i.currentPct < MAX_PCT) {
      return { action: 'raise', recommendedPct: raise(), reason: `${isWords}: below the target ${target} with ${acosWords} in budget — push for top slots`, dataDay }
    }
    if (i.currentPct > 0 && (is >= i.targetIS * 1.1 || i.topAcos >= i.targetAcos * 1.2)) {
      return {
        action: 'lower', recommendedPct: lower(), dataDay,
        reason: is >= i.targetIS * 1.1 ? `${isWords}: comfortably above the target ${target} — ease off for least cost` : `${acosWords} over the target ${pct0(i.targetAcos)} (${isWords}) — ease off`,
      }
    }
    return keep(`${isWords}: within the target ${target}`)
  }
  // No target IS: top-of-search ACoS alone, as before — and said.
  const dataDay = i.newestDay
  const tail = `over ${win} (newest data ${i.newestDay ?? 'none'})`
  const keep = (reason: string): TosDecision => ({ action: 'keep', recommendedPct: i.currentPct, reason: `ACoS only: no target IS set — ${reason}`, dataDay })
  if (i.topSpendCents === 0 || i.topAcos == null) return keep(`no top-of-search spend in ${win}`)
  if (i.topAcos <= i.targetAcos * 0.8 && i.currentPct < MAX_PCT) {
    return { action: 'raise', recommendedPct: raise(), reason: `ACoS only: no target IS set — ${acosWords} well under the target ${pct0(i.targetAcos)} ${tail} — capture more top slots`, dataDay }
  }
  if (i.topAcos >= i.targetAcos * 1.2 && i.currentPct > 0) {
    return { action: 'lower', recommendedPct: lower(), reason: `ACoS only: no target IS set — ${acosWords} over the target ${pct0(i.targetAcos)} ${tail} — ease off`, dataDay }
  }
  return keep(`${acosWords} within the target ${pct0(i.targetAcos)} ${tail}`)
}

/** A1 — the step a writer last made on a campaign: when, and the settled data day it rested on (null: before A1). */
export interface LastTosStep {
  at: Date
  dataDay: string | null
}

/**
 * A1 — may a writer step this campaign again? Only when its data day is newer than the one its own last step rested
 * on. A step from before A1 kept no data day: the newest it could have read is the settled window's end on its day.
 * Pure.
 */
export function newDayGate(dataDay: string | null, last: LastTosStep | null, lag: SettledLag = settledLag()): { ok: boolean; why?: string } {
  if (!dataDay) return { ok: false, why: 'held: no settled day with data to rest a step on' }
  if (!last) return { ok: true }
  const lastDay = last.dataDay ?? isoDay(settledWindowBounds(1, 'SPONSORED_PRODUCTS', { now: last.at, lag }).until)
  if (dataDay > lastDay) return { ok: true }
  return { ok: false, why: `held: its last step (${isoDay(last.at)}) already rested on settled data through ${lastDay}; the next step waits for a newer settled day (newest now ${dataDay})` }
}

/** A1 — per campaign, the newest placement write this actor made that was not refused (a refused write changed nothing). */
async function lastTosSteps(campaignIds: readonly string[], actor: string): Promise<Map<string, LastTosStep>> {
  const out = new Map<string, LastTosStep>()
  if (!campaignIds.length) return out
  const ids = [...campaignIds]
  const rows = await prisma.$queryRaw<Array<{ entityId: string; createdAt: Date; dataDay: string | null }>>`
    SELECT DISTINCT ON ("entityId") "entityId", "createdAt", evidence->>'dataDay' AS "dataDay"
      FROM "AdvertisingActionLog"
     WHERE "actionType" = 'update_placement_bidding' AND "entityType" = 'CAMPAIGN'
       AND "entityId" = ANY(${ids}::text[]) AND "userId" = ${actor}
       AND COALESCE("payloadAfter"->>'mode', '') <> 'blocked'
     ORDER BY "entityId", "createdAt" DESC`
  for (const r of rows ?? []) out.set(r.entityId, { at: new Date(r.createdAt), dataDay: r.dataDay ?? null })
  return out
}

/** A1 — the evidence a step carries, so the next run knows which settled day it rested on. */
function stepEvidence(r: TosRow, windowDays: number): AdWriteEvidence {
  return { ...(r.dataDay ? { dataDay: r.dataDay } : {}), windowDays, ...(r.topISDays ? { sampleSize: r.topISDays, sampleUnit: 'days' as const } : {}) }
}

export async function analyzeTopOfSearch(opts: { windowDays?: number; marketplace?: string; targetAcos?: number; targetIS?: number } = {}): Promise<{ windowDays: number; targetAcos: number; targetIS: number | null; window: { since: string; until: string }; rows: TosRow[] }> {
  const windowDays = Math.max(7, Math.min(90, opts.windowDays ?? 30))
  const targetAcos = opts.targetAcos ?? 0.25
  const targetIS = opts.targetIS ?? null
  // 6c — settled: `windowDays` days ending at the ad product's attribution lag, so the ACoS this
  // decides on is not today's spend against sales Amazon has not attributed yet.
  const bounds = settledBounds(windowDays)
  const window = { since: isoDay(bounds.since), until: isoDay(bounds.until) }
  const where = { placement: TOP_REPORT_PLACEMENT, ...settledWhere(windowDays) }
  const perf = await prisma.amazonAdsPlacementReport.groupBy({
    by: ['campaignId'],
    where,
    _sum: { impressions: true, clicks: true, costMicros: true, sales7dCents: true, orders7d: true },
    _max: { date: true },
  })
  const extIds = perf.map((p) => p.campaignId)
  if (extIds.length === 0) return { windowDays, targetAcos, targetIS, window, rows: [] }
  const campaigns = await prisma.campaign.findMany({
    where: { externalCampaignId: { in: extIds }, ...(opts.marketplace ? { marketplace: opts.marketplace } : {}) },
    select: { id: true, name: true, marketplace: true, externalCampaignId: true, dynamicBidding: true, status: true },
  })
  const byExt = new Map(campaigns.map((c) => [c.externalCampaignId!, c]))
  // A1 — Amazon's top-of-search IS per campaign and settled day (stored on the TOP row), weighted by that day's
  // top-of-search impressions. Imported lazily: placement-grid.service.ts reaches this file through the rank engine.
  const isRows = await prisma.amazonAdsPlacementReport.findMany({
    where: { ...where, campaignId: { in: [...byExt.keys()] }, topOfSearchIS: { not: null } },
    select: { campaignId: true, date: true, impressions: true, topOfSearchIS: true },
  })
  const isPoints = new Map<string, Array<{ day: string; value: number; weight: number }>>()
  for (const r of isRows ?? []) {
    if (r.topOfSearchIS == null) continue
    const pts = isPoints.get(r.campaignId) ?? []
    pts.push({ day: isoDay(r.date), value: Number(r.topOfSearchIS), weight: r.impressions ?? 0 })
    isPoints.set(r.campaignId, pts)
  }
  const { weightedIS } = isPoints.size ? await import('./placement-grid.service.js') : { weightedIS: () => null }

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
    const pts = isPoints.get(p.campaignId) ?? []
    const isDays = new Set(pts.map((x) => x.day)).size
    const topISNewest = pts.length ? pts.map((x) => x.day).sort()[pts.length - 1] : null
    const topIS = pts.length ? weightedIS(pts) : null
    const db = (c.dynamicBidding ?? {}) as { placementBidding?: Array<{ placement: string; percentage: number }> }
    const currentPct = db.placementBidding?.find((x) => x.placement === TOP_BID_KEY)?.percentage ?? 0
    const decision = decideTopOfSearch({
      topSpendCents, topSalesCents, topAcos, currentPct, targetAcos, targetIS,
      is: topIS, isDays, isNewest: topISNewest,
      newestDay: p._max?.date ? isoDay(new Date(p._max.date)) : null,
      window: { ...window, days: windowDays },
    })
    rows.push({ campaignId: c.id, name: c.name, marketplace: c.marketplace, topImpr: p._sum.impressions ?? 0, topClicks: p._sum.clicks ?? 0, topSpendCents, topSalesCents, topAcos, topIS, topISDays: isDays, topISNewest, currentPct, ...decision, status: c.status })
  }
  rows.sort((a, b) => b.topSpendCents - a.topSpendCents)
  return { windowDays, targetAcos, targetIS, window, rows }
}

const REST_BID_KEY = 'PLACEMENT_REST_OF_SEARCH'
const clampPct = (p: number) => Math.max(0, Math.min(MAX_PCT, Math.round(p)))

// PP — generic: set ONE placement's bias, preserving the others.
// A1 — `evidence` (optional) rides to the audit row; the Top-of-Search writers keep their step's settled data day there.
export async function applyPlacementBias(campaignId: string, placement: string, percentage: number, opts?: { actor?: string; reason?: string; evidence?: AdWriteEvidence }): Promise<unknown> {
  const { updatePlacementBidding } = await import('./ads-create.service.js')
  const c = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { dynamicBidding: true } })
  const db = (c?.dynamicBidding ?? {}) as { placementBidding?: Array<{ placement: string; percentage: number }> }
  const others = (db.placementBidding ?? []).filter((x) => x.placement !== placement)
  const adjustments = [...others, { placement, percentage: clampPct(percentage) }]
  return updatePlacementBidding({ campaignId, adjustments, actor: opts?.actor, reason: opts?.reason, ...(opts?.evidence ? { evidence: opts.evidence } : {}) })
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

/**
 * HX.1 — `opts` carries the actor and reason down to the audit trail.
 *
 * This function is how the rank loop physically holds a rank, and it used to forward no attribution
 * at all — so every placement change in the account was logged with a null actor and could not be
 * traced to the schedule, family plan or operator that caused it. Optional so existing manual /
 * recommendation call sites keep working unchanged; they simply record no actor, as before.
 */
export async function setSearchPlacement(campaignId: string, placement: string, percentage: number, opts?: { actor?: string; reason?: string }): Promise<unknown> {
  const { updatePlacementBidding } = await import('./ads-create.service.js')
  const c = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { dynamicBidding: true } })
  const db = (c?.dynamicBidding ?? {}) as { placementBidding?: Array<{ placement: string; percentage: number }> }
  return updatePlacementBidding({ campaignId, adjustments: buildSearchPlacementAdjustments(db.placementBidding ?? [], placement, percentage), actor: opts?.actor, reason: opts?.reason })
}

// Back-compat wrapper for the Top-of-Search recommendation / manual paths.
export async function applyTopOfSearch(campaignId: string, percentage: number, opts?: { actor?: string; reason?: string; evidence?: AdWriteEvidence }): Promise<unknown> {
  return applyPlacementBias(campaignId, TOP_BID_KEY, percentage, opts)
}

/**
 * Auto-apply every raise/lower recommendation (within the step/cap guardrails).
 * A1 — one step per campaign per new settled day (`newDayGate`); a move it holds for that is listed in `held`.
 */
export async function applyTopOfSearchRecommendations(opts: { windowDays?: number; marketplace?: string; targetAcos?: number } = {}): Promise<{ applied: number; rows: TosRow[]; held: Array<{ campaignId: string; reason: string }> }> {
  const { windowDays, rows } = await analyzeTopOfSearch(opts)
  let applied = 0
  const held: Array<{ campaignId: string; reason: string }> = []
  // BB-6 — never on a campaign the bid brain owns (one writer per campaign).
  const brainOwned = await brainOwnedCampaignIds(rows.map((r) => r.campaignId))
  // ONE BRAIN AB-6 — nor on one whose placements a product's brain owns or the Owner holds (brain/engine-skips.ts).
  const leverHolds = await readLeverHolds(rows.filter((r) => !brainOwned.has(r.campaignId)).map((r) => r.campaignId), { actor: TOS_ACTOR }, 'tos-optimizer')
  const moving = rows.filter((r) => !brainOwned.has(r.campaignId) && r.action !== 'keep' && r.recommendedPct !== r.currentPct)
  const last = await lastTosSteps(moving.map((r) => r.campaignId), TOS_ACTOR)
  for (const r of moving) {
    if (leverHolds.skip(r.campaignId, 'placements')) continue
    const gate = newDayGate(r.dataDay, last.get(r.campaignId) ?? null)
    if (!gate.ok) { held.push({ campaignId: r.campaignId, reason: gate.why }); continue }
    await applyTopOfSearch(r.campaignId, r.recommendedPct, { actor: TOS_ACTOR, reason: r.reason, evidence: stepEvidence(r, windowDays) })
    applied += 1
  }
  return { applied, rows, held }
}

/**
 * 4m (review 3.7) — why another automation left a campaign alone that Hourly Bids holds (`rankOwnedCampaignIds`:
 * an enabled goal schedule, or an enabled product plan's campaigns). Per campaign without `count`; a run's total with it.
 */
export function rankOwnedWhy(what: string, count?: number): string {
  const tail = `two writers on the same ${what} would undo each other.`
  if (count == null) return `Hourly Bids holds this campaign (an enabled schedule or product plan) and sets its ${what}, so this automation leaves it alone: ${tail}`
  const one = count === 1
  return `Hourly Bids holds ${count} ${one ? 'campaign' : 'campaigns'} here (an enabled schedule or product plan) and sets ${one ? 'its' : 'their'} ${what}, so this automation left ${one ? 'it' : 'them'} alone: ${tail}`
}

// ── Apex D.2 — autonomous Top-of-Search defense ───────────────────────────
// Tune the PLACEMENT_TOP multiplier toward the target so a campaign holds the
// top slot when ROAS allows and eases off when it doesn't — toward a target
// top-of-search IS only when one is given (else on top-of-search ACoS alone),
// one step per campaign per new settled day (A1, above). Shared by the
// scheduled cron (top-of-search-defense) and the defend_top_of_search rule
// action. Live writes are clipped (±STEP_PCT, ≤MAX_PCT) AND restricted to
// allowlisted campaigns when allowlistedOnly.
//
// ADX A2 — this comment used to say placement writes hit the write-gate WITHOUT a
// campaignId, so the A.2a per-campaign allowlist had to be enforced here instead.
// That is no longer true: C1 added `campaignId` to the gate call in
// updatePlacementBidding, so the allowlist now binds placement writes at the
// chokepoint like every other write. The `allowlistedOnly` filter below is a second,
// earlier check — belt and braces, not the only guard. Left stale, the old wording
// asserted a safety hole that had already been closed, which is its own hazard.
export interface DefendTosResult {
  evaluated: number
  changed: number
  applied: number
  skippedNotAllowlisted: number
  skippedPaused: number // RC2.T4 — raises skipped because the campaign is paused
  /** 4m (review 3.7) — moves left alone because Hourly Bids holds the campaign (`rankOwnedCampaignIds`). */
  skippedRankOwned: number
  /** 4m — the same, in plain words; absent when none was left alone. */
  rankOwnedNote?: string
  /** BB-6 — moves left alone because the bid brain owns the campaign (one writer per campaign). */
  skippedBrainOwned?: number
  /** ONE BRAIN AB-6 — moves left alone because a product's brain owns (or the Owner holds) the campaign's placements. */
  brainSkips?: { counts: LeverHeld; sample?: unknown[]; unread?: string }
  /** A1 — moves held because no settled day newer than this writer's last step exists yet (absent when none). */
  heldNoNewDay?: number
  /** A1 — campaigns held because a target IS is set but Amazon's IS is missing, on too few days or too old (absent when none). */
  heldNoUsableIS?: number
  /** A1 — up to 8 of those holds, each with its reason (window, days with a reading, newest data day). */
  heldSample?: Array<{ campaign: string; reason: string }>
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
  /** Who writes: the cron's own actor by default; a rule passes its own (automation:<ruleId>) so its write cap counts. */
  actor?: string
  /** 1d — the cron's guard (the account dial and its caps), asked once per campaign before its one write. A rule passes none. */
  guard?: EngineGuard
} = {}): Promise<DefendTosResult> {
  const { windowDays, rows } = await analyzeTopOfSearch({ targetAcos: opts.targetAcos, targetIS: opts.targetIS, marketplace: opts.marketplace, windowDays: opts.windowDays })
  const actor = opts.actor ?? TOS_ACTOR
  // RC2.T4 — never RAISE top-of-search on a campaign that is currently PAUSED (pushing the slot
  // then just queues more spend for when it is resumed). Easing off (lower) still applies.
  // 4m (review 3.7) — a campaign Hourly Bids holds is left alone, raise or lower: the rank engine sets its Top of
  // Search every run, so a second writer here would only be undone (and undo it). Asked before the dry-run return, so a
  // preview never offers the move either.
  const { rankOwnedCampaignIds } = await import('./rank-release.service.js')
  const rankOwned = await rankOwnedCampaignIds()
  const candidate = rows.filter((r) => r.action !== 'keep' && r.recommendedPct !== r.currentPct)
  // BID BRAIN BB-6 — a campaign the brain owns has one writer, the brain: its placements are left to it too.
  const brainOwned = await brainOwnedCampaignIds(candidate.map((r) => r.campaignId))
  const notBidBrain = candidate.filter((r) => !brainOwned.has(r.campaignId))
  const skippedBrainOwned = candidate.length - notBidBrain.length
  // ONE BRAIN AB-6 — and a campaign whose placements a product's brain owns, or the Owner holds at his own value
  // (brain/engine-skips.ts), asked before the dry-run return so a preview never offers the move either. Read once per run.
  const leverHolds = await readLeverHolds(notBidBrain.map((r) => r.campaignId), { actor }, 'tos-defense')
  const leftToBrain: LeverSkip[] = []
  const notBrain = notBidBrain.filter((r) => {
    const skip = leverHolds.skip(r.campaignId, 'placements')
    if (skip) leftToBrain.push(skip)
    return !skip
  })
  const free = notBrain.filter((r) => !rankOwned.has(r.campaignId))
  const skippedRankOwned = notBrain.length - free.length
  const rankOwnedNote = skippedRankOwned > 0 ? rankOwnedWhy('Top of Search placement', skippedRankOwned) : undefined
  const skippedPaused = free.filter((r) => r.action === 'raise' && r.status === 'PAUSED').length
  const unpaused = free.filter((r) => !(r.action === 'raise' && r.status === 'PAUSED'))
  // A1 — one step per campaign per new settled day: this writer's own last step must rest on an older day. Asked
  // before the dry-run return, so a preview offers only the moves a real run would make.
  const last = await lastTosSteps(unpaused.map((r) => r.campaignId), actor)
  const waiting: Array<{ campaign: string; reason: string }> = []
  const actionable = unpaused.filter((r) => {
    const gate = newDayGate(r.dataDay, last.get(r.campaignId) ?? null)
    if (!gate.ok) waiting.push({ campaign: r.name, reason: gate.why })
    return gate.ok
  })
  const noIS = rows.filter((r) => r.hold)
  const heldSample = [...waiting, ...noIS.map((r) => ({ campaign: r.name, reason: r.reason }))].slice(0, 8)
  const sample = actionable.slice(0, 8).map((r) => ({ campaign: r.name, fromPct: r.currentPct, toPct: r.recommendedPct, action: r.action, reason: r.reason }))
  const held = {
    skippedRankOwned, ...(rankOwnedNote ? { rankOwnedNote } : {}), ...(skippedBrainOwned ? { skippedBrainOwned } : {}),
    ...(brainSkipsOutput(leverHolds.counts(), leftToBrain, leverHolds.unread) as Pick<DefendTosResult, 'brainSkips'>),
    ...(waiting.length ? { heldNoNewDay: waiting.length } : {}), ...(noIS.length ? { heldNoUsableIS: noIS.length } : {}),
    ...(heldSample.length ? { heldSample } : {}),
  }
  if (opts.dryRun) {
    return { evaluated: rows.length, changed: actionable.length, applied: 0, skippedNotAllowlisted: 0, skippedPaused, ...held, dryRun: true, sample }
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
    const permit = opts.guard?.permit()
    if (permit && !permit.forward) { opts.guard!.settle(permit, 0, { ...nothingHeld(), forward: true }); continue }
    await applyTopOfSearch(r.campaignId, r.recommendedPct, { actor, reason: r.reason, evidence: stepEvidence(r, windowDays) })
    applied += 1
    if (permit) opts.guard!.settle(permit, 1, nothingHeld())
  }
  return { evaluated: rows.length, changed: actionable.length, applied, skippedNotAllowlisted, skippedPaused, ...held, dryRun: false, sample }
}

/**
 * A4 — a rule's `targetIS` is a FRACTION (0.5 = 50 %), the unit the defense, the cron's NEXUS_TOS_TARGET_IS and the
 * stored IS all use. Anything else is refused, not converted: 25 meant as 25 % used to be compared with a fraction and
 * raised every campaign forever, and a value like 0.8 cannot be told apart from 0.8 % — so the rule says what it got
 * and changes nothing. Absent: no target IS (the defense decides on ACoS alone and says so). Pure.
 */
export function ruleTargetIS(raw: unknown): { ok: boolean; targetIS?: number; error?: string } {
  if (raw === undefined || raw === null) return { ok: true, targetIS: undefined }
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0 && raw <= 1) return { ok: true, targetIS: raw }
  return { ok: false, error: `targetIS must be a fraction above 0 and at most 1 (0.5 = 50 % top-of-search impression share); got ${JSON.stringify(raw)}. Nothing was changed.` }
}

// Rule action — same engine, allowlist-enforced, dry-run honored from rule meta.
ACTION_HANDLERS.defend_top_of_search = async (action, _context, meta): Promise<ActionResult> => {
  const target = ruleTargetIS(action.targetIS)
  if (!target.ok) return { type: action.type, ok: false, error: target.error }
  const r = await defendTopOfSearch({
    targetAcos: typeof action.targetAcos === 'number' ? (action.targetAcos as number) : undefined,
    targetIS: target.targetIS,
    marketplace: typeof action.marketplace === 'string' ? (action.marketplace as string) : undefined,
    windowDays: typeof action.windowDays === 'number' ? (action.windowDays as number) : undefined,
    allowlistedOnly: true,
    dryRun: meta.dryRun,
    // Part 06 fix — the rule's own actor, so its maxWritesPerDay counts these writes (it wrote as the cron before).
    actor: `automation:${meta.ruleId}`,
  })
  return { type: action.type, ok: true, output: r }
}

logger.debug('[D.2] defend_top_of_search handler registered')
