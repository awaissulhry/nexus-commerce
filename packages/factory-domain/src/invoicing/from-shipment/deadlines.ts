import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import { fifteenthOfNextMonth, formatDateIt, monthOf } from '../fatturapa/format'

/**
 * Which invoice shipped goods get, and by when (B-W1-51; FIN-055, FIN-059, FIN-065 words; DPR 633/1972 art. 21 c.4),
 * pure:
 *
 *   immediate (TD01)   one delivery, invoiced within 12 days of it (the DDT's date): art. 21 c.4, first sentence.
 *   deferred (TD24)    the goods shipped with DDTs in one calendar month, invoiced together by the 15th of the next month,
 *                      citing the DDTs: art. 21 c.4 lett. a. One invoice per customer and month.
 *
 * The rule (W1; a preset per customer comes later): one DDT still within its 12 days → TD01; several DDTs of one month,
 * or one DDT past its 12 days → TD24 while the 15th of the next month has not passed. The office may pick the other
 * type while it is in time. When both limits passed the invoice is late: one DDT is invoiced at once as a TD01 (the
 * FatturaPA builder refuses a TD24 after its 15th); several DDTs are split, one TD01 each. The deadlines are in words,
 * with the days left, for the "Shipped, not invoiced" list and the record's countdown (A2 SCR-080, SCR-081).
 */

export type ShipInvoiceType = 'TD01' | 'TD24'

/** Days an immediate invoice may follow the delivery (art. 21 c.4 DPR 633/1972). */
export const IMMEDIATE_INVOICE_DAYS = 12
/** A deadline this many days away or fewer is "due soon" (the list's amber). */
export const DUE_SOON_DAYS = 3

export type DeadlineState = 'OPEN' | 'DUE_SOON' | 'LATE'

export interface InvoiceDeadline {
  readonly docType: ShipInvoiceType
  /** The last day to issue it (Europe/Rome business date). */
  readonly dueBy: BusinessDate
  /** Days from today to dueBy: 0 on the day, negative when late. */
  readonly daysLeft: number
  readonly state: DeadlineState
  readonly words: string
}

const DAY_MS = 86_400_000
const utc = (date: BusinessDate): number => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))

/** The business date `days` days after `date`. */
export function addDays(date: BusinessDate, days: number): BusinessDate {
  return new Date(utc(date) + days * DAY_MS).toISOString().slice(0, 10)
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: BusinessDate, to: BusinessDate): number {
  return Math.round((utc(to) - utc(from)) / DAY_MS)
}

function stateOf(daysLeft: number): DeadlineState {
  if (daysLeft < 0) return 'LATE'
  return daysLeft <= DUE_SOON_DAYS ? 'DUE_SOON' : 'OPEN'
}

function leftWords(daysLeft: number): string {
  if (daysLeft < 0) return `late by ${-daysLeft} day${daysLeft === -1 ? '' : 's'}`
  if (daysLeft === 0) return 'due today'
  return `${daysLeft} day${daysLeft === 1 ? '' : 's'} left`
}

/** TD01: by the DDT's date + 12 days. */
export function immediateDeadline(ddt: { readonly number: string; readonly date: BusinessDate }, today: BusinessDate): InvoiceDeadline {
  const dueBy = addDays(ddt.date, IMMEDIATE_INVOICE_DAYS)
  const daysLeft = daysBetween(today, dueBy)
  return {
    docType: 'TD01',
    dueBy,
    daysLeft,
    state: stateOf(daysLeft),
    words: `Immediate invoice (TD01) by ${formatDateIt(dueBy)}, 12 days after DDT ${ddt.number} of ${formatDateIt(ddt.date)} (DPR 633/1972 art. 21 c.4): ${leftWords(daysLeft)}.`,
  }
}

/** TD24: by the 15th of the month after the DDTs' month. */
export function deferredDeadline(month: string, today: BusinessDate): InvoiceDeadline {
  const dueBy = fifteenthOfNextMonth(`${month}-01`)
  const daysLeft = daysBetween(today, dueBy)
  return {
    docType: 'TD24',
    dueBy,
    daysLeft,
    state: stateOf(daysLeft),
    words: `Deferred invoice (TD24) for the DDTs of ${month} by ${formatDateIt(dueBy)}, the 15th of the next month (DPR 633/1972 art. 21 c.4 lett. a): ${leftWords(daysLeft)}.`,
  }
}

