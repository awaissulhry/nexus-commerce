import { money, parseAmount, type Phrase, type Tone } from '../../_shared/model'
import type { Locale } from '../../../../lib/i18n/locales'
import type { OpenRefunds, Refund, RefundStatus, ToRefund } from './api'

/**
 * Refunds and the credit balance, pure (B-W2a-80; design finance.payments): who may (payments.refund records and moves a
 * refund, payments.void voids a paid one), the tile "Refunds to make", the rows of Payments › Rows ▾ Refunds (what is to
 * refund: credit notes with money left, and the refunds), the Refund dialog's rules (the credit note it settles or a
 * payment's credit balance; the amount capped at what is still refundable; paid now with a value date and the bank's
 * reference, or to make by a day; bank transfer only), the moves held with why, and the CSV. Words: `finance-daily`.
 */

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

export interface RefundAbilities {
  view: boolean
  refund: boolean
  void: boolean
  price: boolean
}

export const refundAbilitiesOf = (permissions: readonly string[]): RefundAbilities => {
  const held = new Set(permissions)
  return { view: held.has('payments.view'), refund: held.has('payments.refund'), void: held.has('payments.void'), price: held.has('money.price') }
}

export const REFUND_TONE: Record<RefundStatus, Tone> = { DUE: 'warning', PAID: 'success', CANCELLED: 'neutral', VOIDED: 'neutral' }

/** The tile: refunds due plus credit notes with money left to refund (unknown: "—"). */
export function refundsTile(open: OpenRefunds | null): { value: string; hint: Phrase | null } {
  if (!open) return { value: '—', hint: null }
  const { refundsDue, creditNotesToRefund } = open.counts
  const total = refundsDue + creditNotesToRefund
  if (total === 0) return { value: '0', hint: null }
  return { value: String(total), hint: phrase('refunds.tileHint', { due: refundsDue, notes: creditNotesToRefund }) }
}

/** The views of Payments › Refunds: what is to refund now (the tile's), then the API's own. */
export const REFUND_ROWS = ['open', 'due', 'paid', 'closed', 'all'] as const
export type RefundRows = (typeof REFUND_ROWS)[number]
export const refundRowsOf = (value: string | null | undefined): RefundRows => ((REFUND_ROWS as readonly string[]).includes(value ?? '') ? (value as RefundRows) : 'open')

/** One row of the refunds list: a credit note with money left to refund, or a refund. */
export type RefundRow = { kind: 'toRefund'; id: string; note: ToRefund } | { kind: 'refund'; id: string; refund: Refund }

export function refundRowsFrom(rows: RefundRows, open: OpenRefunds | null, refunds: readonly Refund[] | null): RefundRow[] | null {
  if (rows === 'open') {
    if (!open) return null
    return [...open.creditNotesToRefund.map((note) => ({ kind: 'toRefund' as const, id: `note-${note.creditNoteId}`, note })), ...open.refundsDue.map((refund) => ({ kind: 'refund' as const, id: refund.id, refund }))]
  }
  return refunds ? refunds.map((refund) => ({ kind: 'refund' as const, id: refund.id, refund })) : null
}

/** What a refund settles: a credit note of an invoice, or a payment's credit balance. */
export function settlesWords(refund: Pick<Refund, 'source' | 'creditNote' | 'payment'>): Phrase {
  if (refund.source === 'CREDIT_NOTE' && refund.creditNote) return phrase('refunds.ofNote', { number: refund.creditNote.number ?? '—', invoice: refund.creditNote.creditOfNumber ?? '—' })
  if (refund.payment) return phrase('refunds.ofPayment', { reference: refund.payment.externalRef })
  return phrase('refunds.ofUnknown')
}

// ---- the Refund dialog -----------------------------------------------------------------------------------------------------

/** What the dialog refunds: a credit note (its money left to refund) or a payment's credit balance (what is not placed). */
export type RefundTarget =
  | { kind: 'creditNote'; creditNoteId: string; label: string; partyName: string; currency: string; cap: number | null }
  | { kind: 'payment'; paymentId: string; label: string; partyName: string; currency: string; cap: number | null }

export const targetOfNote = (note: ToRefund): RefundTarget => ({ kind: 'creditNote', creditNoteId: note.creditNoteId, label: note.number ?? '—', partyName: note.party.legalName, currency: note.currency, cap: note.refundableAmount ?? null })

export interface RefundDraft {
  /** The amount as typed (empty: all that is refundable). */
  amount: string
  /** Paid now (a value date and the bank's reference) or to make by a day. */
  when: 'now' | 'later'
  paidOn: string
  reference: string
  dueDate: string
  note: string
}

export const emptyRefund = (today: string): RefundDraft => ({ amount: '', when: 'now', paidOn: today, reference: '', dueDate: today, note: '' })

/** The dialog's problems as message keys (by field). */
export function refundProblems(target: RefundTarget | null, draft: RefundDraft, today: string): { target?: string; amount?: string; paidOn?: string; reference?: string; dueDate?: string } {
  const problems: { target?: string; amount?: string; paidOn?: string; reference?: string; dueDate?: string } = {}
  if (!target) problems.target = 'refund.problem.target'
  else if (target.cap !== null && target.cap <= 0) problems.target = 'refund.problem.nothing'
  if (draft.amount.trim() !== '') {
    const amount = parseAmount(draft.amount)
    if (amount === null) problems.amount = 'refund.problem.amount'
    else if (target && target.cap !== null && amount > target.cap) problems.amount = 'refund.problem.over'
  }
  if (draft.when === 'now') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.paidOn)) problems.paidOn = 'refund.problem.date'
    else if (draft.paidOn > today) problems.paidOn = 'refund.problem.future'
    const reference = draft.reference.trim()
    if (reference === '') problems.reference = 'refund.problem.reference'
    else if (reference.length > 200) problems.reference = 'refund.problem.referenceLong'
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.dueDate)) problems.dueDate = 'refund.problem.date'
  return problems
}

