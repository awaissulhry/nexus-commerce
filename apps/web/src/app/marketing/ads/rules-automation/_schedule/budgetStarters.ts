/**
 * BSP-B5 — starter budget schedules, DERIVED FROM THE ACCOUNT'S OWN HOURS.
 *
 * The approved P5 row said "starter schedules built from *this* account's measured hours", and that
 * phrase is the whole specification. A starter with hard-coded hours — "18:00–23:00, +50%" — would
 * be a fabricated reading dressed as a recommendation: it would look identical whether the account
 * peaked at 18:00 or at 04:00. So every window here is computed from the `RawCell[]` the builder
 * already holds for the SELECTED CAMPAIGNS (`GET /advertising/dayparting/heatmap`, 60 days), and
 * when there are no cells there is no starter — `reason` says which, and the caller disables it.
 *
 * ── Why the sizes are what they are ─────────────────────────────────────────────────────────────
 *
 * A starter that proposes a write the gate will refuse is the same lie one layer down, so both
 * defaults are pinned to the write gate's own limits (`ads-write-gate.ts`, `budgetDayMoveDenial`):
 *
 *   · **+50%** is the largest raise guaranteed to clear the percentage ceiling. The gate allows the
 *     GREATER of +50% and a flat €10/day, so a small campaign may have more headroom than this —
 *     but +50% is the figure that lands for every campaign, which is what a starter needs.
 *   · **−30%** is exactly the daily drop limit.
 *
 * Both bounds are on CUMULATIVE daily movement across every writer, so a schedule sharing a
 * campaign with the pacer may still be refused; `DAY_MOVE_NOTE` states that rather than implying a
 * guarantee.
 *
 * 🔴 And on a campaign already at Amazon's €1 floor a decrease is arithmetically a no-op —
 * `computeBudget(1, 'campaign-budget', 'decPct', 30)` returns €1.00, verified against the real
 * executor. The cut starter therefore COUNTS the floored campaigns in the current selection and
 * says how many its window cannot move, rather than implying a cut it cannot deliver. That count
 * is the reason `budgetStarters` takes budgets and not just a campaign count.
 *
 * Nothing here writes. A starter fills the builder's own window rows, which the operator edits and
 * then creates by hand — the same "ordinary criteria the operator edits before creating" contract
 * the rule starters (`RuleBuilder.STARTER_TEMPLATES`) established in BP.P5.
 */
import { metricVal, type RawCell } from './heatMetrics'
import { WEEKDAYS } from './scheduleConfig'

/** One window row, in the shape `ScheduleBuilder` keeps them (minus its client-side `id`). */
export interface StarterWindow { day: number; start: string; end: string; adj: string; value: string }

export interface BudgetStarter {
  key: string
  name: string
  /** What it will do, in the operator's terms, including the numbers it derived. */
  desc: string
  /** Null when the account's data cannot support it — the caller disables and shows `reason`. */
  windows: StarterWindow[] | null
  /** Why it is unavailable. Empty when `windows` is non-null. */
  reason: string
}

/** The gate's own words, so a starter cannot imply a guarantee the gate will not honour. */
export const DAY_MOVE_NOTE =
  'The write gate caps total daily budget movement at −30% / +50% (or €10, whichever is larger) per campaign per UTC day, counting every writer — so a campaign the pacer has already moved today may refuse part of this.'

