/**
 * BID BRAIN BB-1 — the goal resolver: the ACoS a keyword aims at, and the band inside which the brain leaves it alone.
 *
 *   band     the strategy's targetLoPct / targetHiPct (BB-5); `targetPct` is the aim inside it. Until a band is set, a
 *            single target becomes −10 % / +15 % around it (20 % → 18–23 %).
 *   TACoS    aim = TACoS × total sales ÷ ad sales over 30 days, the ratio held to 1–5 and the aim capped at break-even.
 *            Without sales data the next ACoS target down the chain is used, as the engines do today.
 *   profit   break-even ACoS caps the band top (LAUNCH: up to 1.5 × break-even).
 *   phase    PROFIT → the aim as set (the middle of the band without a target) · GROW → the band top · LAUNCH → a ramp
 *            from 1.5 × break-even down to the band top over LAUNCH_RAMP_DAYS · CLEAR_STOCK → break-even plus the
 *            storage saving · DEFEND → the band top on brand terms (a share floor, BB-9), the aim elsewhere.
 *   season   demand D (search volume, 4 settled weeks against the 4 before) and velocity V (units a day, 14 days
 *            against 56): D > 1.15 and V > 1.1 → halfway to the band top; D < 0.85 → halfway to the band bottom; demand
 *            unknown (SQP stale) → neutral, said so.
 *
 * All values are FRACTIONS (0.2 = 20 %); the strategy's integer percents meet them only through `pctToFraction`.
 * Pure: no database, no clock.
 */

/** The strategy's `goal` values (ads-strategy/fields.ts STRATEGY_GOALS), which the brain reads as the phase. */
export const BRAIN_PHASES = ['LAUNCH', 'GROW', 'PROFIT', 'CLEAR_STOCK', 'DEFEND'] as const
export type BrainPhase = (typeof BRAIN_PHASES)[number]

export const BAND_BELOW = 0.9
export const BAND_ABOVE = 1.15
export const LAUNCH_RAMP_DAYS = 28
export const LAUNCH_BREAK_EVEN_MULTIPLE = 1.5
export const TACOS_RATIO_MIN = 1
export const TACOS_RATIO_MAX = 5

export interface GoalInputs {
  /** The strategy's target as written (resolved whole): its kind and its integer percent. */
  target: { kind: 'ACOS' | 'TACOS'; pct: number } | null
  /** The first ACoS target down the chain (what the engines steer by today); used when a TACoS cannot be converted. */
  acosFallbackPct?: number | null
  /** BB-5 — the band, in the target's own kind (integer percents). Either side may be missing. */
  band?: { loPct: number | null; hiPct: number | null } | null
  phase?: BrainPhase | null
  /** Days since the product entered LAUNCH; unknown → the band top, said so. */
  launchDay?: number | null
  /** Break-even ACoS as a fraction (ads-target-acos.service.ts breakevenAcos); null when no profit data. */
  breakEvenAcos?: number | null
  /** CLEAR_STOCK — the storage fees clearing saves, as a share of revenue. */
  storageSavingAcos?: number | null
  /** TACoS → ACoS: the market's Amazon sales and the advertised products' ad sales over 30 days. */
  sales?: { totalCents: number; adCents: number } | null
  season?: { demand: number | null; velocity: number | null } | null
  /** DEFEND aims brand terms at the band top. */
  brandTerm?: boolean
}

export interface Goal {
  ok: true
  aim: number
  lo: number
  hi: number
  kind: 'ACOS' | 'TACOS'
  /** Where the band came from. */
  bandFrom: 'band' | 'single'
  phase: BrainPhase | null
  /** Short notes for the "why": "TACoS 8 % × sales ratio 2.5", "season: demand unknown". */
  notes: string[]
}
export interface GoalRefusal { ok: false; reason: string }
export type GoalResult = Goal | GoalRefusal
/** The api tsconfig is not strict, so a boolean discriminant does not narrow: ask this instead. */
export const isGoal = (g: GoalResult): g is Goal => g.ok === true

const pct = (f: number) => `${Math.round(f * 1000) / 10}%`
const frac = (p: number | null | undefined): number | null => (typeof p === 'number' && Number.isFinite(p) && p > 0 ? p / 100 : null)
const round4 = (x: number) => Math.round(x * 10_000) / 10_000

