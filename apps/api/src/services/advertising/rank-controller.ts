/**
 * RS.4 — pure rank controller. The bridge from a goal (RankTarget) to a concrete
 * actuation each tick. No DB / IO, so it's unit-tested and reused verbatim by the
 * RS.5 defend loop. "Rank" on Amazon = a Top-of-Search impression-share held by
 * bid-to-win, so this converges the placement-bias % toward the target IS within
 * the ACOS/CPC guardrails — or ignoring ACOS when the target is all-out — and
 * snaps back fast when the loss proxy says we're slipping off the slot.
 */

export interface RankTargetSpec {
  key: string
  placement: string // PLACEMENT_TOP | PLACEMENT_REST_OF_SEARCH | PLACEMENT_PRODUCT_PAGE
  targetISPct: number | null // 0-100 target Top-of-Search impression share
  acosCapPct: number | null // ACOS ceiling %; ignored when allOut
  maxCpcCents: number | null // hard bid ceiling (runaway guard); applied at the bid layer (RS.5)
  biasPct: number | null // starting placement-bias % on entry
  pause: boolean
  allOut: boolean // ignore acosCapPct — hold the slot at any cost up to maxCpc
  // MP v2 — motion profile: HOW the loop moves the bid. floor = biasPct (Placement %); blank knobs => snap to it both ways.
  jumpStartPct?: number | null // DORMANT in v2 — computeStep ignores it (snap-to-Placement made the opening jump redundant)
  stepUpPct?: number | null // climb step %/cycle; null => SNAP up to Placement % (default 15/25 when chasing above it)
  stepDownPct?: number | null // ease step %/cycle; null => SNAP down to Placement %; a number => gradual (never snap)
  maxBiasPct?: number | null // ceiling; null => Placement % (never above). Set above to allow climbing. all-out forces 900.
  keepClimbing?: boolean // climb to the ceiling even with NO signal (only matters when ceiling > Placement %; bounded by ceiling + ACOS)
  // BL — blended multi-placement + base-bid (all optional; absent => single-placement legacy).
  lanes?: LaneSpec[] | null // when set, the engine drives EACH lane's placement at once
  bidMode?: string | null // base-bid lever: null|'hold'|'absolute'|'suppress'|'deltaPct'
  bidValueCents?: number | null // 'absolute' → set ad-group default bid to this
  bidDeltaPct?: number | null // reserved for 'deltaPct'
}

// BL — one placement lane in a blended target: the per-placement bid strategy. A lane is
// a single-placement RankTargetSpec minus the shared key/pause/base-bid; the engine
// expands each into computeStep with that placement's own signal (Top=Top-IS, Rest=SQP,
// Product=open-loop).
export interface LaneSpec {
  placement: string // PLACEMENT_TOP | PLACEMENT_REST_OF_SEARCH | PLACEMENT_PRODUCT_PAGE
  biasPct: number | null
  maxBiasPct?: number | null
  targetISPct?: number | null
  acosCapPct?: number | null
  stepUpPct?: number | null
  stepDownPct?: number | null
  keepClimbing?: boolean
  allOut?: boolean
}

export interface ScheduleWindow { days?: number[]; startHour?: number; endHour?: number; bidMultiplierPct?: number; targetKey?: string }

/**
 * Which target governs (day, hour): a window covering the moment with a targetKey
 * wins; otherwise the schedule baseline ("for the rest, hold Y"). null => no
 * goal-mode target here (legacy multiplier-only schedule).
 */
export function resolveActiveTargetKey(windows: ScheduleWindow[] | null | undefined, defaultTargetKey: string | null | undefined, day: number, hour: number): string | null {
  for (const w of windows ?? []) {
    if (!w?.targetKey) continue
    const days = w.days && w.days.length ? w.days : [0, 1, 2, 3, 4, 5, 6]
    const start = w.startHour ?? 0
    const end = w.endHour ?? 24
    if (days.includes(day) && hour >= start && hour < end) return w.targetKey
  }
  return defaultTargetKey ?? null
}

export interface Observed {
  currentPct: number // current PLACEMENT_TOP bias % (0-900)
  achievedISFraction: number | null // 0-1 achieved TOS IS (daily truth), null if unknown
  achievedAcosFraction: number | null // 0-1 achieved ACOS, null if unknown
  lossDetected?: boolean // RS.6 fast proxy: hourly impressions cratered vs our baseline
}

export interface StepDecision { action: 'raise' | 'hold' | 'lower' | 'pause'; nextPct: number; reason: string }

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)))
const pctStr = (f: number) => `${Math.round(f * 100)}%`

/** Step size — larger for all-out so we re-take harder. */
export function stepFor(target: RankTargetSpec): number {
  return target.allOut ? 25 : 15
}

// RS.6 — loss proxy. Amazon exposes no live rank, and TOS-IS is daily/sparse, so
// the fastest "we're slipping" fingerprint is the campaign's own hourly
// impressions cratering vs its recent baseline. Conservative on purpose: it needs
// a meaningful baseline AND a sharp drop, so noise/low-volume hours don't trip it.
export const LOSS_MIN_BASELINE = 5
export const LOSS_THRESHOLD = 0.4
export function isRankLoss(latestImpr: number, baselineImpr: number): boolean {
  return baselineImpr >= LOSS_MIN_BASELINE && latestImpr < baselineImpr * LOSS_THRESHOLD
}

/**
 * The controller. Given the active target + observed signals, return the next
 * placement-bias %. allOut (or a null acosCap) => the ACOS ceiling is ignored.
 */
