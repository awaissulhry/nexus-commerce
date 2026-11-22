import { describe, expect, it } from 'vitest'
import { coverageOf, overdueOf, planByHandMarkOf, settledByOf, UNDO_HELD, UNDO_HELD_WORDS, undoVerdictOf, type PlanStep, type UndoFacts } from './money-plan'

/** B-OM-004 (order money tab M4-B1, B12): the plan read's pure rules. Every amount is made up. */

const step = (fields: Partial<PlanStep> & Pick<PlanStep, 'id' | 'seq' | 'kind'>): PlanStep => ({ status: 'OPEN', amount: 10_000, dueDate: null, paidSoFar: null, ...fields })

describe('ON_DELIVERY / ON_INVOICE steps covered by the goods’ invoices (M4-B1: they never became Paid)', () => {
  const steps = [
    step({ id: 'deposit', seq: 10, kind: 'DEPOSIT', amount: 30_000, paidSoFar: 30_000, status: 'PAID' }),
    step({ id: 'delivery', seq: 20, kind: 'ON_DELIVERY', amount: 40_000 }),
    step({ id: 'invoice', seq: 30, kind: 'ON_INVOICE', amount: 30_000 }),
  ]

  it('the goods’ money is given out in seq order, each step at most its amount; the deposit step takes none', () => {
    expect(coverageOf(steps, 50_000)).toEqual(new Map([['delivery', 40_000], ['invoice', 10_000]]))
    expect(coverageOf(steps, 0)).toEqual(new Map([['delivery', 0], ['invoice', 0]]))
    expect(coverageOf(steps, 90_000)).toEqual(new Map([['delivery', 40_000], ['invoice', 30_000]]))
    // In seq order whatever order the rows come in; a negative figure covers nothing.
    expect(coverageOf([...steps].reverse(), 45_000).get('delivery')).toBe(40_000)
    expect(coverageOf(steps, -500).get('delivery')).toBe(0)
  })

  it('a step covered in full is settled by the invoices; a PAID step by its payment; a part covered is not settled', () => {
    const coverage = coverageOf(steps, 50_000)
    expect(settledByOf(steps[0]!, 0)).toBe('PAYMENT')
    expect(settledByOf(steps[1]!, coverage.get('delivery')!)).toBe('INVOICES')
    expect(settledByOf(steps[2]!, coverage.get('invoice')!)).toBeNull()
    // A before-shipping step is never settled by the invoices (it has its own request).
    expect(settledByOf(step({ id: 'before', seq: 15, kind: 'BEFORE_SHIPPING' }), 10_000)).toBeNull()
  })

  it('overdue: OPEN steps whose day passed, less what is paid on them and what the invoices cover', () => {
    const due = [
      step({ id: 'deposit', seq: 10, kind: 'DEPOSIT', amount: 30_000, paidSoFar: 10_000, dueDate: '2026-11-01' }),
      step({ id: 'before', seq: 20, kind: 'BEFORE_SHIPPING', amount: 50_000, paidSoFar: 0, dueDate: '2026-11-22' }),
      step({ id: 'invoice', seq: 30, kind: 'ON_INVOICE', amount: 22_480, dueDate: '2026-11-10' }),
      step({ id: 'paid', seq: 40, kind: 'BEFORE_SHIPPING', status: 'PAID', amount: 5_000, paidSoFar: 5_000, dueDate: '2026-11-01' }),
    ]
    // Today's step is not overdue yet; the PAID one never.
    expect(overdueOf(due, new Map([['invoice', 2_480]]), '2026-11-22')).toBe(20_000 + 20_000)
    expect(overdueOf(due, new Map(), '2026-11-23')).toBe(20_000 + 50_000 + 22_480)
  })
})

describe('the hand changes read back from the audit (planByHand)', () => {
  it('reads the act, the steps, the requests and the replacements; anything else is not one', () => {
    expect(planByHandMarkOf({ act: 'REPLACE_DEPOSIT', milestoneIds: ['s1'], depositRequestIds: ['r1', 'r2'], replacements: [{ from: 'r1', to: 'r2' }, { from: 'r3' }], before: {} })).toEqual({
      act: 'REPLACE_DEPOSIT',
      milestoneIds: ['s1'],
      depositRequestIds: ['r1', 'r2'],
      replacements: [{ from: 'r1', to: 'r2' }],
      why: null,
    })
    expect(planByHandMarkOf({ act: 'ACCEPT_SHORT', depositRequestIds: ['r1'], why: 'BANK_CHARGES' })).toMatchObject({ act: 'ACCEPT_SHORT', milestoneIds: [], why: 'BANK_CHARGES' })
    expect(planByHandMarkOf({ act: 'SOMETHING_ELSE', milestoneIds: ['s1'] })).toBeNull()
    expect(planByHandMarkOf(null)).toBeNull()
    expect(planByHandMarkOf(['MOVE_DUE'])).toBeNull()
  })
})

describe('undo a payment on a deposit: the verdict, held in words', () => {
  const facts = (fields: Partial<UndoFacts> = {}): UndoFacts => ({ mayAct: true, request: { status: 'OPEN', fiscalDocument: 'TD02' }, depositInvoiceIssued: false, depositInvoiceDraft: false, writeOffStanding: false, hardLocked: false, ...fields })

  it('may on an open request with nothing in the way; no right: no door and no words', () => {
    expect(undoVerdictOf(facts())).toEqual({ may: true, why: null, code: null })
    expect(undoVerdictOf(facts({ mayAct: false, depositInvoiceIssued: true }))).toEqual({ may: false, why: null, code: null })
  })

  it('held by the first reason, in this order: carried, paid, a deposit invoice issued, its draft, a write-off, a month closed for good', () => {
    expect(undoVerdictOf(facts({ request: { status: 'PAID', fiscalDocument: 'NONE' }, depositInvoiceIssued: true })).code).toBe('CARRIED')
    expect(undoVerdictOf(facts({ request: { status: 'PAID', fiscalDocument: 'TD02' }, depositInvoiceIssued: true })).code).toBe('PAID')
    expect(undoVerdictOf(facts({ depositInvoiceIssued: true, depositInvoiceDraft: true }))).toEqual({ may: false, why: UNDO_HELD_WORDS.DEPOSIT_INVOICE_ISSUED, code: 'DEPOSIT_INVOICE_ISSUED' })
    expect(undoVerdictOf(facts({ depositInvoiceDraft: true, writeOffStanding: true })).code).toBe('DEPOSIT_INVOICE_DRAFT')
    expect(undoVerdictOf(facts({ writeOffStanding: true, hardLocked: true })).code).toBe('WRITE_OFF')
    expect(undoVerdictOf(facts({ hardLocked: true })).code).toBe('HARD_LOCKED')
  })

  it('every reason has its words in English and Italian; the Italian deposit invoice one says a credit note first', () => {
    for (const code of UNDO_HELD) {
      expect(UNDO_HELD_WORDS[code].en.length, code).toBeGreaterThan(10)
      expect(UNDO_HELD_WORDS[code].it.length, code).toBeGreaterThan(10)
    }
    expect(UNDO_HELD_WORDS.DEPOSIT_INVOICE_ISSUED.en).toContain('a credit note first, in Finance')
    expect(UNDO_HELD_WORDS.DEPOSIT_INVOICE_ISSUED.it).toContain('prima una nota di credito')
  })
})