export function resolveGoal(input: GoalInputs): GoalResult {
  const notes: string[] = []
  const bandLo = frac(input.band?.loPct)
  const bandHi = frac(input.band?.hiPct)
  const targetPct = frac(input.target?.pct)
  const kind = input.target?.kind ?? 'ACOS'

  // 1. The aim and band in the target's own kind.
  let aim = targetPct ?? (bandLo != null && bandHi != null ? (bandLo + bandHi) / 2 : null)
  if (aim == null) return { ok: false, reason: 'no target ACoS in the ads strategy' }
  let lo = bandLo ?? aim * BAND_BELOW
  let hi = bandHi ?? aim * BAND_ABOVE
  const bandFrom: Goal['bandFrom'] = bandLo != null || bandHi != null ? 'band' : 'single'
  if (lo > hi) [lo, hi] = [hi, lo]
  aim = Math.min(hi, Math.max(lo, aim))

  // 2. TACoS → ACoS: one ratio converts the aim and the band together.
  let outKind: Goal['kind'] = 'ACOS'
  if (kind === 'TACOS') {
    const s = input.sales
    if (s && s.adCents > 0 && s.totalCents > 0) {
      const ratio = Math.min(TACOS_RATIO_MAX, Math.max(TACOS_RATIO_MIN, s.totalCents / s.adCents))
      notes.push(`TACoS ${pct(aim)} × sales ratio ${Math.round(ratio * 100) / 100}`)
      aim *= ratio
      lo *= ratio
      hi *= ratio
      outKind = 'TACOS'
    } else {
      const fallback = frac(input.acosFallbackPct)
      if (fallback == null) return { ok: false, reason: 'a TACoS target without sales data, and no ACoS target to fall back to' }
      notes.push(`TACoS without sales data — the ACoS target ${pct(fallback)}`)
      aim = fallback
      lo = fallback * BAND_BELOW
      hi = fallback * BAND_ABOVE
    }
  }

  // 3. Profit: break-even caps the band top (LAUNCH may go to 1.5 × break-even).
  const be = input.breakEvenAcos
  const phase = input.phase ?? null
  if (be != null && be >= 0) {
    const cap = phase === 'LAUNCH' ? be * LAUNCH_BREAK_EVEN_MULTIPLE : be
    if (hi > cap) {
      notes.push(`band top held to ${phase === 'LAUNCH' ? '1.5 × ' : ''}break-even ${pct(be)}`)
      hi = cap
      lo = Math.min(lo, hi)
      aim = Math.min(aim, hi)
    }
  }

  // 4. Phase.
  if (phase === 'GROW') aim = hi
  else if (phase === 'LAUNCH') {
    const top = be != null && be >= 0 ? Math.max(hi, be * LAUNCH_BREAK_EVEN_MULTIPLE) : hi
    if (input.launchDay == null) {
      aim = hi
      notes.push('launch day unknown — the band top')
    } else {
      const left = Math.max(0, 1 - input.launchDay / LAUNCH_RAMP_DAYS)
      aim = hi + (top - hi) * left
      if (left > 0) notes.push(`launch ramp day ${input.launchDay} of ${LAUNCH_RAMP_DAYS}`)
    }
    hi = Math.max(hi, aim)
  } else if (phase === 'CLEAR_STOCK') {
    if (be != null && be >= 0) {
      aim = be + Math.max(0, input.storageSavingAcos ?? 0)
      notes.push('clear stock: break-even plus the storage saving')
    } else {
      aim = hi
      notes.push('clear stock without profit data — the band top')
    }
    hi = Math.max(hi, aim)
  } else if (phase === 'DEFEND' && input.brandTerm) {
    aim = hi
    notes.push('defend: a brand term at the band top')
  }

  // 5. Season.
  const d = input.season?.demand ?? null
  const v = input.season?.velocity ?? null
  if (d == null) {
    if (input.season) notes.push('season: demand unknown')
  } else if (d > 1.15 && v != null && v > 1.1) {
    aim += (hi - aim) / 2
    notes.push(`season up (demand ×${Math.round(d * 100) / 100})`)
  } else if (d < 0.85) {
    aim -= (aim - lo) / 2
    notes.push(`season down (demand ×${Math.round(d * 100) / 100})`)
  }

  return { ok: true, aim: round4(aim), lo: round4(lo), hi: round4(hi), kind: outKind, bandFrom, phase, notes }
}

/** "aim 20% (band 18–28%, PROFIT)". */
export function goalWords(g: Goal): string {
  const band = `${g.bandFrom === 'band' ? 'band' : 'default band'} ${pct(g.lo)}–${pct(g.hi)}`
  return `aim ${pct(g.aim)} (${band}${g.phase ? `, ${g.phase}` : ''})`
}
