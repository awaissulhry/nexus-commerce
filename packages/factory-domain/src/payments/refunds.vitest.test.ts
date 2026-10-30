import { describe, expect, it } from 'vitest'
import { voidProblems } from './payments'
import { overpaidOf, paidOnProblem, refundableOnCreditNote, refundAmountProblem, refundMoveProblem, releasePlan, suggestOldestFirst, unplacedOf } from './refunds'

/** B-W2a-61 (FIN-127 refunds, FIN-122 one payment to many invoices and the credit balance). Every amount is made up. */

describe('what a credit note may refund (FIN-127)', () => {
  it('a TD01/TD24 gives back what it was paid beyond what it is worth after its credit notes', () => {
    expect(overpaidOf({ docType: 'TD24', grossTotal: 100_000, creditedGross: 30_000, paid: 100_000 })).toBe(30_000)
    expect(overpaidOf({ docType: 'TD01', grossTotal: 100_000, creditedGross: 30_000, paid: 80_000 })).toBe(10_000)
    expect(overpaidOf({ docType: 'TD01', grossTotal: 100_000, creditedGross: 30_000, paid: 50_000 })).toBe(0)
  })

  it('a deposit invoice (TD02, B-W2a-F2 a balance before shipping too) is paid in full: every credit on it is money back', () => {
    expect(overpaidOf({ docType: 'TD02', grossTotal: 61_000, creditedGross: 61_000, paid: 61_000 })).toBe(61_000)
  })

  it('never more than the note has left, nor than its invoice has left after the refunds of all its notes', () => {
    expect(refundableOnCreditNote({ noteGross: 30_000, liveOnNote: 0, overpaid: 30_000, liveOnInvoice: 0 })).toBe(30_000)
    expect(refundableOnCreditNote({ noteGross: 30_000, liveOnNote: 10_000, overpaid: 30_000, liveOnInvoice: 10_000 })).toBe(20_000)
    expect(refundableOnCreditNote({ noteGross: 30_000, liveOnNote: 0, overpaid: 10_000, liveOnInvoice: 0 })).toBe(10_000)
    expect(refundableOnCreditNote({ noteGross: 30_000, liveOnNote: 0, overpaid: 40_000, liveOnInvoice: 35_000 })).toBe(5_000)
  })

  it('refuses in words: nothing left, more than is left, a value date to come', () => {
    expect(refundAmountProblem(100, 0, 'EUR', 'credit note FT-2026-00012')).toBe('Nothing is left to refund on the credit note FT-2026-00012.')
    expect(refundAmountProblem(15_001, 15_000, 'EUR', 'credit note FT-2026-00012')).toBe('The credit note FT-2026-00012 has 150.00 EUR left to refund: refund at most that.')
    expect(refundAmountProblem(15_000, 15_000, 'EUR', 'x')).toBeNull()
    expect(paidOnProblem('2026-11-01', '2026-10-30')).toContain('has not come yet')
    expect(paidOnProblem('2026-10-30', '2026-10-30')).toBeNull()
  })

  it('moves: DUE → PAID | CANCELLED | changed; PAID → VOIDED only; CANCELLED and VOIDED final', () => {
    expect(refundMoveProblem('DUE', 'PAID')).toBeNull()
    expect(refundMoveProblem('DUE', 'CHANGED')).toBeNull()
    expect(refundMoveProblem('DUE', 'VOIDED')).toContain('only a refund recorded as paid by mistake')
    expect(refundMoveProblem('PAID', 'CHANGED')).toContain('never changes')
    expect(refundMoveProblem('PAID', 'VOIDED')).toBeNull()
    expect(refundMoveProblem('CANCELLED', 'PAID')).toContain('never changes again')
    expect(refundMoveProblem('VOIDED', 'VOIDED')).toBe('The refund is voided already.')
  })
})

describe('the credit balance and one payment to many invoices (FIN-122)', () => {
  it('a payment keeps what pays nothing: amount less allocations less live refunds (nothing when voided)', () => {
    expect(unplacedOf({ status: 'RECEIVED', amount: 10_000, allocated: 2_000, refunded: 5_000 })).toBe(3_000)
    expect(unplacedOf({ status: 'VOIDED', amount: 10_000, allocated: 0, refunded: 0 })).toBe(0)
    expect(voidProblems({ status: 'RECEIVED', allocated: 0, refunded: 5_000 })).toEqual(['Part of the payment is refunded or due to be: cancel or void the refund first, then void the payment.'])
  })

  it('"Suggest" fills the open items oldest first; what is left stays on the payment', () => {
    const { suggested, left } = suggestOldestFirst(200_000, [
      { id: 'deposit', open: 30_000 },
      { id: 'ft-1', open: 120_000 },
      { id: 'ft-2', open: 80_000 },
    ])
    expect([...suggested.entries()]).toEqual([
      ['deposit', 30_000],
      ['ft-1', 120_000],
      ['ft-2', 50_000],
    ])
    expect(left).toBe(0)
    expect(suggestOldestFirst(50_000, [{ id: 'ft-1', open: 20_000 }]).left).toBe(30_000)
  })

  it('carrying a credit note\'s excess: the newest allocations first, each reversed whole, the part that fits placed again', () => {
    const plan = releasePlan(
      [
        { id: 'a1', paymentId: 'p1', amount: 60_000 },
        { id: 'a2', paymentId: 'p2', amount: 40_000 },
      ],
      50_000,
    )
    expect(plan).toEqual({
      steps: [
        { allocationId: 'a2', paymentId: 'p2', reversed: 40_000, placedAgain: 0 },
        { allocationId: 'a1', paymentId: 'p1', reversed: 60_000, placedAgain: 50_000 },
      ],
      released: 50_000,
    })
    expect(releasePlan([{ id: 'a1', paymentId: 'p1', amount: 10_000 }], 25_000).released).toBe(10_000)
  })
})
