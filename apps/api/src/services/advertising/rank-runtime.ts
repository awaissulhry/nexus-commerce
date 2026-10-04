/**
 * RD.P2 — what each campaign is being asked to hold right now, is it holding it, and if not, what
 * is stopping it.
 *
 * The list page has always been group-grained while every defect is campaign-grained: one row
 * called "IT GALE JACKET" hides eleven campaigns with four different fates, and all of them render
 * `Health: OK`. This module is the campaign-grained answer, and the group row is a **roll-up of it**
 * rather than a second derivation — an aggregate computed separately is free to drift from its own
 * members.
 *
 * 🔴 **It reuses the engine's functions and reimplements none of them.** `resolveActiveTargetKey`,
 * `applyTargetOverrides`, `toSpec`, `biasBand`, `cpcCapPct` and `strategyHeadroom` are imported
 * from the controller and the job, so a page column cannot disagree with the loop that actually
 * decides. The one place this module adds judgement is naming the states.
 *
 * 2e (Owner D1 = A) — the loop is an hour-of-day bid plan: every serving hour HOLDS the Placement % its target sets
 * (per lane for a blend), capped only by the CPC ceiling. Nothing chases a goal, so there is no `all-out` or `chasing`
 * state any more, `goal` is never live, and "cannot converge" means only that the CPC ceiling holds a campaign below
 * the % its hour sets.
 *
 * The path mirrors `runRankDefendOnce`'s schedule loop (`ad-rank-defend.job.ts:663–681`) exactly:
 *
 *     enabled && isGoalMode        → otherwise the loop never sees this schedule
 *     governed by a ProductRankPlan → the loop SKIPS it (plan wins)
 *     event ?? weekly plan          → events override the plan
 *     resolveActiveTargetKey(...)   → null means "we looked, nothing was due"
 *     targetByKey.get(key)          → missing means a dangling reference
 *     applyTargetOverrides(toSpec(target), schedule.targetOverrides)
 *
 * Note the override source: the **AdSchedule** row, not the group. `saveRankScheduleGroup`
 * materialises the group's per-campaign map down onto each member as that campaign's slice
 * (`ads-create.service.ts:1159`), and the engine reads the member. Reading the group map here would
 * be a different answer for any campaign whose slice was not what the group holds.
 */
import {
  biasBand, cpcCapPct, resolveActiveTargetKey, strategyHeadroom,
  type RankTargetSpec, type ScheduleWindow,
} from './rank-controller.js'
import { applyTargetOverrides, isGoalMode, toSpec } from '../../jobs/ad-rank-defend.job.js'

/** A `RankTarget` row as Prisma returns it — typed off the engine's own mapper, not re-declared. */
export type RankTargetRowLike = Parameters<typeof toSpec>[0]
/** The per-campaign override map the engine reads off `AdSchedule.targetOverrides`. */
export type TargetOverrides = Parameters<typeof applyTargetOverrides>[1]

export type RdModeKind =
  | 'not-running'
  | 'governed-elsewhere'
  | 'nothing-held'
  | 'dangling-target'
  | 'min-bid'
  | 'capped-base'
  | 'capped-floor'
  | 'holding'

/** Severity order for the group roll-up: what an operator should look at first. */
const MODE_SEVERITY: RdModeKind[] = [
  'dangling-target', 'capped-base', 'capped-floor', 'governed-elsewhere',
  'nothing-held', 'not-running', 'min-bid', 'holding',
]
/** One word per state, for the spread. */
const MODE_WORD: Record<RdModeKind, string> = {
  'not-running': 'not running', 'governed-elsewhere': 'governed elsewhere',
  'nothing-held': 'holding nothing', 'dangling-target': 'dangling',
  'min-bid': 'min bid', 'capped-base': 'capped', 'capped-floor': 'capped',
  holding: 'holding',
}

export interface RdMode { kind: RdModeKind; label: string; detail: string }

export interface RdCeiling {
  capPct: number | null
  baseAlone: boolean
  /** True when the ceiling — not the target — is deciding the placement. */
  binding: boolean
  maxCpcCents: number | null
  maxBaseBidCents: number | null
  label: string
}

