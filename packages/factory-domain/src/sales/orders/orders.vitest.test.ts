import { describe, expect, it } from 'vitest'
import { InvalidStateError } from '../../core/errors'
import { assertTransition, canTransition } from '../../state/machine'
import {
  daysLate,
  followMoves,
  orderActions,
  orderFromVersion,
  orderProgress,
  promiseProblems,
  promiseStateProblem,
  salesOrderMachine,
  type AcceptedLine,
  type AcceptedVersion,
  type SettlementAnswer,
} from './orders'

/**
 * The sales order's rules (B-W1-25; SAL-200, SAL-203, SAL-204, SAL-206; A1 §2.5 "Sales order"; PLAN §4.7 "Closing the
 * order"): one writer per move with its guard, the moves the system follows from the facts, the per-size progress, the
 * promise rules and the copy of an accepted version. Every number is made up and computed by hand.
 */

const settled: SettlementAnswer = { settled: true, missing: [], source: 'test' }
const unsettled: SettlementAnswer = { settled: false, missing: [{ code: 'BALANCE_DUE', message: 'A balance of 120.00 is due.' }], source: 'test' }

describe('the machine: one action per move, each with its guard (SAL-204)', () => {
  it('production starts only with a released work order of its lines', () => {
    expect(canTransition(salesOrderMachine, 'CONFIRMED', 'IN_PRODUCTION', { releasedWorkOrders: 0 })).toMatchObject({ ok: false, missing: ['a released work order of its lines'] })
    expect(canTransition(salesOrderMachine, 'CONFIRMED', 'IN_PRODUCTION', { releasedWorkOrders: 1 }).ok).toBe(true)
  })

  it('ready when quality released every piece, or by hand with a reason', () => {
    expect(canTransition(salesOrderMachine, 'IN_PRODUCTION', 'READY', { released: false }).ok).toBe(false)
    expect(canTransition(salesOrderMachine, 'IN_PRODUCTION', 'READY', { released: true }).ok).toBe(true)
    expect(canTransition(salesOrderMachine, 'IN_PRODUCTION', 'READY', { released: false, reason: 'Quality signed the paper sheet.' }).ok).toBe(true)
    expect(canTransition(salesOrderMachine, 'IN_PRODUCTION', 'READY', { released: false, reason: '   ' }).ok).toBe(false)
  })

  it('partly shipped and shipped come from the shipped quantities only', () => {
    expect(canTransition(salesOrderMachine, 'READY', 'PARTLY_SHIPPED', { shipped: 'PARTLY' }).ok).toBe(true)
    expect(canTransition(salesOrderMachine, 'READY', 'PARTLY_SHIPPED', { shipped: 'ALL' }).ok).toBe(false)
    expect(canTransition(salesOrderMachine, 'PARTLY_SHIPPED', 'SHIPPED', { shipped: 'PARTLY' }).ok).toBe(false)
    expect(canTransition(salesOrderMachine, 'PARTLY_SHIPPED', 'SHIPPED', { shipped: 'ALL' }).ok).toBe(true)
    // A shipment the carrier brought back: SHIPPED goes back to PARTLY_SHIPPED, never further.
    expect(canTransition(salesOrderMachine, 'SHIPPED', 'PARTLY_SHIPPED', { shipped: 'PARTLY' }).ok).toBe(true)
    expect(canTransition(salesOrderMachine, 'PARTLY_SHIPPED', 'READY', { released: true }).ok).toBe(false)
  })

  it('CLOSED only from SHIPPED, settled or with a reason; CLOSED is final', () => {
    expect(canTransition(salesOrderMachine, 'PARTLY_SHIPPED', 'CLOSED', { settlement: settled }).ok).toBe(false)
    expect(canTransition(salesOrderMachine, 'SHIPPED', 'CLOSED', { settlement: settled }).ok).toBe(true)
    const refused = canTransition(salesOrderMachine, 'SHIPPED', 'CLOSED', { settlement: unsettled })
    expect(refused).toMatchObject({ ok: false, missing: ['every line shipped, invoiced and paid (A balance of 120.00 is due.), or a reason to close it anyway'] })
    expect(canTransition(salesOrderMachine, 'SHIPPED', 'CLOSED', { settlement: unsettled, reason: 'Written off: the customer disputes 120.00.' }).ok).toBe(true)
    expect(canTransition(salesOrderMachine, 'SHIPPED', 'CLOSED', {}).ok).toBe(false)
    expect(() => assertTransition(salesOrderMachine, 'CLOSED', 'PARTLY_SHIPPED', { shipped: 'PARTLY' })).toThrow(InvalidStateError)
    expect(salesOrderMachine.finals).toEqual(['CLOSED', 'CANCELLED'])
  })

  it('CANCELLED only while CONFIRMED, with a reason, before any work order is released and with no draft left', () => {
    expect(canTransition(salesOrderMachine, 'CONFIRMED', 'CANCELLED', { reason: 'The customer withdrew.', releasedWorkOrders: 0, draftWorkOrders: [] }).ok).toBe(true)
    expect(canTransition(salesOrderMachine, 'CONFIRMED', 'CANCELLED', { reason: '', releasedWorkOrders: 0 })).toMatchObject({ ok: false, missing: ['a reason for the cancellation'] })
    expect(canTransition(salesOrderMachine, 'CONFIRMED', 'CANCELLED', { reason: 'Too late.', releasedWorkOrders: 1 })).toMatchObject({
      ok: false,
      missing: ['no released work order (production has started: a cancellation would leave its work behind)'],
    })
    expect(canTransition(salesOrderMachine, 'CONFIRMED', 'CANCELLED', { reason: 'Too late.', releasedWorkOrders: 0, draftWorkOrders: ['WO-00007'] })).toMatchObject({
      ok: false,
      missing: ['its draft work orders cancelled first (WO-00007)'],
    })
    expect(canTransition(salesOrderMachine, 'IN_PRODUCTION', 'CANCELLED', { reason: 'Too late.' })).toMatchObject({ ok: false, reason: 'not_allowed' })
  })
})

