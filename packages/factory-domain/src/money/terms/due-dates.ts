import type { Issue } from '../../core/errors'
import type { MinorUnits } from '../../core/money'
import { isBusinessDate, type BusinessDate } from '../../core/time'
import type { DocumentLanguage } from '../../documents/model'
import { endOfMonth, invoiceDueOf, type Instalment, type InvoiceDue } from '../../sales/terms/terms'

/**
 * Italian due-date conventions (B-W2b-396; FIN-076 "Italian due-date conventions"; design finance.settings "Payment
 * terms": "30/60 days end of month", "skip August"), pure. W2a's terms count each instalment's days from its event (the
 * invoice's date: "30 gg data fattura"), and an instalment's own `endOfMonth` moves the due day to the last day of its
 * month ("30 gg d.f.f.m.": 30 days from the invoice, then the end of that month). A terms entry (factory-db pricing.prisma
 * PaymentTerms, B-W2b-369) adds two conventions agreed with the customer:
 *
 *   fromEndOfMonth   the days count from the end of the event's month ("30 gg f.m. data fattura": an invoice of 10 March
 *                    is due 30 days after 31 March, on 30 April); with the instalment's endOfMonth too, the due day then
 *                    moves to the end of its own month.
 *   skipMonths       months no instalment falls due in (1 = January … 12 = December; "escluso agosto"): a due day in a
 *                    skipped month moves to the first month that is not skipped, on the same day of the month (the last
 *                    day of that month when the month is shorter), or on its last day when the due day was the end of a
 *                    month. At most 11 months, each once (the database's own rule).
 *
 * The rule for a skipped month is UNVERIFIED (GATE-ACCOUNTANT, `SKIPPED_MONTH_RULE`): customers also agree "the 10th of
 * the next month"; a terms entry with skipped months is only ever the office's own choice (none is made by itself).
 */

export const SKIP_MONTHS_MAX = 11

export interface DueConventions {
  /** Count the days from the end of the event's month. */
  readonly fromEndOfMonth: boolean
  /** Months (1–12) no instalment falls due in. */
  readonly skipMonths: readonly number[]
}

export const NO_CONVENTIONS: DueConventions = Object.freeze({ fromEndOfMonth: false, skipMonths: Object.freeze([]) as readonly number[] })

/** The rule that moves a due day out of a skipped month, waiting for the accountant's word. */
export const SKIPPED_MONTH_RULE = Object.freeze({
  status: 'UNVERIFIED' as const,
  gate: 'GATE-ACCOUNTANT' as const,
  words: 'A due day in a skipped month moves to the first month that is not skipped, on the same day (the end of the month when it was one). Your accountant confirms the convention agreed with the customer.',
})

/** The skipped months as given, checked: whole months 1 to 12, each once, at most 11. */
export function skipMonthsProblems(months: readonly number[], path = 'skipMonths'): Issue[] {
  const issues: Issue[] = []
  if (months.some((month) => !Number.isInteger(month) || month < 1 || month > 12)) issues.push({ path, message: 'Months are 1 (January) to 12 (December).' })
  if (new Set(months).size !== months.length) issues.push({ path, message: 'Each month once.' })
  if (months.length > SKIP_MONTHS_MAX) issues.push({ path, message: `At most ${SKIP_MONTHS_MAX} months are skipped: one month at least stays to pay in.` })
  return issues
}

/** The months in calendar order, each once (as stored). */
export const normalSkipMonths = (months: readonly number[]): number[] => [...new Set(months)].sort((a, b) => a - b)

/** The conventions of a stored terms row (a malformed value reads as none: the database never stores one). */
export function conventionsOf(row: { readonly fromEndOfMonth?: boolean | null; readonly skipMonths?: readonly number[] | null }): DueConventions {
  const months = Array.isArray(row.skipMonths) ? row.skipMonths.filter((month) => Number.isInteger(month) && month >= 1 && month <= 12) : []
  return { fromEndOfMonth: row.fromEndOfMonth === true, skipMonths: normalSkipMonths(months) }
}