/** 2e — no goal is read any more: always { null, null, false, null }. Kept so the payload keeps its shape. */
export interface RdGoal {
  targetPct: number | null
  actualPct: number | null
  live: boolean
  deadReason: string | null
}

export interface RdCampaignRuntimeInput {
  scheduleId: string
  campaignId: string
  groupId: string | null
  scheduleEnabled: boolean
  windows: ScheduleWindow[] | null
  defaultTargetKey: string | null
  /** Day/hour in the SCHEDULE's timezone, resolved from the DATABASE clock (as the engine does). */
  timezoneNow: { day: number; hour: number }
  event?: { windows: ScheduleWindow[] | null; defaultTargetKey: string | null; name: string } | null
  targetByKey: Map<string, RankTargetRowLike>
  targetOverrides: TargetOverrides
  maxBaseBidCents: number | null
  biddingStrategy: string | null
  governed: boolean
}

export interface RdCampaignRuntime {
  scheduleId: string
  campaignId: string
  groupId: string | null
  activeTargetKey: string | null
  placement: string | null
  eventName: string | null
  band: { floor: number; ceiling: number } | null
  /** 2e — always false: nothing climbs above the hour's Placement %. */
  canChase: boolean
  mode: RdMode
  ceiling: RdCeiling | null
  goal: RdGoal
  canConverge: boolean
  cannotConvergeReason: string | null
}

const eur = (cents: number | null | undefined) => `€${((cents ?? 0) / 100).toFixed(2)}`

