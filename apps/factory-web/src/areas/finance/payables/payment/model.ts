import type { Proposal, ProposalLine, ProposalRow } from '../proposal/api'

/**
 * The supplier invoice's payment batch without a screen (B-W2b-425): which proposals to look in, and the line of this
 * invoice. No read answers "the proposal of an invoice" (B-W2b-403's gap): the newest proposals that are not cancelled are
 * read, at most PAYMENT_LOOK_BACK. Pure: the tests hold it.
 */

export const PAYMENT_LOOK_BACK = 8

/** The proposals to read for one invoice: newest week first, cancelled ones left out, at most PAYMENT_LOOK_BACK. */
export function proposalsToRead(rows: readonly ProposalRow[]): { ids: string[]; more: boolean } {
  const live = rows.filter((row) => row.status !== 'CANCELLED')
  return { ids: live.slice(0, PAYMENT_LOOK_BACK).map((row) => row.id), more: live.length > PAYMENT_LOOK_BACK }
}

export interface InvoiceBatch {
  proposal: Pick<Proposal, 'id' | 'week' | 'weekStart' | 'weekEnd' | 'status' | 'paidAt' | 'currency'>
  line: ProposalLine
}

/** The first proposal (newest first) with a line of this invoice. */
export function batchOf(proposals: readonly Proposal[], invoiceId: string): InvoiceBatch | null {
  for (const proposal of proposals) {
    const line = proposal.lines.find((entry) => entry.invoice?.id === invoiceId)
    if (line) return { proposal: { id: proposal.id, week: proposal.week, weekStart: proposal.weekStart, weekEnd: proposal.weekEnd, status: proposal.status, paidAt: proposal.paidAt, currency: proposal.currency }, line }
  }
  return null
}

/** A proposal or a supplier invoice that moves reads it again. */
export const batchTouched = (change: { type: string }): boolean => change.type === 'payment_proposal.changed' || change.type.startsWith('supplier_invoice.')
