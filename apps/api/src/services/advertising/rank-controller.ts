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

/**
 * The controller. Given the active target + observed signals, return the next
 * placement-bias %. allOut (or a null acosCap) => the ACOS ceiling is ignored.
 */
export function computeStep(target: RankTargetSpec, obs: Observed, opts: { maxPct?: number } = {}): StepDecision {
  if (target.pause) return { action: 'pause', nextPct: obs.currentPct, reason: 'target = pause' }
  const maxPct = opts.maxPct ?? 900
  const step = stepFor(target)
  const targetIS = target.targetISPct != null ? target.targetISPct / 100 : null
  const acosCap = target.allOut ? null : (target.acosCapPct != null ? target.acosCapPct / 100 : null)
  const acosOk = acosCap == null || obs.achievedAcosFraction == null || obs.achievedAcosFraction <= acosCap * 1.1

  // RS.5.1 — starting-bias floor. With no signal pushing us down, ramp the
  // campaign up to the target's entry bias so it actually COMPETES for the slot
  // (a fresh own-top campaign at 0% would otherwise just "hold" at 0 forever,
  // since Top-of-Search IS data is sparse). Once it's at the floor, hold there
  // until IS data arrives to refine. Skipped when we're easing off for ACOS.
  const holdOrFloor = (reason: string): StepDecision => {
    if (target.biasPct != null && obs.currentPct < target.biasPct && acosOk) {
      return { action: 'raise', nextPct: clamp(Math.min(target.biasPct, obs.currentPct + step * 2), 0, maxPct), reason: `ramping to ${target.biasPct}% entry bias` }
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
      return { action: 'lower', nextPct: clamp(obs.currentPct - step, 0, maxPct), reason: `IS ${pctStr(obs.achievedISFraction)} above target — ease for least cost` }
    }
    if (acosCap != null && obs.achievedAcosFraction != null && obs.achievedAcosFraction > acosCap * 1.2 && obs.currentPct > 0) {
      return { action: 'lower', nextPct: clamp(obs.currentPct - step, 0, maxPct), reason: `ACOS ${pctStr(obs.achievedAcosFraction)} over cap — ease off` }
    }
    return { action: 'hold', nextPct: obs.currentPct, reason: 'holding target IS' }
  }

  // 3) No IS signal — ACOS-guided, or an all-out push.
  if (acosCap != null && obs.achievedAcosFraction != null) {
    if (obs.achievedAcosFraction <= acosCap * 0.8 && obs.currentPct < maxPct) {
      return { action: 'raise', nextPct: clamp(obs.currentPct + step, 0, maxPct), reason: `ACOS ${pctStr(obs.achievedAcosFraction)} well under cap — capture more` }
    }
    if (obs.achievedAcosFraction >= acosCap * 1.2 && obs.currentPct > 0) {
      return { action: 'lower', nextPct: clamp(obs.currentPct - step, 0, maxPct), reason: `ACOS ${pctStr(obs.achievedAcosFraction)} over cap — ease off` }
    }
    return holdOrFloor('ACOS in band')
  }
  if (acosCap == null && obs.currentPct < maxPct) {
    return { action: 'raise', nextPct: clamp(obs.currentPct + step, 0, maxPct), reason: 'all-out — push for the slot' }
  }
  return holdOrFloor('no signal — hold')
}
