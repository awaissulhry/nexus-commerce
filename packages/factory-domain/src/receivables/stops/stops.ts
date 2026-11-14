import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'

/**
 * Reminder stop rules (B-W2b-402; FIN-112: "no reminder when a payment is recorded or being processed, a dispute is open, a
 * promise to pay exists or a credit note is pending"; design finance.receivables "Held (W2b stop rules): 'payment being
 * processed', 'dispute open', 'promise to pay', 'credit note pending'"), pure.
 *
 * A stop a person records on an invoice (factory-db bank.prisma ReminderStop) holds its reminders while it is in force: not
 * lifted, and its last day (until) today or later or none. A promise to pay names the day promised; once that day passed
 * the promise no longer holds (the reminder may go: the promise was not kept). The database refuses to approve or send a
 * reminder covering an invoice under a stop in force. What the factory knows by itself holds a reminder too, shown the same
 * way (no row): an instalment the bank is collecting by Ri.Ba., a card or SEPA payment in progress, a bank line that
 * surely pays it waiting to be accepted, money on account not placed yet, a credit note being drafted (W2a's).
 */

export const STOP_REASONS = ['PAYMENT_PROCESSING', 'DISPUTE', 'PROMISE_TO_PAY', 'CREDIT_PENDING'] as const
export type StopReason = (typeof STOP_REASONS)[number]

export const STOP_REASON_WORDS: Readonly<Record<StopReason, { readonly en: string; readonly it: string }>> = Object.freeze({
  PAYMENT_PROCESSING: { en: 'Payment being processed', it: 'Pagamento in corso' },
  DISPUTE: { en: 'Dispute open', it: 'Contestazione aperta' },
  PROMISE_TO_PAY: { en: 'Promise to pay', it: 'Promessa di pagamento' },
  CREDIT_PENDING: { en: 'Credit note pending', it: 'Nota di credito in arrivo' },
})

/** The held reason a stop shows on a reminder (receivables/reminders HELD_REASONS). */
export const STOP_HELD = {
  PAYMENT_PROCESSING: 'STOP_PAYMENT_PROCESSING',
  DISPUTE: 'STOP_DISPUTE',
  PROMISE_TO_PAY: 'STOP_PROMISE_TO_PAY',
  CREDIT_PENDING: 'STOP_CREDIT_PENDING',
} as const satisfies Record<StopReason, string>

export const MAX_STOP_TEXT = { note: 2000, liftReason: 500 } as const

export const STOP_STATES = ['holding', 'lifted', 'over', 'all'] as const
export type StopState = (typeof STOP_STATES)[number]

/** Whether a stop holds reminders on `today`. */
export const stopHolds = (stop: { readonly liftedAt: Date | null; readonly until: BusinessDate | null }, today: BusinessDate): boolean => stop.liftedAt === null && (stop.until === null || stop.until >= today)

/** Its state on `today`: in force, lifted by a person, or over (its last day passed). */
export const stopState = (stop: { readonly liftedAt: Date | null; readonly until: BusinessDate | null }, today: BusinessDate): Exclude<StopState, 'all'> => (stop.liftedAt !== null ? 'lifted' : stopHolds(stop, today) ? 'holding' : 'over')

/** The problems of a stop as asked (empty when it may be recorded or changed so). */
export function stopProblems(stop: { readonly reason: StopReason; readonly until: BusinessDate | null; readonly note: string | null }, today: BusinessDate, path = 'body'): Issue[] {
  const problems: Issue[] = []
  if (stop.reason === 'PROMISE_TO_PAY' && stop.until === null) problems.push({ path: `${path}/until`, message: 'A promise to pay names the day the customer promised to pay by.' })
  if (stop.until !== null && stop.until < today) problems.push({ path: `${path}/until`, message: 'The last day it holds is today or later.' })
  if (stop.note !== null && stop.note.length > MAX_STOP_TEXT.note) problems.push({ path: `${path}/note`, message: `A note holds at most ${MAX_STOP_TEXT.note} characters.` })
  return problems
}

export const STOP_REFUSALS = {
  NOT_AN_INVOICE: 'Reminders cover issued invoices (TD01 or TD24): a stop is recorded on one of them.',
  LIFTED: 'This stop was lifted: it never changes. Record a new one if reminders should stop again.',
  OVER: 'This stop is over (its last day passed): record a new one if reminders should stop again.',
  SAME_STOP: 'A stop of this reason is in force on the invoice already: change its last day or note instead.',
} as const
export type StopRefusal = keyof typeof STOP_REFUSALS
