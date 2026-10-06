/**
 * RS.5 — the rank-defend loop, since 2e an hour-of-day bid plan. For each enabled GOAL-mode AdSchedule (windows carry
 * a targetKey and/or a defaultTargetKey baseline) and each enabled product plan, resolve which RankTarget the hour's
 * plan names and set that target's FIXED values: the Placement % per lane, the Min-bid floor (and its placement), the
 * base bid. The CPC ceiling still caps the placement %.
 *
 * 2e (Owner D1 = A, 2026-10-04) — no Amazon signal can feed a 15-minute loop (Top-of-search share is daily and 1–3
 * days late, SQP weekly, no organic-rank API), so nothing here reads one any more: no impression share, no ACoS, no
 * loss proxy, no SQP, no climb/ease step, no keep-climbing, no all-out climb, no ceiling chase. A tick writes only
 * when the value the hour holds differs from what is live — in practice at the painted hour boundaries.
 *
 * Writes go through the gated actuation (setSearchPlacement / updatePlacementBidding / the bid-suppression service):
 * local first, pushed to Amazon only when the write gate is open. Cron is OFF unless NEXUS_ENABLE_RANK_DEFEND=1; the
 * run-now endpoint (dryRun) previews decisions without writing.
 *
 * 1c — a live run honours the account dial and its own caps (ads-engine-guard.ts): SUGGEST writes
 * nothing new; halted / OFF only floors bids, restores wait for Resume; at most N changes a run and a day.
 * 1e — a live run, Run now included, also needs the business switch on and the scheduler's arm flags, and holds the
 * engine lock (ads-engine-lock.ts): a Run now during a tick answers "skipped: a run is already in progress".
 * 2a — it gives back what it floored when nothing is due (no window open and no baseline, or a deleted target), leaves
 * a floor it did not set alone, and runs the orphan sweep in each live run (rank-release.service.ts).
 * 2c — a tick decides every campaign first and then writes in one order: give-backs (releases and sweep included),
 * floors, placement moves, base bids (firstWriteIntent). A campaign enters Min bid at most twice a UTC day (anti-flap,
 * counted from the action log); the summary line splits the run's changes by kind.
 */

import cron from '../lib/cron/clustered.js'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { computeStep, resolveActiveTargetKey, cpcCapPct, strategyHeadroom, type RankTargetSpec, type LaneSpec, type ScheduleWindow } from '../services/advertising/rank-controller.js'
import { setSearchPlacement, buildBlendedAdjustments } from '../services/advertising/ads-top-of-search.service.js'
import { updateAdGroupWithSync, type AdsActor } from '../services/advertising/ads-mutation.service.js'
import { suppressCampaignBids, restoreCampaignBids, refloorCampaignBids, normaliseFloorCents, applyBaseBidDelta, revertBaseBidDelta } from '../services/advertising/ads-bid-suppression.service.js'
import { detectSelfCompetition, type CampaignTargeting, type SelfCompetitionConflict } from '../services/advertising/rank-self-competition.js'
import { clampPct, deltaBidCents } from '../services/advertising/ads-placement-math.js'
import { DRY_RUN, allowChange, engineGuardNote, nothingHeld, openEngineGuard, type CampaignPermit, type EngineGuard, type EngineGuardReport, type HeldBack } from '../services/advertising/ads-engine-guard.js'
import { addRelease, emptyRelease, floorOwnerWords, isRankOwnedFloor, releaseCampaigns, sweepOrphanReleases, type ReleaseReport } from '../services/advertising/rank-release.service.js'
import { isOutOfBudget, outOfBudgetWords } from '../services/advertising/delivery-reasons.js'
import { engineActorWhere } from '../services/advertising/ads-engine-actors.js'
import { MAX_MIN_BID_ENTRIES_PER_DAY, noWrites, type RankWriteCounts } from '../services/advertising/rank-write-projection.js'

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
// RD.P2 — exported (keyword only, no behaviour change) so the Rank & Dayparting page can derive
// its Mode column from the ENGINE's spec mapping rather than a second copy of it. A duplicate is
// free to drift from the loop that actually decides, which is the defect that page exists to fix.
export const toSpec = (t: RankTargetRow): RankTargetSpec => ({ key: t.key, placement: t.placement, targetISPct: t.targetISPct, acosCapPct: t.acosCapPct, maxCpcCents: t.maxCpcCents, biasPct: t.biasPct, pause: t.pause, floorBidCents: t.floorBidCents ?? null, allOut: t.allOut, jumpStartPct: t.jumpStartPct ?? null, stepUpPct: t.stepUpPct ?? null, stepDownPct: t.stepDownPct ?? null, maxBiasPct: t.maxBiasPct ?? null, keepClimbing: !!t.keepClimbing, lanes: Array.isArray(t.lanes) ? (t.lanes as LaneSpec[]) : null, bidMode: t.bidMode ?? null, bidValueCents: t.bidValueCents ?? null, bidDeltaPct: t.bidDeltaPct ?? null })

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

// 2e — no achieved impression share, ACoS or loss flag any more: the tick reads none of them.
export interface RankDefendDecision {
  campaignId: string; campaignName: string; targetKey: string; action: string; reason: string
  currentPct: number; nextPct: number; applied: boolean
  planId?: string | null
  // BL — per-placement decisions when the target is a blend (Top/Rest/Product driven at once).
  lanes?: Array<{ placement: string; fromPct: number; toPct: number; action: string }>
  baseBid?: { mode: string; valueCents?: number | null } | null // BL — base-bid directive applied
}
export interface RankPlanRunSummary { planId: string; productId: string; marketplace: string; campaigns: number; decisions: RankDefendDecision[]; selfCompetition?: SelfCompetitionConflict[] }
// 1c — `guard` (live runs only): the dial posture and the caps this run ran under, and what they held back.
// 1e — `skipped`: a live run that did not start (switched off, not armed on the scheduler, or a run already in progress), in words.
// 2a — `release` (live runs only): what it gave back where nothing was due, and what the orphan sweep gave back (`swept`
// = campaigns the sweep looked at).
export type RankReleaseSummary = Omit<ReleaseReport, 'campaigns'> & { swept: number }
// 2c — `writes` (live runs only): the run's changes by kind, the give-backs of `release` included in `restore`;
// `keptServing`: campaigns the anti-flap kept serving through a Min-bid hour.
export interface RankDefendSummary { evaluated: number; applied: number; decisions: RankDefendDecision[]; plans?: RankPlanRunSummary[]; guard?: EngineGuardReport; skipped?: string; release?: RankReleaseSummary; writes?: RankWriteCounts; keptServing?: number }