describe('the moves the system follows (workorder.released, shipments, the settlement)', () => {
  it('follows production, quality, the shipped quantities and closes a settled order that left in full', () => {
    expect(followMoves('CONFIRMED', { releasedWorkOrders: 1 })).toEqual(['IN_PRODUCTION'])
    expect(followMoves('CONFIRMED', { releasedWorkOrders: 0 })).toEqual([])
    expect(followMoves('IN_PRODUCTION', { releasedWorkOrders: 1, released: true, shipped: 'NONE' })).toEqual(['READY'])
    expect(followMoves('IN_PRODUCTION', { releasedWorkOrders: 1, released: true, shipped: 'PARTLY' })).toEqual(['PARTLY_SHIPPED'])
    expect(followMoves('READY', { shipped: 'PARTLY' })).toEqual(['PARTLY_SHIPPED'])
    expect(followMoves('PARTLY_SHIPPED', { shipped: 'ALL' })).toEqual(['SHIPPED'])
    expect(followMoves('PARTLY_SHIPPED', { shipped: 'ALL', settlement: settled })).toEqual(['SHIPPED', 'CLOSED'])
    expect(followMoves('CONFIRMED', { releasedWorkOrders: 2, shipped: 'ALL', settlement: settled })).toEqual(['IN_PRODUCTION', 'SHIPPED', 'CLOSED'])
    expect(followMoves('SHIPPED', { shipped: 'PARTLY' })).toEqual(['PARTLY_SHIPPED'])
    expect(followMoves('SHIPPED', { shipped: 'ALL', settlement: unsettled })).toEqual([])
    expect(followMoves('CLOSED', { shipped: 'PARTLY' })).toEqual([])
    expect(followMoves('CANCELLED', { releasedWorkOrders: 1 })).toEqual([])
  })

  it('never takes a reason: the system closes only what is settled', () => {
    expect(followMoves('SHIPPED', { shipped: 'ALL', settlement: unsettled, reason: 'should not count' })).toEqual([])
    expect(followMoves('IN_PRODUCTION', { released: false, shipped: 'NONE', reason: 'should not count' })).toEqual([])
  })
})

