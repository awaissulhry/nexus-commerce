/**
 * RS.5 — the continuous rank-defend loop. For each enabled GOAL-mode AdSchedule
 * (windows carry a targetKey and/or a defaultTargetKey baseline), resolve which
 * RankTarget governs right now, read the campaign's achieved Top-of-Search
 * impression share + ACOS, and converge the PLACEMENT_TOP bias toward the
 * target's IS — pushing to re-take the slot, easing off to respect the profit
 * ceiling (or ignoring ACOS in all-out mode). This is the engine behind "hold
 * rank these hours, the baseline the rest, and snap back when we lose it".
 *
 * Reuses the proven plumbing: analyzeTopOfSearch (signals) + applyTopOfSearch
 * (gated actuation) + the pure controller (rank-controller.ts). Sandbox-safe —
 * applyTopOfSearch writes locally and only pushes to Amazon when the write-gate
 * is open. Cron is OFF unless NEXUS_ENABLE_RANK_DEFEND=1; the run-now endpoint
 * (dryRun) previews decisions without writing.
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { computeStep, resolveActiveTargetKey, isRankLoss, cpcCapPct, strategyHeadroom, type RankTargetSpec, type LaneSpec, type ScheduleWindow } from '../services/advertising/rank-controller.js'
import { analyzeTopOfSearch, setSearchPlacement, buildBlendedAdjustments } from '../services/advertising/ads-top-of-search.service.js'
import { sqpImpressionShareForAsins } from '../services/advertising/sqp.service.js'
import { updateCampaignWithSync, updateAdGroupWithSync, type AdsActor } from '../services/advertising/ads-mutation.service.js'
import { suppressCampaignBids, restoreCampaignBids, refloorCampaignBids, normaliseFloorCents, applyBaseBidDelta, revertBaseBidDelta } from '../services/advertising/ads-bid-suppression.service.js'
import { detectSelfCompetition, type CampaignTargeting, type SelfCompetitionConflict } from '../services/advertising/rank-self-competition.js'

// Clock source for time-of-day window resolution: the DATABASE clock, not the container's process
// clock. Railway cron containers have exhibited multi-hour clock skew (the process clock ran ~2h
// behind real time while Postgres stayed correct), which silently shifted every rank/dayparting
// window. Sourcing "now" from Postgres makes window selection immune to container clock drift.
async function dbNow(): Promise<Date> {
  try {
    const rows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() as now`
    const n = rows?.[0]?.now
    if (n instanceof Date) return n
    if (n) return new Date(n as unknown as string)
  } catch { /* fall through to process clock */ }
  return new Date()
}

// RD.8 — leadMinutes shifts the evaluation clock forward so a plan starts converging
// BEFORE a window opens (Amazon bid changes propagate with lag → arrive at-rank, not late).
// baseNow: the authoritative clock (pass dbNow()); defaults to the process clock only as a fallback.
function nowInTz(tz: string, leadMinutes = 0, baseNow?: Date): { day: number; hour: number } {
  const baseMs = (baseNow ?? new Date()).getTime()
  const at = leadMinutes ? new Date(baseMs + leadMinutes * 60_000) : new Date(baseMs)
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(at)
  const wk = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun'
  const hourStr = parts.find((p) => p.type === 'hour')?.value ?? '0'
  const dayIdx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wk)
  let hour = parseInt(hourStr, 10) % 24
  if (Number.isNaN(hour)) hour = 0
  return { day: dayIdx < 0 ? 0 : dayIdx, hour }
}

interface RankTargetRow { key: string; placement: string; targetISPct: number | null; acosCapPct: number | null; maxCpcCents: number | null; biasPct: number | null; pause: boolean; floorBidCents?: number | null; allOut: boolean; jumpStartPct?: number | null; stepUpPct?: number | null; stepDownPct?: number | null; maxBiasPct?: number | null; keepClimbing?: boolean; lanes?: unknown; bidMode?: string | null; bidValueCents?: number | null; bidDeltaPct?: number | null }
const toSpec = (t: RankTargetRow): RankTargetSpec => ({ key: t.key, placement: t.placement, targetISPct: t.targetISPct, acosCapPct: t.acosCapPct, maxCpcCents: t.maxCpcCents, biasPct: t.biasPct, pause: t.pause, floorBidCents: t.floorBidCents ?? null, allOut: t.allOut, jumpStartPct: t.jumpStartPct ?? null, stepUpPct: t.stepUpPct ?? null, stepDownPct: t.stepDownPct ?? null, maxBiasPct: t.maxBiasPct ?? null, keepClimbing: !!t.keepClimbing, lanes: Array.isArray(t.lanes) ? (t.lanes as LaneSpec[]) : null, bidMode: t.bidMode ?? null, bidValueCents: t.bidValueCents ?? null, bidDeltaPct: t.bidDeltaPct ?? null })

// RTC — merge per-scope target overrides onto a spec, keyed by the spec's own target
// key. Maps apply in order, so later (more specific) wins: product then campaign.
type TargetOverride = { biasPct?: number; targetISPct?: number; acosCapPct?: number; maxCpcCents?: number; floorBidCents?: number; jumpStartPct?: number; stepUpPct?: number; stepDownPct?: number; maxBiasPct?: number; keepClimbing?: boolean; lanes?: LaneSpec[]; bidMode?: string | null; bidValueCents?: number | null; bidDeltaPct?: number | null }
type TargetOverrideMap = Record<string, TargetOverride> | null | undefined
export function applyTargetOverrides(spec: RankTargetSpec, ...maps: TargetOverrideMap[]): RankTargetSpec {
  let out = spec
  for (const m of maps) {
    const o = m?.[out.key]
    if (!o) continue
    out = {
      ...out,
      ...(o.biasPct != null ? { biasPct: o.biasPct } : {}),
      ...(o.targetISPct != null ? { targetISPct: o.targetISPct } : {}),
      ...(o.acosCapPct != null ? { acosCapPct: o.acosCapPct } : {}),
      ...(o.maxCpcCents != null ? { maxCpcCents: o.maxCpcCents } : {}),
      // MB.1 — a campaign can hold a different Min-bid floor from the library default
      // (a hero SKU floored at 10¢ where the rest of the family sits at 2¢).
      ...(o.floorBidCents != null ? { floorBidCents: o.floorBidCents } : {}),
      // MP — motion knobs are overridable per product/campaign too (campaign wins).
      ...(o.jumpStartPct != null ? { jumpStartPct: o.jumpStartPct } : {}),
      ...(o.stepUpPct != null ? { stepUpPct: o.stepUpPct } : {}),
      ...(o.stepDownPct != null ? { stepDownPct: o.stepDownPct } : {}),
      ...(o.maxBiasPct != null ? { maxBiasPct: o.maxBiasPct } : {}),
      ...(o.keepClimbing !== undefined ? { keepClimbing: o.keepClimbing } : {}),
      // BL.9 — per-scope BLEND override: a product/campaign can set its OWN lanes +
      // base-bid (not just scalar tweaks), so a blend can be campaign-specific. An empty
      // lanes array explicitly clears the blend at this scope (back to single-placement).
      ...(Array.isArray(o.lanes) ? { lanes: o.lanes } : {}),
      ...(o.bidMode !== undefined ? { bidMode: o.bidMode } : {}),
      ...(o.bidValueCents !== undefined ? { bidValueCents: o.bidValueCents } : {}),
      ...(o.bidDeltaPct !== undefined ? { bidDeltaPct: o.bidDeltaPct } : {}),
    }
  }
  return out
}
// A schedule is goal-mode (owned by the rank-defend loop, NOT dayparting) once it
// carries a baseline targetKey or any window targetKey. Exported so the dayparting
// cron can skip these — otherwise both crons fight over the same campaign.
export const isGoalMode = (windows: unknown, defaultTargetKey: string | null): boolean =>
  !!defaultTargetKey || (Array.isArray(windows) && windows.some((w) => w && typeof w === 'object' && (w as { targetKey?: string }).targetKey))

