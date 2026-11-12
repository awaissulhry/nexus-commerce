import { INTL_LOCALE, type Locale } from '../../../../lib/i18n/locales'

/**
 * The lab's price of a lab result on Compliance › Tests & substances (B-W2b-288, FU2:03; LabResult.costAmount + costCurrency of
 * B-W2b-275; design compliance.tests ts-lots "cost: Lab cost column (W2b, hidden without financials.cost)"), pure. The price is
 * the cost grain (money.cost): typed with a result by a person who holds it, shown per result and summed per lot in the Lot
 * tests list. The API drops both fields for everyone without the grain, so the screens draw the column and the field only when
 * the person holds it (never on the floor, never in a portal). Amounts are whole minor units (cents) of an ISO 4217 currency.
 */

export const LAB_COST_NAMESPACE = 'compliance-followups-w2b4'
/** The currencies the field offers (the factory's; the API takes any ISO 4217 code). */
export const LAB_CURRENCIES = ['EUR', 'CHF', 'GBP', 'USD'] as const
/** The largest price of one result the API takes, in minor units (one million). */
export const LAB_COST_MAX = 100_000_000

export interface LabCost {
  /** Minor units (cents), as the API names them. */
  readonly cents: number
  readonly currency: string
}
export interface LabCostSum extends LabCost {
  readonly results: number
}

/** The person holds the cost grain (money.cost): the price field and the Lab cost column are theirs. */
export const holdsCostGrain = (permissions: readonly string[]): boolean => permissions.includes('money.cost')

/** The price as typed: "85,50" in the currency chosen; empty: no price. */
export interface LabCostDraft {
  readonly text: string
  readonly currency: string
}
export const BLANK_LAB_COST: LabCostDraft = Object.freeze({ text: '', currency: 'EUR' })

/** "85", "85,5", "85.50", "1.234,50" → minor units; null when it is not an amount with at most two decimals. */
export function minorUnitsOf(text: string): number | null {
  const plain = text.trim().replace(/\s/g, '')
  if (plain === '') return null
  // The last comma or point with one or two digits after it is the decimal mark; any other is a thousands mark.
  const mark = /[.,](\d{1,2})$/.exec(plain)
  const whole = (mark ? plain.slice(0, mark.index) : plain).replace(/[.,]/g, '')
  if (!/^\d+$/.test(whole)) return null
  const cents = mark ? Number(mark[1]!.padEnd(2, '0')) : 0
  return Number(whole) * 100 + cents
}

/** Why the price is refused (a message key of this folder's catalogue), or null (empty is fine: no price). */
export function labCostProblem(draft: LabCostDraft | undefined): string | null {
  if (!draft || draft.text.trim() === '') return null
  const amount = minorUnitsOf(draft.text)
  if (amount === null) return 'labCost.problem.amount'
  if (amount > LAB_COST_MAX) return 'labCost.problem.tooLarge'
  if (!/^[A-Z]{3}$/.test(draft.currency)) return 'labCost.problem.currency'
  return null
}

/** What the API is sent (`cost`), or null for no price. */
export function labCostBody(draft: LabCostDraft | undefined): LabCost | null {
  if (!draft || labCostProblem(draft) !== null) return null
  const cents = minorUnitsOf(draft.text)
  return cents === null ? null : { cents, currency: draft.currency }
}

/** A price in the page's language ("85,00 €", "€85.00"). */
export function costWords(cost: LabCost, locale: Locale): string {
  try {
    return new Intl.NumberFormat(INTL_LOCALE[locale], { style: 'currency', currency: cost.currency }).format(cost.cents / 100)
  } catch {
    return `${(cost.cents / 100).toFixed(2)} ${cost.currency}`
  }
}

/** A lot's lab prices, one per currency ("85,00 € · 120,00 CHF"); none: null. */
export const lotCostWords = (sums: readonly LabCostSum[] | undefined, locale: Locale): string | null => (sums && sums.length > 0 ? sums.map((sum) => costWords(sum, locale)).join(' · ') : null)

/** The list shows the Lab cost column when the API sent the field (it drops it without the cost grain). */
export const listHasLabCost = (rows: readonly { readonly labCost?: readonly LabCostSum[] | undefined }[]): boolean => rows.some((row) => row.labCost !== undefined)