export function computeStep(target: RankTargetSpec, obs: Observed, opts: { maxPct?: number } = {}): StepDecision {
  if (target.pause) return { action: 'pause', nextPct: obs.currentPct, reason: 'target = pause' }
  // MP v2 — "Placement % is the bid". Snap to the floor (biasPct) both ways by default; a
  // Climb/Ease step makes that move gradual instead; the bid only goes ABOVE the floor when a
  // Ceiling is raised above it — then it chases the [floor, ceiling] band (signal-driven, or
  // always with keepClimbing / all-out) and eases back toward the floor, never below it.
  const floor = clamp(target.biasPct ?? 0, 0, 900) // the bid we hold = Placement %
  const ceiling = target.allOut ? (target.maxBiasPct ?? 900) : (target.maxBiasPct ?? floor)
  const maxPct = Math.min(opts.maxPct ?? 900, Math.max(floor, ceiling))
  const climbStep = target.stepUpPct ?? stepFor(target) // up increment %/cyc (also the chase rate)
  const easeStep = target.stepDownPct ?? climbStep // down increment %/cyc
  const rampUp = target.stepUpPct != null // climb step SET → ramp up to the floor; blank → snap up
  const easeDown = target.stepDownPct != null // ease step SET → ease down to the floor; blank → snap down
  const cur = obs.currentPct
  const acosCap = target.allOut ? null : (target.acosCapPct != null ? target.acosCapPct / 100 : null)
  const acosOk = acosCap == null || obs.achievedAcosFraction == null || obs.achievedAcosFraction <= acosCap * 1.1
  const targetIS = target.targetISPct != null ? target.targetISPct / 100 : null
  const canChase = target.allOut || ceiling > floor

  const toFloorUp = (): StepDecision => rampUp
    ? { action: 'raise', nextPct: clamp(Math.min(floor, cur + climbStep), 0, maxPct), reason: `ramping to ${floor}% Placement (+${climbStep}/cyc)` }
    : { action: 'raise', nextPct: clamp(floor, 0, maxPct), reason: `snap to ${floor}% Placement` }
  // Easing DOWN moves toward the floor, so clamp to [0, 900] — NOT maxPct (which caps raises and
  // equals the floor when there's no chase, which would wrongly snap a gradual ease straight down).
  const toFloorDown = (why: string): StepDecision => easeDown
    ? { action: 'lower', nextPct: clamp(Math.max(floor, cur - easeStep), 0, 900), reason: `${why} — ease to ${floor}% Placement (−${easeStep}/cyc)` }
    : { action: 'lower', nextPct: clamp(floor, 0, 900), reason: `${why} — snap to ${floor}% Placement` }

  // 1) Below the floor → establish the Placement % (snap, or ramp if a Climb step is set).
  if (cur < floor) return toFloorUp()

  // 2) No chase allowed (Ceiling = Placement %) → sit exactly at the floor; come back if drifted up.
  if (!canChase) {
    if (cur > floor) return toFloorDown('above Placement')
    return { action: 'hold', nextPct: cur, reason: `holding ${floor}% Placement` }
  }

  // 3) Chase band [floor, ceiling] — only when a Ceiling above Placement % is set (or all-out).
  if (target.allOut) {
    return cur < maxPct
      ? { action: 'raise', nextPct: clamp(cur + climbStep, 0, maxPct), reason: 'all-out — push for the slot' }
      : { action: 'hold', nextPct: cur, reason: `all-out — holding ${maxPct}% ceiling` }
  }
  // loss proxy — re-take the slot fast
  if (obs.lossDetected && acosOk && cur < maxPct) {
    return { action: 'raise', nextPct: clamp(cur + climbStep * 2, 0, maxPct), reason: 'rank slipping — re-take aggressively' }
  }
  // IS truth signal — seek the least-cost hold of the target share within [floor, ceiling].
  if (targetIS != null && obs.achievedISFraction != null) {
    if (obs.achievedISFraction < targetIS && acosOk && cur < maxPct) {
      return { action: 'raise', nextPct: clamp(cur + climbStep, 0, maxPct), reason: `IS ${pctStr(obs.achievedISFraction)} below target ${pctStr(targetIS)} — push` }
    }
    if (cur > floor && obs.achievedISFraction >= targetIS * 1.1) return toFloorDown(`IS ${pctStr(obs.achievedISFraction)} above target`)
    if (cur > floor && acosCap != null && obs.achievedAcosFraction != null && obs.achievedAcosFraction > acosCap * 1.2) return toFloorDown(`ACOS ${pctStr(obs.achievedAcosFraction)} over cap`)
    return { action: 'hold', nextPct: cur, reason: 'holding target IS' }
  }
  // No IS — ACOS-guided within the band.
  if (acosCap != null && obs.achievedAcosFraction != null) {
    if (obs.achievedAcosFraction <= acosCap * 0.8 && cur < maxPct) {
      return { action: 'raise', nextPct: clamp(cur + climbStep, 0, maxPct), reason: `ACOS ${pctStr(obs.achievedAcosFraction)} well under cap — capture more` }
    }
    if (cur > floor && obs.achievedAcosFraction >= acosCap * 1.2) return toFloorDown(`ACOS ${pctStr(obs.achievedAcosFraction)} over cap`)
  }
  // keep-climbing — push to the ceiling with no signal (bounded by ceiling + ACOS).
  if (target.keepClimbing && acosOk && cur < maxPct) {
    return { action: 'raise', nextPct: clamp(cur + climbStep, 0, maxPct), reason: `climbing to ${maxPct}% ceiling (+${climbStep}/cyc, no signal)` }
  }
  // No reason to be elevated → settle back to the floor (keep-climbing holds at the ceiling instead).
  if (cur > floor && !target.keepClimbing) return toFloorDown('no signal')
  return { action: 'hold', nextPct: cur, reason: cur > floor ? `holding ${cur}% (ceiling)` : `holding ${floor}% Placement` }
}