/**
 * RDX/A1 — collapse per-schedule receipts into one UPDATE per distinct resolved target key.
 * Pure + exported so the stamping can be tested without a database: mis-grouping here would
 * silently write the WRONG target key onto a schedule, which is worse than writing none.
 */
/**
 * G2 — which event governs a schedule right now.
 *
 * Pure and exported because this decides what the engine HOLDS: picking the wrong event, or
 * picking one at all when none applies, changes live bids. The rules are small enough to state and
 * therefore small enough to test, which is the only reason to trust them.
 *
 *  · An event covers [startsAt, endsAt) — half-open, so back-to-back events (a lead-in ending
 *    exactly when the event begins) never both apply for one instant.
 *  · Overlaps resolve to the LATEST-STARTED. A lead-out authored to begin while the event is still
 *    running is a deliberate hand-over, not a conflict.
 *  · Disabled events are invisible. Authoring ahead of time is the normal case.
 */
export interface RankEventLike { groupId: string; startsAt: Date; endsAt: Date; enabled?: boolean; name?: string }
export function pickActiveEvents<T extends RankEventLike>(events: T[], at: Date): Map<string, T> {
  const out = new Map<string, T>()
  for (const e of events) {
    if (e.enabled === false) continue
    if (!(e.startsAt <= at && e.endsAt > at)) continue
    const cur = out.get(e.groupId)
    if (!cur || e.startsAt > cur.startsAt) out.set(e.groupId, e)
  }
  return out
}

export function groupReceipts(receipts: Map<string, string | null>): Map<string | null, string[]> {
  const byKey = new Map<string | null, string[]>()
  for (const [id, key] of receipts) {
    const arr = byKey.get(key) ?? []
    arr.push(id)
    byKey.set(key, arr)
  }
  return byKey
}

export interface RankDefendDecision {
  campaignId: string; campaignName: string; targetKey: string; action: string; reason: string
  currentPct: number; nextPct: number; achievedISPct: number | null; achievedAcosPct: number | null; lossDetected: boolean; applied: boolean
  planId?: string | null
  // BL — per-placement decisions when the target is a blend (Top/Rest/Product driven at once).
  lanes?: Array<{ placement: string; fromPct: number; toPct: number; action: string }>
  baseBid?: { mode: string; valueCents?: number | null } | null // BL — base-bid directive applied
}
export interface RankPlanRunSummary { planId: string; productId: string; marketplace: string; campaigns: number; decisions: RankDefendDecision[]; selfCompetition?: SelfCompetitionConflict[] }
export interface RankDefendSummary { evaluated: number; applied: number; decisions: RankDefendDecision[]; plans?: RankPlanRunSummary[] }

const pctOf = (f: number | null): number | null => (f != null ? Math.round(f * 100) : null)
type SigMap = Map<string, { currentPct: number; topIS: number | null; topAcos: number | null }>
interface CampRow { id: string; name: string; status: string; dynamicBidding: unknown; biddingStrategy?: string | null; bidsSuppressedAt?: Date | null; bidsSuppressedFloorCents?: number | null; deliveryReasons?: string[] }

// RD.4 — one per-campaign decision body, shared by the schedule loop and the
// product-plan fan-out. `write` gates ALL actuation (pause / resume / placement
// bias); when false it is a pure decision (preview / plan dry-run). currentPct is
// always read from dynamicBidding (the bias WE control), never the sparse T+1
// placement report — else the loop is blind to its own prior changes.
// BL — expand one lane into a single-placement RankTargetSpec the controller understands.
function laneToSpec(parent: RankTargetSpec, lane: LaneSpec): RankTargetSpec {
  return {
    key: parent.key, placement: lane.placement, biasPct: lane.biasPct,
    maxBiasPct: lane.maxBiasPct ?? null, targetISPct: lane.targetISPct ?? null, acosCapPct: lane.acosCapPct ?? null,
    maxCpcCents: parent.maxCpcCents, stepUpPct: lane.stepUpPct ?? null, stepDownPct: lane.stepDownPct ?? null,
    keepClimbing: !!lane.keepClimbing, allOut: !!lane.allOut, pause: false, jumpStartPct: null,
  }
}
const SHORT_PLACE: Record<string, string> = { PLACEMENT_TOP: 'Top', PLACEMENT_REST_OF_SEARCH: 'Rest', PLACEMENT_PRODUCT_PAGE: 'Product' }
const shortPlace = (p: string) => SHORT_PLACE[p] ?? p
function baseBidNote(spec: RankTargetSpec): string {
  if (!spec.bidMode || spec.bidMode === 'hold') return ''
  if (spec.bidMode === 'absolute' && spec.bidValueCents != null) return ` · base bid €${(spec.bidValueCents / 100).toFixed(2)}`
  if (spec.bidMode === 'deltaPct' && spec.bidDeltaPct != null) return ` · base bid ${spec.bidDeltaPct >= 0 ? '+' : ''}${spec.bidDeltaPct}%`
  if (spec.bidMode === 'suppress') return ' · base bid floored'
  return ` · base ${spec.bidMode}`
}
// BL — compare placementBidding arrays as {placement→pct} maps, ignoring order and
// treating 0/absent as equal, so the engine never churns a no-op write each tick.
function samePlacements(a: Array<{ placement: string; percentage: number }>, b: Array<{ placement: string; percentage: number }>): boolean {
  const m = (arr: Array<{ placement: string; percentage: number }>) => {
    const o: Record<string, number> = {}
    for (const x of arr ?? []) if (x.percentage) o[x.placement] = x.percentage
    return o
  }
  const ma = m(a), mb = m(b)
  for (const k of new Set([...Object.keys(ma), ...Object.keys(mb)])) if ((ma[k] ?? 0) !== (mb[k] ?? 0)) return false
  return true
}
// BL — apply the target's base-bid directive (the base bid placement multipliers stack
// on). hold/null = no change (but still revert any prior delta); absolute = set ad-group
// default to bidValueCents (idempotent); suppress = floor to ~2¢ (placements stay set);
// deltaPct (BL.7) = scale every bid ±% from a stable baseline (no compounding). Returns writes.
async function applyBaseBidDirective(camp: CampRow, spec: RankTargetSpec, ctx: { write: boolean; actor: string }): Promise<number> {
  if (!ctx.write) return 0
  let n = 0
  const mode = spec.bidMode
  // Leaving deltaPct (or never in it) → restore each entity's stable baseline + clear it.
  if (mode !== 'deltaPct') {
    try { n += await revertBaseBidDelta(camp.id, { actor: ctx.actor as AdsActor }) } catch (e) { logger.warn('[rank-defend] base-bid delta revert failed', { campaignId: camp.id, error: (e as Error).message }) }
  }
  if (!mode || mode === 'hold') return n
  if (mode === 'suppress') {
    if (!camp.bidsSuppressedAt) {
      try { n += await suppressCampaignBids(camp.id, { actor: ctx.actor as AdsActor, reason: 'rank base-bid = suppress (placements stay set)' }) } catch (e) { logger.warn('[rank-defend] base-bid suppress failed', { campaignId: camp.id, error: (e as Error).message }) }
    }
    return n
  }
  if (mode === 'absolute' && spec.bidValueCents != null && spec.bidValueCents > 0) {
    const ags = await prisma.adGroup.findMany({ where: { campaignId: camp.id }, select: { id: true, defaultBidCents: true } })
    for (const g of ags) {
      if (g.defaultBidCents === spec.bidValueCents) continue
      try { const r = await updateAdGroupWithSync({ adGroupId: g.id, patch: { defaultBidCents: spec.bidValueCents }, actor: ctx.actor as AdsActor, reason: 'rank base-bid (absolute)', applyImmediately: true }); if (r.ok) n++ } catch (e) { logger.warn('[rank-defend] base-bid absolute failed', { campaignId: camp.id, adGroupId: g.id, error: (e as Error).message }) }
    }
    return n
  }
  if (mode === 'deltaPct' && spec.bidDeltaPct != null) {
    try { n += await applyBaseBidDelta(camp.id, spec.bidDeltaPct, { actor: ctx.actor as AdsActor, reason: `rank base-bid ${spec.bidDeltaPct >= 0 ? '+' : ''}${spec.bidDeltaPct}%` }) } catch (e) { logger.warn('[rank-defend] base-bid delta failed', { campaignId: camp.id, error: (e as Error).message }) }
    return n
  }
  return n
}

