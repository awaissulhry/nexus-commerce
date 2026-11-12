import { dayWords } from '../../accounting/periods'
import { isBusinessDate, type BusinessDate } from '../../core/time'
import { plusCalendarDays } from '../../timers/rules'

/**
 * Warehouse rules: posting dates, the adjustment value that waits for a yes, the low-stock alerts (B-W2b-314; SCM-196,
 * SCM-281; the design's warehouse.settings ws-posting, ws-adjust), pure.
 *
 * Kept on InventorySettings: the company's row (id = the company's) or the tenant-wide row (companyId null, id = the
 * tenant's). Each rule is the company's own value, else the tenant-wide one, else its default — exactly as the database
 * reads them (`factory_wh_back_dating_days`): a company row's null follows the tenant-wide rules.
 *
 *   backDatingDays             0 to 366: how many days before the day a move is entered its posting date may be (0: the
 *                              same day); none anywhere: no limit. A floor move always counts on the day it is entered.
 *                              A closed month (Finance's period lock) refuses a posting date inside it, whatever this says.
 *   adjustmentApprovalAmount   minor units of the company's currency (the cost grain): an adjustment worth more waits for a
 *                              yes (an approval of kind STOCK_ADJUSTMENT; who approves is the approval rule's). None: no
 *                              adjustment waits.
 *   lowStockAlerts             a material below its planning minimum raises an alert; none anywhere: on.
 */

export const BACK_DATING_LIMITS = Object.freeze({ min: 0, max: 366 })
/** The largest adjustment value in minor units the rules keep (an Int column). */
export const MAX_ADJUSTMENT_AMOUNT = 2_000_000_000

export type RuleSource = 'COMPANY' | 'TENANT' | 'DEFAULT'

export interface SettingsRow {
  readonly backDatingDays: number | null
  readonly adjustmentApprovalAmount: number | null
  readonly lowStockAlerts: boolean | null
}

export interface InForce<Value> {
  readonly value: Value
  readonly source: RuleSource
}

export interface RulesInForce {
  readonly backDatingDays: InForce<number | null>
  readonly adjustmentApprovalAmount: InForce<number | null>
  readonly lowStockAlerts: InForce<boolean>
}

function pick<Key extends keyof SettingsRow>(key: Key, company: SettingsRow | null | undefined, tenant: SettingsRow | null | undefined): { value: SettingsRow[Key]; source: RuleSource } {
  if (company && company[key] !== null) return { value: company[key], source: 'COMPANY' }
  if (tenant && tenant[key] !== null) return { value: tenant[key], source: 'TENANT' }
  return { value: null as SettingsRow[Key], source: 'DEFAULT' }
}

/** The rules in force for a company (its row and the tenant-wide one), or tenant-wide (`company` undefined). */
export function rulesInForce(company: SettingsRow | null | undefined, tenant: SettingsRow | null | undefined): RulesInForce {
  const alerts = pick('lowStockAlerts', company, tenant)
  return {
    backDatingDays: pick('backDatingDays', company, tenant),
    adjustmentApprovalAmount: pick('adjustmentApprovalAmount', company, tenant),
    lowStockAlerts: { value: alerts.value ?? true, source: alerts.source },
  }
}

// ---- posting dates (SCM-196) -------------------------------------------------------------------------------------------

/** The days a posting date may take today: from `earliest` (null: no limit) to `today`. */
export function postingWindow(today: BusinessDate, backDatingDays: number | null): { readonly earliest: BusinessDate | null; readonly latest: BusinessDate } {
  return { earliest: backDatingDays === null ? null : plusCalendarDays(today, -backDatingDays), latest: today }
}

/**
 * Why a posting date may not be used now, in words (null: it may). The day the move is entered is `today` (Rome); a floor
 * move counts on that day only. A closed month is the period lock's, read apart (it may still refuse the day).
 */
export function postingDateProblem(input: { readonly day: string; readonly today: BusinessDate; readonly backDatingDays: number | null; readonly floor?: boolean }): string | null {
  if (!isBusinessDate(input.day)) return 'The posting date is a calendar day written YYYY-MM-DD.'
  if (input.floor && input.day !== input.today) return `A move from the floor counts on the day it is entered (${dayWords(input.today)}): its posting date is that day.`
  if (input.day > input.today) return `The posting date ${dayWords(input.day)} is after today (${dayWords(input.today)}): a move counts on the day it is entered or earlier.`
  const { earliest } = postingWindow(input.today, input.backDatingDays)
  if (earliest !== null && input.day < earliest) {
    const days = input.backDatingDays === 0 ? 'no day back' : input.backDatingDays === 1 ? '1 day back' : `${input.backDatingDays} days back`
    return `The posting date ${dayWords(input.day)} goes back further than the warehouse rules allow (${days}): the earliest is ${dayWords(earliest)}.`
  }
  return null
}

/** The day a move counts on in the books: its posting date, else the day it happened (Rome). */
export const postingDayOf = (move: { readonly postingDate: BusinessDate | null; readonly occurredDay: BusinessDate }): BusinessDate => move.postingDate ?? move.occurredDay

// ---- loosening a rule (asks the reason and a fresh code) ----------------------------------------------------------------

/** More days back than before, or no limit where there was one. */
export const backDatingLoosened = (before: number | null, after: number | null): boolean => before !== null && (after === null || after > before)

/** A higher value than before, or none where there was one (fewer adjustments wait). */
export const adjustmentLimitLoosened = (before: number | null, after: number | null): boolean => before !== null && (after === null || after > before)

/** The words of a loosening's reason: 1 to 500 characters. */
export function looseningReasonProblem(reason: string | null | undefined): string | null {
  const text = reason?.trim() ?? ''
  if (text.length === 0) return 'Loosening a warehouse rule needs the reason (it widens what one person can do).'
  if (text.length > 500) return 'The reason is at most 500 characters.'
  return null
}

// ---- the adjustment that waits for a yes ---------------------------------------------------------------------------------

/**
 * Whether an adjustment waits for a yes under the limit: worth more than it (both in the company's currency, minor
 * units). A value nobody can tell (no cost for the stock, another currency) waits too: nobody can say it is below the
 * limit. No limit: it never waits.
 */
export function adjustmentAboveLimit(input: { readonly limit: number | null; readonly valueAmount: number | null }): boolean {
  if (input.limit === null) return false
  if (input.valueAmount === null) return true
  return Math.abs(input.valueAmount) > input.limit
}