interface CampRow { id: string; name: string; status: string; dynamicBidding: unknown; biddingStrategy?: string | null; bidsSuppressedAt?: Date | null; bidsSuppressedFloorCents?: number | null; bidsSuppressedBy?: string | null; deliveryReasons?: string[] }
interface RankCampaignResult { decision: RankDefendDecision; applied: number; held: HeldBack; writes: RankWriteCounts; keptServing: boolean }

/**
 * 2c (review 2.5) — the order a tick writes its campaigns in: give-backs first, then floors, then placement moves,
 * then base bids. Read off the campaign row and the hour's spec alone (no database), so the tick can order every
 * campaign before it writes to any. It decides ORDER only: decideAndMaybeApply still decides each write, and a
 * campaign still asks its permit once and finishes (1c), so it is never half-applied. When a cap binds mid-tick the
 * campaigns it defers are the ones at the back — never a give-back, which the cap does not refuse anyway.
 */
export const RANK_WRITE_ORDER = ['restore', 'suppress', 'placement', 'base', 'none'] as const
export type RankWriteIntent = (typeof RANK_WRITE_ORDER)[number]
export function firstWriteIntent(camp: Pick<CampRow, 'dynamicBidding' | 'bidsSuppressedAt' | 'bidsSuppressedFloorCents' | 'bidsSuppressedBy'>, spec: RankTargetSpec): RankWriteIntent {
  if (camp.bidsSuppressedAt && !isRankOwnedFloor(camp.bidsSuppressedBy)) return 'none' // someone else's floor: held
  const live = ((camp.dynamicBidding ?? {}) as { placementBidding?: Array<{ placement: string; percentage: number }> }).placementBidding ?? []
  const cur = (p: string) => live.find((x) => x.placement === p)?.percentage ?? 0
  if (spec.pause) {
    if (!camp.bidsSuppressedAt || normaliseFloorCents(camp.bidsSuppressedFloorCents) !== normaliseFloorCents(spec.floorBidCents)) return 'suppress'
    return spec.biasPct != null && cur(spec.placement) !== clampPct(spec.biasPct) ? 'placement' : 'none'
  }
  if (camp.bidsSuppressedAt && spec.bidMode !== 'suppress') return 'restore'
  if (spec.bidMode === 'suppress' && !camp.bidsSuppressedAt) return 'suppress'
  const placementMoves = spec.lanes && spec.lanes.length
    ? !samePlacements(live, buildBlendedAdjustments(live, spec.lanes.map((l) => ({ placement: l.placement, percentage: clampPct(l.biasPct ?? 0) }))))
    : cur(spec.placement) !== clampPct(spec.biasPct ?? 0) || (spec.placement === 'PLACEMENT_TOP' ? cur('PLACEMENT_REST_OF_SEARCH') : spec.placement === 'PLACEMENT_REST_OF_SEARCH' ? cur('PLACEMENT_TOP') : 0) > 0
  if (placementMoves) return 'placement'
  return spec.bidMode === 'absolute' || spec.bidMode === 'deltaPct' ? 'base' : 'none'
}

