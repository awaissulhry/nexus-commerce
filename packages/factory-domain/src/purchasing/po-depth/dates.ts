import type { Issue } from '../../core/errors'
import { isBusinessDate } from '../../core/time'
import { STATUS_WORDS, type PurchaseOrderStatus } from '../orders'

/**
 * The confirmed date kept apart from the asked one (B-W2b-296; SCM-088; factory-db buying-depth.prisma PoDateChange), pure.
 *
 *   asked       the line's need date and each delivery's day are what we asked: never overwritten by an answer.
 *   confirmed   the supplier's day: a line's comes with the supplier's confirmation (link, portal, or the buyer accepting
 *               its changes); a delivery's comes with it when the line is confirmed as asked (each delivery on its own
 *               day), or the buyer records the day the supplier gave (once, while the order is SENT, CHANGES_PROPOSED or
 *               CONFIRMED).
 *   moved       once set, a confirmed day moves only with a row of the date history (PoDateChange: from which day to
 *               which, the supplier's word or the buyer's, when, why, the supplier's person who said so), while the order
 *               is open (SENT, CHANGES_PROPOSED, CONFIRMED, PARTLY_RECEIVED) and the line live. Every change is a row.
 *   follows     a scheduled line's own confirmed day is its earliest delivery's: moving that one moves the line's too, with
 *               a row of its own (the same who, when and why).
 *   late        a confirmed day after the day asked is "confirmed later than needed", by so many days.
 */

export const DATE_SOURCES = ['SUPPLIER', 'BUYER'] as const
export type DateSource = (typeof DATE_SOURCES)[number]
export const MAX_DATE_REASON = 2000
export const MAX_CONTACT_NAME = 200

const OPEN: readonly PurchaseOrderStatus[] = ['SENT', 'CHANGES_PROPOSED', 'CONFIRMED', 'PARTLY_RECEIVED']
const ANSWERED: readonly PurchaseOrderStatus[] = ['SENT', 'CHANGES_PROPOSED', 'CONFIRMED']

/** Why a confirmed day of this order cannot be moved now, or null. */
export function moveDateProblem(status: PurchaseOrderStatus): string | null {
  if (OPEN.includes(status)) return null
  if (status === 'DRAFT' || status === 'PENDING_APPROVAL') return `The order is ${STATUS_WORDS[status]}: the supplier has confirmed nothing yet. Change the days asked instead.`
  return `The order is ${STATUS_WORDS[status]}: its confirmed days move no more.`
}

/** Why the supplier's first day for a delivery cannot be recorded now, or null. */
export function firstDateProblem(status: PurchaseOrderStatus): string | null {
  if (ANSWERED.includes(status)) return null
  if (status === 'DRAFT' || status === 'PENDING_APPROVAL') return `The order is ${STATUS_WORDS[status]}: the supplier answers it once it is sent.`
  return `The order is ${STATUS_WORDS[status]}: a delivery's first confirmed day is recorded while the supplier answers it (sent, changes proposed or confirmed).`
}

export interface DateChangeInput {
  readonly toDate: string
  readonly source: DateSource
  readonly reason?: string | null | undefined
  readonly supplierContactName?: string | null | undefined
  readonly changedAt: Date
}

const blank = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

/** What is wrong with a move of a confirmed day from `fromDate`, said `changedAt` (not after `now`); none: it can go. */
export function dateChangeProblems(fromDate: string, input: DateChangeInput, now: Date): Issue[] {
  const problems: Issue[] = []
  if (!isBusinessDate(input.toDate)) problems.push({ path: 'body/date', message: 'A day (YYYY-MM-DD).' })
  else if (input.toDate === fromDate) problems.push({ path: 'body/date', message: `The confirmed day is already ${fromDate}.` })
  const reason = blank(input.reason)
  if (reason === null) problems.push({ path: 'body/reason', message: 'Say why the day moves (the supplier’s reason or yours).' })
  else if (reason.length > MAX_DATE_REASON || reason.includes('\u0000')) problems.push({ path: 'body/reason', message: `At most ${MAX_DATE_REASON} characters.` })
  const contact = blank(input.supplierContactName)
  if (contact !== null && input.source !== 'SUPPLIER') problems.push({ path: 'body/supplierContactName', message: 'Only the supplier’s word names its person.' })
  else if (contact !== null && (contact.length > MAX_CONTACT_NAME || /[\r\n]/.test(contact))) problems.push({ path: 'body/supplierContactName', message: `One line, at most ${MAX_CONTACT_NAME} characters.` })
  if (Number.isNaN(input.changedAt.getTime()) || input.changedAt.getTime() > now.getTime()) problems.push({ path: 'body/changedAt', message: 'When it was said or agreed: now or earlier.' })
  return problems
}

/** Days from the day asked to the confirmed day when it is later (confirmed later than needed), else 0. */
export function daysLater(needDate: string, confirmedDate: string | null): number {
  if (confirmedDate === null || confirmedDate <= needDate) return 0
  return Math.round((Date.parse(`${confirmedDate}T00:00:00Z`) - Date.parse(`${needDate}T00:00:00Z`)) / 86_400_000)
}

/**
 * A scheduled line's own confirmed day after its deliveries' days: the earliest one set, or null while none is. The
 * caller moves the line's day to it (with its own row) when the line has a confirmed day and this differs.
 */
export function lineDateOf(deliveries: readonly { readonly confirmedDate: string | null }[]): string | null {
  return deliveries.flatMap((delivery) => (delivery.confirmedDate ? [delivery.confirmedDate] : [])).sort()[0] ?? null
}

/** The words of one row of the date history (for the record's timeline; the screen may have its own). */
export function dateChangeWords(change: { readonly fromDate: string; readonly toDate: string; readonly source: DateSource; readonly supplierContactName: string | null; readonly reason: string; readonly what: string }): string {
  const who = change.source === 'SUPPLIER' ? `the supplier${change.supplierContactName ? ` (${change.supplierContactName})` : ''}` : 'the buyer'
  const way = change.toDate > change.fromDate ? 'later' : 'earlier'
  return `${change.what}: ${change.fromDate} → ${change.toDate} (${way}), by ${who}: ${change.reason}`
}