async function decideAndMaybeApply(
  camp: CampRow, key: string, spec: RankTargetSpec, planId: string | null,
  ctx: { write: boolean; actor: string; sigByCampaign: SigMap; lossByCampaign: Map<string, boolean>; suppressRaise?: boolean; sqpByCampaign?: Map<string, number | null>; maxBaseBidByCampaign?: Map<string, number> },
): Promise<{ decision: RankDefendDecision; applied: number }> {
  const sigRaw = ctx.sigByCampaign.get(camp.id) ?? { currentPct: 0, topIS: null, topAcos: null }
  const cdb = (camp.dynamicBidding ?? {}) as { placementBidding?: Array<{ placement: string; percentage: number }> }
  // PP — read the bias of the TARGET's placement (Top for own-top/defend/all-out, Rest
  // for rest-of-search), not always Top. The engine drives whichever placement the
  // active target names.
  const currentPct = cdb.placementBidding?.find((x) => x.placement === spec.placement)?.percentage ?? 0
  const base = { campaignId: camp.id, campaignName: camp.name, targetKey: key, currentPct, achievedISPct: pctOf(sigRaw.topIS), achievedAcosPct: pctOf(sigRaw.topAcos), planId }
  let applied = 0
  // NP — no-pause: a Pause target (or OOS/lost-buybox via effectiveSpec) drops every
  // bid to the floor (~2¢) and keeps the campaign ENABLED — NEVER status=PAUSED, which
  // disrupts Amazon's algorithm. Prior bids are remembered for exact restore. Idempotent.
  if (spec.pause) {
    // MB.1 — the floor is the target's own (per-campaign overridable), not a constant.
    const floor = normaliseFloorCents(spec.floorBidCents)
    // Already floored at exactly this value → nothing to do, and deliberately no scan. The
    // pre-MB.1 code did no database work at all on a suppressed campaign, and a Min-bid
    // baseline can hold 54 hours a week across every campaign in a group; re-deriving an
    // unchanged answer four times an hour is load bought for nothing.
    const atFloorAlready = !!camp.bidsSuppressedAt && normaliseFloorCents(camp.bidsSuppressedFloorCents) === floor
    let suppressed = 0
    if (ctx.write && !atFloorAlready) {
      try {
        // Not-yet-suppressed → suppress at this floor. Already suppressed at a DIFFERENT
        // floor → move it, which is the case suppressCampaignBids refuses by design.
        suppressed = camp.bidsSuppressedAt
          ? await refloorCampaignBids(camp.id, { actor: ctx.actor as AdsActor, floorCents: floor, reason: `rank — Min bid → floor €${(floor / 100).toFixed(2)}` })
          : await suppressCampaignBids(camp.id, { actor: ctx.actor as AdsActor, floorCents: floor, reason: `rank — Min bid → bids floored to €${(floor / 100).toFixed(2)} (no-pause)` })
      } catch (e) { logger.warn('[rank-defend] bid-suppress failed', { campaignId: camp.id, error: (e as Error).message }) }
    }
    applied += suppressed
    // MB.3 — placement during Min-bid hours. Until now the multipliers were left exactly as
    // the PREVIOUS window set them, so a Min-bid hour following an all-out one still carried
    // Top +300% and the floored bid served at ~4× its face value. A Placement % on the
    // Min-bid target now governs that too; leaving it blank keeps the old behaviour, which is
    // what every already-saved schedule has.
    let placeNote = ''
    let placed = false
    if (spec.biasPct != null) {
      const want = Math.max(0, Math.min(900, Math.round(spec.biasPct)))
      if (currentPct !== want) {
        placeNote = ` · ${shortPlace(spec.placement)} ${currentPct}→${want}%`
        if (ctx.write) {
          // Floor first, then the multiplier: for one tick the campaign is at the floored bid
          // with the OLD multiplier, never at the old bid with a new one.
          try { await setSearchPlacement(camp.id, spec.placement, want, { actor: ctx.actor, reason: `rank — Min bid placement ${currentPct}→${want}%` }); applied++; placed = true } catch (e) { logger.warn('[rank-defend] min-bid placement failed', { campaignId: camp.id, error: (e as Error).message }) }
        }
      } else placeNote = ` · ${shortPlace(spec.placement)} held ${want}%`
    }
    const reason = `target = Min bid → bids at floor €${(floor / 100).toFixed(2)} (campaign live, restorable)${placeNote}`
    return { decision: { ...base, action: 'pause', reason, nextPct: spec.biasPct != null ? Math.max(0, Math.min(900, Math.round(spec.biasPct))) : currentPct, lossDetected: false, applied: suppressed > 0 || placed || (ctx.write && !!camp.bidsSuppressedAt) }, applied }
  }
  // Serve target → restore any no-pause bid suppression (exact prior bids), UNLESS the
  // target's own base-bid directive is 'suppress' (then we keep bids floored on purpose).
  if (ctx.write && camp.bidsSuppressedAt && spec.bidMode !== 'suppress') {
    try { applied += await restoreCampaignBids(camp.id, { actor: ctx.actor as AdsActor, reason: 'rank — serve target → restore prior bids' }) } catch (e) { logger.warn('[rank-defend] bid-restore failed', { campaignId: camp.id, error: (e as Error).message }) }
  }
  // Defend semantics: resume only if something ELSE left it paused (we never pause). Never touch ARCHIVED.
  if (ctx.write && camp.status === 'PAUSED') {
    try { await updateCampaignWithSync({ campaignId: camp.id, patch: { status: 'ENABLED' }, actor: ctx.actor as AdsActor, reason: 'rank defend — resume to hold the slot', applyImmediately: true } as never); applied++ } catch (e) { logger.warn('[rank-defend] resume failed', { campaignId: camp.id, error: (e as Error).message }) }
  }
  const loss = ctx.lossByCampaign.get(camp.id) ?? false
  // MB.4 — the campaign's CPC ceiling, expressed as the highest placement % that still
  // respects it. Computed once here and applied to every path below, so a blend cannot
  // breach a ceiling the single-placement path honours.
  const cpcCap = cpcCapPct(spec.maxCpcCents, ctx.maxBaseBidByCampaign?.get(camp.id), strategyHeadroom(camp.biddingStrategy))
  const capNote = (from: number, to: number): string =>
    ` · capped ${from}→${to}% by €${((spec.maxCpcCents ?? 0) / 100).toFixed(2)} CPC ceiling${cpcCap?.baseAlone ? ' (base bid ALONE exceeds it — lower the bids)' : ''}`
  if (cpcCap?.baseAlone) {
    // No multiplier can rescue this: even 0% placement pays more than the ceiling. Logged
    // rather than notified because this evaluates every 15 minutes and a notification per
    // tick would bury the alert it is trying to raise.
    logger.warn('[rank-defend] base bid alone exceeds the CPC ceiling', { campaignId: camp.id, campaign: camp.name, maxCpcCents: spec.maxCpcCents, maxBaseBidCents: ctx.maxBaseBidByCampaign?.get(camp.id), strategy: camp.biddingStrategy })
  }
  // C2 — never bid UP into a capped campaign (burns the fixed daily budget early + surrenders
  // the slot). Shared by both paths.
  const campOutOfBudget = (camp.deliveryReasons ?? []).includes('OUT_OF_BUDGET')

  // ── BL — blended path: drive Top + Rest of Search + Product pages SIMULTANEOUSLY ──
  // in one combined placement write. Each lane gets its own feedback signal: Top = Amazon
  // Top-of-Search IS, Rest = SQP brand impression share, Product = open-loop (set-and-hold).
  if (spec.lanes && spec.lanes.length) {
    const laneDecisions: NonNullable<RankDefendDecision['lanes']> = []
    const driven: Array<{ placement: string; percentage: number }> = []
    const capped: string[] = [] // MB.4 — lanes the CPC ceiling pulled back, named in the reason
    for (const lane of spec.lanes) {
      const laneCur = cdb.placementBidding?.find((x) => x.placement === lane.placement)?.percentage ?? 0
      const lTop = lane.placement === 'PLACEMENT_TOP'
      const lRest = lane.placement === 'PLACEMENT_REST_OF_SEARCH'
      const laneIS = lTop ? sigRaw.topIS : lRest ? (ctx.sqpByCampaign?.get(camp.id) ?? null) : null
      const dd = computeStep(laneToSpec(spec, lane), { currentPct: laneCur, achievedISFraction: laneIS, achievedAcosFraction: lTop ? sigRaw.topAcos : null, lossDetected: lTop ? loss : false })
      let toPct = dd.nextPct, act = dd.action
      if ((ctx.suppressRaise || campOutOfBudget) && act === 'raise') { toPct = laneCur; act = 'hold' }
      // MB.4 — the ceiling binds every lane. The cap is a property of the campaign's bids,
      // not of one placement, so a lane may not exceed it even while another sits below.
      if (cpcCap && toPct > cpcCap.capPct) {
        capped.push(`${shortPlace(lane.placement)} ${toPct}→${cpcCap.capPct}`)
        toPct = cpcCap.capPct
        act = toPct > laneCur ? 'raise' : toPct < laneCur ? 'lower' : 'hold'
      }
      driven.push({ placement: lane.placement, percentage: toPct })
      laneDecisions.push({ placement: lane.placement, fromPct: laneCur, toPct, action: act })
    }
    const adjustments = buildBlendedAdjustments(cdb.placementBidding ?? [], driven)
    const changed = !samePlacements(cdb.placementBidding ?? [], adjustments)
    // HX.1 — computed BEFORE the write so the audit row carries the same explanation the console
    // shows in the decision preview. A history entry without a reason is just a number moving.
    const blendReason = `blend: ${laneDecisions.map((l) => `${shortPlace(l.placement)} ${l.fromPct}→${l.toPct}`).join(', ')}${capped.length ? ` · CPC ceiling €${((spec.maxCpcCents ?? 0) / 100).toFixed(2)} capped ${capped.join(', ')}${cpcCap?.baseAlone ? ' (base bid ALONE exceeds it)' : ''}` : ''}`
    if (ctx.write && changed) {
      try { const { updatePlacementBidding } = await import('../services/advertising/ads-create.service.js'); await updatePlacementBidding({ campaignId: camp.id, adjustments, actor: ctx.actor, reason: blendReason }); applied++ } catch (e) { logger.warn('[rank-defend] blended apply failed', { campaignId: camp.id, error: (e as Error).message }) }
    }
    const baseApplied = await applyBaseBidDirective(camp, spec, ctx)
    applied += baseApplied
    const head = laneDecisions.find((l) => l.placement === 'PLACEMENT_TOP') ?? laneDecisions[0]
    const reason = `${blendReason}${baseBidNote(spec)}`
    return { decision: { ...base, action: head?.action ?? 'hold', reason, nextPct: head?.toPct ?? currentPct, lossDetected: loss, applied: (ctx.write && changed) || baseApplied > 0, lanes: laneDecisions, baseBid: spec.bidMode && spec.bidMode !== 'hold' ? { mode: spec.bidMode, valueCents: spec.bidValueCents } : null }, applied }
  }

  // ── Legacy single-placement path (behaviour unchanged) ──────────────────────────
  // PP — the IS / ACOS / loss signals are Top-of-Search-specific. RM2 — non-Top targets
  // use the family's SQP brand impression share as a coarse feedback signal.
  const isTop = spec.placement === 'PLACEMENT_TOP'
  const achievedIS = isTop ? sigRaw.topIS : (ctx.sqpByCampaign?.get(camp.id) ?? null)
  const d = computeStep(spec, { currentPct, achievedISFraction: achievedIS, achievedAcosFraction: isTop ? sigRaw.topAcos : null, lossDetected: isTop ? loss : false })
  let action = d.action, nextPct = d.nextPct, reason = d.reason
  if ((ctx.suppressRaise || campOutOfBudget) && action === 'raise') {
    action = 'hold'; nextPct = currentPct
    reason = campOutOfBudget ? 'campaign OUT_OF_BUDGET — holding (raise the daily budget to hold this slot)' : 'family daily budget reached — holding (no raise)'
  }
  // MB.4 — the CPC ceiling binds LAST, after every other adjustment, so nothing downstream
  // can put the bid back over it. The action is re-derived rather than preserved: a target
  // sitting ABOVE the cap arrives here as a 'hold', and holding is precisely what it must
  // not do — the cap has to be able to turn that into a 'lower'.
  if (cpcCap && nextPct > cpcCap.capPct) {
    reason = `${reason}${capNote(nextPct, cpcCap.capPct)}`
    nextPct = cpcCap.capPct
    action = nextPct > currentPct ? 'raise' : nextPct < currentPct ? 'lower' : 'hold'
  }
  // PP — also zero the OTHER search placement (Top↔Rest mutually exclusive) even on a hold.
  const otherSearch = spec.placement === 'PLACEMENT_TOP' ? 'PLACEMENT_REST_OF_SEARCH' : spec.placement === 'PLACEMENT_REST_OF_SEARCH' ? 'PLACEMENT_TOP' : null
  const otherCur = otherSearch ? (cdb.placementBidding?.find((x) => x.placement === otherSearch)?.percentage ?? 0) : 0
  const targetChanges = (action === 'raise' || action === 'lower') && nextPct !== currentPct
  if (otherCur > 0) reason = `${reason} · dropping ${otherSearch === 'PLACEMENT_TOP' ? 'Top' : 'Rest'} ${otherCur}→0`
  const willApply = ctx.write && (targetChanges || otherCur > 0)
  if (willApply) {
    // HX.1 — attribute the write. Without the actor this row lands with userId:null and cannot be
    // traced back to the schedule or plan that made it.
    try { await setSearchPlacement(camp.id, spec.placement, targetChanges ? nextPct : currentPct, { actor: ctx.actor, reason }); applied++ } catch (e) { logger.warn('[rank-defend] apply failed', { campaignId: camp.id, error: (e as Error).message }) }
  }
  const baseApplied = await applyBaseBidDirective(camp, spec, ctx)
  applied += baseApplied
  return { decision: { ...base, action, reason: reason + baseBidNote(spec), nextPct, lossDetected: loss, applied: willApply || baseApplied > 0, baseBid: spec.bidMode && spec.bidMode !== 'hold' ? { mode: spec.bidMode, valueCents: spec.bidValueCents } : null }, applied }
}

