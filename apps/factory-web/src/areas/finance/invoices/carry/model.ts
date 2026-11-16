import type { Phrase } from '../../_shared/model'
import type { CarryPreview } from './api'

/**
 * B-W2b-GB02 (G088): the deposits waiting to be carried onto an invoice, pure. The payments' open items name, per invoice
 * of an order, the deposit requests whose money paid without a deposit invoice still waits (`depositToCarry`); each is
 * previewed (what the carry would do) before a person carries it onto this invoice.
 */

export interface DepositToCarry {
  readonly depositRequestId: string
  /** Minor units (absent without the price grain). */
  readonly amount?: number
  /** What the carry would do now; null while read; a problem in words when it cannot be carried. */
  readonly preview: CarryPreview | null
}

/** The deposits the open items say wait for this invoice (none: nothing is drawn). */
export function depositsOf(items: readonly { readonly id: string; readonly depositToCarry?: readonly { readonly depositRequestId: string; readonly amount?: number }[] | undefined }[], invoiceId: string): { depositRequestId: string; amount?: number }[] {
  const item = items.find((entry) => entry.id === invoiceId)
  return (item?.depositToCarry ?? []).map((entry) => (entry.amount === undefined ? { depositRequestId: entry.depositRequestId } : { depositRequestId: entry.depositRequestId, amount: entry.amount }))
}

/** Why "Carry onto this invoice" is held, or null. */
export function carryHeld(input: { readonly mayRecord: boolean; readonly busy: boolean; readonly preview: CarryPreview | null }): Phrase | null {
  if (!input.mayRecord) return { key: 'held.noRecord' }
  if (input.busy) return { key: 'held.busy' }
  if (input.preview === null) return { key: 'held.reading' }
  if (input.preview.problem) return { key: 'held.cannot' }
  return null
}