describe('per line × size progress (the design: Ordered · Made · Shipped · Left)', () => {
  const lines = [
    { id: 'L2', seq: 20, quantity: 1, sizes: [] },
    { id: 'L1', seq: 10, quantity: 5, sizes: [{ size: '50', quantity: 2 }, { size: '52', quantity: 3 }] },
  ]

  it('counts each measure per size, made stays null, invoiced is decimal, credits subtract', () => {
    const progress = orderProgress({
      lines,
      inWorkOrders: [{ lineId: 'L1', size: '50', quantity: 2 }, { lineId: 'L1', size: '52', quantity: 1 }, { lineId: 'L1', size: '52', quantity: 2 }, { lineId: 'L2', size: '52', quantity: 1 }],
      released: [{ lineId: 'L1', size: '50', quantity: 2 }, { lineId: 'L1', size: '52', quantity: 1 }],
      shipped: [{ lineId: 'L1', size: '50', quantity: 2 }],
      invoiced: [{ lineId: 'L1', size: '50', quantity: '2.0000' }, { lineId: 'L1', size: '50', quantity: '-1.0000' }],
    })
    expect(progress.rows).toEqual([
      { lineId: 'L1', seq: 10, size: '50', ordered: 2, inWorkOrders: 2, made: null, released: 2, shipped: 2, invoiced: '1', toShip: 0 },
      { lineId: 'L1', seq: 10, size: '52', ordered: 3, inWorkOrders: 3, made: null, released: 1, shipped: 0, invoiced: '0', toShip: 3 },
      // A made-to-measure unit has no size rows: everything of its line counts, whatever the size.
      { lineId: 'L2', seq: 20, size: null, ordered: 1, inWorkOrders: 1, made: null, released: 0, shipped: 0, invoiced: '0', toShip: 1 },
    ])
    expect(progress.lines.map((line) => [line.lineId, line.ordered, line.shipped, line.toShip])).toEqual([['L1', 5, 2, 3], ['L2', 1, 0, 1]])
    expect(progress.totals).toEqual({ ordered: 6, inWorkOrders: 6, made: null, released: 3, shipped: 2, invoiced: '1', toShip: 4 })
    expect(progress.shipped).toBe('PARTLY')
    expect(progress.released).toBe(false)
  })

  it('ALL when every size left as ordered; released when quality released every piece', () => {
    const all = orderProgress({
      lines: [lines[1]!],
      inWorkOrders: [],
      released: [{ lineId: 'L1', size: '50', quantity: 2 }, { lineId: 'L1', size: '52', quantity: 3 }],
      shipped: [{ lineId: 'L1', size: '50', quantity: 2 }, { lineId: 'L1', size: '52', quantity: 3 }],
      invoiced: [],
    })
    expect([all.shipped, all.released]).toEqual(['ALL', true])
    const none = orderProgress({ lines: [lines[1]!], inWorkOrders: [], released: [], shipped: [], invoiced: [] })
    expect([none.shipped, none.released]).toEqual(['NONE', false])
  })
})

describe('dates and the promise (SAL-206): the first promise is never overwritten', () => {
  it('late: days past the promise of an order not shipped yet', () => {
    expect(daysLate('IN_PRODUCTION', '2026-11-10', '2026-11-13')).toBe(3)
    expect(daysLate('IN_PRODUCTION', '2026-11-10', '2026-11-10')).toBe(0)
    expect(daysLate('SHIPPED', '2026-11-10', '2026-11-13')).toBeNull()
    expect(daysLate('CONFIRMED', null, '2026-11-13')).toBeNull()
  })

  it('a reason, a day from today on, a different day, lines of this order once', () => {
    const base = { status: 'CONFIRMED' as const, current: '2026-12-10', promiseDate: '2026-12-20', reason: 'Leather arrives late.', lineIds: [], knownLineIds: ['L1', 'L2'], today: '2026-11-01' }
    expect(promiseProblems(base)).toEqual([])
    expect(promiseProblems({ ...base, reason: ' ' }).map((issue) => issue.path)).toEqual(['body/reason'])
    expect(promiseProblems({ ...base, promiseDate: '2026-10-31' }).map((issue) => issue.path)).toEqual(['body/promiseDate'])
    expect(promiseProblems({ ...base, promiseDate: '2026-12-10' })).toEqual([{ path: 'body/promiseDate', message: 'The order is already promised for 2026-12-10.' }])
    // A line may get the order's day.
    expect(promiseProblems({ ...base, promiseDate: '2026-12-10', lineIds: ['L1'] })).toEqual([])
    expect(promiseProblems({ ...base, lineIds: ['L1', 'L9', 'L1'] }).map((issue) => issue.path)).toEqual(['body/lineIds/1', 'body/lineIds/2'])
  })

  it('a final order keeps its dates; lines are fixed once anything shipped', () => {
    expect(promiseStateProblem('CLOSED', false)).toMatch(/CLOSED; its dates no longer change/)
    expect(promiseStateProblem('PARTLY_SHIPPED', false)).toBeNull()
    expect(promiseStateProblem('PARTLY_SHIPPED', true)).toMatch(/lines are fixed once anything shipped/)
    expect(promiseStateProblem('READY', true)).toBeNull()
  })
})

