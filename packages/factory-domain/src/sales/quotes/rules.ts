import type { Issue } from '../../core/errors'
import { fitsDecimal } from '../../core/money'
import { parseDecimal } from '../../tax/decimal'

/**
 * The quote rules a company quotes by (SAL-184, FIN-023; A1 §2.5 Quote: "approval needed when the margin floor or
 * discount limit is broken"; the design's Sales settings): the margin floor, the discount limit, how long an offer
 * stands by default and the deposit asked by default.
 *
 * Where they come from is one seam (apps/factory-api modules/sales/quotes/rules.ts `quoteRulesFor`): the SalesSettings
 * table (factory-db sales.prisma, keyed like CostingSettings: the company's row, else the tenant's), else
 * QUOTE_RULE_DEFAULTS (the old app's defaults: a 20 % floor, a 30 % deposit). Every version keeps the floor it was checked
 * against (QuoteVersion.marginFloorPct).
 */

export interface QuoteRules {
  /** The lowest margin, percent of the net amount, a quote is sent with without an approval. */
  readonly marginFloorPct: string
  /** The largest discount off the list price, percent, a line is sent with without an approval. */
  readonly discountLimitPct: string
  /** A new quote stands this many days (its validUntil), unless the office sets another day. */
  readonly defaultValidityDays: number
  /** The deposit asked at acceptance, percent of the gross total; null: none by default. */
  readonly defaultDepositPct: string | null
  /** Where the rules came from: the defaults below, the tenant's settings or the company's own. */
  readonly source: 'DEFAULT' | 'TENANT' | 'COMPANY'
}

export const QUOTE_RULE_DEFAULTS: QuoteRules = Object.freeze({
  marginFloorPct: '20',
  discountLimitPct: '15',
  defaultValidityDays: 30,
  defaultDepositPct: '30',
  source: 'DEFAULT',
})

/** The shortest and longest default validity, in days. */
export const VALIDITY_DAYS = { min: 1, max: 365 } as const

const percent = (value: string | null, path: string, issues: Issue[], { allowZero, max }: { allowZero: boolean; max: number }) => {
  if (value === null) return
  const parsed = parseDecimal(value)
  if (parsed === null || !fitsDecimal(value, 7, 4) || parsed.lt(0) || (!allowZero && parsed.isZero()) || parsed.gt(max)) {
    issues.push({ path, message: `A percentage from ${allowZero ? 0 : 'above 0'} to ${max}, at most 4 decimals.` })
  }
}

/**
 * What is wrong with a set of rules (PUT /sales/settings refuses them with these; the …_sales_settings_guards triggers
 * hold the same ranges for every login).
 */
export function quoteRuleProblems(rules: Omit<QuoteRules, 'source'>, at = 'body'): Issue[] {
  const issues: Issue[] = []
  percent(rules.marginFloorPct, `${at}/marginFloorPct`, issues, { allowZero: true, max: 100 })
  percent(rules.discountLimitPct, `${at}/discountLimitPct`, issues, { allowZero: true, max: 100 })
  percent(rules.defaultDepositPct, `${at}/defaultDepositPct`, issues, { allowZero: false, max: 100 })
  if (!Number.isInteger(rules.defaultValidityDays) || rules.defaultValidityDays < VALIDITY_DAYS.min || rules.defaultValidityDays > VALIDITY_DAYS.max) {
    issues.push({ path: `${at}/defaultValidityDays`, message: `Whole days from ${VALIDITY_DAYS.min} to ${VALIDITY_DAYS.max}.` })
  }
  return issues
}
