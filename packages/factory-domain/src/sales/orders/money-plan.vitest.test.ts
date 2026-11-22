import { describe, expect, it } from 'vitest'
import { coverageOf, overdueOf, planByHandMarkOf, settledByOf, UNDO_HELD, UNDO_HELD_WORDS, undoVerdictOf, type PlanStep, type UndoFacts } from './money-plan'
// B-OM-011 … 016: the hand planner.
import { amountOfPct, BY_HAND_NOTES, MONEY_PLAN_REFUSALS, MONEY_PLAN_REFUSAL_WORDS, planByHand, sharePctOf, type MoneyPlanAction, type MoneyPlanOutcome, type PlannerFacts, type PlannerRequest, type PlannerStep } from './money-plan'

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

// ════ B-OM-011 … 016 (order money tab, PR S2): the hand planner ════
describe('the hand planner: what each act writes, or why not in words', () => {
  const step = (fields: Partial<PlannerStep> & Pick<PlannerStep, 'id' | 'seq' | 'kind' | 'amount'>): PlannerStep => ({ status: 'OPEN', sharePct: null, dueDate: null, label: null, depositRequestId: null, ...fields })
  const request = (fields: Partial<PlannerRequest> & Pick<PlannerRequest, 'id' | 'amount'>): PlannerRequest => ({ kind: 'ACCONTO', status: 'OPEN', paid: 0, dueDate: '2026-12-01', ...fields })
  // Gross 1,000.00: the deposit 30 %, before shipping 50 %, on the invoice 20 %.
  const facts = (change: { steps?: PlannerStep[]; requests?: PlannerRequest[]; order?: Partial<PlannerFacts['order']> } = {}): PlannerFacts => ({
    order: { status: 'CONFIRMED', gross: 100_000, goodsLeft: false, paymentTermsId: 'terms-1', ...change.order },
    steps: change.steps ?? [
      step({ id: 'dep', seq: 10, kind: 'DEPOSIT', amount: 30_000, sharePct: '30.0000', dueDate: '2026-12-01', depositRequestId: 'r-dep' }),
      step({ id: 'bal', seq: 20, kind: 'BEFORE_SHIPPING', amount: 50_000, sharePct: '50.0000', dueDate: '2026-12-20', depositRequestId: 'r-bal' }),
      step({ id: 'inv', seq: 30, kind: 'ON_INVOICE', amount: 20_000, sharePct: '20.0000' }),
    ],
    requests: change.requests ?? [request({ id: 'r-dep', amount: 30_000 }), request({ id: 'r-bal', amount: 50_000, dueDate: '2026-12-20' })],
    today: '2026-11-22',
  })
  const plan = (outcome: MoneyPlanOutcome) => {
    if (!outcome.ok) throw new Error(`refused: ${outcome.refusal}`)
    return outcome.plan
  }
  const refusal = (outcome: MoneyPlanOutcome) => (outcome.ok ? null : outcome.refusal)
  const act = (action: MoneyPlanAction, given = facts()) => planByHand(given, action)

  it('every refusal has its words in English and Italian', () => {
    for (const code of MONEY_PLAN_REFUSALS) {
      expect(MONEY_PLAN_REFUSAL_WORDS[code].en.length, code).toBeGreaterThan(10)
      expect(MONEY_PLAN_REFUSAL_WORDS[code].it.length, code).toBeGreaterThan(10)
    }
    expect(refusal(act({ act: 'RENAME_STEP', milestoneId: 'bal', label: 'Saldo' }, facts({ order: { status: 'CANCELLED' } })))).toBe('ORDER_FINAL')
    expect(refusal(act({ act: 'RENAME_STEP', milestoneId: 'bal', label: 'Saldo' }, facts({ order: { status: 'CLOSED' } })))).toBe('ORDER_FINAL')
  })

  it('B-OM-011 replace the deposit: the old request cancelled, a new one of the new amount in its place, the open steps shared again', () => {
    const replaced = plan(act({ act: 'REPLACE_DEPOSIT', requestId: 'r-dep', amount: 40_000 }))
    expect(replaced.cancelRequests).toEqual([{ id: 'r-dep', note: BY_HAND_NOTES.REPLACED }])
    expect(replaced.newRequests).toEqual([{ ref: 'new:1', kind: 'ACCONTO', amount: 40_000, dueDate: '2026-12-01', sharePct: '40.0000', stepKind: 'DEPOSIT' }])
    expect(replaced.steps).toEqual([expect.objectContaining({ id: 'dep', amount: 40_000, sharePct: '40.0000', request: 'new:1', status: 'OPEN' })])
    expect(replaced.replacements).toEqual([{ from: 'r-dep', to: 'new:1' }])
    expect(replaced.remake).toBe(true)
    const paid = facts({ requests: [request({ id: 'r-dep', amount: 30_000, paid: 1_000 }), request({ id: 'r-bal', amount: 50_000 })] })
    expect(refusal(act({ act: 'REPLACE_DEPOSIT', requestId: 'r-dep', amount: 40_000 }, paid))).toBe('MONEY_PLACED')
    expect(refusal(act({ act: 'REPLACE_DEPOSIT', requestId: 'r-dep', amount: 0 }))).toBe('BELOW_ZERO')
    expect(refusal(act({ act: 'REPLACE_DEPOSIT', requestId: 'r-dep', amount: 120_000 }))).toBe('OVER_TOTAL')
    expect(refusal(act({ act: 'REPLACE_DEPOSIT', requestId: 'r-dep', amount: 30_000 }))).toBe('NOTHING_CHANGES')
    expect(refusal(act({ act: 'REPLACE_DEPOSIT', requestId: 'r-dep', amount: 40_000 }, facts({ order: { goodsLeft: true } })))).toBe('GOODS_LEFT')
    expect(refusal(act({ act: 'REPLACE_DEPOSIT', requestId: 'r-bal', amount: 40_000 }))).toBe('NOT_DEPOSIT')
  })

  it('B-OM-012 move a due day: the step and its open request together; a request alone moves its steps', () => {
    const moved = plan(act({ act: 'MOVE_DUE', milestoneId: 'bal', dueDate: '2026-12-27' }))
    expect(moved.steps).toEqual([expect.objectContaining({ id: 'bal', dueDate: '2026-12-27', amount: 50_000, request: 'r-bal' })])
    expect(moved.moveRequests).toEqual([{ id: 'r-bal', dueDate: '2026-12-27' }])
    expect(moved.newRequests).toEqual([])
    const byRequest = plan(act({ act: 'MOVE_DUE', requestId: 'r-dep', dueDate: '2026-12-05' }))
    expect(byRequest.moveRequests).toEqual([{ id: 'r-dep', dueDate: '2026-12-05' }])
    expect(byRequest.steps.map((entry) => [entry.id, entry.dueDate])).toEqual([['dep', '2026-12-05']])
    expect(refusal(act({ act: 'MOVE_DUE', milestoneId: 'bal', dueDate: '2026-11-21' }))).toBe('PAST_DAY')
    expect(refusal(act({ act: 'MOVE_DUE', milestoneId: 'inv', dueDate: '2026-12-27' }))).toBe('NOT_ADVANCE')
    expect(refusal(act({ act: 'MOVE_DUE', milestoneId: 'bal', dueDate: '2026-12-20' }))).toBe('NOTHING_CHANGES')
  })

  it('B-OM-013 ask for a waived deposit again: a new request and a new step after the others; the waived rows stay', () => {
    const waived = facts({
      steps: [step({ id: 'dep', seq: 10, kind: 'DEPOSIT', status: 'WAIVED', amount: 30_000, sharePct: '30.0000', depositRequestId: 'r-dep' }), step({ id: 'inv', seq: 20, kind: 'ON_INVOICE', amount: 70_000 })],
      requests: [request({ id: 'r-dep', amount: 30_000, status: 'WAIVED' })],
    })
    const asked = plan(act({ act: 'ASK_AGAIN', milestoneId: 'dep', dueDate: '2026-12-10' }, waived))
    expect(asked.newRequests).toEqual([expect.objectContaining({ ref: 'new:1', amount: 30_000, dueDate: '2026-12-10', stepKind: 'DEPOSIT' })])
    expect(asked.steps).toEqual([expect.objectContaining({ id: null, seq: 30, kind: 'DEPOSIT', amount: 30_000, dueDate: '2026-12-10', request: 'new:1', status: 'OPEN' })])
    expect(asked.cancelRequests).toEqual([])
    expect(asked.replacements).toEqual([{ from: 'r-dep', to: 'new:1' }])
    expect(refusal(act({ act: 'ASK_AGAIN', milestoneId: 'bal', dueDate: '2026-12-10' }))).toBe('NOT_WAIVED')
    expect(refusal(act({ act: 'ASK_AGAIN', milestoneId: 'dep', dueDate: '2026-12-10' }, { ...waived, order: { ...waived.order, goodsLeft: true } }))).toBe('GOODS_LEFT')
  })

  it('B-OM-014 add a step out of another: the sum kept; a step before shipping with its day gets its request; a second deposit refused', () => {
    const added = plan(act({ act: 'ADD_STEP', kind: 'BEFORE_SHIPPING', amount: 10_000, dueDate: '2026-12-10', label: 'Seconda rata', from: 'inv' }))
    expect(added.steps).toEqual([
      expect.objectContaining({ id: 'inv', amount: 10_000, sharePct: '10.0000', request: null }),
      expect.objectContaining({ id: null, seq: 40, kind: 'BEFORE_SHIPPING', amount: 10_000, dueDate: '2026-12-10', label: 'Seconda rata', request: 'new:1' }),
    ])
    expect(added.newRequests).toEqual([expect.objectContaining({ ref: 'new:1', amount: 10_000, stepKind: 'BEFORE_SHIPPING' })])
    // Taken out of an advance step with an open request: its request is replaced by one of its new amount.
    const fromBalance = plan(act({ act: 'ADD_STEP', kind: 'ON_DELIVERY', amount: 5_000, dueDate: null, label: null, from: 'bal' }))
    expect(fromBalance.cancelRequests).toEqual([{ id: 'r-bal', note: BY_HAND_NOTES.CHANGED }])
    expect(fromBalance.steps[0]).toMatchObject({ id: 'bal', amount: 45_000, request: 'new:1' })
    expect(fromBalance.steps[1]).toMatchObject({ kind: 'ON_DELIVERY', amount: 5_000, dueDate: null, request: null })
    expect(refusal(act({ act: 'ADD_STEP', kind: 'DEPOSIT', amount: 5_000, dueDate: '2026-12-10', label: null, from: 'inv' }))).toBe('SECOND_DEPOSIT')
    expect(refusal(act({ act: 'ADD_STEP', kind: 'ON_DELIVERY', amount: 20_000, dueDate: null, label: null, from: 'inv' }))).toBe('BELOW_ZERO')
    const partPaid = facts({ requests: [request({ id: 'r-dep', amount: 30_000 }), request({ id: 'r-bal', amount: 50_000, paid: 100 })] })
    expect(refusal(act({ act: 'ADD_STEP', kind: 'ON_DELIVERY', amount: 5_000, dueDate: null, label: null, from: 'bal' }, partPaid))).toBe('REST_TO')
    expect(refusal(act({ act: 'ADD_STEP', kind: 'BEFORE_SHIPPING', amount: 5_000, dueDate: '2026-11-01', label: null, from: 'inv' }))).toBe('PAST_DAY')
    // A deposit added (none yet): production waits for it from now on.
    const noDeposit = facts({ steps: [step({ id: 'inv', seq: 10, kind: 'ON_INVOICE', amount: 100_000 })], requests: [] })
    expect(plan(act({ act: 'ADD_STEP', kind: 'DEPOSIT', amount: 30_000, dueDate: '2026-12-01', label: null, from: 'inv' }, noDeposit)).depositRequired).toBe(true)
    expect(refusal(act({ act: 'ADD_STEP', kind: 'DEPOSIT', amount: 30_000, dueDate: null, label: null, from: 'inv' }, noDeposit))).toBe('NO_DAY')
  })

  it('B-OM-014 change a step: another open step takes the difference; refused without one, below zero, on money placed', () => {
    const changed = plan(act({ act: 'CHANGE_STEP', milestoneId: 'bal', amount: 40_000, restTo: 'inv' }))
    expect(changed.steps.map((entry) => [entry.id, entry.amount])).toEqual([['bal', 40_000], ['inv', 30_000]])
    expect(changed.cancelRequests).toEqual([{ id: 'r-bal', note: BY_HAND_NOTES.CHANGED }])
    expect(changed.steps.reduce((sum, entry) => sum + entry.amount, 0)).toBe(70_000)
    expect(refusal(act({ act: 'CHANGE_STEP', milestoneId: 'bal', amount: 40_000, restTo: null }))).toBe('TOTAL_CHANGES')
    expect(refusal(act({ act: 'CHANGE_STEP', milestoneId: 'bal', amount: 40_000, restTo: 'bal' }))).toBe('REST_TO')
    expect(refusal(act({ act: 'CHANGE_STEP', milestoneId: 'bal', amount: 70_000, restTo: 'inv' }))).toBe('BELOW_ZERO')
    const paid = facts({ requests: [request({ id: 'r-dep', amount: 30_000 }), request({ id: 'r-bal', amount: 50_000, paid: 100 })] })
    expect(refusal(act({ act: 'CHANGE_STEP', milestoneId: 'bal', amount: 40_000, restTo: 'inv' }, paid))).toBe('MONEY_PLACED')
  })

  it('B-OM-014 remove a step: cancelled with plain words, its request too; the last deposit removed: production no longer waits', () => {
    const removed = plan(act({ act: 'REMOVE_STEP', milestoneId: 'inv', restTo: 'bal' }))
    expect(removed.steps).toEqual([expect.objectContaining({ id: 'inv', status: 'CANCELLED', statusNote: BY_HAND_NOTES.REMOVED }), expect.objectContaining({ id: 'bal', amount: 70_000 })])
    expect(removed.depositRequired).toBeNull()
    const deposit = plan(act({ act: 'REMOVE_STEP', milestoneId: 'dep', restTo: 'inv' }))
    expect(deposit.cancelRequests).toEqual([{ id: 'r-dep', note: BY_HAND_NOTES.REMOVED }])
    expect(deposit.depositRequired).toBe(false)
    const last = facts({ steps: [step({ id: 'inv', seq: 10, kind: 'ON_INVOICE', amount: 100_000 })], requests: [] })
    expect(refusal(act({ act: 'REMOVE_STEP', milestoneId: 'inv', restTo: null }, last))).toBe('LAST_STEP')
    expect(refusal(act({ act: 'REMOVE_STEP', milestoneId: 'inv', restTo: null }))).toBe('TOTAL_CHANGES')
  })

  it('B-OM-014 rename a step and undo its opening', () => {
    expect(plan(act({ act: 'RENAME_STEP', milestoneId: 'bal', label: 'Saldo prima della spedizione' })).steps).toEqual([expect.objectContaining({ id: 'bal', label: 'Saldo prima della spedizione' })])
    expect(refusal(act({ act: 'RENAME_STEP', milestoneId: 'bal', label: null }))).toBe('NOTHING_CHANGES')
    const undone = plan(act({ act: 'UNDO_OPEN', milestoneId: 'bal' }))
    expect(undone.cancelRequests).toEqual([{ id: 'r-bal', note: BY_HAND_NOTES.UNDONE }])
    expect(undone.steps).toEqual([expect.objectContaining({ id: 'bal', request: null, amount: 50_000 })])
    expect(refusal(act({ act: 'UNDO_OPEN', milestoneId: 'dep' }))).toBe('NOT_ADVANCE')
    expect(refusal(act({ act: 'UNDO_OPEN', milestoneId: 'inv' }))).toBe('NOT_ADVANCE')
    const notOpened = facts({ steps: [step({ id: 'bal', seq: 10, kind: 'BEFORE_SHIPPING', amount: 100_000 })], requests: [] })
    expect(refusal(act({ act: 'UNDO_OPEN', milestoneId: 'bal' }, notOpened))).toBe('NOT_OPENED')
    const paid = facts({ requests: [request({ id: 'r-dep', amount: 30_000 }), request({ id: 'r-bal', amount: 50_000, paid: 100 })] })
    expect(refusal(act({ act: 'UNDO_OPEN', milestoneId: 'bal' }, paid))).toBe('MONEY_PLACED')
  })

  it('B-OM-015 change the terms: refused when the same or archived; else the open steps are made again', () => {
    expect(refusal(act({ act: 'CHANGE_TERMS', paymentTermsId: 'terms-1', termsArchived: false }))).toBe('TERMS_SAME')
    expect(refusal(act({ act: 'CHANGE_TERMS', paymentTermsId: 'terms-2', termsArchived: true }))).toBe('TERMS_ARCHIVED')
    expect(plan(act({ act: 'CHANGE_TERMS', paymentTermsId: 'terms-2', termsArchived: false }))).toMatchObject({ remake: true, steps: [], newRequests: [] })
  })

  it('B-OM-016 accept a deposit short: within the tolerance; beyond it (or none) only with the override; nothing short refused', () => {
    const short = facts({ requests: [request({ id: 'r-dep', amount: 30_000, paid: 29_000 }), request({ id: 'r-bal', amount: 50_000 })] })
    const accept = (tolerance: number | null, override = false, given = short) => act({ act: 'ACCEPT_SHORT', requestId: 'r-dep', why: 'BANK_CHARGES', tolerance, override }, given)
    expect(plan(accept(2_500))).toMatchObject({ payRequest: 'r-dep', short: 1_000, overridden: false, steps: [], cancelRequests: [] })
    expect(refusal(accept(500))).toBe('OVER_TOLERANCE')
    expect(plan(accept(500, true))).toMatchObject({ payRequest: 'r-dep', short: 1_000, overridden: true })
    expect(refusal(accept(null))).toBe('NO_TOLERANCE')
    expect(refusal(accept(2_500, false, facts()))).toBe('NOTHING_SHORT')
    const full = facts({ requests: [request({ id: 'r-dep', amount: 30_000, paid: 30_000 }), request({ id: 'r-bal', amount: 50_000 })] })
    expect(refusal(accept(2_500, false, full))).toBe('NOTHING_SHORT')
  })

  it('the shares: 4 places of the gross; a share typed in % as minor units, half up', () => {
    expect(sharePctOf(30_000, 100_000)).toBe('30.0000')
    expect(sharePctOf(1, 3)).toBe('33.3333')
    expect(sharePctOf(0, 100_000)).toBeNull()
    expect(amountOfPct('30', 102_480)).toBe(30_744)
    expect(amountOfPct('0', 102_480)).toBeNull()
    expect(amountOfPct('101', 102_480)).toBeNull()
    expect(amountOfPct('abc', 102_480)).toBeNull()
  })
})
