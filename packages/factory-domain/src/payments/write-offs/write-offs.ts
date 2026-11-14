import type { MinorUnits } from '../../core/money'

/**
 * Writing off a small difference (B-W2b-393; FIN-119; design finance.payments rec allocation "small difference →
 * write-off within tolerance"), pure. A customer who paid a few cents less closes what the payment left open on ONE
 * invoice (UNDERPAYMENT, on the allocation that short-pays it); one who paid a little more keeps the payment's leftover
 * out of the credit balance (OVERPAYMENT). Never more than the company's write-off tolerance in force (the receivables
 * settings: the company's row, else the tenant-wide one; none set = nothing is written off), always the WHOLE difference,
 * with a reason (rounding, the bank's charges, or another one in words). A wrong one is taken back by a reversal (the
 * ledger is append-only, a note says why). The …_bank_bridge_w2b_guards trigger holds every rule for every login.
 */

export const WRITE_OFF_KINDS = ['UNDERPAYMENT', 'OVERPAYMENT'] as const
export type WriteOffKind = (typeof WRITE_OFF_KINDS)[number]

export const WRITE_OFF_REASONS = ['ROUNDING', 'BANK_CHARGES', 'OTHER'] as const
export type WriteOffReason = (typeof WRITE_OFF_REASONS)[number]

export const WRITE_OFF_REASON_WORDS: Readonly<Record<WriteOffReason, string>> = Object.freeze({
  ROUNDING: 'rounding',
  BANK_CHARGES: "the bank's charges",
  OTHER: 'another reason',
})

export const WRITE_OFF_KIND_WORDS: Readonly<Record<WriteOffKind, string>> = Object.freeze({
  UNDERPAYMENT: 'paid a little less',
  OVERPAYMENT: 'paid a little more',
})

/** Why a difference is not written off, by code (the API's issue `writeOff/<CODE>`). */
export const WRITE_OFF_REFUSALS = ['NO_TOLERANCE', 'OVER_TOLERANCE', 'NOTHING_LEFT', 'SHORT_ON_SEVERAL', 'SHORT_ON_DEPOSIT', 'NOTE_NEEDED', 'NOT_RECEIVED', 'NOT_AN_INVOICE_ALLOCATION', 'REVERSED_ALREADY', 'A_REVERSAL'] as const
export type WriteOffRefusal = (typeof WRITE_OFF_REFUSALS)[number]

export const WRITE_OFF_REFUSAL_WORDS: Readonly<Record<WriteOffRefusal, string>> = Object.freeze({
  NO_TOLERANCE: "The company has no write-off tolerance set (the accountant's, in the receivables settings): nothing is written off.",
  OVER_TOLERANCE: "The difference is more than the company's write-off tolerance: place it, refund it or ask the customer.",
  NOTHING_LEFT: 'There is no difference left to write off.',
  SHORT_ON_SEVERAL: 'More than one item is left short: a write-off closes what is left on one invoice.',
  SHORT_ON_DEPOSIT: 'A deposit request is left short: a deposit is paid in full, never written off.',
  NOTE_NEEDED: "Say in a note why it is written off (needed for 'another reason' and on a reversal).",
  NOT_RECEIVED: 'The payment is voided: nothing is written off on it.',
  NOT_AN_INVOICE_ALLOCATION: 'Name an allocation of this payment to an invoice that is not taken back.',
  REVERSED_ALREADY: 'This write-off is taken back already.',
  A_REVERSAL: 'This row takes a write-off back itself; it is not taken back.',
})

/** The most a note says. */
export const MAX_WRITE_OFF_NOTE = 500

/** Why this write-off cannot be written (null: it can): the tolerance, the difference, the note. */
export function writeOffProblem(input: { readonly amount: MinorUnits; readonly tolerance: MinorUnits | null; readonly reason: WriteOffReason; readonly note: string | null }): WriteOffRefusal | null {
  if (input.tolerance === null) return 'NO_TOLERANCE'
  if (input.amount <= 0) return 'NOTHING_LEFT'
  if (input.amount > input.tolerance) return 'OVER_TOLERANCE'
  if (input.reason === 'OTHER' && input.note === null) return 'NOTE_NEEDED'
  return null
}

/** A note as kept: trimmed, null when blank; refused when too long (the caller says so). */
export function noteOf(value: string | null | undefined): string | null {
  const text = (value ?? '').trim()
  return text === '' ? null : text
}