// RD.5 — family guardrails. effectiveSpec transforms the window target before the
// controller sees it: OOS/lost-buybox → pause (stop wasting spend); family over
// its ACOS cap → drop all-out so even a must-win window respects a profit ceiling.
export function effectiveSpec(spec: RankTargetSpec, flags: { oos?: boolean; overAcos?: boolean; familyAcosCapPct?: number | null }): RankTargetSpec {
  if (flags.oos) return { ...spec, pause: true }
  if (flags.overAcos && spec.allOut) return { ...spec, allOut: false, acosCapPct: spec.acosCapPct ?? flags.familyAcosCapPct ?? null }
  return spec
}

// Family-aggregate spend (most recent day with data) + ACOS (window) over a set of
// campaigns. localEntityId = Campaign.id; costMicros → cents (÷10000).
async function familySpendRecentCents(campaignIds: string[]): Promise<number> {
  if (!campaignIds.length) return 0
  const latest = await prisma.amazonAdsDailyPerformance.findFirst({ where: { entityType: 'CAMPAIGN', localEntityId: { in: campaignIds } }, orderBy: { date: 'desc' }, select: { date: true } })
  if (!latest) return 0
  const agg = await prisma.amazonAdsDailyPerformance.aggregate({ where: { entityType: 'CAMPAIGN', localEntityId: { in: campaignIds }, date: latest.date }, _sum: { costMicros: true } })
  return Math.round(Number(agg._sum.costMicros ?? 0n) / 10000)
}
async function familyAcosFraction(campaignIds: string[], windowDays = 14): Promise<number | null> {
  if (!campaignIds.length) return null
  const since = new Date(Date.now() - windowDays * 86_400_000)
  const agg = await prisma.amazonAdsDailyPerformance.aggregate({ where: { entityType: 'CAMPAIGN', localEntityId: { in: campaignIds }, date: { gte: since } }, _sum: { costMicros: true, sales7dCents: true } })
  const spend = Math.round(Number(agg._sum.costMicros ?? 0n) / 10000)
  const sales = agg._sum.sales7dCents ?? 0
  return sales > 0 ? spend / sales : null
}

