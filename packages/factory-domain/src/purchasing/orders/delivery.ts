import { addDays } from '../../planning/buy'
import type { BusinessDate } from '../../core/time'
import { formatDate, formatDateTime } from '../../documents/format'
import type { DocumentLanguage } from '../../documents/model'

/**
 * When the supplier answers and when the goods come (B-W2a-52; SCM-087 "Confirmation deadline and reminders", SCM-067
 * "Expected deliveries view"; design purchasing.orders tiles "Due this week", "Late", Rows "Expected this week · Late",
 * the send dialog's "Confirm by (default 48 h; reminder and buyer alert after)", record › Sends "Reminders sent"), pure.
 *
 *   confirm by   set at the send: 48 hours later by default, longer by the supplier's closed days in between (its
 *                calendar, platform/calendars); the office may move it while the order waits. After it, the buyer is
 *                alerted by the exception rule PO_NOT_CONFIRMED (platform/alerts: this module raises no alert of its own)
 *                and a reminder may go to the supplier.
 *   reminders    to a SENT order only, for its current revision: by the buyer at any time while it waits, or by the daily
 *                run when the company switched automatic reminders on (off by default: the Owner's switch; until a
 *                setting exists it stays off in code). The daily run sends the first after the deadline, then one a day,
 *                at most REMINDERS.most per revision; a reminder by hand counts too.
 *   expected     an open line (not ended, not received in full) of a sent order is expected on its confirmed date, else
 *                its need date: LATE before today, THIS_WEEK from today to Sunday, later LATER.
 */

const HOUR = 60 * 60 * 1000

// ---- confirm by -----------------------------------------------------------------------------------------------------------

/** The default deadline: two days (48 hours) after the send. */
export const CONFIRM_DAYS = 2
/** The latest deadline the office may set: the link's life is at most 60 days. */
export const MAX_CONFIRM_DAYS = 60

/**
 * The default confirm-by instant: the send time plus the calendar days from the send day to the day two of the
 * supplier's open days later (`arrivalDay`, from platform/calendars arrivalDate; null: no calendar, two days).
 */
export function defaultConfirmBy(sentAt: Date, sendDay: BusinessDate, arrivalDay: BusinessDate | null): Date {
  const days = arrivalDay === null ? CONFIRM_DAYS : Math.max(CONFIRM_DAYS, dayDistance(sendDay, arrivalDay))
  return new Date(sentAt.getTime() + days * 24 * HOUR)
}

const dayNumber = (date: BusinessDate): number => {
  const [year, month, day] = date.split('-').map((part) => Number.parseInt(part, 10)) as [number, number, number]
  return Date.UTC(year, month - 1, day) / 86_400_000
}
export const dayDistance = (from: BusinessDate, to: BusinessDate): number => dayNumber(to) - dayNumber(from)

/** Why a confirm-by time given by the office is refused (at the send, or when it moves it), or null. */
export function confirmByProblem(confirmBy: Date, facts: { readonly now: Date; readonly sentAt: Date | null; readonly linkExpiresAt: Date | null }): string | null {
  if (confirmBy.getTime() <= facts.now.getTime()) return 'The supplier is asked to answer by a time still to come.'
  if (facts.sentAt && confirmBy.getTime() <= facts.sentAt.getTime()) return 'The supplier is asked to answer after the order was sent.'
  if (confirmBy.getTime() > facts.now.getTime() + MAX_CONFIRM_DAYS * 24 * HOUR) return `Ask for an answer within ${MAX_CONFIRM_DAYS} days.`
  if (facts.linkExpiresAt && confirmBy.getTime() > facts.linkExpiresAt.getTime()) return 'The confirm link stops working before then: ask for an answer while it works, or send a new link first.'
  return null
}

/** The deadline can be moved only while the order waits for the supplier's answer. */
export function moveConfirmByProblem(status: string): string | null {
  if (status === 'SENT') return null
  if (status === 'DRAFT') return 'The order is not sent yet: its confirm-by time is set when you send it.'
  return 'The order waits for no answer: it has no confirm-by time to move.'
}

// ---- reminders -------------------------------------------------------------------------------------------------------------

/** The daily run: the first reminder after the deadline, then one a day, at most three per revision. */
export const REMINDERS = Object.freeze({ everyHours: 24, most: 3 })

export interface ReminderFacts {
  readonly status: string
  readonly revision: number
  readonly confirmBy: Date | null
  /** The reminders of the order's current revision (by hand or automatic), any order. */
  readonly reminders: readonly { readonly sentAt: Date }[]
}

export interface ReminderState {
  /** The order waits for its answer and its deadline passed. */
  readonly overdue: boolean
  /** The daily run would send one now (overdue, fewer than the most, the last one a day ago or more). */
  readonly due: boolean
  readonly sent: number
  readonly lastAt: Date | null
  /** When the daily run would send the next one; null: none will (not waiting, or the most were sent). */
  readonly nextAt: Date | null
}

