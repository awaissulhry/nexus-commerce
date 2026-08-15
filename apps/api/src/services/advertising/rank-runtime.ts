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
 * decides. The one place this module adds judgement is naming the states — see `allOut` below.
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
  | 'all-out'
  | 'chasing'
  | 'holding'

/** Severity order for the group roll-up: what an operator should look at first. */
const MODE_SEVERITY: RdModeKind[] = [
  'dangling-target', 'capped-base', 'capped-floor', 'governed-elsewhere',
  'nothing-held', 'not-running', 'min-bid', 'all-out', 'chasing', 'holding',
]
/** One word per state, for the spread. */
const MODE_WORD: Record<RdModeKind, string> = {
  'not-running': 'not running', 'governed-elsewhere': 'governed elsewhere',
  'nothing-held': 'holding nothing', 'dangling-target': 'dangling',
  'min-bid': 'min bid', 'capped-base': 'capped', 'capped-floor': 'capped',
  'all-out': 'all-out', chasing: 'chasing', holding: 'holding',
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

export interface RdGoal {
  targetPct: number | null
  actualPct: number | null
  /** False when the engine never reads this goal. Two causes, and they differ. */
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
  /** Achieved impression share for the active lane, 0-100, where a signal exists. */
  achievedISPct?: number | null
}

export interface RdCampaignRuntime {
  scheduleId: string
  campaignId: string
  groupId: string | null
  activeTargetKey: string | null
  placement: string | null
  eventName: string | null
  band: { floor: number; ceiling: number } | null
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
    return { ...base, mode: { kind: 'not-running', label: 'Not running', detail: input.scheduleEnabled ? 'This schedule carries no rank target, so the rank loop does not own it.' : 'Paused — the rank loop skips it. Amazon keeps whatever bids were last set.' } }
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
    return { ...base, eventName, mode: { kind: 'nothing-held', label: 'Holding nothing', detail: 'No window is open at this hour and no baseline is set, so this schedule holds nothing right now.' } }
  }
  const row = input.targetByKey.get(key)
  if (!row) {
    return { ...base, eventName, activeTargetKey: key, mode: { kind: 'dangling-target', label: 'Dangling target', detail: `The plan names "${key}", which no longer exists in the goal library. Nothing is held — the schedule was authored before the target was deleted.` } }
  }

  // ── the spec the engine would decide with ─────────────────────────────────────────────────
  const spec: RankTargetSpec = applyTargetOverrides(toSpec(row), input.targetOverrides)
  const { floor, ceiling } = biasBand(spec)
  const canChase = !!spec.allOut || ceiling > floor
  const cap = cpcCapPct(spec.maxCpcCents, input.maxBaseBidCents, strategyHeadroom(input.biddingStrategy))
  const binding = !!cap && (cap.baseAlone || cap.capPct < floor)
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

  // ── the goal, and the two different reasons it can be dead ────────────────────────────────
  //
  // 🔴 `allOut` is the one that is easy to get wrong. `canChase` is TRUE for an all-out target,
  // but `computeStep`'s all-out branch reads neither `targetISPct` nor `acosCapPct` — it climbs
  // `+stepUpPct` toward the ceiling and nothing else. Printing "Chasing 90% IS" there would be a
  // brand-new lie of exactly the shape this page exists to remove.
  const goal: RdGoal = {
    targetPct: spec.targetISPct ?? null,
    actualPct: input.achievedISPct ?? null,
    live: spec.targetISPct != null && canChase && !spec.allOut,
    deadReason: null,
  }
  if (spec.targetISPct != null && !goal.live) {
    goal.deadReason = spec.allOut
      ? 'All-out climbs to the ceiling and ignores this goal — the controller never reads it.'
      : 'The ceiling equals the floor, so the controller returns before it reads this goal. The target holds a fixed placement.'
  }

  // ── convergence ───────────────────────────────────────────────────────────────────────────
  let canConverge = true
  let cannotConvergeReason: string | null = null
  if (cap?.baseAlone) {
    canConverge = false
    cannotConvergeReason = `The base bid alone (${eur(input.maxBaseBidCents)}) exceeds the ${eur(spec.maxCpcCents)} CPC ceiling — no multiplier can rescue it. Lower the bids.`
  } else if (cap && cap.capPct < floor) {
    canConverge = false
    cannotConvergeReason = `The CPC ceiling pins this to ${cap.capPct}%, below its own ${floor}% floor. The ceiling is deciding, not the target.`
  } else if (spec.targetISPct != null && !canChase) {
    canConverge = false
    cannotConvergeReason = `The ceiling equals the floor (${floor}%), so this schedule's ${spec.targetISPct}% impression-share goal is never read. It holds a fixed placement.`
  }

  // ── mode, in precedence order: the ceiling binds LAST in the engine and therefore first here ──
  let mode: RdMode
  if (spec.pause) {
    mode = { kind: 'min-bid', label: `Min bid ${eur(spec.floorBidCents ?? 2)}`, detail: 'This hour holds the minimum bid rather than a rank. Nothing is being pursued.' }
  } else if (cap?.baseAlone) {
    mode = { kind: 'capped-base', label: `Capped 0% · base ${eur(input.maxBaseBidCents)} > ${eur(spec.maxCpcCents)}`, detail: cannotConvergeReason ?? '' }
  } else if (cap && cap.capPct < floor) {
    mode = { kind: 'capped-floor', label: `Capped ${cap.capPct}% · floor ${floor}%`, detail: cannotConvergeReason ?? '' }
  } else if (spec.allOut) {
    mode = { kind: 'all-out', label: `All-out → ${ceiling}%`, detail: `Climbing toward ${ceiling}% and bounded only by the ${eur(spec.maxCpcCents)} CPC ceiling. All-out ignores both the impression-share goal and the ACoS cap.` }
  } else if (canChase) {
    mode = { kind: 'chasing', label: `Chasing ${spec.targetISPct ?? '—'}% IS`, detail: `A real closed loop: the ceiling (${ceiling}%) sits above the floor (${floor}%), so the controller reads the goal and moves between them.` }
  } else {
    mode = { kind: 'holding', label: `Holding ${floor}%`, detail: `Snap-and-hold at ${floor}%. The ceiling equals the floor, so the controller never enters its feedback branch.` }
  }

  return {
    scheduleId: input.scheduleId, campaignId: input.campaignId, groupId: input.groupId,
    activeTargetKey: key, placement: spec.placement, eventName,
    band: { floor, ceiling }, canChase, mode, ceiling: ceilingOut, goal,
    canConverge, cannotConvergeReason,
  }
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