// RD.4 — one per-campaign decision body, shared by the schedule loop and the
// product-plan fan-out. `write` gates ALL actuation (pause / resume / placement
// bias); when false it is a pure decision (preview / plan dry-run). currentPct is
// always read from dynamicBidding (the bias WE control), never the sparse T+1
// placement report — else the loop is blind to its own prior changes.
// BL — expand one lane into a single-placement RankTargetSpec the controller understands. 2e — only the lane's own
// Placement % is carried: its ceiling, IS/ACoS, steps, keep-climbing and all-out are not read.
function laneToSpec(parent: RankTargetSpec, lane: LaneSpec): RankTargetSpec {
  return {
    key: parent.key, placement: lane.placement, biasPct: lane.biasPct,
    targetISPct: null, acosCapPct: null, maxCpcCents: parent.maxCpcCents, allOut: false, pause: false,
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
// 1c — `permit` says which of these this campaign may write this run; what it may not is noted in `held`.
// 2c — split in two so a campaign writes in the tick's order: the give-back half (revertBaseBidDirective) runs before
// the placement write, the forward half (applyBaseBidDirective) after it. Each adds its writes to `writes` by kind.
interface BaseBidCtx { write: boolean; actor: string; permit: CampaignPermit; entriesToday?: number }
async function revertBaseBidDirective(camp: CampRow, spec: RankTargetSpec, ctx: BaseBidCtx, held: HeldBack, writes: RankWriteCounts): Promise<number> {
  if (!ctx.write || spec.bidMode === 'deltaPct') return 0
  // Leaving deltaPct (or never in it) → restore each entity's stable baseline + clear it.
  // 1c — a give-back: never capped, but it waits while stopped (the gate would refuse it after Nexus moved its bids).
  let n = 0
  if (ctx.permit.restore) {
    try { n = await revertBaseBidDelta(camp.id, { actor: ctx.actor as AdsActor }) } catch (e) { logger.warn('[rank-defend] base-bid delta revert failed', { campaignId: camp.id, error: (e as Error).message }) }
  } else if (await hasBaseBidDelta(camp.id)) held.restore = true
  writes.restore += n
  return n
}
async function applyBaseBidDirective(camp: CampRow, spec: RankTargetSpec, ctx: BaseBidCtx, held: HeldBack, writes: RankWriteCounts): Promise<{ applied: number; keptServing: boolean }> {
  const none = { applied: 0, keptServing: false }
  if (!ctx.write) return none
  const allow = (kind: keyof HeldBack) => allowChange(ctx.write, ctx.permit, held, kind)
  let n = 0
  const mode = spec.bidMode
  if (!mode || mode === 'hold') return none
  if (mode === 'suppress') {
    if (camp.bidsSuppressedAt) return none
    // 2c — floored-base hours count as Min-bid entries: the anti-flap holds the third on one UTC day.
    const entries = ctx.entriesToday ?? 0
    if (entries >= MAX_MIN_BID_ENTRIES_PER_DAY) return { applied: 0, keptServing: true }
    if (allow('floor')) {
      try {
        n = await suppressCampaignBids(camp.id, { actor: ctx.actor as AdsActor, reason: 'rank base-bid = suppress (placements stay set)' })
        await recordMinBidEntry(camp.id, ctx.actor, 2, entries + 1)
      } catch (e) { logger.warn('[rank-defend] base-bid suppress failed', { campaignId: camp.id, error: (e as Error).message }) }
    }
    writes.suppress += n
    return { applied: n, keptServing: false }
  }
  if (mode === 'absolute' && spec.bidValueCents != null && spec.bidValueCents > 0) {
    const ags = await prisma.adGroup.findMany({ where: { campaignId: camp.id }, select: { id: true, defaultBidCents: true } })
    const moves = ags.filter((g) => g.defaultBidCents !== spec.bidValueCents)
    if (!moves.length || !allow('forward')) return none
    for (const g of moves) {
      try { const r = await updateAdGroupWithSync({ adGroupId: g.id, patch: { defaultBidCents: spec.bidValueCents }, actor: ctx.actor as AdsActor, reason: 'rank base-bid (absolute)', applyImmediately: true }); if (r.ok) n++ } catch (e) { logger.warn('[rank-defend] base-bid absolute failed', { campaignId: camp.id, adGroupId: g.id, error: (e as Error).message }) }
    }
    writes.base += n
    return { applied: n, keptServing: false }
  }
  if (mode === 'deltaPct' && spec.bidDeltaPct != null) {
    if (!ctx.permit.forward) {
      // Only note it as held back when it would actually move a bid (applyBaseBidDelta is idempotent).
      if (await baseBidDeltaWouldMove(camp.id, spec.bidDeltaPct)) held.forward = true
      return none
    }
    try { n = await applyBaseBidDelta(camp.id, spec.bidDeltaPct, { actor: ctx.actor as AdsActor, reason: `rank base-bid ${spec.bidDeltaPct >= 0 ? '+' : ''}${spec.bidDeltaPct}%` }) } catch (e) { logger.warn('[rank-defend] base-bid delta failed', { campaignId: camp.id, error: (e as Error).message }) }
    writes.base += n
    return { applied: n, keptServing: false }
  }
  return none
}

// 1c — read-only twins of revertBaseBidDelta / applyBaseBidDelta's own skip rules, used only when the permit
// withholds them, so a held-back run reports a change it would really have made rather than every delta campaign.
async function hasBaseBidDelta(campaignId: string): Promise<boolean> {
  const [g, t] = await Promise.all([
    prisma.adGroup.count({ where: { campaignId, baseBidFromCents: { not: null } } }),
    prisma.adTarget.count({ where: { adGroup: { campaignId }, baseBidFromCents: { not: null } } }),
  ])
  return g + t > 0
}
async function baseBidDeltaWouldMove(campaignId: string, deltaPct: number): Promise<boolean> {
  const [groups, targets] = await Promise.all([
    prisma.adGroup.findMany({ where: { campaignId }, select: { defaultBidCents: true, baseBidFromCents: true } }),
    prisma.adTarget.findMany({ where: { adGroup: { campaignId }, isNegative: false }, select: { bidCents: true, baseBidFromCents: true } }),
  ])
  const moves = (cur: number, from: number | null) => !(from != null && cur === deltaBidCents(from, deltaPct))
  return groups.some((g) => moves(g.defaultBidCents, g.baseBidFromCents)) || targets.some((t) => moves(t.bidCents, t.baseBidFromCents))
}

// 2b — the out-of-budget hold is logged once per key (schedule actor + campaign) per UTC day: the tick runs every 15
// minutes and a warning per tick would bury it. Only today's keys are kept.
function oncePerUtcDay(): (key: string, now?: Date) => boolean {
  let noticeDay = ''
  const noticed = new Set<string>()
  return (key, now = new Date()) => {
    const day = now.toISOString().slice(0, 10)
    if (day !== noticeDay) { noticeDay = day; noticed.clear() }
    if (noticed.has(key)) return false
    noticed.add(key)
    return true
  }
}
export const firstOutOfBudgetNoticeToday = oncePerUtcDay()
// 2c — the anti-flap hold is logged once per campaign per UTC day, the same way.
export const firstKeptServingNoticeToday = oncePerUtcDay()

/**
 * 2c (review 2.5, G.11) — anti-flap. A campaign enters Min bid at most MAX_MIN_BID_ENTRIES_PER_DAY times a UTC day;
 * a later Min-bid hour leaves it serving (nothing is written) until the next UTC day. Each entry floors every bid and
 * the next serving hour gives every bid back, so a table painted on and off Min bid all day costs ~2 writes per bid
 * per switch; this can only take writes away.
 *
 * Counted from the action log: each entry leaves ONE record row on the campaign — a `custom_event`, which the caps,
 * the breaker and the day count already leave out, and which the Change Log shows as a note and never offers to undo.
 * The bid rows themselves are per ad group and target, so they cannot say how many times a campaign entered.
 */
const MIN_BID_ENTRY_MARK = 'rankMinBidEntry'
const utcMidnight = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
async function minBidEntriesToday(campaignIds: string[], now: Date): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (!campaignIds.length) return out
  try {
    const rows = await prisma.advertisingActionLog.groupBy({
      by: ['entityId'],
      where: {
        ...engineActorWhere('rank-defend'), actionType: 'custom_event', entityType: 'CAMPAIGN', entityId: { in: campaignIds },
        createdAt: { gte: utcMidnight(now) }, payloadAfter: { path: [MIN_BID_ENTRY_MARK], equals: true },
      },
      _count: { _all: true },
    })
    for (const r of rows) out.set(r.entityId, r._count._all)
  } catch (e) {
    // Unknown is not zero, but anti-flap only ever takes writes away: without a count the tick runs as before 2c.
    logger.warn('[rank-defend] could not count today\'s Min-bid entries — anti-flap not applied this run', { error: (e as Error).message })
  }
  return out
}
async function recordMinBidEntry(campaignId: string, actor: string, floorCents: number, entry: number): Promise<void> {
  try {
    await prisma.advertisingActionLog.create({
      data: {
        actionType: 'custom_event', entityType: 'CAMPAIGN', entityId: campaignId, userId: actor, payloadBefore: {}, amazonResponseStatus: 'SUCCESS',
        payloadAfter: { [MIN_BID_ENTRY_MARK]: true, note: `Min bid: every bid floored to €${(floorCents / 100).toFixed(2)} — entry ${entry} of ${MAX_MIN_BID_ENTRIES_PER_DAY} allowed today (UTC)` },
      },
    })
  } catch (e) { logger.warn('[rank-defend] could not record a Min-bid entry — it will not count toward today\'s limit', { campaignId, error: (e as Error).message }) }
}
const keptServingWords = (entries: number): string =>
  `kept serving: this campaign already entered Min bid ${entries === 1 ? 'once' : `${entries} times`} today (UTC) — a campaign is floored at most ${MAX_MIN_BID_ENTRIES_PER_DAY} times a day, so its bids stay as they are until tomorrow`

async function decideAndMaybeApply(
  camp: CampRow, key: string, spec: RankTargetSpec, planId: string | null,
  ctx: { write: boolean; permit: CampaignPermit; actor: string; suppressRaise?: boolean; maxBaseBidByCampaign?: Map<string, number>; entriesToday?: number },
): Promise<RankCampaignResult> {
  // 1c — every write below asks the campaign's permit first (dial posture + caps, decided once per campaign by the
  // caller). What it may not write is noted in `held`; on a dry run (`write` false) nothing is written or noted.
  // 2c — `writes` counts what it wrote by kind, in the order it writes: restore, suppress, placement, base.
  const held = nothingHeld()
  const writes = noWrites()
  const allow = (kind: keyof HeldBack) => allowChange(ctx.write, ctx.permit, held, kind)
  const cdb = (camp.dynamicBidding ?? {}) as { placementBidding?: Array<{ placement: string; percentage: number }> }
  // PP — read the bias of the TARGET's placement (Top for own-top/defend/all-out, Rest
  // for rest-of-search), not always Top. The engine drives whichever placement the
  // active target names.
  const currentPct = cdb.placementBidding?.find((x) => x.placement === spec.placement)?.percentage ?? 0
  const base = { campaignId: camp.id, campaignName: camp.name, targetKey: key, currentPct, planId }
  let applied = 0
  // C2 — never bid UP into a capped campaign (burns the fixed daily budget early + surrenders the slot): a placement
  // raise waits, a lowering and a floor still land. 2b (review N2) — read from Amazon's real codes (delivery-reasons.ts);
  // the bare 'OUT_OF_BUDGET' matched here before is not one Amazon sends, so this never held a raise.
  const budgetWords = outOfBudgetWords(camp.deliveryReasons)
  const campOutOfBudget = isOutOfBudget(camp.deliveryReasons)
  const budgetWait = (what: string): string => `${budgetWords} — the ${what} raise waits until the budget resets or is raised`
  // Logged once per schedule (a plan: per campaign) per UTC day, not every tick; a dry run logs nothing.
  const logBudgetHold = (what: string): void => {
    if (ctx.write && firstOutOfBudgetNoticeToday(`${ctx.actor}|${camp.id}`)) logger.warn('[rank-defend] campaign out of budget — placement raise waits (logged once a day per schedule)', { campaignId: camp.id, campaign: camp.name, actor: ctx.actor, deliveryReasons: camp.deliveryReasons, held: what })
  }
  // 2a (review N1) — a floor this engine did not set (a person's, the out-of-stock check's, budget enforcement's) is not
  // its to lift, move or build on: no restore, no re-floor, no base-bid or placement change while it holds. The serve
  // path used to restore any floor at all.
  if (camp.bidsSuppressedAt && !isRankOwnedFloor(camp.bidsSuppressedBy)) {
    return { decision: { ...base, action: 'hold', reason: `bids held at a floor set by ${floorOwnerWords(camp.bidsSuppressedBy)} — rank leaves this campaign alone until that floor is lifted`, nextPct: currentPct, applied: false }, applied: 0, held, writes, keptServing: false }
  }
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
    // 2c — anti-flap: a third entry on one UTC day is not made. The campaign keeps serving and nothing is written for
    // it this tick — no floor and no Min-bid placement — so it holds what its last serving hour set.
    const entries = ctx.entriesToday ?? 0
    if (!camp.bidsSuppressedAt && entries >= MAX_MIN_BID_ENTRIES_PER_DAY) {
      if (ctx.write && firstKeptServingNoticeToday(camp.id)) logger.warn(`[rank-defend] ${camp.name}: ${keptServingWords(entries)} (logged once a day per campaign)`, { campaignId: camp.id, actor: ctx.actor, entriesToday: entries })
      return { decision: { ...base, action: 'hold', reason: keptServingWords(entries), nextPct: currentPct, applied: false }, applied: 0, held, writes, keptServing: true }
    }
    let suppressed = 0
    // 1c — moving an already-floored campaign to a HIGHER floor raises bids: that is a raise, not a floor (it waits
    // while stopped, where the gate passes only lowering writes).
    const raisesFloor = !!camp.bidsSuppressedAt && floor > normaliseFloorCents(camp.bidsSuppressedFloorCents)
    if (!atFloorAlready && allow(raisesFloor ? 'forward' : 'floor')) {
      try {
        // Not-yet-suppressed → suppress at this floor. Already suppressed at a DIFFERENT
        // floor → move it, which is the case suppressCampaignBids refuses by design.
        suppressed = camp.bidsSuppressedAt
          ? await refloorCampaignBids(camp.id, { actor: ctx.actor as AdsActor, floorCents: floor, reason: `rank — Min bid → floor €${(floor / 100).toFixed(2)}` })
          : await suppressCampaignBids(camp.id, { actor: ctx.actor as AdsActor, floorCents: floor, reason: `rank — Min bid → bids floored to €${(floor / 100).toFixed(2)} (no-pause)` })
        if (!camp.bidsSuppressedAt) await recordMinBidEntry(camp.id, ctx.actor, floor, entries + 1)
      } catch (e) { logger.warn('[rank-defend] bid-suppress failed', { campaignId: camp.id, error: (e as Error).message }) }
    }
    applied += suppressed
    writes.suppress += suppressed
    // MB.3 — placement during Min-bid hours. Until now the multipliers were left exactly as
    // the PREVIOUS window set them, so a Min-bid hour following an all-out one still carried
    // Top +300% and the floored bid served at ~4× its face value. A Placement % on the
    // Min-bid target now governs that too; leaving it blank keeps the old behaviour, which is
    // what every already-saved schedule has.
    let placeNote = ''
    let placed = false
    let placeHeld = false
    if (spec.biasPct != null) {
      const want = Math.max(0, Math.min(900, Math.round(spec.biasPct)))
      if (campOutOfBudget && want > currentPct) {
        // 2b — the floor above still lands; only the placement raise waits.
        const move = `${shortPlace(spec.placement)} ${currentPct}→${want}%`
        placeHeld = true
        placeNote = ` · ${budgetWait(move)}`
        logBudgetHold(move)
      } else if (currentPct !== want) {
        placeNote = ` · ${shortPlace(spec.placement)} ${currentPct}→${want}%`
        if (allow('forward')) {
          // Floor first, then the multiplier: for one tick the campaign is at the floored bid
          // with the OLD multiplier, never at the old bid with a new one.
          try { await setSearchPlacement(camp.id, spec.placement, want, { actor: ctx.actor, reason: `rank — Min bid placement ${currentPct}→${want}%` }); applied++; writes.placement++; placed = true } catch (e) { logger.warn('[rank-defend] min-bid placement failed', { campaignId: camp.id, error: (e as Error).message }) }
        }
      } else placeNote = ` · ${shortPlace(spec.placement)} held ${want}%`
    }
    const reason = `target = Min bid → bids at floor €${(floor / 100).toFixed(2)} (campaign live, restorable)${placeNote}`
    return { decision: { ...base, action: 'pause', reason, nextPct: spec.biasPct != null && !placeHeld ? Math.max(0, Math.min(900, Math.round(spec.biasPct))) : currentPct, applied: suppressed > 0 || placed || (ctx.write && !!camp.bidsSuppressedAt) }, applied, held, writes, keptServing: false }
  }
  // Serve target → restore any no-pause bid suppression (exact prior bids), UNLESS the
  // target's own base-bid directive is 'suppress' (then we keep bids floored on purpose).
  // 1c — a give-back, so a cap never refuses it; while stopped it is not attempted at all (bidsSuppressedAt stays set
  // and the first run after Resume restores), because the gate would refuse the raise after Nexus restored its copy.
  if (camp.bidsSuppressedAt && spec.bidMode !== 'suppress' && allow('restore')) {
    try { const n = await restoreCampaignBids(camp.id, { actor: ctx.actor as AdsActor, reason: 'rank — serve target → restore prior bids' }); applied += n; writes.restore += n } catch (e) { logger.warn('[rank-defend] bid-restore failed', { campaignId: camp.id, error: (e as Error).message }) }
  }
  // 2c — the base-bid give-back (leaving a ±% base bid) goes with the restore, before any placement write.
  const reverted = await revertBaseBidDirective(camp, spec, ctx, held, writes)
  applied += reverted
  // SYNC.1 — a PAUSED campaign is left PAUSED. This used to read "resume only if something ELSE
  // left it paused (we never pause)" and push status=ENABLED to Amazon. Since NP the engine
  // suppresses with a bid floor and never pauses a campaign, so there was nothing of ours left to
  // resume — the only pauses it ever undid were somebody else's. On 2026-08-21 that was the
  // operator's, in Seller Central: 20 campaigns re-enabled 10 minutes after the settings sync had
  // correctly pulled their pause down. Serving the slot is not worth overriding a human's decision
  // about whether a campaign should run at all. `updateCampaignWithSync` now refuses this write for
  // engine actors, so re-adding it here fails loudly rather than silently working again.
  //
  // Bid suppression above is still restored on a serve target — that IS ours, and it is the lever
  // the engine is meant to pull.
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

  // ── BL — blended path: drive Top + Rest of Search + Product pages SIMULTANEOUSLY ──
  // in one combined placement write. 2e — each lane holds its own fixed Placement %; no lane reads a signal.
  if (spec.lanes && spec.lanes.length) {
    const laneDecisions: NonNullable<RankDefendDecision['lanes']> = []
    const driven: Array<{ placement: string; percentage: number }> = []
    const capped: string[] = [] // MB.4 — lanes the CPC ceiling pulled back, named in the reason
    const budgetHeld: string[] = [] // 2b — lane raises waiting on an out-of-budget campaign, named in the reason
    for (const lane of spec.lanes) {
      const laneCur = cdb.placementBidding?.find((x) => x.placement === lane.placement)?.percentage ?? 0
      const dd = computeStep(laneToSpec(spec, lane), { currentPct: laneCur })
      let toPct = dd.nextPct, act = dd.action
      if (campOutOfBudget && act === 'raise') budgetHeld.push(`${shortPlace(lane.placement)} ${laneCur}→${toPct}%`)
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
    if (budgetHeld.length) logBudgetHold(budgetHeld.join(', '))
    const blendReason = `blend: ${laneDecisions.map((l) => `${shortPlace(l.placement)} ${l.fromPct}→${l.toPct}`).join(', ')}${budgetHeld.length ? ` · ${budgetWait(budgetHeld.join(', '))}` : ''}${capped.length ? ` · CPC ceiling €${((spec.maxCpcCents ?? 0) / 100).toFixed(2)} capped ${capped.join(', ')}${cpcCap?.baseAlone ? ' (base bid ALONE exceeds it)' : ''}` : ''}`
    const placeAllowed = changed && allow('forward')
    if (placeAllowed) {
      try { const { updatePlacementBidding } = await import('../services/advertising/ads-create.service.js'); await updatePlacementBidding({ campaignId: camp.id, adjustments, actor: ctx.actor, reason: blendReason, targetKey: spec.key }); applied++; writes.placement++ } catch (e) { logger.warn('[rank-defend] blended apply failed', { campaignId: camp.id, error: (e as Error).message }) }
    }
    const baseRes = await applyBaseBidDirective(camp, spec, ctx, held, writes)
    applied += baseRes.applied
    const head = laneDecisions.find((l) => l.placement === 'PLACEMENT_TOP') ?? laneDecisions[0]
    const reason = `${blendReason}${baseBidNote(spec)}${baseRes.keptServing ? ` · ${keptServingWords(ctx.entriesToday ?? 0)}` : ''}`
    return { decision: { ...base, action: head?.action ?? 'hold', reason, nextPct: head?.toPct ?? currentPct, applied: placeAllowed || reverted + baseRes.applied > 0, lanes: laneDecisions, baseBid: spec.bidMode && spec.bidMode !== 'hold' ? { mode: spec.bidMode, valueCents: spec.bidValueCents } : null }, applied, held, writes, keptServing: baseRes.keptServing }
  }

  // ── Single-placement path ──────────────────────────────────────────────────────
  // 2e — the target's fixed Placement %; no impression share, ACoS, SQP or loss proxy is read.
  const d = computeStep(spec, { currentPct })
  let action = d.action, nextPct = d.nextPct, reason = d.reason
  if ((ctx.suppressRaise || campOutOfBudget) && action === 'raise') {
    const move = `${shortPlace(spec.placement)} ${currentPct}→${nextPct}%`
    action = 'hold'; nextPct = currentPct
    if (campOutOfBudget) logBudgetHold(move)
    reason = campOutOfBudget ? budgetWait(move) : 'family daily budget reached — holding (no raise)'
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
  const willApply = (targetChanges || otherCur > 0) && allow('forward')
  if (willApply) {
    // HX.1 — attribute the write. Without the actor this row lands with userId:null and cannot be
    // traced back to the schedule or plan that made it.
    try { await setSearchPlacement(camp.id, spec.placement, targetChanges ? nextPct : currentPct, { actor: ctx.actor, reason }); applied++; writes.placement++ } catch (e) { logger.warn('[rank-defend] apply failed', { campaignId: camp.id, error: (e as Error).message }) }
  }
  const baseRes = await applyBaseBidDirective(camp, spec, ctx, held, writes)
  applied += baseRes.applied
  const keptNote = baseRes.keptServing ? ` · ${keptServingWords(ctx.entriesToday ?? 0)}` : ''
  return { decision: { ...base, action, reason: reason + baseBidNote(spec) + keptNote, nextPct, applied: willApply || reverted + baseRes.applied > 0, baseBid: spec.bidMode && spec.bidMode !== 'hold' ? { mode: spec.bidMode, valueCents: spec.bidValueCents } : null }, applied, held, writes, keptServing: baseRes.keptServing }
}

// RD.5 — family guardrails. effectiveSpec transforms the window target before the
// controller sees it: OOS/lost-buybox → pause (stop wasting spend). 2e — the family ACOS cap only ever took
// all-out off a target; nothing climbs any more, so it has nothing left to do and is not read.
export function effectiveSpec(spec: RankTargetSpec, flags: { oos?: boolean }): RankTargetSpec {
  if (flags.oos) return { ...spec, pause: true }
  return spec
}

// Family-aggregate spend (most recent day with data) over a set of
// campaigns. localEntityId = Campaign.id; costMicros → cents (÷10000).
async function familySpendRecentCents(campaignIds: string[]): Promise<number> {
  if (!campaignIds.length) return 0
  const latest = await prisma.amazonAdsDailyPerformance.findFirst({ where: { entityType: 'CAMPAIGN', localEntityId: { in: campaignIds } }, orderBy: { date: 'desc' }, select: { date: true } })
  if (!latest) return 0
  const agg = await prisma.amazonAdsDailyPerformance.aggregate({ where: { entityType: 'CAMPAIGN', localEntityId: { in: campaignIds }, date: latest.date }, _sum: { costMicros: true } })
  return Math.round(Number(agg._sum.costMicros ?? 0n) / 10000)
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
  // 1e — a LIVE run (the tick, Run now, a plan's Apply now) honours this business's switch and the scheduler's arm
  // flags, and holds the engine lock so it never runs beside another (ads-engine-lock.ts). A dry run previews freely.
  if (opts.dryRun) return rankDefendTick(opts)
  const { guardLiveRun } = await import('../services/advertising/ads-engine-lock.js')
  const run = await guardLiveRun('rank-defend', () => rankDefendTick(opts))
  return run.ran ? run.value : { evaluated: 0, applied: 0, decisions: [], plans: [], skipped: run.reason }
}

async function rankDefendTick(opts: { dryRun?: boolean; onlyPlanId?: string; force?: boolean }): Promise<RankDefendSummary> {
  const dryRun = !!opts.dryRun
  // onlyPlanId scopes a run to ONE plan (per-plan run-now / apply-now): skip schedules
  // and the enabled filter, so even a disabled plan can be previewed or manually applied.
  const schedules = opts.onlyPlanId ? [] : (await prisma.adSchedule.findMany({ where: { enabled: true } })).filter((s) => isGoalMode(s.windows, s.defaultTargetKey))
  const plans = await prisma.productRankPlan.findMany({ where: opts.onlyPlanId ? { id: opts.onlyPlanId } : { enabled: true } })
  if (schedules.length === 0 && plans.length === 0) {
    // 2a — nothing to run, but a floor left behind (every schedule deleted while halted, say) still needs the sweep.
    if (dryRun || opts.onlyPlanId) return { evaluated: 0, applied: 0, decisions: [], plans: [] }
    const guard = await openEngineGuard('rank-defend')
    const release = await giveBack(guard, [], new Set())
    return { evaluated: 0, applied: 0, decisions: [], plans: [], guard: guard.report(), release }
  }

  // Authoritative clock for ALL window resolution in this run (not the container process clock).
  const clockNow = await dbNow()

  const targets = await prisma.rankTarget.findMany()
  const targetByKey = new Map(targets.map((t) => [t.key, t as unknown as RankTargetRow]))

  // Resolve each plan's family campaigns LIVE (RD.4) → the governed set, so the
  // schedule loop never fights a plan over the same campaign (precedence: plan wins).
  const { resolveProductFamily } = await import('../services/advertising/ads-dayparting-refresh.service.js')
  const planFamilies: Array<{ plan: (typeof plans)[number]; campaigns: Array<{ id: string }> }> = []
  const governed = new Set<string>()
  // 2a — a plan whose family could not be resolved leaves `governed` incomplete, so the orphan sweep sits this run out.
  let familyUnknown = false
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
            await notifyAutomation({ type: 'rank_plan_mistarget', severity: 'danger', title: 'Rank plan auto-paused — blast-radius guard', body: `A rank plan resolved to ${camps.length} campaigns (cap ${plan.maxCampaigns}) for ${plan.marketplace} and was switched off before it could fan out. It stays off. The Rank-defend engine is switched in the Control Room.`, href: '/marketing/ads/rules-automation/control-room', meta: { planId: plan.id, productId: plan.productId, marketplace: plan.marketplace, resolved: camps.length, max: plan.maxCampaigns } })
          } catch { /* notify is best-effort */ }
        }
        continue
      }
      planFamilies.push({ plan, campaigns: camps })
      for (const c of camps) governed.add(c.id)
    } catch (e) { familyUnknown = true; logger.warn('[rank-defend] family resolve failed', { planId: plan.id, error: (e as Error).message }) }
  }

  // Union of schedule + plan campaigns → one campaign load + one signal pass.
  const unionIds = [...new Set([...schedules.map((s) => s.campaignId), ...governed])]
  const campaigns = await prisma.campaign.findMany({ where: { id: { in: unionIds } }, select: { id: true, name: true, marketplace: true, status: true, externalCampaignId: true, dynamicBidding: true, biddingStrategy: true, acos: true, spend: true, bidsSuppressedAt: true, bidsSuppressedFloorCents: true, bidsSuppressedBy: true, deliveryReasons: true } })
  const campById = new Map(campaigns.map((c) => [c.id, c]))
  // RTC — per-campaign (campaign-scope) target overrides for every campaign in play.
  const schedOverrides = new Map<string, TargetOverrideMap>()
  try {
    const so = await prisma.adSchedule.findMany({ where: { campaignId: { in: unionIds } }, select: { campaignId: true, targetOverrides: true } })
    for (const s of so) { const m = s.targetOverrides as TargetOverrideMap; if (m && Object.keys(m).length) schedOverrides.set(s.campaignId, m) }
  } catch { /* best-effort */ }

  // 2e — no signal reads here any more (Top-of-search share, the hourly loss proxy, SQP share): the tick sets the
  // hour's fixed values and none of them fed anything else.

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

  const decisions: RankDefendDecision[] = []
  const planSummaries: RankPlanRunSummary[] = []
  let applied = 0
  // 1c — the account dial and this engine's caps, read once per run. Each campaign asks for its permit once, before
  // its first write, so a campaign is never split; a dry run reads neither (it writes nothing).
  const guard = dryRun ? null : await openEngineGuard('rank-defend')
  // 2a — campaigns where nothing is due this hour: what this engine floored there is given back.
  const idle: IdleCampaign[] = []
  // 2c — decide, then write. The two loops below only resolve each campaign's hour into a work item and write nothing;
  // the items then run in RANK_WRITE_ORDER (after the give-backs above), and their decisions are put back in loop
  // order, so every summary and plan receipt reads as before.
  const work: RankWork[] = []
  const planRuns: Array<{ plan: (typeof plans)[number]; key: string | null; conflicts: SelfCompetitionConflict[]; items: RankWork[] }> = []

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
    const items: RankWork[] = []
    let planConflicts: SelfCompetitionConflict[] = []
    const write = !dryRun && PLAN_ALLOW_APPLY && (!plan.manualOnly || !!opts.force)
    if (write && (!key || !targetByKey.get(key))) {
      const why = key ? `its plan names "${key}", which no longer exists` : 'its plan holds nothing at this hour'
      for (const fc of famCamps) idle.push({ campaignId: fc.id, actor: `automation:rank-plan-${plan.id}`, why })
    }
    if (key) {
      const target = targetByKey.get(key)
      if (target) {
        // RD.5 — family pre-flight guards (once per plan, shared by every campaign):
        // retail-readiness (OOS/lost-buybox), family daily spend vs budget cap.
        const famCampIds = famCamps.map((c) => c.id)
        const readinessByCamp = await getReadiness(plan.marketplace)
        const overBudget = plan.familyDailyBudgetCents != null && (await familySpendRecentCents(famCampIds)) >= plan.familyDailyBudgetCents
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
          const eff = effectiveSpec(applyTargetOverrides(toSpec(demote ? baselineTarget! : target), plan.targetOverrides as TargetOverrideMap, schedOverrides.get(fc.id)), { oos })
          const item: RankWork = { seq: work.length, camp, key: useKey, spec: eff, planId: plan.id, write, actor: `automation:rank-plan-${plan.id}`, suppressRaise: overBudget }
          items.push(item); work.push(item)
        }
      }
    }
    planRuns.push({ plan, key, conflicts: planConflicts, items })
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
    // 2a — nothing is held, so what this schedule floored is given back (it used to stay floored until a window opened).
    if (!key) { idle.push({ campaignId: camp.id, actor: `automation:rank-defend-${s.id}`, why: 'its schedule holds nothing at this hour' }); continue }
    // A resolved key with no RankTarget behind it is a dangling reference (the target was
    // deleted after the schedule was authored). Nothing is held, so record nothing held.
    const target = targetByKey.get(key)
    if (!target) { receipts.set(s.id, null); idle.push({ campaignId: camp.id, actor: `automation:rank-defend-${s.id}`, why: `its schedule names "${key}", which no longer exists` }); continue }
    work.push({ seq: work.length, camp, key, spec: applyTargetOverrides(toSpec(target), s.targetOverrides as TargetOverrideMap), planId: null, write: !dryRun, actor: `automation:rank-defend-${s.id}` })
  }

  // 2a — a one-plan run does not know who else holds a campaign, nor does a run that could not resolve a plan's family:
  // neither sweeps. 2c — the give-backs run first, before any campaign's new writes.
  if (familyUnknown && !opts.onlyPlanId) logger.warn('[rank-defend] a plan family could not be resolved — orphan sweep skipped this run')
  const release = guard ? await giveBack(guard, idle, opts.onlyPlanId || familyUnknown ? null : governed) : undefined

  // 2c — then every campaign, in RANK_WRITE_ORDER (restore → suppress → placement → base), loop order within a kind.
  const entriesToday = await minBidEntriesToday([...new Set(work.map((w) => w.camp.id))], clockNow)
  const order = new Map(work.map((w) => [w, RANK_WRITE_ORDER.indexOf(firstWriteIntent(w.camp, w.spec))]))
  const writes = noWrites()
  let keptServing = 0
  for (const w of [...work].sort((a, b) => order.get(a)! - order.get(b)! || a.seq - b.seq)) {
    const permit = w.write && guard ? guard.permit() : DRY_RUN
    const r = await decideAndMaybeApply(w.camp, w.key, w.spec, w.planId, { write: w.write, permit, actor: w.actor, maxBaseBidByCampaign, suppressRaise: w.suppressRaise, entriesToday: entriesToday.get(w.camp.id) ?? 0 })
    if (w.write) guard?.settle(permit, r.applied, r.held)
    applied += r.applied
    for (const k of Object.keys(writes) as Array<keyof RankWriteCounts>) writes[k] += r.writes[k]
    if (r.keptServing) keptServing++
    w.result = r
  }
  for (const w of work) decisions.push(w.result!.decision)
  for (const { plan, key, conflicts, items } of planRuns) {
    const planDecisions = items.map((i) => i.result!.decision)
    planSummaries.push({ planId: plan.id, productId: plan.productId, marketplace: plan.marketplace, campaigns: planDecisions.length, decisions: planDecisions, selfCompetition: conflicts })
    if (!dryRun) {
      try { await prisma.productRankPlan.update({ where: { id: plan.id }, data: { lastEvaluatedAt: new Date(), lastSummary: { at: new Date().toISOString(), activeTargetKey: key ?? null, campaigns: planDecisions.length, decisions: planDecisions, selfCompetition: conflicts } as never } }) } catch { /* best-effort */ }
    }
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

  if (release) writes.restore += release.writes
  return { evaluated: decisions.length, applied, decisions, plans: planSummaries, ...(guard ? { guard: guard.report(), writes, keptServing } : {}), ...(release ? { release } : {}) }
}