export interface TypeChoice {
  /** The type the invoice gets (the one asked for, else the rule's), or null when none may be made (see problems). */
  readonly docType: ShipInvoiceType | null
  /** The rule's suggestion, in words. */
  readonly suggested: ShipInvoiceType | null
  readonly allowed: readonly ShipInvoiceType[]
  /** The deadline of the chosen type (the countdown), and both when they apply. */
  readonly deadline: InvoiceDeadline | null
  readonly immediate: InvoiceDeadline | null
  readonly deferred: InvoiceDeadline | null
  readonly words: string
  readonly problems: readonly Issue[]
}

/**
 * The type of the invoice of these DDTs (all of one customer), today, and its deadline. `requested`: the office's pick
 * (refused, with why, when it is not allowed).
 */
export function chooseInvoiceType(ddts: readonly { readonly number: string; readonly date: BusinessDate }[], today: BusinessDate, requested?: ShipInvoiceType, path = 'body/docType'): TypeChoice {
  const none = (message: string, at = 'body/ddtIds'): TypeChoice => ({ docType: null, suggested: null, allowed: [], deadline: null, immediate: null, deferred: null, words: message, problems: [{ path: at, message }] })
  if (ddts.length === 0) return none('Choose at least one shipped DDT to invoice.')
  const months = [...new Set(ddts.map((ddt) => monthOf(ddt.date)))].sort()
  if (months.length > 1) {
    return none(`One deferred invoice covers the DDTs of one calendar month (DPR 633/1972 art. 21 c.4 lett. a): these are of ${months.join(' and ')}. Make one invoice per month.`)
  }
  const deferred = deferredDeadline(months[0]!, today)
  const immediate = ddts.length === 1 ? immediateDeadline(ddts[0]!, today) : null
  const allowed: ShipInvoiceType[] = []
  // TD01: one delivery, in its 12 days; or late, when a TD24 cannot be made in time either.
  if (immediate && (immediate.state !== 'LATE' || deferred.state === 'LATE')) allowed.push('TD01')
  if (deferred.state !== 'LATE') allowed.push('TD24')
  if (allowed.length === 0) {
    return {
      ...none(`The deferred invoice for the DDTs of ${months[0]} was due by ${formatDateIt(deferred.dueBy)}: it is late. Invoice each DDT now on its own (one immediate invoice, TD01, each) and tell the accountant (late invoicing).`),
      deferred,
    }
  }
  const suggested: ShipInvoiceType = allowed[0]!
  const reason =
    suggested === 'TD01'
      ? immediate!.state === 'LATE'
        ? `Late: both limits passed (${formatDateIt(immediate!.dueBy)} and ${formatDateIt(deferred.dueBy)}). Issue it now as an immediate invoice (TD01) and tell the accountant (late invoicing).`
        : `One DDT, still within its 12 days: an immediate invoice (TD01). ${immediate!.words}`
      : ddts.length > 1
        ? `${ddts.length} DDTs of ${months[0]}: one deferred invoice (TD24) citing them. ${deferred.words}`
        : `DDT ${ddts[0]!.number} is past its 12 days: a deferred invoice (TD24). ${deferred.words}`
  if (requested !== undefined && !allowed.includes(requested)) {
    const why =
      requested === 'TD01'
        ? ddts.length > 1
          ? 'An immediate invoice (TD01) is for one delivery: several DDTs make a deferred invoice (TD24).'
          : `An immediate invoice (TD01) was due by ${formatDateIt(immediate!.dueBy)}: make the deferred invoice (TD24) while it is in time.`
        : `A deferred invoice (TD24) for the DDTs of ${months[0]} was due by ${formatDateIt(deferred.dueBy)}: it is late.`
    return { docType: null, suggested, allowed, deadline: null, immediate, deferred, words: reason, problems: [{ path, message: why }] }
  }
  const docType = requested ?? suggested
  return { docType, suggested, allowed, deadline: docType === 'TD01' ? immediate : deferred, immediate, deferred, words: reason, problems: [] }
}
