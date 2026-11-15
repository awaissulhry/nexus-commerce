import { scoped, type Phrase } from '../riba/depth'
import { MAX_WRITE_OFF_NOTE, type PaymentWriteOffs, type PossibleWriteOff, type Unapplied, type WriteOff, type WriteOffReason } from './api'

/**
 * The write-off and the money not placed, without a screen (B-W2b-425): who may write off, why a difference waits (over
 * the tolerance, none set, voided), the reason and its note, a take-back's note, and the tile. Every phrase is a key of
 * this step's catalogue for a `finance`-scoped translator. Pure: the tests hold it.
 */

export interface WriteOffCan {
  writeOff: boolean
  price: boolean
}

export const writeOffCanOf = (permissions: readonly string[]): WriteOffCan => ({ writeOff: permissions.includes('payments.writeOff'), price: permissions.includes('money.price') })

/** Why this difference may not be written off by this person now (null: it may). */
export function possibleHeld(possible: PossibleWriteOff, answer: Pick<PaymentWriteOffs, 'tolerance'>, can: WriteOffCan, voided: boolean, busy: boolean): Phrase | null {
  if (!can.writeOff) return { key: scoped('writeOff.held.right') }
  if (voided) return { key: scoped('refusal.writeOff.NOT_RECEIVED') }
  if (answer.tolerance.source === null) return { key: scoped('refusal.writeOff.NO_TOLERANCE') }
  if (!possible.withinTolerance) return { key: scoped('refusal.writeOff.OVER_TOLERANCE') }
  if (busy) return { key: 'common.working' }
  return null
}

/** The write-offs that may be taken back: live ones (not a reversal, not reversed). */
export const reversible = (row: WriteOff): boolean => row.reversalOfId === null && !row.reversed

export function reverseHeld(row: WriteOff, can: WriteOffCan, busy: boolean): Phrase | null {
  if (!can.writeOff) return { key: scoped('writeOff.held.right') }
  if (row.reversed) return { key: scoped('refusal.writeOff.REVERSED_ALREADY') }
  if (row.reversalOfId !== null) return { key: scoped('refusal.writeOff.A_REVERSAL') }
  if (busy) return { key: 'common.working' }
  return null
}

/** Why the write-off dialog's primary waits: 'another reason' needs a note; a note fits. */
export function reasonHeld(reason: WriteOffReason, note: string): Phrase | null {
  if (reason === 'OTHER' && note.trim() === '') return { key: scoped('refusal.writeOff.NOTE_NEEDED') }
  if (note.length > MAX_WRITE_OFF_NOTE) return { key: scoped('writeOff.noteLong'), params: { max: MAX_WRITE_OFF_NOTE } }
  return null
}

/** A take-back always says why. */
export function takeBackHeld(note: string): Phrase | null {
  if (note.trim() === '') return { key: scoped('refusal.writeOff.NOTE_NEEDED') }
  if (note.length > MAX_WRITE_OFF_NOTE) return { key: scoped('writeOff.noteLong'), params: { max: MAX_WRITE_OFF_NOTE } }
  return null
}

/** The tile "Not placed on an invoice": how many payments and the euro amount (null: no grain or another currency only). */
export function notPlacedTile(answer: Unapplied | null): { count: number; amount: number | null; others: number } | null {
  if (!answer) return null
  const euro = answer.totals.amounts.find((entry) => entry.currency === 'EUR')
  return { count: answer.totals.count, amount: euro?.amount ?? (answer.totals.amounts.length === 0 ? 0 : null), others: answer.totals.amounts.filter((entry) => entry.currency !== 'EUR').length }
}

/** A live event that changes what is not placed: a payment moved, a bank line accepted or taken back, a write-off. */
export const unappliedTouched = (change: { type: string }): boolean =>
  change.type.startsWith('payment.') || change.type === 'bank_match.accepted' || change.type === 'bank_match.reversed' || change.type === 'invoice.issued'
