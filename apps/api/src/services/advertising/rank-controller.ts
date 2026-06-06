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
  // MP — motion profile: how the loop MOVES the bias. All null/false => today's behaviour.
  jumpStartPct?: number | null // opening bid: SNAP to this in one cycle on entry; null = gradual ramp to biasPct
  stepUpPct?: number | null // climb step %/cycle; null => 15 (25 all-out)
  stepDownPct?: number | null // ease step %/cycle; null => SNAP down to floor on plan change; a number => gradual (never snap)
  maxBiasPct?: number | null // climb ceiling; null => 900
  keepClimbing?: boolean // after the opening, keep stepping to the ceiling even with NO signal (bounded by ceiling + ACOS)
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
  // MP — motion profile. Defaults reproduce the historical behaviour EXACTLY (regression-locked):
  // step 15/25, snap down to the entry bias, ceiling 900, ramp (not jump) to entry, hold (not climb).
  const maxPct = Math.min(opts.maxPct ?? 900, target.maxBiasPct ?? 900)
  const step = target.stepUpPct ?? stepFor(target) // climb increment %/cycle
  const downStep = target.stepDownPct ?? step // ease increment %/cycle
  const snapDown = target.stepDownPct == null // null => snap to floor on a plan change (today); a number => gradual
  const floor = target.jumpStartPct ?? target.biasPct // the level we establish + hold on entry (opening jump or ramp target)
  const targetIS = target.targetISPct != null ? target.targetISPct / 100 : null
  const acosCap = target.allOut ? null : (target.acosCapPct != null ? target.acosCapPct / 100 : null)
  const acosOk = acosCap == null || obs.achievedAcosFraction == null || obs.achievedAcosFraction <= acosCap * 1.1

  // RS.5.1 / MP — with no live signal, converge on the motion floor (jumpStartPct ?? biasPct)
  // so the campaign actually COMPETES (Top-of-Search IS data is sparse). How it gets there
  // and back is the motion profile:
  //  • UP to the floor: SNAP in one cycle (jumpStartPct set — the "opening jump") or ramp
  //    gradually +step×2 (today). Climbing has overspend risk, so the ramp stays gradual.
  //  • keepClimbing: optionally push PAST the floor to the ceiling even with no signal
  //    (bounded by the ACOS cap + ceiling); the ceiling then becomes the resting point.
  //  • DOWN to the floor: SNAP in one cycle (today — safe, only reduces spend) or ease
  //    gradually −downStep when stepDownPct is set. All-out / keepClimbing don't fall back.
  const holdOrFloor = (reason: string): StepDecision => {
    if (floor != null && obs.currentPct < floor && acosOk) {
      if (target.jumpStartPct != null) return { action: 'raise', nextPct: clamp(floor, 0, maxPct), reason: `jump to ${clamp(floor, 0, maxPct)}% opening` }
      return { action: 'raise', nextPct: clamp(Math.min(floor, obs.currentPct + step * 2), 0, maxPct), reason: `ramping to ${floor}% entry bias` }
    }
    if (target.keepClimbing && acosOk && obs.currentPct < maxPct) {
      return { action: 'raise', nextPct: clamp(obs.currentPct + step, 0, maxPct), reason: `climbing to ${maxPct}% ceiling (+${step}/cyc, no signal)` }
    }
    if (floor != null && !target.allOut && !target.keepClimbing && obs.currentPct > floor) {
      if (snapDown) return { action: 'lower', nextPct: clamp(floor, 0, maxPct), reason: `set to ${floor}% entry bias (no signal)` }
      return { action: 'lower', nextPct: clamp(Math.max(floor, obs.currentPct - downStep), 0, maxPct), reason: `easing to ${floor}% entry bias (−${downStep}/cyc)` }
    }
    return { action: 'hold', nextPct: obs.currentPct, reason }
  }

  // 1) Loss reaction — re-take the slot FAST when the proxy says we're slipping.
  if (obs.lossDetected && acosOk && obs.currentPct < maxPct) {
    return { action: 'raise', nextPct: clamp(obs.currentPct + step * 2, 0, maxPct), reason: 'rank slipping — re-take aggressively' }
  }

  // 2) IS-driven hold (the truth signal).
  if (targetIS != null && obs.achievedISFraction != null) {
    if (obs.achievedISFraction < targetIS && acosOk && obs.currentPct < maxPct) {
      return { action: 'raise', nextPct: clamp(obs.currentPct + step, 0, maxPct), reason: `IS ${pctStr(obs.achievedISFraction)} below target ${pctStr(targetIS)} — push` }
    }
    if (obs.currentPct > 0 && obs.achievedISFraction >= targetIS * 1.1) {
      return { action: 'lower', nextPct: clamp(obs.currentPct - downStep, 0, maxPct), reason: `IS ${pctStr(obs.achievedISFraction)} above target — ease for least cost` }
    }
    if (acosCap != null && obs.achievedAcosFraction != null && obs.achievedAcosFraction > acosCap * 1.2 && obs.currentPct > 0) {
      return { action: 'lower', nextPct: clamp(obs.currentPct - downStep, 0, maxPct), reason: `ACOS ${pctStr(obs.achievedAcosFraction)} over cap — ease off` }
    }
    return { action: 'hold', nextPct: obs.currentPct, reason: 'holding target IS' }
  }

  // 3) No IS signal — ACOS-guided, or an all-out push.
  if (acosCap != null && obs.achievedAcosFraction != null) {
    if (obs.achievedAcosFraction <= acosCap * 0.8 && obs.currentPct < maxPct) {
      return { action: 'raise', nextPct: clamp(obs.currentPct + step, 0, maxPct), reason: `ACOS ${pctStr(obs.achievedAcosFraction)} well under cap — capture more` }
    }
    if (obs.achievedAcosFraction >= acosCap * 1.2 && obs.currentPct > 0) {
      return { action: 'lower', nextPct: clamp(obs.currentPct - downStep, 0, maxPct), reason: `ACOS ${pctStr(obs.achievedAcosFraction)} over cap — ease off` }
    }
    return holdOrFloor('ACOS in band')
  }
  if (acosCap == null && obs.currentPct < maxPct) {
    return { action: 'raise', nextPct: clamp(obs.currentPct + step, 0, maxPct), reason: 'all-out — push for the slot' }
  }
  return holdOrFloor('no signal — hold')
}