// RD.6 — load each family campaign's positive EXACT/PHRASE keywords + AUTO flag +
// efficiency (Campaign.acos / spendCents) for the self-competition detector.
async function loadFamilyTargeting(famCampIds: string[], campById: Map<string, { acos?: unknown; spend?: unknown }>): Promise<CampaignTargeting[]> {
  if (!famCampIds.length) return []
  const [autoGroups, kws] = await Promise.all([
    prisma.adGroup.findMany({ where: { campaignId: { in: famCampIds }, targetingType: 'AUTO' }, select: { campaignId: true } }),
    prisma.adTarget.findMany({ where: { adGroup: { campaignId: { in: famCampIds } }, kind: 'KEYWORD', isNegative: false, expressionType: { in: ['EXACT', 'PHRASE'] } }, select: { expressionValue: true, expressionType: true, adGroup: { select: { campaignId: true } } } }),
  ])
  const autoSet = new Set(autoGroups.map((g) => g.campaignId))
  const kwByCamp = new Map<string, Set<string>>()
  for (const k of kws) {
    const cid = k.adGroup?.campaignId; if (!cid) continue
    const s = kwByCamp.get(cid) ?? new Set<string>(); s.add(`${k.expressionValue.trim().toLowerCase()}|${k.expressionType}`); kwByCamp.set(cid, s)
  }
  return famCampIds.map((id) => {
    const camp = campById.get(id)
    const acosNum = camp?.acos != null ? Number(camp.acos) : NaN
    return { campaignId: id, keywords: [...(kwByCamp.get(id) ?? [])], isAuto: autoSet.has(id), acos: Number.isFinite(acosNum) ? acosNum : null, spendCents: Math.round(Number(camp?.spend ?? 0) * 100) }
  })
}

// RD.7 — plan actuation is LIVE, gated. Plans actuate via setSearchPlacement (the
// target's own placement) through the same write-gate as schedules (sandbox-safe;
// live only when the gate is open).
// Auto-actuation (cron) skips manualOnly plans; an explicit run-now (force) actuates
// them too.
const PLAN_ALLOW_APPLY = true