export function reminderState(facts: ReminderFacts, now: Date): ReminderState {
  const sorted = [...facts.reminders].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())
  const last = sorted.at(-1)?.sentAt ?? null
  const waiting = facts.status === 'SENT' && facts.confirmBy !== null
  const overdue = waiting && facts.confirmBy!.getTime() <= now.getTime()
  if (!waiting || sorted.length >= REMINDERS.most) return { overdue, due: false, sent: sorted.length, lastAt: last, nextAt: null }
  const after = last === null ? facts.confirmBy!.getTime() : Math.max(facts.confirmBy!.getTime(), last.getTime() + REMINDERS.everyHours * HOUR)
  return { overdue, due: overdue && after <= now.getTime(), sent: sorted.length, lastAt: last, nextAt: new Date(after) }
}

/** A reminder goes only to an order waiting for its supplier's answer (the …_supply_w2a_guards trigger too). */
export function remindProblem(status: string): string | null {
  if (status === 'SENT') return null
  if (status === 'DRAFT') return 'The order is not sent yet: send it.'
  if (status === 'CHANGES_PROPOSED') return "The supplier answered with changes: accept or refuse them; a reminder is for an order still waiting."
  return 'The supplier answered this order already: it waits for no confirmation.'
}

/**
 * The Owner's switch for automatic reminders per company (W2a plan §2 "Owner switch"): OFF by default and until a
 * setting holds it (no column in schema wave 3: the daily run sends nothing to any supplier). One function, so the
 * setting replaces it in one place.
 */
export const AUTOMATIC_REMINDERS_DEFAULT = false

const MAIL = {
  it: {
    subject: (number: string) => `Promemoria: conferma dell'ordine di acquisto ${number}`,
    hello: (name: string | null) => (name ? `Gentile ${name},` : 'Buongiorno,'),
    body: (number: string, sent: string, by: string) => `le ricordiamo il nostro ordine di acquisto ${number}, inviato il ${sent}: le avevamo chiesto di confermarlo entro ${by}. Il documento è di nuovo in allegato.`,
    link: "Per confermarlo, proporre altre quantità o date, o rifiutarlo, usi il link personale dell'e-mail con cui le abbiamo inviato l'ordine. Se non lo trova più, risponda a questa e-mail: gliene invieremo uno nuovo.",
  },
  en: {
    subject: (number: string) => `Reminder: please confirm purchase order ${number}`,
    hello: (name: string | null) => (name ? `Dear ${name},` : 'Hello,'),
    body: (number: string, sent: string, by: string) => `a reminder of our purchase order ${number}, sent on ${sent}: we asked you to confirm it by ${by}. The document is attached again.`,
    link: 'To confirm it, propose other quantities or dates, or decline it, use the personal link in the e-mail that brought you the order. If you cannot find it, reply to this e-mail and we will send a new one.',
  },
} as const

/** The reminder (no link in it: the link of the send is a bearer token kept nowhere; a reply gets a new one). */
export function confirmationReminderMail(input: { readonly language: DocumentLanguage; readonly number: string; readonly recipientName: string | null; readonly sentOn: BusinessDate; readonly confirmBy: Date; readonly timeZone: string; readonly message: string | null }): { readonly subject: string; readonly body: string } {
  const words = MAIL[input.language]
  const body = [
    words.hello(input.recipientName),
    words.body(input.number, formatDate(input.sentOn, input.language), formatDateTime(input.confirmBy, input.timeZone, input.language)),
    ...(input.message?.trim() ? [input.message.trim()] : []),
    words.link,
  ].join('\n\n')
  return { subject: words.subject(input.number), body }
}

// ---- expected deliveries -----------------------------------------------------------------------------------------------------

export const DELIVERY_STATES = ['LATE', 'THIS_WEEK', 'LATER'] as const
export type DeliveryState = (typeof DELIVERY_STATES)[number]

/** The Sunday that ends the week of `today` (weeks start on Monday). */
export function weekEndOf(today: BusinessDate): BusinessDate {
  const [year, month, day] = today.split('-').map((part) => Number.parseInt(part, 10)) as [number, number, number]
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay() // 0 Sunday … 6 Saturday
  return addDays(today, weekday === 0 ? 0 : 7 - weekday)
}

/** The day a line is expected: the supplier's confirmed date, else the day it is needed. */
export const expectedDateOf = (line: { readonly confirmedDate: BusinessDate | null; readonly needDate: BusinessDate }): BusinessDate => line.confirmedDate ?? line.needDate

export function deliveryStateOf(expected: BusinessDate, today: BusinessDate): DeliveryState {
  if (expected < today) return 'LATE'
  return expected <= weekEndOf(today) ? 'THIS_WEEK' : 'LATER'
}

/** How many calendar days late an expected line is (0 when it is not late). */
export const daysLate = (expected: BusinessDate, today: BusinessDate): number => Math.max(0, dayDistance(expected, today))

/** The order states whose open lines are expected (sent, answered or partly received). */
export const EXPECTING_STATUSES = ['SENT', 'CONFIRMED', 'CHANGES_PROPOSED', 'PARTLY_RECEIVED'] as const