export function deriveCampaignRuntime(input: RdCampaignRuntimeInput): RdCampaignRuntime {
  const base = {
    scheduleId: input.scheduleId, campaignId: input.campaignId, groupId: input.groupId,
    activeTargetKey: null as string | null, placement: null as string | null, eventName: null as string | null,
    band: null, canChase: false, ceiling: null,
    goal: { targetPct: null, actualPct: null, live: false, deadReason: null } as RdGoal,
    canConverge: true, cannotConvergeReason: null as string | null,
  }

  // ── the gates the engine applies before it evaluates anything ─────────────────────────────
  if (!input.scheduleEnabled || !isGoalMode(input.windows, input.defaultTargetKey)) {
    return { ...base, mode: { kind: 'not-running', label: 'Not running', detail: input.scheduleEnabled ? 'This schedule names no target in any hour, so the hourly bid engine does not own it.' : 'Paused — the hourly bid engine skips it. The bids it floored were given back when it was paused (while ads automation is stopped: on the first run after Resume for a paused campaign, while a live one waits for a person on the Hourly Bids list); placement percentages stay as last set.' } }
  }
  if (input.governed) {
    return { ...base, mode: { kind: 'governed-elsewhere', label: 'Governed elsewhere', detail: 'A Rank Director family plan governs this campaign and takes precedence, so the schedule is never evaluated for it.' } }
  }

  // ── events override the weekly plan, exactly as the engine loads them ─────────────────────
  const ev = input.event ?? null
  const planWindows = (ev ? ev.windows : input.windows) ?? []
  const planBaseline = ev ? ev.defaultTargetKey : input.defaultTargetKey
  const key = resolveActiveTargetKey(planWindows, planBaseline, input.timezoneNow.day, input.timezoneNow.hour)
  const eventName = ev?.name ?? null

  if (!key) {
    return { ...base, eventName, mode: { kind: 'nothing-held', label: 'Holding nothing', detail: 'No window is open at this hour and no baseline is set, so this schedule holds nothing right now. Bids it floored are given back; placement percentages stay as last set.' } }
  }
  const row = input.targetByKey.get(key)
  if (!row) {
    return { ...base, eventName, activeTargetKey: key, mode: { kind: 'dangling-target', label: 'Dangling target', detail: `The plan names "${key}", which no longer exists in the target library. Nothing is held — the schedule was authored before the target was deleted. Bids it floored are given back; placement percentages stay as last set.` } }
  }

  // ── the spec the engine would decide with ─────────────────────────────────────────────────
  const spec: RankTargetSpec = applyTargetOverrides(toSpec(row), input.targetOverrides)
  const { floor, ceiling } = biasBand(spec)
  // What the hour holds, per lane for a blend (each lane its own Placement %, exactly as the job drives it).
  const held = heldPlacements(spec)
  const top = Math.max(...held.map((h) => h.pct))
  const cap = cpcCapPct(spec.maxCpcCents, input.maxBaseBidCents, strategyHeadroom(input.biddingStrategy))
  // The job applies the cap to every lane, so it binds as soon as it sits below the highest one.
  const binding = !spec.pause && !!cap && (cap.baseAlone || cap.capPct < top)
  const ceilingOut: RdCeiling | null = cap
    ? {
      capPct: cap.capPct, baseAlone: cap.baseAlone, binding,
      maxCpcCents: spec.maxCpcCents ?? null, maxBaseBidCents: input.maxBaseBidCents ?? null,
      // Short enough to be a column, not a sentence — the sentence is in the tooltip.
      label: cap.baseAlone
        ? `base ${eur(input.maxBaseBidCents)} > ${eur(spec.maxCpcCents)}`
        : `cap ${cap.capPct}% · ${eur(spec.maxCpcCents)}`,
    }
    : null

  // ── 2e — can it hold what the hour sets? Only the CPC ceiling can stop it ──────────────────
  let canConverge = true
  let cannotConvergeReason: string | null = null
  if (!spec.pause && cap?.baseAlone) {
    canConverge = false
    cannotConvergeReason = `The base bid alone (${eur(input.maxBaseBidCents)}) exceeds the ${eur(spec.maxCpcCents)} CPC ceiling — no placement % can bring it under. Lower the bids.`
  } else if (binding && cap) {
    canConverge = false
    cannotConvergeReason = `The ${eur(spec.maxCpcCents)} CPC ceiling holds this at ${cap.capPct}%, below the ${top}% this hour's plan sets.`
  }

  // ── mode, in precedence order: the ceiling binds LAST in the engine and therefore first here ──
  let mode: RdMode
  if (spec.pause) {
    mode = { kind: 'min-bid', label: `Min bid ${eur(spec.floorBidCents ?? 2)}`, detail: 'This hour holds every bid at the floor; the campaign stays live and the bids come back when a serving hour starts.' }
  } else if (cap?.baseAlone) {
    mode = { kind: 'capped-base', label: `Capped 0% · base ${eur(input.maxBaseBidCents)} > ${eur(spec.maxCpcCents)}`, detail: cannotConvergeReason ?? '' }
  } else if (binding && cap) {
    mode = { kind: 'capped-floor', label: `Capped ${cap.capPct}% · plan ${top}%`, detail: cannotConvergeReason ?? '' }
  } else {
    const words = held.map((h) => `${SHORT_PLACE[h.placement] ?? h.placement} ${h.pct}%`).join(' · ')
    mode = { kind: 'holding', label: `Holding ${words}`, detail: `This hour's plan sets ${words}. The engine sets it once when the hour starts and holds it; it reads no rank or share signal.` }
  }

  return {
    scheduleId: input.scheduleId, campaignId: input.campaignId, groupId: input.groupId,
    activeTargetKey: key, placement: spec.placement, eventName,
    band: { floor, ceiling }, canChase: false, mode, ceiling: ceilingOut, goal: base.goal,
    canConverge, cannotConvergeReason,
  }
}

const SHORT_PLACE: Record<string, string> = { PLACEMENT_TOP: 'Top', PLACEMENT_REST_OF_SEARCH: 'Rest', PLACEMENT_PRODUCT_PAGE: 'Product' }

/** 2e — the placement %s a serving hour holds: each lane's own for a blend, else the target's one placement. */
function heldPlacements(spec: RankTargetSpec): Array<{ placement: string; pct: number }> {
  if (spec.lanes && spec.lanes.length) return spec.lanes.map((l) => ({ placement: l.placement, pct: biasBand(l).floor }))
  return [{ placement: spec.placement, pct: biasBand(spec).floor }]
}

// ── RD.P4 · is a signal trustworthy? ─────────────────────────────────────────────────────────