export async function runRankDefendOnce(opts: { dryRun?: boolean; onlyPlanId?: string; force?: boolean } = {}): Promise<RankDefendSummary> {
  const dryRun = !!opts.dryRun
  // onlyPlanId scopes a run to ONE plan (per-plan run-now / apply-now): skip schedules
  // and the enabled filter, so even a disabled plan can be previewed or manually applied.
  const schedules = opts.onlyPlanId ? [] : (await prisma.adSchedule.findMany({ where: { enabled: true } })).filter((s) => isGoalMode(s.windows, s.defaultTargetKey))
  const plans = await prisma.productRankPlan.findMany({ where: opts.onlyPlanId ? { id: opts.onlyPlanId } : { enabled: true } })
  if (schedules.length === 0 && plans.length === 0) return { evaluated: 0, applied: 0, decisions: [], plans: [] }

  // Authoritative clock for ALL window resolution in this run (not the container process clock).
  const clockNow = await dbNow()

  const targets = await prisma.rankTarget.findMany()
  const targetByKey = new Map(targets.map((t) => [t.key, t as unknown as RankTargetRow]))

  // Resolve each plan's family campaigns LIVE (RD.4) → the governed set, so the
  // schedule loop never fights a plan over the same campaign (precedence: plan wins).
  const { resolveProductFamily } = await import('../services/advertising/ads-dayparting-refresh.service.js')
  const planFamilies: Array<{ plan: (typeof plans)[number]; campaigns: Array<{ id: string }> }> = []
  const governed = new Set<string>()
  for (const plan of plans) {
    try {
      const fam = await resolveProductFamily({ parentProductId: plan.productId, marketplace: plan.marketplace })
      // RD.12 — honour the operator's manual campaign scope: drop excluded campaigns
      // BEFORE governance + blast-radius, so they're neither held nor counted nor
      // marked governed (they stay free for schedules / manual control).
      const excluded = new Set<string>(Array.isArray(plan.excludeCampaignIds) ? (plan.excludeCampaignIds as string[]) : [])
      const camps = (fam.campaigns ?? []).filter((c) => !excluded.has(c.id))
      // RD.8 — blast-radius guard: a plan resolving to MORE than maxCampaigns is likely
      // mis-targeted (wrong product / runaway ASIN match). Refuse to actuate it, and on
      // a real run auto-pause it so it can't fan out to an unexpected fleet.
      if (plan.maxCampaigns != null && camps.length > plan.maxCampaigns) {
        logger.warn('[rank-defend] plan exceeds maxCampaigns — refusing', { planId: plan.id, resolved: camps.length, max: plan.maxCampaigns })
        if (!dryRun) {
          try { await prisma.productRankPlan.update({ where: { id: plan.id }, data: { enabled: false, pausedAt: new Date(), lastSummary: { at: new Date().toISOString(), autoPaused: true, reason: `family resolved to ${camps.length} campaigns > maxCampaigns ${plan.maxCampaigns}` } as never } }) } catch { /* best-effort */ }
          // D2 — surface the blast-radius auto-pause instead of only logging: a plan that silently
          // disarms itself (e.g. an ASIN match fanned out to a fleet) must reach the operator.
          try {
            const { notifyAutomation } = await import('../services/advertising/ads-automation-notify.service.js')
            await notifyAutomation({ type: 'rank_plan_mistarget', severity: 'danger', title: 'Rank plan auto-paused — blast-radius guard', body: `A rank plan resolved to ${camps.length} campaigns (cap ${plan.maxCampaigns}) for ${plan.marketplace} and was auto-disabled before it could fan out. Re-scope the plan's product/ASIN match, then re-enable.`, href: '/marketing/ads-console/rank?mode=plan', meta: { planId: plan.id, productId: plan.productId, marketplace: plan.marketplace, resolved: camps.length, max: plan.maxCampaigns } })
          } catch { /* notify is best-effort */ }
        }
        continue
      }
      planFamilies.push({ plan, campaigns: camps })
      for (const c of camps) governed.add(c.id)
    } catch (e) { logger.warn('[rank-defend] family resolve failed', { planId: plan.id, error: (e as Error).message }) }
  }

  // Union of schedule + plan campaigns → one campaign load + one signal pass.
  const unionIds = [...new Set([...schedules.map((s) => s.campaignId), ...governed])]
  const campaigns = await prisma.campaign.findMany({ where: { id: { in: unionIds } }, select: { id: true, name: true, marketplace: true, status: true, externalCampaignId: true, dynamicBidding: true, biddingStrategy: true, acos: true, spend: true, bidsSuppressedAt: true, bidsSuppressedFloorCents: true, deliveryReasons: true } })
  const campById = new Map(campaigns.map((c) => [c.id, c]))
  // RTC — per-campaign (campaign-scope) target overrides for every campaign in play.
  const schedOverrides = new Map<string, TargetOverrideMap>()
  try {
    const so = await prisma.adSchedule.findMany({ where: { campaignId: { in: unionIds } }, select: { campaignId: true, targetOverrides: true } })
    for (const s of so) { const m = s.targetOverrides as TargetOverrideMap; if (m && Object.keys(m).length) schedOverrides.set(s.campaignId, m) }
  } catch { /* best-effort */ }

  // One analyzeTopOfSearch call per marketplace gives every campaign's topIS + topAcos signals.
  const markets = [...new Set(campaigns.map((c) => c.marketplace).filter(Boolean) as string[])]
  const sigByCampaign: SigMap = new Map()
  for (const mk of markets) {
    try {
      const { rows } = await analyzeTopOfSearch({ marketplace: mk, windowDays: 14 })
      for (const r of rows) sigByCampaign.set(r.campaignId, { currentPct: r.currentPct, topIS: r.topIS, topAcos: r.topAcos })
    } catch (e) { logger.warn('[rank-defend] signal read failed', { marketplace: mk, error: (e as Error).message }) }
  }

  // RS.6 — loss proxy: the latest hour's impressions cratering vs the campaign's
  // own ~2-day baseline is the fastest "we're slipping" signal. Conservative
  // threshold → sparse/low-volume campaigns never trip it (no false snap-backs).
  const lossByCampaign = new Map<string, boolean>()
  const extIds = campaigns.map((c) => c.externalCampaignId).filter(Boolean) as string[]
  if (extIds.length > 0) {
    try {
      const since = new Date(Date.now() - 2 * 24 * 3600 * 1000)
      const hourly = await prisma.amazonAdsHourlyPerformance.findMany({ where: { entityType: 'CAMPAIGN', entityId: { in: extIds }, date: { gte: since } }, select: { entityId: true, date: true, hour: true, impressions: true } })
      const byExt = new Map<string, { ts: number; impr: number }[]>()
      for (const h of hourly) { const ts = h.date.getTime() + (h.hour ?? 0) * 3600_000; const arr = byExt.get(h.entityId) ?? []; arr.push({ ts, impr: h.impressions ?? 0 }); byExt.set(h.entityId, arr) }
      for (const c of campaigns) {
        if (!c.externalCampaignId) continue
        const series = (byExt.get(c.externalCampaignId) ?? []).sort((a, b) => a.ts - b.ts)
        if (series.length < 3) continue
        const latest = series[series.length - 1].impr
        const prior = series.slice(0, -1)
        const baseline = prior.reduce((s, x) => s + x.impr, 0) / prior.length
        lossByCampaign.set(c.id, isRankLoss(latest, baseline))
      }
    } catch (e) { logger.warn('[rank-defend] loss-proxy read failed', { error: (e as Error).message }) }
  }

  // MB.4 — each campaign's HIGHEST live base bid, the number the CPC ceiling is measured
  // against. `suppressedFromBidCents` is taken into account because it is what the bid
  // RETURNS to the moment a serving target takes over: reading only the floored 2¢ of a
  // suppressed campaign would compute a ceiling-free cap for the very tick that restores it.
  // Grouped rather than row-by-row — one campaign here holds 141 targets.
  const maxBaseBidByCampaign = new Map<string, number>()
  try {
    const [agRows, agIndex] = await Promise.all([
      prisma.adGroup.groupBy({ by: ['campaignId'], where: { campaignId: { in: unionIds } }, _max: { defaultBidCents: true, suppressedFromBidCents: true } }),
      prisma.adGroup.findMany({ where: { campaignId: { in: unionIds } }, select: { id: true, campaignId: true } }),
    ])
    for (const r of agRows) {
      const v = Math.max(r._max.defaultBidCents ?? 0, r._max.suppressedFromBidCents ?? 0)
      if (v > 0) maxBaseBidByCampaign.set(r.campaignId, v)
    }
    const campByAdGroup = new Map(agIndex.map((g) => [g.id, g.campaignId]))
    const tgRows = await prisma.adTarget.groupBy({ by: ['adGroupId'], where: { adGroup: { campaignId: { in: unionIds } }, isNegative: false }, _max: { bidCents: true, suppressedFromBidCents: true } })
    for (const r of tgRows) {
      const cid = campByAdGroup.get(r.adGroupId); if (!cid) continue
      const v = Math.max(r._max.bidCents ?? 0, r._max.suppressedFromBidCents ?? 0)
      if (v > (maxBaseBidByCampaign.get(cid) ?? 0)) maxBaseBidByCampaign.set(cid, v)
    }
  } catch (e) { logger.warn('[rank-defend] max-base-bid read failed — CPC ceilings not enforced this tick', { error: (e as Error).message }) }

  // RM2 — per-campaign SQP brand impression share, the feedback signal for Rest-of-Search targets
  // (Amazon exposes no Rest placement-IS). Resolve each campaign's advertised ASINs → latest weekly
  // SQP share for its market. Best-effort: any failure leaves a campaign open-loop (null).
  const sqpByCampaign = new Map<string, number | null>()
  try {
    const ads = await prisma.adProductAd.findMany({ where: { adGroup: { campaignId: { in: unionIds } }, status: 'ENABLED' }, select: { asin: true, adGroup: { select: { campaignId: true } } } })
    const asinsByCampaign = new Map<string, Set<string>>()
    for (const a of ads) { const cid = a.adGroup?.campaignId; if (!cid || !a.asin) continue; const s = asinsByCampaign.get(cid) ?? new Set<string>(); s.add(a.asin); asinsByCampaign.set(cid, s) }
    for (const c of campaigns) {
      const asins = [...(asinsByCampaign.get(c.id) ?? [])]
      if (!asins.length || !c.marketplace) { sqpByCampaign.set(c.id, null); continue }
      try { sqpByCampaign.set(c.id, await sqpImpressionShareForAsins(c.marketplace, asins)) } catch { sqpByCampaign.set(c.id, null) }
    }
  } catch (e) { logger.warn('[rank-defend] SQP signal read failed', { error: (e as Error).message }) }

  const decisions: RankDefendDecision[] = []
  const planSummaries: RankPlanRunSummary[] = []
  let applied = 0

  // RD.5 — retail-readiness (OOS/lost-buybox) per market, memoised across plans.
  const { analyzeRetailReadiness } = await import('../services/advertising/ads-retail-readiness.service.js')
  const readinessMemo = new Map<string, Map<string, string>>()
  const getReadiness = async (mk: string): Promise<Map<string, string>> => {
    const hit = readinessMemo.get(mk); if (hit) return hit
    const map = new Map<string, string>()
    try { const rr = await analyzeRetailReadiness({ marketplace: mk }); for (const c of rr.campaigns) map.set(c.campaignId, c.verdict) } catch { /* best-effort */ }
    readinessMemo.set(mk, map); return map
  }

  // ── Plans first (governed). Dry-only actuation until RD.7. ──
  for (const { plan, campaigns: famCamps } of planFamilies) {
    const { day, hour } = nowInTz(plan.timezone || 'Europe/Rome', plan.leadTimeMinutes || 0, clockNow)
    const key = resolveActiveTargetKey(plan.windows as ScheduleWindow[], plan.defaultTargetKey, day, hour)
    const planDecisions: RankDefendDecision[] = []
    let planConflicts: SelfCompetitionConflict[] = []
    if (key) {
      const target = targetByKey.get(key)
      if (target) {
        const write = !dryRun && PLAN_ALLOW_APPLY && (!plan.manualOnly || !!opts.force)
        // RD.5 — family pre-flight guards (once per plan, shared by every campaign):
        // retail-readiness (OOS/lost-buybox), family daily spend vs budget cap,
        // family ACOS vs cap.
        const famCampIds = famCamps.map((c) => c.id)
        const readinessByCamp = await getReadiness(plan.marketplace)
        const overBudget = plan.familyDailyBudgetCents != null && (await familySpendRecentCents(famCampIds)) >= plan.familyDailyBudgetCents
        const acosFrac = plan.familyAcosCapPct != null ? await familyAcosFraction(famCampIds) : null
        const overAcos = plan.familyAcosCapPct != null && acosFrac != null && acosFrac > plan.familyAcosCapPct / 100
        // RD.6 — self-competition: demote redundant family campaigns (lose a keyword/
        // auto contest and win none) to the plan baseline so we stop outbidding ourselves.
        const sc = detectSelfCompetition(await loadFamilyTargeting(famCampIds, campById))
        planConflicts = sc.conflicts
        const baselineTarget = plan.defaultTargetKey ? targetByKey.get(plan.defaultTargetKey) : undefined
        for (const fc of famCamps) {
          const camp = campById.get(fc.id); if (!camp) continue
          const oos = readinessByCamp.get(fc.id) === 'pause'
          const demote = sc.demoted.has(fc.id) && !!baselineTarget && plan.defaultTargetKey !== key
          const useKey = demote ? plan.defaultTargetKey! : key
          const eff = effectiveSpec(applyTargetOverrides(toSpec(demote ? baselineTarget! : target), plan.targetOverrides as TargetOverrideMap, schedOverrides.get(fc.id)), { oos, overAcos, familyAcosCapPct: plan.familyAcosCapPct })
          const { decision, applied: a } = await decideAndMaybeApply(camp, useKey, eff, plan.id, { write, actor: `automation:rank-plan-${plan.id}`, sigByCampaign, lossByCampaign, sqpByCampaign, maxBaseBidByCampaign, suppressRaise: overBudget })
          planDecisions.push(decision); decisions.push(decision); applied += a
        }
      }
    }
    planSummaries.push({ planId: plan.id, productId: plan.productId, marketplace: plan.marketplace, campaigns: planDecisions.length, decisions: planDecisions, selfCompetition: planConflicts })
    if (!dryRun) {
      try { await prisma.productRankPlan.update({ where: { id: plan.id }, data: { lastEvaluatedAt: new Date(), lastSummary: { at: new Date().toISOString(), activeTargetKey: key ?? null, campaigns: planDecisions.length, decisions: planDecisions, selfCompetition: planConflicts } as never } }) } catch { /* best-effort */ }
    }
  }

  // ── Schedules (skip plan-governed campaigns). Existing behaviour preserved. ──
  //
  // RDX/A1 — receipts. Every schedule this loop actually LOOKED AT records when it was
  // evaluated and which target it resolved to. Before this, only ProductRankPlan got a
  // summary (line ~485), so every group-materialised AdSchedule row read
  // `lastApplied: null` forever and the console could not answer "when did this last
  // run / what is it holding right now".
  //
  // A campaign skipped because a family plan governs it is deliberately NOT stamped:
  // that schedule genuinely did not run, and the console reports it as governed
  // elsewhere rather than pretending it ticked.
  /**
   * G2 — dated event overrides.
   *
   * An event replaces the weekly plan for the dates it covers: Black Friday, a launch week. Loaded
   * once per tick for every group in play, so the per-schedule loop below stays a map lookup.
   *
   * INERT WITHOUT DATA. No enabled event covering `now` means this map is empty and every schedule
   * resolves exactly as before — which is why this can ship without a behaviour gate.
   *
   * Overlapping events resolve to the one that STARTED LATEST. A lead-out authored to begin while
   * an event is still running is a deliberate hand-over, not a conflict, and "most recently begun
   * wins" is the rule that makes that read correctly.
   */
  const eventByGroup = new Map<string, { windows: unknown; defaultTargetKey: string | null; name: string }>()
  try {
    const groupIds = [...new Set(schedules.map((s) => s.groupId).filter(Boolean))] as string[]
    if (groupIds.length) {
      const at = clockNow ?? new Date()
      const events = await prisma.rankScheduleEvent.findMany({
        where: { groupId: { in: groupIds }, enabled: true, startsAt: { lte: at }, endsAt: { gt: at } },
        orderBy: { startsAt: 'asc' },
        select: { groupId: true, windows: true, defaultTargetKey: true, name: true, startsAt: true, endsAt: true },
      })
      for (const [gid, e] of pickActiveEvents(events.map((e) => ({ ...e, enabled: true })), at)) {
        eventByGroup.set(gid, { windows: e.windows, defaultTargetKey: e.defaultTargetKey, name: e.name })
      }
      if (events.length) logger.info('[rank-defend] event overrides active', { count: events.length, names: events.map((e) => e.name) })
    }
  } catch (e) { logger.warn('[rank-defend] event lookup failed — falling back to weekly plans', { error: (e as Error).message }) }

  const receipts = new Map<string, string | null>() // AdSchedule.id → resolved target key
  for (const s of schedules) {
    if (governed.has(s.campaignId)) continue
    const camp = campById.get(s.campaignId); if (!camp) continue
    const { day, hour } = nowInTz(s.timezone || 'Europe/Rome', 0, clockNow)
    // The event supplies the plan; everything else about the schedule is unchanged.
    const ev = s.groupId ? eventByGroup.get(s.groupId) : undefined
    const planWindows = (ev ? ev.windows : s.windows) as ScheduleWindow[]
    const planBaseline = ev ? ev.defaultTargetKey : s.defaultTargetKey
    const key = resolveActiveTargetKey(planWindows, planBaseline, day, hour)
    // Stamped even when the schedule resolves to nothing — "we looked, nothing was due"
    // is what distinguishes an idle schedule from a cron that has stopped running.
    receipts.set(s.id, key)
    if (!key) continue
    // A resolved key with no RankTarget behind it is a dangling reference (the target was
    // deleted after the schedule was authored). Nothing is held, so record nothing held.
    const target = targetByKey.get(key); if (!target) { receipts.set(s.id, null); continue }
    const { decision, applied: a } = await decideAndMaybeApply(camp, key, applyTargetOverrides(toSpec(target), s.targetOverrides as TargetOverrideMap), null, { write: !dryRun, actor: `automation:rank-defend-${s.id}`, sigByCampaign, lossByCampaign, sqpByCampaign, maxBaseBidByCampaign })
    decisions.push(decision); applied += a
  }
  // Grouped by resolved key so the 33 live schedules cost ~2 statements rather than 33.
  // Best-effort, exactly like the plan summary above — a receipt must never fail a tick.
  if (!dryRun && receipts.size > 0) {
    const byKey = groupReceipts(receipts)
    const stampedAt = clockNow ?? new Date()
    for (const [key, ids] of byKey) {
      try { await prisma.adSchedule.updateMany({ where: { id: { in: ids } }, data: { lastEvaluatedAt: stampedAt, lastApplied: key } }) }
      catch (e) { logger.warn('[rank-defend] receipt write failed', { count: ids.length, error: (e as Error).message }) }
    }
  }

  return { evaluated: decisions.length, applied, decisions, plans: planSummaries }
}