const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00`

/** Spend per hour-of-day, summed across every weekday in the window. */
function spendByHour(cells: RawCell[]): number[] {
  const g = metricVal('Spend').f
  const out = Array.from({ length: 24 }, () => 0)
  for (const c of cells) out[c.hour] += g(c)
  return out
}

/** Attributed sales per hour-of-day. */
function salesByHour(cells: RawCell[]): number[] {
  const out = Array.from({ length: 24 }, () => 0)
  for (const c of cells) out[c.hour] += c.salesCents / 100
  return out
}

/**
 * The contiguous run of hours around the spend peak that stays at or above `frac` of it.
 * Returned as `[startHour, endHourExclusive]`, which is how the executor reads a window.
 */
function peakSpan(byHour: number[], frac = 0.6): [number, number] | null {
  const max = Math.max(...byHour)
  if (max <= 0) return null
  const peak = byHour.indexOf(max)
  let lo = peak, hi = peak
  while (lo > 0 && byHour[lo - 1] >= max * frac) lo--
  while (hi < 23 && byHour[hi + 1] >= max * frac) hi++
  return [lo, hi + 1]
}

/**
 * The longest contiguous run of hours that SPENT money and returned NOTHING.
 *
 * 🔴 Requires real spend in every hour of the run. An hour with no spend and no sales is not a bad
 * hour, it is an hour with no data, and a starter that cut budget there would be acting on absence.
 */
function deadSpan(spend: number[], sales: number[], minSpend: number): [number, number] | null {
  let best: [number, number] | null = null, bestLen = 0
  let start = -1
  for (let h = 0; h <= 24; h++) {
    const dead = h < 24 && spend[h] >= minSpend && sales[h] === 0
    if (dead) { if (start < 0) start = h }
    else if (start >= 0) {
      if (h - start > bestLen) { bestLen = h - start; best = [start, h] }
      start = -1
    }
  }
  return bestLen >= 2 ? best : null
}

const everyDay = (start: number, end: number, adj: string, value: string): StarterWindow[] =>
  WEEKDAYS.map((d) => ({ day: d.idx, start: hh(start), end: hh(end), adj, value }))

const eur = (n: number) => `€${n.toFixed(n >= 100 ? 0 : 2)}`
const span = (a: number, b: number) => `${hh(a)}–${hh(b)}`

/**
 * The starter list for the CURRENT selection. Recomputed whenever the cells change, so the numbers
 * in the descriptions are always the ones behind the windows being offered.
 *
 * `campaignCount` only shapes the copy; the arithmetic is entirely the cells'.
 */
export function budgetStarters(cells: RawCell[], campaignCount: number, dailyBudgets: Array<number | null> = []): BudgetStarter[] {
  /** Amazon's floor. A campaign already here cannot go lower, so a percentage cut does nothing. */
  const atFloor = dailyBudgets.filter((b) => b != null && Number(b) <= 1).length
  const floorNote = atFloor > 0
    ? ` ${atFloor} of the ${campaignCount} selected ${atFloor === 1 ? 'campaign is' : 'campaigns are'} already at Amazon's €1 floor, where a decrease is arithmetically a no-op — this window cannot move ${atFloor === 1 ? 'it' : 'them'}.`
    : ''
  const noData = campaignCount === 0
    ? 'Add campaigns first — a starter is built from their own hourly history, not from a default.'
    : 'The selected campaigns reported no hourly spend in the last 60 days, so there is nothing to derive a window from.'

  if (!cells.length) {
    return [
      { key: 'peak', name: 'Fund the peak hours', desc: 'Raise budget across the hours these campaigns actually spend in.', windows: null, reason: noData },
      { key: 'dead', name: 'Stand down in the dead hours', desc: 'Cut budget across the hours that spend and return nothing.', windows: null, reason: noData },
      { key: 'allday', name: 'Weekend multiplier', desc: 'A daily ×multiplier on Saturday and Sunday.', windows: null, reason: noData },
    ]
  }

  const spend = spendByHour(cells)
  const sales = salesByHour(cells)
  const total = spend.reduce((a, b) => a + b, 0)
  const peak = peakSpan(spend)
  // A run is only "dead" if its hours each carry at least 1% of a day's average hourly spend —
  // below that the zero is noise, not evidence.
  const dead = deadSpan(spend, sales, Math.max(0.5, (total / 24) * 0.01))

  const out: BudgetStarter[] = []

  /**
   * 🔴 A span this wide is not a peak, and calling it one would be the dishonest half of a true
   * number. Measured on the IT selection: hours 11:00–00:00 all sit within 40% of the maximum, so
   * the derivation faithfully returned a THIRTEEN-hour "peak" — and a +50% lift across 13 hours
   * every day is an across-the-board budget rise, which is an `AdBudgetPlan` decision, not a
   * schedule. The flatness is itself the finding, so the starter reports it instead of dressing it
   * up. (Half a day is the line: at 12+ hours the word has stopped meaning anything.)
   */
  const PEAK_MAX_HOURS = 12
  const peakWidth = peak ? peak[1] - peak[0] : 0
  out.push(peak && peakWidth < PEAK_MAX_HOURS
    ? {
      key: 'peak',
      name: 'Fund the peak hours',
      desc: `${span(peak[0], peak[1])} carries ${eur(spend.slice(peak[0], peak[1]).reduce((a, b) => a + b, 0))} of the ${eur(total)} these campaigns spent in 60 days — raise budget 50% across it, every day.`,
      windows: everyDay(peak[0], peak[1], 'incPct', '50'),
      reason: '',
    }
    : {
      key: 'peak',
      name: 'Fund the peak hours',
      desc: 'Raise budget across the hours these campaigns actually spend in.',
      windows: null,
      reason: peak
        ? `Spend is spread evenly — ${peakWidth} of 24 hours (${span(peak[0], peak[1])}) sit within 40% of the busiest, so there is no peak distinct enough to fund. Raising budget across ${peakWidth} hours a day is an across-the-board rise, which belongs to the monthly plan rather than to a schedule.`
        : 'These campaigns have hourly rows but no recorded spend, so there is no peak to fund.',
    })

  out.push(dead
    ? {
      key: 'dead',
      name: 'Stand down in the dead hours',
      desc: `${span(dead[0], dead[1])} spent ${eur(spend.slice(dead[0], dead[1]).reduce((a, b) => a + b, 0))} and returned no attributed sales in 60 days — cut budget 30% across it, every day.${floorNote}`,
      windows: everyDay(dead[0], dead[1], 'decPct', '30'),
      reason: '',
    }
    : { key: 'dead', name: 'Stand down in the dead hours', desc: 'Cut budget across the hours that spend and return nothing.', windows: null, reason: 'No run of two or more hours both spent money and returned nothing — there is no dead span to stand down in.' })

  /**
   * The multiplier starter exists because BSP-P4 made the daily grain authorable and a starter is
   * the natural way to meet it. It is weekday-shaped rather than hour-shaped, so it carries no
   * hours at all — which is exactly what `activeWindow` reads as all-day.
   */
  const weekendSpend = cells.filter((c) => c.dow === 0 || c.dow === 6).reduce((a, c) => a + c.costCents / 100, 0)
  const weekdaySpend = total - weekendSpend
  const weekendShare = total > 0 ? (weekendSpend / total) * 100 : 0
  out.push({
    key: 'allday',
    name: 'Weekend multiplier',
    desc: `Saturday and Sunday take ${weekendShare.toFixed(0)}% of these campaigns' spend (${eur(weekendSpend)} of ${eur(total)}; weekdays ${eur(weekdaySpend)}) — apply a ×1.5 daily multiplier to both.`,
    windows: [0, 6].map((d) => ({ day: d, start: '', end: '', adj: 'mult', value: '1.5' })),
    reason: '',
  })

  return out
}

/**
 * The two starters that ADJUST a percentage need the Campaign Budget type; the multiplier needs
 * Budget Multiplier. Applying one switches the type for the operator rather than silently writing
 * a window the chosen type cannot express.
 */
export const starterType = (key: string): 'campaign-budget' | 'budget-multiplier' =>
  (key === 'allday' ? 'budget-multiplier' : 'campaign-budget')
