import { describe, expect, it } from 'vitest'
import { compareFigures, figuresOf, figuresProblems, foldReference, type OurBooks } from './figures'

/** B-W2b-406 (FIN-135): a customer's own figures against ours, made-up books only. */

const BOOKS: OurBooks = {
  invoices: [
    { id: 'i1', number: 'FT-2026-00001', orderId: 'o1', open: 61000 },
    { id: 'i2', number: 'FT-2026-00002', orderId: 'o1', open: 10000 },
    { id: 'i3', number: 'FT-2026-00003', orderId: 'o2', open: 0 },
    { id: 'i4', number: 'FT-2026-00004', orderId: null, open: 5000 },
    { id: 'i5', number: 'FT-2026-00005', orderId: 'o3', open: 2000 },
  ],
  orders: [
    { id: 'o1', number: 'SO-2026-0007', customerRef: 'PO 4471' },
    { id: 'o2', number: 'SO-2026-0008', customerRef: null },
    { id: 'o3', number: 'SO-2026-0009', customerRef: null },
  ],
  payments: [
    { id: 'p1', reference: 'CRO 0000 1111', receivedOn: '2026-11-02', amount: 40000 },
    { id: 'p2', reference: 'BANKLINE-X', receivedOn: '2026-11-05', amount: 12000 },
    { id: 'p3', reference: 'TRN-9', receivedOn: '2026-11-08', amount: 3000 },
    { id: 'p4', reference: 'TRN-OLD', receivedOn: '2026-10-01', amount: 9000 },
  ],
  balance: 78000,
}

describe('their figures against ours', () => {
  it('folds references to letters and digits', () => {
    expect(foldReference('FT 2026/00001')).toBe(foldReference('FT-2026-00001'))
    expect(foldReference(' po 4471 ')).toBe('PO4471')
    expect(foldReference('Città')).toBe('CITTA')
  })

  it('finds their orders by our order number, their own reference or an invoice number, and says every difference', () => {
    const answer = compareFigures(
      {
        orders: [
          { reference: 'po-4471', amount: 71000 },
          { reference: 'Fattura FT 2026/00004', amount: 4000 },
          { reference: 'SO-2026-0008', amount: 1500 },
          { reference: 'Unknown order 9', amount: 300 },
          { reference: 'FT-2026-00001', amount: 61000 },
        ],
        payments: [],
        balance: 78000,
      },
      BOOKS,
    )
    expect(answer.orders.map((line) => [line.index, line.ours?.kind ?? null, line.ours?.number ?? null, line.state, line.difference])).toEqual([
      [0, 'ORDER', 'SO-2026-0007', 'SAME', 0],
      [1, 'INVOICE', 'FT-2026-00004', 'DIFFERS', -1000],
      [2, 'ORDER', 'SO-2026-0008', 'NOTHING_OPEN', 1500],
      [3, null, null, 'NOT_FOUND', 300],
      // FT-2026-00001 is counted under SO-2026-0007 already.
      [4, 'INVOICE', 'FT-2026-00001', 'TWICE', 61000],
      // Open with us, not on their list: per order.
      [null, 'ORDER', 'SO-2026-0009', 'ONLY_OURS', -2000],
    ])
    expect(answer.orders[0]!.ours!.invoices.map((invoice) => invoice.number)).toEqual(['FT-2026-00001', 'FT-2026-00002'])
    expect(answer.balance).toEqual({ theirs: 78000, ours: 78000, difference: 0, state: 'SAME' })
    expect(answer.differences).toBe(5)
  })

  it('finds their payments by reference, else by amount within 5 days; ours from their first day', () => {
    const answer = compareFigures(
      {
        orders: [],
        payments: [
          { reference: 'CRO00001111', date: '2026-11-02', amount: 40000 },
          { reference: 'bonifico 5 nov', date: '2026-11-03', amount: 12000 },
          { reference: 'TRN 9', date: '2026-11-08', amount: 3500 },
          { reference: 'never arrived', date: '2026-11-09', amount: 700 },
        ],
        balance: 70000,
      },
      { ...BOOKS, payments: [...BOOKS.payments, { id: 'p5', reference: 'TRN-10', receivedOn: '2026-11-09', amount: 800 }] },
    )
    expect(answer.payments.map((line) => [line.index, line.ours?.id ?? null, line.foundBy, line.state, line.difference])).toEqual([
      [0, 'p1', 'REFERENCE', 'SAME', 0],
      [1, 'p2', 'AMOUNT_AND_DAY', 'SAME', 0],
      [2, 'p3', 'REFERENCE', 'DIFFERS', 500],
      [3, null, null, 'NOT_FOUND', 700],
      // p4 is before their first payment's day: not listed.
      [null, 'p5', null, 'ONLY_OURS', -800],
    ])
    expect(answer.paymentsFrom).toBe('2026-11-02')
    expect(answer.balance).toEqual({ theirs: 70000, ours: 78000, difference: -8000, state: 'DIFFERS' })
    // Orders open with us they did not list count too.
    expect(answer.differences).toBe(3 + answer.orders.length + 1)
  })

  it('lists none of our payments when they list none', () => {
    const answer = compareFigures({ orders: [], payments: [], balance: 0 }, BOOKS)
    expect(answer.paymentsFrom).toBeNull()
    expect(answer.payments).toEqual([])
  })

  it('refuses figures it may not keep, each at its path', () => {
    const problems = figuresProblems(
      {
        asOf: '2026-11-20',
        figures: { orders: [{ reference: '  ', amount: 1.5 }], payments: [{ reference: 'x'.repeat(101), date: '2026-11-21', amount: 10 }], balance: 10 },
        note: '',
      },
      '2026-11-15',
    )
    expect(problems.map((problem) => problem.path)).toEqual([
      'body/asOf',
      'body/figures/orders/0/reference',
      'body/figures/orders/0/amount',
      'body/figures/payments/0/reference',
      'body/figures/payments/0/date',
      'body/note',
    ])
    expect(figuresProblems({ asOf: '2026-11-10', figures: figuresOf({ orders: [{ reference: ' PO  4471 ', amount: -100 }], payments: [], balance: -100 }) }, '2026-11-15')).toEqual([])
  })
})