describe('the order of an accepted version (SAL-200, SAL-203)', () => {
  const version: AcceptedVersion = {
    taxMode: 'IT_B2C',
    currency: 'EUR',
    language: 'it',
    billTo: { legalName: 'Made-up Rider' },
    shipTo: { line1: 'Via Esempio 1', city: 'Milano' },
    paymentTerms: 'Bonifico',
    promiseDate: '2026-12-15',
    noWithdrawal: false,
    depositAmount: 18_300,
    netAmount: 50_000,
    vatAmount: 11_000,
    grossAmount: 61_000,
    costAmount: 31_250,
    customerRef: 'RFQ-9',
    acceptedOn: '2026-11-02',
  }
  const line = (seq: number, extra: Partial<AcceptedLine> = {}): AcceptedLine => ({
    id: `Q${seq}`,
    seq,
    kind: 'SIZE_GRID',
    styleId: 'S',
    styleRevisionId: 'R1',
    revisionReleased: true,
    colourwayId: 'C',
    measurementProfileId: null,
    baseSize: null,
    description: 'Jacket BLK',
    note: null,
    quantity: 2,
    unitPrice: '305.000000',
    netAmount: 50_000,
    vatRatePct: '22.00',
    vatNature: null,
    vatAmount: 11_000,
    unitCost: '156.250000',
    costAmount: 31_250,
    sizes: [{ size: '50', quantity: 1, unitPrice: null }, { size: '52', quantity: 1, unitPrice: '310.000000' }],
    ...extra,
  })

  it('copies lines, sizes, prices on the version basis, costs, tax mode, addresses and the first promise', () => {
    const draft = orderFromVersion(version, [line(20, { styleRevisionId: 'R2', revisionReleased: false }), line(10)])
    expect(draft.priceBasis).toBe('GROSS')
    expect(draft.header).toEqual({
      status: 'CONFIRMED',
      orderDate: '2026-11-02',
      currency: 'EUR',
      language: 'it',
      taxMode: 'IT_B2C',
      billTo: { legalName: 'Made-up Rider' },
      shipTo: { line1: 'Via Esempio 1', city: 'Milano' },
      paymentTerms: 'Bonifico',
      customerRef: 'RFQ-9',
      requestedDate: null,
      promiseDate: '2026-12-15',
      originalPromiseDate: '2026-12-15',
      priority: 0,
      noWithdrawal: false,
      depositRequired: true,
      netAmount: 50_000,
      vatAmount: 11_000,
      grossAmount: 61_000,
      costAmount: 31_250,
    })
    expect(draft.lines.map((entry) => [entry.seq, entry.quoteLineId, entry.styleRevisionId, entry.unitPrice, entry.unitCost, entry.costAmount])).toEqual([
      [10, 'Q10', 'R1', '305.000000', '156.250000', 31_250],
      // Priced on a draft revision: the order fixes none (the work order picks the released one).
      [20, 'Q20', null, '305.000000', '156.250000', 31_250],
    ])
    expect(draft.lines[0]!.sizes).toEqual([{ size: '50', quantity: 1, unitPrice: null }, { size: '52', quantity: 1, unitPrice: '310.000000' }])
  })

  it('a business is priced net; no deposit asked: production does not wait for one', () => {
    const draft = orderFromVersion({ ...version, taxMode: 'IT_B2B', depositAmount: null }, [line(10)])
    expect([draft.priceBasis, draft.header.depositRequired]).toEqual(['NET', false])
  })
})

describe('what a person may do next', () => {
  it('cancel is held once production started; close waits for the settlement or a reason', () => {
    expect(orderActions('CONFIRMED', { releasedWorkOrders: 0, draftWorkOrders: [] })).toEqual([
      { action: 'changePromise', allowed: true, needsReason: true, held: null },
      { action: 'cancel', allowed: true, needsReason: true, held: null },
    ])
    expect(orderActions('CONFIRMED', { releasedWorkOrders: 1 }).find((action) => action.action === 'cancel')).toMatchObject({ allowed: false, held: expect.stringMatching(/no released work order/) })
    expect(orderActions('SHIPPED', { settlement: settled })).toEqual([
      { action: 'changePromise', allowed: true, needsReason: true, held: null },
      { action: 'close', allowed: true, needsReason: false, held: null },
    ])
    expect(orderActions('SHIPPED', { settlement: unsettled }).find((action) => action.action === 'close')).toMatchObject({ needsReason: true, held: expect.stringMatching(/^Not settled: A balance/) })
    expect(orderActions('CLOSED', {})).toEqual([])
  })
})
