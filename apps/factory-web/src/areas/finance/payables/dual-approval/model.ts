import type { InvoiceDual } from './api'

/**
 * Dual approval's words without a screen (B-W2b-425): which sentence says where the invoice stands. Pure: the tests hold it.
 *   under       one person approves (the total is not above the amount)
 *   both        above the amount, no yes yet: two people approve
 *   second      a first yes stands: a second person approves now (`mine`: it was this person's)
 *   lapsed      a first yes lapsed (the invoice changed after it): the next yes is a first again
 */
export type DualState = 'under' | 'both' | 'second' | 'secondMine' | 'lapsed'

export function dualState(dual: InvoiceDual, me: string | null): DualState {
  if (!dual.needed) return 'under'
  if (dual.first?.standing) return dual.first.by.id === me || dual.held === 'SECOND_APPROVER' ? 'secondMine' : 'second'
  return dual.first ? 'lapsed' : 'both'
}

export const DUAL_TONE: Record<DualState, 'neutral' | 'info' | 'warning'> = { under: 'neutral', both: 'info', second: 'info', secondMine: 'warning', lapsed: 'warning' }

/** A supplier invoice that moves (a first yes, an approval, a line) reads it again. */
export const dualTouched = (change: { type: string }): boolean => change.type.startsWith('supplier_invoice.')