interface IdleCampaign { campaignId: string; actor: AdsActor; why: string }
// 2c — one campaign's hour, resolved before the tick writes anything; `result` is filled when it runs.
interface RankWork { seq: number; camp: CampRow; key: string; spec: RankTargetSpec; planId: string | null; write: boolean; actor: AdsActor; suppressRaise?: boolean; result?: RankCampaignResult }

/**
 * 2a — every live run, first (2c: before any new write): give back what this engine floored where nothing is due, then
 * the orphan sweep (`sweepGoverned` = campaigns enabled plans hold; null skips it). Both ask the guard per campaign: counted against the
 * caps and never refused by one; while stopped they wait, and the sweep of the first run after Resume gives them back.
 * The sweep changes paused campaigns only; a live one is listed for a person (Owner, 2026-10-04 — rank-release.service.ts).
 */
async function giveBack(guard: EngineGuard, idle: IdleCampaign[], sweepGoverned: Set<string> | null): Promise<RankReleaseSummary> {
  const out = emptyRelease()
  for (const why of new Set(idle.map((i) => i.why))) addRelease(out, await releaseCampaigns(idle.filter((i) => i.why === why), { reason: `rank release — ${why}`, guard }))
  let swept = 0
  if (sweepGoverned) {
    try { const sw = await sweepOrphanReleases({ guard, governed: sweepGoverned }); swept = sw.orphans; addRelease(out, sw) }
    catch (e) { logger.warn('[rank-defend] orphan sweep failed', { error: (e as Error).message }) }
  }
  const { campaigns: _detail, ...counts } = out
  return { ...counts, swept }
}