/**
 * Three states, never merged, and the middle one decided by BASIS rather than age.
 *
 * The axis is measured, not designed. The SQP programme found 20 of 34 campaigns with a share are
 * steered by **exactly one ASIN**, and the mean campaign contributes 10% of its ASINs to its own
 * number (`docs/2026-08-12-sqp-feed.md` §18). A share computed from one ASIN of eighteen is not a
 * staler number — it is a number about a different thing, and only a contributor count can see it.
 *
 * Age is a STALL ALARM here, not a quality test. With `NEXUS_SQP_LOOKBACK=2` the feed can never be
 * fresher than ~11 days plus the week length, so any threshold tighter than ~21 days nulls every
 * campaign permanently (their Option C: at 14 days, 0 of 34 keep a signal). 28 days changes nothing
 * today, which is exactly what an alarm should do.
 *
 * Pure, because this is the judgement — the query that feeds it is not.
 */
export const SQP_STALL_DAYS = 28
export const THIN_BASIS_FRACTION = 0.34

export interface SqpFreshness {
  freshness: 'fresh' | 'stale'
  thin: boolean
  stalled: boolean
  staleReason: string | null
}

export function classifySqpFreshness(input: { withData: number; total: number; ageDays: number | null }): SqpFreshness {
  const { withData, total, ageDays } = input
  const frac = total > 0 ? withData / total : 0
  // One contributor is thin whatever the fraction says: a single ASIN cannot describe a campaign.
  const thin = withData <= 1 || frac < THIN_BASIS_FRACTION
  const stalled = ageDays != null && ageDays > SQP_STALL_DAYS
  const reasons: string[] = []
  if (thin) reasons.push(`${withData} of ${total} advertised ASIN${total === 1 ? '' : 's'} appear in that week, so the share describes a fraction of the campaign`)
  if (stalled) reasons.push(`the feed has not advanced in ${ageDays} days`)
  return { freshness: thin || stalled ? 'stale' : 'fresh', thin, stalled, staleReason: reasons.length ? reasons.join('; ') : null }
}

// ── the group grain, as a roll-up ────────────────────────────────────────────────────────────

export interface RdGroupRollUp {
  members: number
  /** Every distinct fate, most severe first. */
  modeCounts: Array<{ kind: RdModeKind; count: number }>
  /** `4 chasing · 8 holding`, or one word when they all agree. Never an average. */
  modeSummary: string
  mixed: boolean
  cannotConverge: number
  goalsLive: number
}

type RollUpRow = Pick<RdCampaignRuntime, 'mode' | 'canConverge' | 'goal'>

/**
 * Aggregate members WITHOUT averaging.
 *
 * A single collapsed mode is the same shape of lie as the `Health: OK` this section removes: eleven
 * campaigns with four fates reduced to one word. So the group states the spread, ordered by what
 * deserves attention rather than by how many rows share it.
 */
export function rollUpGroup(rows: RollUpRow[]): RdGroupRollUp {
  const counts = new Map<RdModeKind, number>()
  for (const r of rows) counts.set(r.mode.kind, (counts.get(r.mode.kind) ?? 0) + 1)

  // 'capped-base' and 'capped-floor' both read as "capped" to an operator, so they share a word —
  // but they stay distinct kinds because their fixes are different (lower the bids vs raise the
  // ceiling), and the campaign grain says which.
  const byWord = new Map<string, { word: string; count: number; rank: number }>()
  for (const [kind, count] of counts) {
    const word = MODE_WORD[kind]
    const rank = MODE_SEVERITY.indexOf(kind)
    const prev = byWord.get(word)
    if (prev) { prev.count += count; prev.rank = Math.min(prev.rank, rank) }
    else byWord.set(word, { word, count, rank })
  }
  const spread = [...byWord.values()].sort((a, b) => a.rank - b.rank || b.count - a.count)
  const mixed = spread.length > 1
  const modeSummary = spread.length === 0
    ? '—'
    : mixed
      ? spread.map((s) => `${s.count} ${s.word}`).join(' · ')
      : spread[0].word.charAt(0).toUpperCase() + spread[0].word.slice(1)

  return {
    members: rows.length,
    modeCounts: [...counts.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => MODE_SEVERITY.indexOf(a.kind) - MODE_SEVERITY.indexOf(b.kind)),
    modeSummary,
    mixed,
    cannotConverge: rows.filter((r) => !r.canConverge).length,
    goalsLive: rows.filter((r) => r.goal.live).length,
  }
}