export async function runRankDefendCron(): Promise<void> {
  try {
    await recordCronRun('ad-rank-defend', async () => {
      const r = await runRankDefendOnce()
      // AR — after holding the slot, re-push any bid/placement whose LAST live write
      // to Amazon failed (dead-lettered queue rows + failed inline placement), so
      // Amazon converges to our local truth without waiting for the next change or a
      // manual resync. Bounded + gated; a sweep error must not fail the rank tick.
      let rec = ''
      try {
        const { reconcileFailedAmazonWrites } = await import('../services/advertising/ads-write-reconcile.service.js')
        const rr = await reconcileFailedAmazonWrites({ limit: 50 })
        if (rr.attempted || rr.skippedPermanent) {
          rec = ` reconciled=${rr.attempted}(ag=${rr.adGroups},tg=${rr.adTargets},cm=${rr.campaigns})${rr.skippedPermanent ? ` skip-perm=${rr.skippedPermanent}` : ''}`
        }
      } catch (e) { logger.warn('[ad-rank-defend] reconcile sweep failed', { error: (e as Error).message }) }
      return `evaluated=${r.evaluated} applied=${r.applied}${rec}`
    })
  }
  catch (err) { logger.error('ad-rank-defend cron failure', { error: err instanceof Error ? err.message : String(err) }) }
}

let task: ReturnType<typeof cron.schedule> | null = null
let running = false // C3 — overlap guard: a slow tick must not run concurrently with the next
export function startRankDefendCron(): void {
  if (task) return
  // OFF by default — operator opts in (and the write-gate still governs live pushes).
  if (process.env.NEXUS_ENABLE_RANK_DEFEND !== '1') { logger.info('ad-rank-defend cron disabled (set NEXUS_ENABLE_RANK_DEFEND=1)'); return }
  const schedule = process.env.NEXUS_RANK_DEFEND_SCHEDULE ?? '*/15 * * * *'
  task = cron.schedule(schedule, () => {
    if (running) { logger.warn('[ad-rank-defend] previous tick still in flight — skipping this run'); return }
    running = true
    void runRankDefendCron().finally(() => { running = false })
  })
  logger.info(`ad-rank-defend cron scheduled (${schedule})`)
}
