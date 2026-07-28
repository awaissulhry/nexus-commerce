/**
 * AX-ZD.5 — data vintage.
 *
 * Amazon's numbers move for a long time after the day they describe. Clicks and
 * cost settle in 48–72h, conversions keep landing for up to 14 days, and
 * revisions arrive for up to 60. An independent study of 14,991 campaigns found
 * the top 5% moved impressions by ≥36.67% between day 1 and day 17.
 *
 * Every competitor in the teardown inherits that pipeline and NOT ONE exposes
 * it, which is why the same complaint — "the numbers changed, your tool is
 * wrong" — recurs verbatim across all of them. The platform with the least
 * real-time infrastructure has the best accuracy reputation, purely because it
 * doesn't surprise people.
 *
 * So: no storage, no schema change, no background job. Settlement state is a
 * pure function of how old a date is. The whole cost of this is being willing to
 * say "this number is not finished yet".
 *
 * The one rule with teeth: `provisional` data must never reach a bid, a rule or
 * an automated decision. Displaying it is fine — acting on it is not.
 */

/** Ordered from least to most trustworthy. */
export const VINTAGE_STATES = ['provisional', 'stabilising', 'settling', 'settled', 'final'] as const
export type VintageState = (typeof VINTAGE_STATES)[number]

export interface Vintage {
  state: VintageState
  /** Whole days between the metric's date and now. */
  ageDays: number
  /** Safe to drive a bid, rule or budget decision from. */
  ruleSafe: boolean
  /** Conversion-based figures (ROAS, ACOS, CVR) are still moving. */
  conversionsSettling: boolean
  /** One line an operator can read without needing this file. */
  note: string
}

/** Day boundaries, in UTC, matching how Amazon dates a report row. */
function daysBetweenUtc(date: Date, now: Date): number {
  const d = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  const n = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return Math.floor((n - d) / 86_400_000)
}

/**
 * Settlement state for one metric date.
 *
 * Boundaries follow the spec: D-0/D-1 provisional, D-2/D-3 stabilising,
 * D-4/D-14 settling, D-15/D-59 settled, D+60 final.
 *
 * A future date (clock skew, or a report dated ahead) is treated as provisional
 * rather than throwing — the caller wants a label, not an exception.
 */
export function vintageOf(date: Date, now: Date = new Date()): Vintage {
  const ageDays = Math.max(0, daysBetweenUtc(date, now))

  if (ageDays <= 1) {
    return {
      state: 'provisional', ageDays, ruleSafe: false, conversionsSettling: true,
      note: 'Provisional — today and yesterday are still being reported. Display only; never optimise against these.',
    }
  }
  if (ageDays <= 3) {
    return {
      state: 'stabilising', ageDays, ruleSafe: false, conversionsSettling: true,
      note: 'Stabilising — clicks and spend are close to final, but conversions are still landing, so ROAS and ACOS will move.',
    }
  }
  if (ageDays <= 14) {
    return {
      state: 'settling', ageDays, ruleSafe: false, conversionsSettling: true,
      note: 'Settling — conversions attribute back to the click date for up to 14 days, so sales figures are still rising.',
    }
  }
  if (ageDays <= 59) {
    return {
      state: 'settled', ageDays, ruleSafe: true, conversionsSettling: false,
      note: 'Settled — safe to optimise against. Amazon can still restate up to day 60, but movement is small.',
    }
  }
  return {
    state: 'final', ageDays, ruleSafe: true, conversionsSettling: false,
    note: 'Final — past Amazon\'s 60-day restatement window; these numbers no longer change.',
  }
}

/**
 * The guard. Anything that moves money — a bid, a budget, a rule, an autopilot
 * decision — asks this before trusting a date.
 *
 * Deliberately a hard boolean rather than a score: "mostly settled" is how you
 * end up optimising against a number that grows 36% underneath you.
 */
export function isRuleSafe(date: Date, now: Date = new Date()): boolean {
  return vintageOf(date, now).ruleSafe
}

/**
 * Amazon's attribution window per ad product — the reason conversions keep
 * arriving. A purchase on day 14 is attributed back to the CLICK date, so it
 * rewrites day 0's ACOS long after day 0 looked finished.
 */
export function attributionWindowDays(adProduct: string | null | undefined): number {
  const p = (adProduct ?? '').toUpperCase()
  if (p.includes('BRAND')) return 14
  if (p.includes('DISPLAY')) return 14
  // Sponsored Products: 7 days for sellers, 14 for vendors. We are a seller.
  return 7
}

export interface WindowVintage {
  from: string
  to: string
  days: number
  /** Day counts per state, so a window can describe its own trustworthiness. */
  breakdown: Record<VintageState, number>
  /** The least-settled state present — a window is only as good as its worst day. */
  worst: VintageState
  /** True when every day in the window is safe to optimise against. */
  ruleSafe: boolean
  /** One line for a README, an export header, or a tooltip. */
  summary: string
}

/**
 * Describe a whole date range, which is what an export or a dashboard actually
 * shows. A window is only as trustworthy as its least-settled day, so `worst`
 * — not an average — is what gets surfaced.
 */
export function describeWindow(from: Date, to: Date, now: Date = new Date()): WindowVintage {
  const breakdown: Record<VintageState, number> = {
    provisional: 0, stabilising: 0, settling: 0, settled: 0, final: 0,
  }
  let days = 0
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()))
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate())
  // Guard against an inverted or absurd range rather than looping forever.
  while (cursor.getTime() <= end && days < 1000) {
    breakdown[vintageOf(cursor, now).state] += 1
    days += 1
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  const worst = VINTAGE_STATES.find((s) => breakdown[s] > 0) ?? 'final'
  const unsettled = breakdown.provisional + breakdown.stabilising + breakdown.settling
  const iso = (d: Date) => d.toISOString().slice(0, 10)

  const summary = days === 0
    ? 'Empty date range.'
    : unsettled === 0
      ? `All ${days} day${days === 1 ? '' : 's'} settled — safe to optimise against.`
      : `${unsettled} of ${days} day${days === 1 ? '' : 's'} are still moving (${breakdown.provisional} provisional, ${breakdown.stabilising} stabilising, ${breakdown.settling} settling). Amazon restates for up to 60 days, so this window will not match a copy taken later.`

  return { from: iso(from), to: iso(to), days, breakdown, worst, ruleSafe: unsettled === 0, summary }
}

/** Compact badge text: "provisional · 0d old". Pairs with a last-synced stamp. */
export function vintageBadge(date: Date, now: Date = new Date()): string {
  const v = vintageOf(date, now)
  return `${v.state} · ${v.ageDays}d old`
}