const monthOf = (day: BusinessDate): number => Number.parseInt(day.slice(5, 7), 10)
const lastDayOf = (day: BusinessDate): number => Number.parseInt(endOfMonth(day).slice(8, 10), 10)

/** The first day of the month after `day`'s. */
function nextMonthStart(day: BusinessDate): BusinessDate {
  const date = new Date(`${day.slice(0, 7)}-01T00:00:00.000Z`)
  date.setUTCMonth(date.getUTCMonth() + 1)
  return date.toISOString().slice(0, 10)
}

/** `day` moved out of the skipped months: the same day of the first month not skipped (its last day when shorter or when `day` ended its month). */
export function outOfSkippedMonths(day: BusinessDate, skipMonths: readonly number[]): BusinessDate {
  if (skipMonths.length === 0 || !skipMonths.includes(monthOf(day))) return day
  const wasEnd = Number.parseInt(day.slice(8, 10), 10) === lastDayOf(day)
  const wanted = Number.parseInt(day.slice(8, 10), 10)
  let month = nextMonthStart(day)
  for (let guard = 0; guard < 12 && skipMonths.includes(monthOf(month)); guard += 1) month = nextMonthStart(month)
  const last = lastDayOf(month)
  const dayOfMonth = wasEnd ? last : Math.min(wanted, last)
  return `${month.slice(0, 8)}${String(dayOfMonth).padStart(2, '0')}`
}

/** An instalment's due day from its event's day under the conventions (W2a's dueDateOf with none). */
export function dueDateUnder(eventDay: BusinessDate, item: Pick<Instalment, 'days' | 'endOfMonth'>, conventions: DueConventions = NO_CONVENTIONS): BusinessDate {
  if (!isBusinessDate(eventDay)) throw new RangeError(`not a calendar day: ${eventDay}`)
  const start = conventions.fromEndOfMonth ? endOfMonth(eventDay) : eventDay
  const date = new Date(`${start}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + item.days)
  const counted = date.toISOString().slice(0, 10)
  return outOfSkippedMonths(item.endOfMonth ? endOfMonth(counted) : counted, conventions.skipMonths)
}

/**
 * When an invoice falls due under terms with their conventions: W2a's invoiceDueOf (the instalments that count from the
 * invoice, their shares among themselves, the early-payment discount), each instalment's day by `dueDateUnder`. Terms
 * whose instalments all come before the invoice leave one instalment due on its day, as before (no convention moves it).
 */
export function invoiceDueUnder(
  terms: { readonly method: string; readonly instalments: readonly Instalment[]; readonly earlyPaymentDiscountPct: string | null; readonly earlyPaymentDays: number | null } & DueConventions,
  invoiceDay: BusinessDate,
  amount: MinorUnits,
): InvoiceDue {
  const due = invoiceDueOf(terms, invoiceDay, amount)
  const onInvoice = terms.instalments.filter((item) => item.from === 'INVOICE')
  if (onInvoice.length === 0) return due
  return { ...due, instalments: due.instalments.map((item, index) => ({ ...item, dueDate: dueDateUnder(invoiceDay, onInvoice[index]!, terms) })) }
}

const MONTHS: Readonly<Record<DocumentLanguage, readonly string[]>> = {
  it: ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
}

/** The conventions in words, for the terms' summary ("dalla fine del mese · escluso agosto"); null when none. */
export function conventionWords(conventions: DueConventions, language: DocumentLanguage): string | null {
  const parts: string[] = []
  if (conventions.fromEndOfMonth) parts.push(language === 'it' ? 'giorni contati dalla fine del mese' : 'days counted from the end of the month')
  if (conventions.skipMonths.length > 0) {
    const names = conventions.skipMonths.map((month) => MONTHS[language][month - 1]!)
    const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} ${language === 'it' ? 'e' : 'and'} ${names.at(-1)!}`
    parts.push(language === 'it' ? `escluso ${list} (la scadenza passa al mese dopo)` : `${list} skipped (the due day moves to the next month)`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}
