import { describe, expect, it } from 'vitest'
import { carryNote, carryRequestProblem, depositCarryPlan, type CarryRequest } from './deposit-carry'
import { creditReasonOfCausale, defaultRefundReason, REFUND_REASON_WORDS, REFUND_REASONS } from './refunds'

/** B-W2b-21: a deposit paid without a deposit invoice carried onto the order's invoice (Z8:01); why a refund pays back (Z8:02). Made-up figures. */

const paidNone: CarryRequest = { status: 'PAID', fiscalDocument: 'NONE', orderId: 'order-1', orderNumber: 'SO-2026-0007', currency: 'EUR' }

describe('which deposit is carried', () => {
  it('only a PAID deposit of an order that issues no deposit invoice', () => {
    expect(carryRequestProblem(paidNone)).toBeNull()
    expect(carryRequestProblem({ ...paidNone, fiscalDocument: 'TD02' })).toContain('deposit invoice (TD02)')
    expect(carryRequestProblem({ ...paidNone, status: 'OPEN' })).toContain('only a PAID deposit')
    expect(carryRequestProblem({ ...paidNone, orderId: null })).toContain('names no order yet')
  })
})

describe('where each allocation goes', () => {
  const allocations = [
    { id: 'a1', paymentId: 'p1', amount: 30_000 },
    { id: 'a2', paymentId: 'p2', amount: 6_000 },
  ]
  it('an invoice named takes every allocation whole, when it is open for all of it', () => {
    const plan = depositCarryPlan(paidNone, allocations, [{ id: 'i1', number: 'FT-2026-00012', currency: 'EUR', open: 120_000 }], 'i1')
    expect(plan).toMatchObject({ problem: null, amount: 36_000 })
    expect(plan.steps).toEqual([
      { allocationId: 'a1', paymentId: 'p1', amount: 30_000, invoiceId: 'i1' },
      { allocationId: 'a2', paymentId: 'p2', amount: 6_000, invoiceId: 'i1' },
    ])
    expect(depositCarryPlan(paidNone, allocations, [{ id: 'i1', number: 'FT-2026-00012', currency: 'EUR', open: 35_000 }], 'i1').problem).toContain('is open for 350.00 EUR; the deposit holds 360.00 EUR')
    expect(depositCarryPlan(paidNone, allocations, [{ id: 'i1', number: 'FT-2026-00012', currency: 'EUR', open: 120_000 }], 'i9').problem).toContain('not an issued invoice')
  })
  it('none named: each allocation onto the oldest invoice that still takes it whole', () => {
    const invoices = [
      { id: 'i1', number: 'FT-2026-00012', currency: 'EUR', open: 31_000 },
      { id: 'i2', number: 'FT-2026-00015', currency: 'EUR', open: 50_000 },
    ]
    expect(depositCarryPlan(paidNone, allocations, invoices).steps.map((step) => step.invoiceId)).toEqual(['i1', 'i2'])
    expect(depositCarryPlan(paidNone, [{ id: 'a1', paymentId: 'p1', amount: 90_000 }], invoices).problem).toContain('carried whole per payment')
    expect(depositCarryPlan(paidNone, allocations, []).problem).toContain('has no issued invoice')
  })
  it('nothing left: carried already', () => {
    expect(depositCarryPlan(paidNone, [], [{ id: 'i1', number: 'FT-2026-00012', currency: 'EUR', open: 120_000 }]).problem).toContain('carried onto the invoice already')
  })
  it('the reversal says why, in the office’s words or the person’s', () => {
    expect(carryNote('SO-2026-0007', 'FT-2026-00012', null)).toBe('Deposit of order SO-2026-0007 carried onto invoice FT-2026-00012: the deposit issues no deposit invoice (fiscal document NONE).')
    expect(carryNote('SO-2026-0007', 'FT-2026-00012', ' Agreed with the customer ')).toBe('Agreed with the customer')
  })
})

describe('why a refund pays money back', () => {
  it('every reason has words in both languages', () => {
    for (const reason of REFUND_REASONS) expect(REFUND_REASON_WORDS[reason].it.length * REFUND_REASON_WORDS[reason].en.length).toBeGreaterThan(0)
  })
  it('reads the reason a credit note’s causale names', () => {
    expect(creditReasonOfCausale('Nota di credito: Reso merce - RMA SEED-RMA-0001 - rif. fattura n. FT-2026-00001 del 28/10/2026 (art. 26 DPR 633/1972)')).toBe('RETURN')
    expect(creditReasonOfCausale('Nota di credito: Restituzione acconto - rif. fattura n. FT-2026-00002 del 28/10/2026 (art. 26 DPR 633/1972)')).toBe('DEPOSIT_REFUND')
    expect(creditReasonOfCausale('Storno parziale')).toBeNull()
    expect(creditReasonOfCausale(null)).toBeNull()
  })
  it('a payment’s unplaced part is an overpayment; a credit note follows its lines, its causale, then what it credits', () => {
    expect(defaultRefundReason({ source: 'PAYMENT' })).toBe('OVERPAYMENT')
    expect(defaultRefundReason({ source: 'CREDIT_NOTE', fromReturn: true, creditReason: 'PRICE_REDUCTION' })).toBe('RETURN')
    expect(defaultRefundReason({ source: 'CREDIT_NOTE', creditReason: 'DEFECT' })).toBe('PRICE_ADJUSTMENT')
    expect(defaultRefundReason({ source: 'CREDIT_NOTE', creditReason: 'DEPOSIT_REFUND' })).toBe('DEPOSIT_BACK')
    expect(defaultRefundReason({ source: 'CREDIT_NOTE', creditReason: 'OTHER', creditsDeposit: true })).toBe('DEPOSIT_BACK')
    expect(defaultRefundReason({ source: 'CREDIT_NOTE', creditReason: null })).toBe('OTHER')
  })
})