/** The amount the dialog refunds (minor units): the typed one, else everything refundable; null when unknown. */
export function refundAmountOf(target: RefundTarget | null, draft: RefundDraft): number | null {
  if (draft.amount.trim() !== '') return parseAmount(draft.amount)
  return target?.cap ?? null
}

/** The body the API takes. */
export function refundAskOf(target: RefundTarget, draft: RefundDraft) {
  const amount = draft.amount.trim() === '' ? undefined : (parseAmount(draft.amount) ?? undefined)
  return {
    ...(target.kind === 'creditNote' ? { creditNoteId: target.creditNoteId } : { paymentId: target.paymentId }),
    ...(amount !== undefined ? { amount } : {}),
    ...(draft.note.trim() ? { internalNote: draft.note.trim() } : {}),
    ...(draft.when === 'now' ? { paid: { paidOn: draft.paidOn, externalRef: draft.reference.trim() } } : { dueDate: draft.dueDate }),
  }
}

/** The dialog's primary in words ("Refund 150.00"), with the amount when it is known. */
export function refundGoWords(target: RefundTarget | null, draft: RefundDraft, locale: Locale): Phrase {
  const amount = refundAmountOf(target, draft)
  if (amount === null || !target) return phrase(draft.when === 'now' ? 'refund.goPlain' : 'refund.goLaterPlain')
  return phrase(draft.when === 'now' ? 'refund.go' : 'refund.goLater', { amount: money(amount, target.currency, locale) })
}

/** Why the band's Refund (and a credit note's) waits, or null. */
export function refundHeld(can: RefundAbilities, offline = false): Phrase | null {
  if (!can.refund) return phrase('refund.held.noRight')
  if (!can.price) return phrase('refund.held.noPrice')
  if (offline) return phrase('refund.held.offline')
  return null
}

// ---- moves of a refund ------------------------------------------------------------------------------------------------------

export type RefundMove = 'paid' | 'cancel' | 'void'

/** Why a move of a refund waits, or null (DUE: made or cancelled; PAID: voided by payments.void). */
export function moveHeld(refund: Pick<Refund, 'status'>, move: RefundMove, can: RefundAbilities): Phrase | null {
  if (move === 'void') {
    if (!can.void) return phrase('refunds.held.noVoid')
    return refund.status === 'PAID' ? null : phrase('refunds.held.voidNotPaid')
  }
  if (!can.refund) return phrase('refund.held.noRight')
  return refund.status === 'DUE' ? null : phrase('refunds.held.notDue')
}

/** A move's problems (message keys by field): a value date not in the future and a reference; a reason of 3 to 500. */
export function moveProblems(move: RefundMove, input: { paidOn: string; reference: string; reason: string }, today: string): { paidOn?: string; reference?: string; reason?: string } {
  const problems: { paidOn?: string; reference?: string; reason?: string } = {}
  if (move === 'paid') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paidOn)) problems.paidOn = 'refund.problem.date'
    else if (input.paidOn > today) problems.paidOn = 'refund.problem.future'
    if (input.reference.trim() === '') problems.reference = 'refund.problem.reference'
  } else if (input.reason.trim().length < 3) problems.reason = 'refunds.problem.reason'
  else if (input.reason.trim().length > 500) problems.reason = 'refunds.problem.reasonLong'
  return problems
}

/** A live event that changes the refunds or the tile: a refund moved, a payment's balance released, a credit note issued. */
export const refundsTouched = (change: { type: string }): boolean => change.type.startsWith('refund.') || change.type === 'payment.overpayment_released' || change.type.startsWith('invoice.') || change.type.startsWith('payment.')

// ---- CSV ---------------------------------------------------------------------------------------------------------------------

const cell = (value: string | number | null | undefined): string => {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",;\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** The selected rows as CSV (amounts only with the price grain). */
export function refundsCsv(rows: readonly RefundRow[], price: boolean, words: { header: (key: string) => string; state: (row: RefundRow) => string; settles: (row: RefundRow) => string }, locale: Locale): string {
  const columns = ['customer', 'settles', 'state', 'due', 'paidOn', 'reference', ...(price ? ['amount'] : [])]
  const lines = [columns.map((column) => cell(words.header(column))).join(',')]
  for (const row of rows) {
    const refund = row.kind === 'refund' ? row.refund : null
    const amount = row.kind === 'refund' ? money(row.refund.amount, row.refund.currency, locale) : money(row.note.refundableAmount, row.note.currency, locale)
    lines.push([row.kind === 'refund' ? row.refund.party.legalName : row.note.party.legalName, words.settles(row), words.state(row), refund?.dueDate ?? '', refund?.paidOn ?? '', refund?.externalRef ?? '', ...(price ? [amount] : [])].map(cell).join(','))
  }
  return `${lines.join('\n')}\n`
}
