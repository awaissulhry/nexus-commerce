import type { BusinessDate } from '../core/time'

/**
 * Number series (plan A1 §2.3 NumberSeries, §3.9; PLAN §2.8; features PLT-122, PLT-123). A series hands out the
 * numbers of one kind of document for one company: `kind` + `code` (the sezionale: `MAIN`, `A`, `B`…) name the series,
 * and its counter runs per period, the calendar year for a series that resets yearly. The database keeps one row per
 * company, kind, code and period (`scopeKey`); apps/factory-api's allocateNumber takes the next number inside the
 * issuing command's transaction.
 */

/** What a series numbers. New kinds are additive (the Prisma enum NumberKind lists the same values). */
export const NUMBER_KINDS = [
  'QUOTE',
  'SALES_ORDER',
  'PURCHASE_ORDER',
  'GOODS_RECEIPT',
  'WORK_ORDER',
  'SHIPMENT',
  'DDT',
  'INVOICE',
  'DEPOSIT_INVOICE',
  'CREDIT_NOTE',
  'RETURN',
  'LOT',
  'BATCH',
  'PPE_REGISTER',
] as const
export type NumberKind = (typeof NUMBER_KINDS)[number]

/**
 * The fiscal documents: progressive numbering with no gap and never the same number twice (DPR 633/1972 art. 21 c.2
 * for invoices, credit notes and deposit invoices; DPR 472/1996 for the DDT). A fiscal series also refuses a document
 * dated before its last number's date, and keeps every number within FatturaPA's 20 characters.
 */
export const FISCAL_KINDS: readonly NumberKind[] = ['DDT', 'INVOICE', 'DEPOSIT_INVOICE', 'CREDIT_NOTE']

export function isNumberKind(value: unknown): value is NumberKind {
  return typeof value === 'string' && (NUMBER_KINDS as readonly string[]).includes(value)
}

export function isFiscalKind(kind: NumberKind): boolean {
  return FISCAL_KINDS.includes(kind)
}

/** The kind in words, for messages: `invoice`, `DDT`, `purchase order`, `PPE register`. */
export function kindLabel(kind: NumberKind): string {
  if (kind === 'DDT') return 'DDT'
  if (kind === 'PPE_REGISTER') return 'PPE register'
  return kind.toLowerCase().replace(/_/g, ' ')
}

/** When the counter starts again: every calendar year, or never. */
export const NUMBER_RESETS = ['YEARLY', 'NEVER'] as const
export type NumberReset = (typeof NUMBER_RESETS)[number]

/** The period key of a series that never resets. */
export const NO_RESET_SCOPE = 'ALL'

/** The code of a company's first series of a kind. */
export const DEFAULT_SERIES_CODE = 'MAIN'

/** A series code: 1 to 16 capital letters, digits or hyphens, starting with a letter or digit (`MAIN`, `A`, `B-2`). */
export const SERIES_CODE = /^[A-Z0-9][A-Z0-9-]{0,15}$/

export function isSeriesCode(value: unknown): value is string {
  return typeof value === 'string' && SERIES_CODE.test(value)
}

/** The largest number a series hands out: the Int column's limit. */
export const MAX_NUMBER = 2_147_483_647

export function isNumberValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_NUMBER
}

/** The calendar years a yearly series may run in. */
export const MIN_YEAR = 2000
export const MAX_YEAR = 2999

/**
 * The period a document dated `date` (a business date, Europe/Rome) is numbered in: its calendar year for a yearly
 * series (`2026`), `ALL` for one that never resets. The fiscal year start of a company does not move it: Italian
 * numbering follows the calendar year of the document's date.
 */
export function scopeKeyFor(reset: NumberReset, date: BusinessDate): string {
  if (reset === 'NEVER') return NO_RESET_SCOPE
  const year = Number.parseInt(date.slice(0, 4), 10)
  if (!/^\d{4}-/.test(date) || year < MIN_YEAR || year > MAX_YEAR) throw new RangeError(`not a business date in ${MIN_YEAR}-${MAX_YEAR}: ${date}`)
  return String(year)
}

/** The calendar year of a yearly series' period, or null for `ALL`. */
export function yearOfScope(scopeKey: string): number | null {
  if (scopeKey === NO_RESET_SCOPE) return null
  if (!/^\d{4}$/.test(scopeKey)) throw new RangeError(`not a period key: ${scopeKey}`)
  return Number.parseInt(scopeKey, 10)
}

/** A period key as stored: `ALL` or a year from MIN_YEAR to MAX_YEAR. */
export function isScopeKey(value: unknown): value is string {
  if (value === NO_RESET_SCOPE) return true
  if (typeof value !== 'string' || !/^\d{4}$/.test(value)) return false
  const year = Number.parseInt(value, 10)
  return year >= MIN_YEAR && year <= MAX_YEAR
}

/** The prefix a new series of a kind starts with in its default pattern (the admin may type any pattern). */
const DEFAULT_PREFIX: Readonly<Record<NumberKind, string>> = {
  QUOTE: 'QT',
  SALES_ORDER: 'SO',
  PURCHASE_ORDER: 'PO',
  GOODS_RECEIPT: 'GR',
  WORK_ORDER: 'WO',
  SHIPMENT: 'SH',
  DDT: 'DDT',
  INVOICE: 'FT',
  DEPOSIT_INVOICE: 'FA',
  CREDIT_NOTE: 'NC',
  RETURN: 'RMA',
  LOT: 'LOT',
  BATCH: 'BT',
  PPE_REGISTER: 'REG',
}

/** The pattern a new series gets when the admin types none: `FT-{YYYY}-{N:5}` (yearly) or `LOT-{N:6}` (never resets). */
export function defaultPattern(kind: NumberKind, reset: NumberReset): string {
  const prefix = DEFAULT_PREFIX[kind]
  return reset === 'YEARLY' ? `${prefix}-{YYYY}-{N:5}` : `${prefix}-{N:6}`
}