/** 2a — what the run gave back, in the summary line; nothing extra when it gave back nothing. */
export function rankReleaseNote(r: RankReleaseSummary | null | undefined): string {
  if (!r || !(r.restored || r.failed || r.deferred)) return ''
  const restored = r.restored ? ` released=${r.restored}${r.writes ? ` (${r.writes} bid${r.writes === 1 ? '' : 's'} back)` : ''}` : ''
  return `${restored}${r.swept ? ` swept=${r.swept}` : ''}${r.failed ? ` release-failed=${r.failed} (kept for the next run)` : ''}${r.deferred ? ` release-waiting=${r.deferred} (${r.deferredWhy ?? 'stopped'})` : ''}`
}

/**
 * 2c — the run's changes by kind, in the order it wrote them (`restore` includes the release's give-backs), and the
 * campaigns the cap moved to the next run. Nothing extra on a run that wrote and deferred nothing; ` kept-serving=N`
 * only when the anti-flap held a Min-bid hour.
 */
export function rankWritesNote(r: Pick<RankDefendSummary, 'writes' | 'keptServing' | 'guard'>): string {
  const w = r.writes
  const deferred = r.guard?.deferredByCap ?? 0
  const kept = r.keptServing ? ` kept-serving=${r.keptServing} (entered Min bid ${MAX_MIN_BID_ENTRIES_PER_DAY} times today already)` : ''
  if (!w || !(w.restore || w.suppress || w.placement || w.base || deferred)) return kept
  return ` restore=${w.restore} suppress=${w.suppress} placement=${w.placement} base=${w.base} deferred=${deferred}${kept}`
}

