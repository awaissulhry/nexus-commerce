import { monthLabel } from '../../accounting/periods'

/**
 * The payroll export's rules (B-W2b-54; MES-267, MES-273, MES-274; design people.payroll), pure. Nexus does not run payroll: it
 * makes a file for the labour consultant. The month's state, the link's terms and the refusals, each in words.
 */

export const PAYROLL_EXPORT_STATUSES = ['DRAFT', 'EXPORTED', 'CANCELLED'] as const
export type PayrollExportStatus = (typeof PAYROLL_EXPORT_STATUSES)[number]

export const MONTH_STATES = ['NOT_EXPORTED', 'EXPORTED', 'CORRECTION_PENDING'] as const
export type MonthState = (typeof MONTH_STATES)[number]

export const PAYROLL_REFUSALS = [
  'CHECKS_OPEN',
  'ALREADY_EXPORTED',
  'NOTHING_EXPORTED',
  'NOT_LATEST',
  'NOTHING_CHANGED',
  'CHANGED_WHILE_MAKING',
  'NOT_DRAFT',
  'NOT_EXPORTED',
  'REPLACED',
  'NAME_TAKEN',
  'NOT_OUR_CODE',
  'LINK_NOT_LIVE',
  'SUPPRESSED',
  'LAYOUT_ARCHIVED',
] as const
export type PayrollRefusal = (typeof PAYROLL_REFUSALS)[number]

export const PAYROLL_LIMITS = Object.freeze({ reasonMin: 3, reasonMax: 500, note: 500, message: 1000, list: 100, listDefault: 24 })

/** How long our copy of a file is kept at least (the same five years as the LUL calendar; the consultant confirms it). */
export const PAYROLL_RETENTION_YEARS = 5

/**
 * What a secure link allows, narrower than its purpose's maxima: payroll data lives on a link for days, not months. Every
 * download uses one of its uses, and so does opening its page.
 */
export const PAYROLL_LINK_TERMS = Object.freeze({ expiryDays: { default: 7, max: 30 }, uses: { default: 10, max: 20 } })

export function monthStateOf(latest: { readonly revision: number } | null, changes: number): MonthState {
  if (!latest) return 'NOT_EXPORTED'
  return changes > 0 ? 'CORRECTION_PENDING' : 'EXPORTED'
}

export function monthStateWords(state: MonthState, month: string, latest: { readonly revision: number; readonly exportedOn: string | null } | null, changes: { readonly people: number; readonly values: number }): string {
  const label = monthLabel(month)
  if (state === 'NOT_EXPORTED') return `${label} · not exported`
  const exported = `Exported ${latest?.exportedOn ?? ''} · v${latest?.revision ?? 1}`
  return state === 'EXPORTED' ? exported : `${exported} · correction pending: ${changes.people} ${changes.people === 1 ? 'person' : 'people'}, ${changes.values} ${changes.values === 1 ? 'value' : 'values'}`
}

export const CORRECTION_WORDS = 'The new version replaces the one before for the consultant. The one before is kept.'
