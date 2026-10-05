/**
 * ONE rule for every box where a person types an Amazon campaign's daily budget or Target ACoS
 * (ads perfect plan, PR 1c — findings CM-7 = AM-1 and CM-13).
 *
 * Before this file each screen read the box its own way, so the same action gave different
 * results per screen: the Ad Manager pencil and its bulk tools rounded to whole euros (€12.34 was
 * written as €12.00), an empty box wrote €1.00, a bulk "Set" with no value showed €0.00 in its
 * review and wrote €1.00, and an empty Target ACoS wrote 0 % instead of "unset". The detail page
 * and the old console kept the cents but let €0.50 or €0.00 through unchecked.
 *
 * The rule, everywhere:
 * · A budget keeps its cents (rounded to the cent, never to the euro).
 * · An empty box, or text that is not a number, sends NOTHING. The screen says why and its
 *   Apply / Save stays off.
 * · €1.00 is Amazon's own smallest daily budget. A typed amount below it is refused with that
 *   sentence; only a percentage cut can land below it, and then the campaign stops at €1.00 and
 *   the screen says, before anything is sent, how many campaigns will.
 * · A blank Target ACoS means "unset" (`null`): the optimiser then uses its own fallback.
 *
 * PURE: no React, no fetch. `budgetInput.vitest.test.ts` pins every case above.
 */

/** Amazon's smallest daily budget for a Sponsored Products campaign in the EU stores, in euros. */
export const AMAZON_MIN_DAILY_BUDGET = 1

/** The highest Target ACoS the automation endpoint stores (it keeps fractions from 0 to 5). */
const MAX_TARGET_ACOS_PCT = 500

export const BUDGET_MESSAGES = {
  empty: 'Enter a daily budget. An empty box changes nothing.',
  notNumber: 'Enter the budget as a number, for example 12.50.',
  belowMinimum: 'Amazon’s smallest daily budget is €1.00.',
  percentEmpty: 'Enter a percentage. An empty box changes nothing.',
  percentNotNumber: 'Enter the percentage as a number, for example 10.',
  percentNotAboveZero: 'Enter a percentage above 0.',
  decreaseOver100: 'A decrease can be at most 100%.',
  acosNotNumber: 'Enter a number, or leave the box blank to unset the target.',
  acosOutOfRange: `Enter a Target ACoS from 0% to ${MAX_TARGET_ACOS_PCT}%.`,
} as const

export type BudgetMode = 'set' | 'incPct' | 'decPct'
export type ReadResult = { ok: true; value: number } | { ok: false; message: string }

/** Euros to the cent. `toFixed(6)` first, so 1.005 (stored as 1.00499…) rounds up to 1.01. */
export function roundToCents(eur: number): number {
  return Math.round(Number((eur * 100).toFixed(6))) / 100
}

const AMOUNT_TEXT = /^[+-]?(\d+([.,]\d*)?|[.,]\d+)$/

/** A typed number: "12.34", "12,34", " 12 ". Anything else (letters, "1e3", "1.2.3") is null. */
export function readAmount(raw: string): number | null {
  const s = raw.trim()
  if (!AMOUNT_TEXT.test(s)) return null
  const n = Number(s.replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

/** A typed daily budget → the euros to send, or the sentence that says why nothing is sent. */
export function readDailyBudget(raw: string): ReadResult {
  if (raw.trim() === '') return { ok: false, message: BUDGET_MESSAGES.empty }
  const n = readAmount(raw)
  if (n == null) return { ok: false, message: BUDGET_MESSAGES.notNumber }
  const value = roundToCents(n)
  if (value < AMAZON_MIN_DAILY_BUDGET) return { ok: false, message: BUDGET_MESSAGES.belowMinimum }
  return { ok: true, value }
}

/** A typed "increase / decrease by %" value. */
export function readBudgetPercent(raw: string, mode: 'incPct' | 'decPct'): ReadResult {
  if (raw.trim() === '') return { ok: false, message: BUDGET_MESSAGES.percentEmpty }
  const n = readAmount(raw)
  if (n == null) return { ok: false, message: BUDGET_MESSAGES.percentNotNumber }
  if (n <= 0) return { ok: false, message: BUDGET_MESSAGES.percentNotAboveZero }
  if (mode === 'decPct' && n > 100) return { ok: false, message: BUDGET_MESSAGES.decreaseOver100 }
  return { ok: true, value: n }
}

/** The value box of a "Set to (€) / Increase by (%) / Decrease by (%)" control. */
export function readBudgetChange(mode: BudgetMode, raw: string): ReadResult {
  return mode === 'set' ? readDailyBudget(raw) : readBudgetPercent(raw, mode)
}

/**
 * The budget one campaign is sent for a Set / ±% change, to the cent. `value` is what
 * `readBudgetChange` returned, so a Set is already ≥ €1.00; only a percentage cut can land below
 * Amazon's minimum, and then it stops at €1.00 with `atMinimum: true`.
 */
export function nextDailyBudget(current: number, mode: BudgetMode, value: number): { value: number; atMinimum: boolean } {
  const raw = mode === 'set' ? value : mode === 'incPct' ? current * (1 + value / 100) : current * (1 - value / 100)
  const next = roundToCents(raw)
  return next < AMAZON_MIN_DAILY_BUDGET
    ? { value: AMAZON_MIN_DAILY_BUDGET, atMinimum: true }
    : { value: next, atMinimum: false }
}

/** What a Set / ±% change sends to a set of campaigns: the lowest and highest new budget, and how many stop at €1.00. */
export function summariseBudgetChange(currents: number[], mode: BudgetMode, value: number): { lowest: number; highest: number; atMinimum: number } | null {
  if (currents.length === 0) return null
  const nexts = currents.map((c) => nextDailyBudget(c, mode, value))
  return {
    lowest: Math.min(...nexts.map((n) => n.value)),
    highest: Math.max(...nexts.map((n) => n.value)),
    atMinimum: nexts.filter((n) => n.atMinimum).length,
  }
}

/** The sentence for campaigns a cut stops at Amazon's minimum, or null when none does. */
export function atMinimumNote(count: number): string | null {
  if (count <= 0) return null
  return `${count} campaign${count === 1 ? '' : 's'} would go below €1.00 and ${count === 1 ? 'stops' : 'stop'} at €1.00, Amazon’s smallest daily budget.`
}

export type TargetAcosRead = { ok: true; fraction: number | null } | { ok: false; message: string }

/** A typed Target ACoS in percent → the fraction to send. Blank is `null`: the target is unset. */
export function readTargetAcosPercent(raw: string): TargetAcosRead {
  if (raw.trim() === '') return { ok: true, fraction: null }
  const n = readAmount(raw)
  if (n == null) return { ok: false, message: BUDGET_MESSAGES.acosNotNumber }
  if (n < 0 || n > MAX_TARGET_ACOS_PCT) return { ok: false, message: BUDGET_MESSAGES.acosOutOfRange }
  return { ok: true, fraction: n / 100 }
}
