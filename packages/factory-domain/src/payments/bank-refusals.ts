/**
 * The money rules the database holds since W2b-6 schema wave 50/57 (factory-db …_bank_bridge_w2b_guards, B-W2b-370; FIN-112,
 * FIN-119, FIN-154) that W1 and W2a routes can reach, read back from the database's own words, pure: a small difference
 * written off (PaymentWriteOff) counts in what a payment has placed and what an invoice is open for, an allocation or a
 * payment with a write-off still standing is not reversed or voided before it, a reminder is not approved or sent while a
 * stop holds on one of its invoices, and an accounting export hands a document over once (a re-export carries only the
 * changes). The commands of B-W2b-393, -402 and -408 check these first in words; when a write reaches the rule without that
 * check (W1's payments, W2a's refunds, reminders and exports), the API answers 409 in these words instead of a 500
 * (apps/factory-api core/errors).
 */

/** The issue paths of the refusals. */
export const BANK_REFUSAL_ISSUES = Object.freeze({
  standing: 'payments/WRITE_OFF_STANDING',
  writtenOff: 'payments/WRITTEN_OFF',
  stopped: 'receivables/REMINDER_STOPPED',
  handedOver: 'accounting/DOCUMENT_HANDED_OVER',
} as const)

/** The words of a reminder stop's reason code (ReminderStopReason). */
export const REMINDER_STOP_REASON_WORDS: Readonly<Record<string, string>> = Object.freeze({
  PAYMENT_PROCESSING: 'a payment is being processed',
  DISPUTE: 'a dispute is open',
  PROMISE_TO_PAY: 'the customer promised to pay',
  CREDIT_PENDING: 'a credit note is pending',
})

const ALLOCATION_STANDING = /^payments: allocation \S+ has a write-off still standing/
const PAYMENT_STANDING = /^payments: payment \S+ has a write-off still standing/
const WRITTEN_OFF = /^(payments: (payment \S+ of \S+ has \S+ allocated; \S+ more passes it \(.*, \S+ written off\)|invoice \S+ is open for \S+ \(gross \S+, credited \S+, paid \S+, written off \S+\); \S+ more passes it)|refunds: payment \S+ of \S+ has \S+ allocated, \S+ refunded or due and \S+ written off;)/
const STOPPED = /^receivables: reminder \S+ covers invoice \S+, whose reminders are stopped \(([A-Z_]+)\)/
const HANDED_OVER = /^accounting: export \S+ hands over /

/** The words and issue path of a refusal of the database's bank and bridge rules, or null when the message is another one. */
export function databaseBankRefusal(message: string): { readonly path: string; readonly message: string } | null {
  if (ALLOCATION_STANDING.test(message)) {
    return { path: BANK_REFUSAL_ISSUES.standing, message: 'A small difference was written off on this allocation: reverse the write-off first, then the allocation.' }
  }
  if (PAYMENT_STANDING.test(message)) {
    return { path: BANK_REFUSAL_ISSUES.standing, message: 'A small difference of this payment was written off: reverse the write-off first, then void the payment.' }
  }
  if (WRITTEN_OFF.test(message)) {
    return { path: BANK_REFUSAL_ISSUES.writtenOff, message: 'Part of this money is written off as a small difference, so less is left to place or refund than it seems.' }
  }
  const stopped = STOPPED.exec(message)
  if (stopped) {
    const reason = REMINDER_STOP_REASON_WORDS[stopped[1] as string] ?? 'a stop holds'
    return { path: BANK_REFUSAL_ISSUES.stopped, message: `This reminder covers an invoice whose reminders are stopped (${reason}): it is not approved or sent while the stop holds.` }
  }
  if (HANDED_OVER.test(message)) {
    return { path: BANK_REFUSAL_ISSUES.handedOver, message: 'This export would hand a document over twice: a re-export carries only the documents that changed.' }
  }
  return null
}
