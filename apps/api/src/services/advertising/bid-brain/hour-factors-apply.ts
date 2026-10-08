/**
 * BID BRAIN BB-22 — the learned hour factors carried into one run of the bid brain (pure; hour-factors-store.ts reads what
 * this needs). For each campaign the brain owns whose hourly plan holds an hour now: the move its approved cell takes
 * inside its limits (hour-factors.ts cellMove), and then
 *
 *   off      nothing: the run is exactly as before BB-22 (no read either — the store returns before any)
 *   shadow   the plan's hours run exactly as approved; the learned factor's move is said beside the plan's in the why of
 *            the campaign's decisions (" · hour factors (shadow): …"), nothing else changes (the golden test holds)
 *   on       where the product's brain owns the hours lever (PROPOSE — the Owner's per-product switch; design §10's
 *            individual control) and its kill switch is not on: the plan hour's lanes are the learned ones, inside the
 *            cell's limits, and the plan's note names them (plan-hour.ts `learned`) — so decide.ts, the placement write and
 *            its action log all carry the same words. The approved cell rides along (`approved`): BB-18's stack ceiling
 *            reads it, so the keyword bids are exactly those without BB-22 — the learned factor moves placements only.
 *            Anywhere else the words say why it is not applied.
 */
import { MANAGED_PLACEMENTS } from '../ads-placement-math.js'
import type { RankTargetSpec } from '../rank-controller.js'
import { cellMove, type CellMove, type HourFactorMode } from './hour-factors.js'
import { laneOf, type PlanHour } from './plan-hour.js'
import type { LaneName } from './recipe.js'

const clampPct = (x: number | null | undefined) => Math.max(0, Math.min(900, Math.round(x ?? 0)))

/** The lanes an approved cell declares, as the brain carries them out (plan-hour.ts planFacts): a blend owns all three. */
export function approvedLanes(spec: Pick<RankTargetSpec, 'lanes' | 'placement' | 'biasPct'>): Array<{ lane: LaneName; pct: number }> {
  if (spec.lanes?.length) {
    const declared = new Map(spec.lanes.map((l) => [l.placement, l.biasPct ?? 0]))
    return MANAGED_PLACEMENTS.map((p) => ({ lane: laneOf(p), pct: clampPct(declared.get(p)) }))
  }
  return [{ lane: laneOf(spec.placement), pct: clampPct(spec.biasPct) }]
}

/** The spec with a move's lanes (the original when nothing moved). Pure. */
export function learnedSpec(spec: RankTargetSpec, move: CellMove): RankTargetSpec {
  if (move.status !== 'moved') return spec
  const to = new Map(move.lanes.map((l) => [l.lane, l.to]))
  if (spec.lanes?.length) {
    const declared = new Map(spec.lanes.map((l) => [l.placement, l]))
    return {
      ...spec,
      lanes: MANAGED_PLACEMENTS.map((p) => {
        const own = declared.get(p)
        return { ...(own ?? {}), placement: p, biasPct: to.get(laneOf(p)) ?? clampPct(own?.biasPct) }
      }),
    }
  }
  return { ...spec, biasPct: to.get(laneOf(spec.placement)) ?? spec.biasPct }
}

/** One owned campaign's hour, as the store read it for this run. */
export interface CampaignHourInput {
  campaignId: string
  /** The plan's hour now (shadow.ts run.planHours). */
  hour: PlanHour
  /** The cell now in the plan's time zone (d 0 = Sunday). */
  d: number
  h: number
  /** The learned move at this cell, with its interval and the factors behind it (null: not learned). */
  rho: number | null
  rhoLo: number | null
  rhoHi: number | null
  learned: number | null
  painted: number | null
  /** Why the learned moves do not fit the plan any more (it changed since): null when they do. */
  stale: string | null
  /** The Owner locked this hour (an hour cell of the hours lever, or the whole lever). */
  locked: boolean
  movePct: number
  tosCapPct: number | null
  tosRatio: number | null
  /** 'on' carries it out here: the product's brain owns the hours lever and its kill switch is off. */
  applies: boolean
  /** Why 'on' does not carry it out here (the product's hours lever, its kill switch); null when it does. */
  whyNot: string | null
}

export interface RunHourFactors {
  /** The plan hours the run decides with (the run's own unless 'on' moved one). */
  planHours: Map<string, PlanHour>
  /** Per campaign: the words for the why of its decisions (shadow, or 'on' where it does not apply). */
  notes: Map<string, string>
  /** Per campaign: the move (for the counts and the read view). */
  moves: Map<string, CellMove>
}

/** The move of one campaign's cell now (pure). */
export function moveOf(c: CampaignHourInput): CellMove {
  const spec = c.hour.spec
  const floor = !!spec && (spec.pause === true || spec.bidMode === 'suppress')
  return cellMove({
    d: c.d, h: c.h, lanes: spec && !floor ? approvedLanes(spec) : [], floor, noTarget: !spec, locked: c.locked, stale: c.stale, event: c.hour.event,
    rho: c.rho, rhoLo: c.rhoLo, rhoHi: c.rhoHi, learned: c.learned, painted: c.painted, movePct: c.movePct, tosCapPct: c.tosCapPct, tosRatio: c.tosRatio,
  })
}

/**
 * The run's plan hours and words under the mode (pure). `wantNotes`: the words are written (a full run: the light ticks
 * store no new why for an unchanged decision, so they skip them).
 */
export function runHourFactors(planHours: ReadonlyMap<string, PlanHour>, campaigns: readonly CampaignHourInput[], mode: HourFactorMode, opts: { wantNotes: boolean }): RunHourFactors {
  const out: RunHourFactors = { planHours: new Map(planHours), notes: new Map(), moves: new Map() }
  if (mode === 'off') return out
  for (const c of campaigns) {
    const hour = planHours.get(c.campaignId)
    if (!hour) continue
    const move = moveOf({ ...c, hour })
    out.moves.set(c.campaignId, move)
    if (mode === 'on' && c.applies) {
      // Moved: the plan's note carries the words (decide's why, the placement write's note). Kept: said in the why.
      if (move.status === 'moved' && hour.spec) out.planHours.set(c.campaignId, { ...hour, spec: learnedSpec(hour.spec, move), approved: hour.spec, learned: `learned hour factor: ${move.words}` })
      else if (opts.wantNotes) out.notes.set(c.campaignId, `hour factors: ${move.words}`)
      continue
    }
    if (!opts.wantNotes) continue
    const label = mode === 'shadow' ? 'hour factors (shadow — nothing changed)' : `hour factors (not applied: ${c.whyNot ?? 'not switched on for this product'})`
    out.notes.set(c.campaignId, `${label}: ${move.words}`)
  }
  return out
}