/** 1c — the run's summary line: the counts, plus what the dial or the caps held back (nothing extra on a normal run). */
export function rankDefendSummaryLine(r: RankDefendSummary): string {
  if (r.skipped) return `skipped: ${r.skipped}`
  return `evaluated=${r.evaluated} applied=${r.applied}${rankWritesNote(r)}${engineGuardNote(r.guard)}${rankReleaseNote(r.release)}`
}

export async function runRankDefendCron(): Promise<void> {
  try {
    await recordCronRun('ad-rank-defend', async () => {
      // R16 — this business's own switch (the env armed the cron; a business may still switch it off).
      const { engineMode } = await import('../services/automation/engine-switch.service.js')
      const gate = await engineMode('rank-defend', 'AUTO')
      if (gate.mode === 'OFF') return `skipped: ${gate.note}`
      const r = await runRankDefendOnce()
      if (r.skipped) return rankDefendSummaryLine(r) // 1e — it did not run (e.g. a Run now holds the lock): no sweep either
      // AR — after holding the slot, re-push any bid/placement whose LAST live write
      // to Amazon failed (dead-lettered queue rows + failed inline placement), so
      // Amazon converges to our local truth without waiting for the next change or a
      // manual resync. Bounded + gated; a sweep error must not fail the rank tick.
      let rec = ''
      try {
        const { reconcileFailedAmazonWrites } = await import('../services/advertising/ads-write-reconcile.service.js')
        const rr = await reconcileFailedAmazonWrites({ limit: 50 })
        if (rr.attempted || rr.skippedPermanent || rr.orphansCleared) {
          rec = ` reconciled=${rr.attempted}(ag=${rr.adGroups},tg=${rr.adTargets},cm=${rr.campaigns})${rr.skippedPermanent ? ` skip-perm=${rr.skippedPermanent}` : ''}${rr.orphansCleared ? ` orphans-cleared=${rr.orphansCleared}` : ''}`
        }
      } catch (e) { logger.warn('[ad-rank-defend] reconcile sweep failed', { error: (e as Error).message }) }
      return `${rankDefendSummaryLine(r)}${rec}`
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
  task = cron.schedule(schedule, async () => {
    if (running) { await logger.warn('[ad-rank-defend] previous tick still in flight — skipping this run'); return }
    running = true
    await runRankDefendCron().finally(() => { running = false })
  })
  logger.info(`ad-rank-defend cron scheduled (${schedule})`)
}
