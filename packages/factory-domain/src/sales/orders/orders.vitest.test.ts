import { describe, expect, it } from 'vitest'
import { InvalidStateError } from '../../core/errors'
import { assertTransition, canTransition } from '../../state/machine'
// B-OO-003: the cancel's impact check reads CANCEL_STATUSES too.
import { cancelImpact, type CancelFacts } from './daily'
import {
  CANCEL_STATUSES,
  daysLate,
  followMoves,
  orderActions,
  orderFromVersion,
  orderProgress,
  promiseProblems,
  promiseStateProblem,
  READY_QUALITY_WORDS, // B-OO-002
  releasedPiecesOf, // B-OO-002
  reversalMoves,
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

  // B-OO-002 (order overview N13, Owner D1): quality release is always in use — a reason never opens READY on its own.
  it('ready only when quality released every piece; a person\'s reason alone is refused (with the counts when read)', () => {
    expect(canTransition(salesOrderMachine, 'IN_PRODUCTION', 'READY', { released: false }).ok).toBe(false)
    expect(canTransition(salesOrderMachine, 'IN_PRODUCTION', 'READY', { released: true }).ok).toBe(true)
    expect(canTransition(salesOrderMachine, 'IN_PRODUCTION', 'READY', { released: false, reason: 'Quality signed the paper sheet.' })).toMatchObject({
      ok: false,
      reason: 'guard',
      missing: ['every piece still to ship released by quality'],
    })
    expect(canTransition(salesOrderMachine, 'IN_PRODUCTION', 'READY', { released: false, reason: '   ' }).ok).toBe(false)
    // Released, with or without a reason (the by-hand catch-up still gives one): allowed.
    expect(canTransition(salesOrderMachine, 'IN_PRODUCTION', 'READY', { released: true, reason: 'Quality released the last two.' }).ok).toBe(true)
    // The 409's words carry the counts the API read.
    const refused = canTransition(salesOrderMachine, 'IN_PRODUCTION', 'READY', { released: false, releasedPieces: { released: 2, toRelease: 4 }, reason: 'All done.' })
    expect(refused).toMatchObject({ ok: false, missing: ['every piece still to ship released by quality (2 of 4 released)'] })
    expect(() => assertTransition(salesOrderMachine, 'IN_PRODUCTION', 'READY', { released: false, releasedPieces: { released: 2, toRelease: 4 }, reason: 'All done.' })).toThrow(/2 of 4 released/)
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

  it('CANCELLED before anything shipped, with a reason and no draft left; released work orders are left behind (B-W2a-30)', () => {
    expect(canTransition(salesOrderMachine, 'CONFIRMED', 'CANCELLED', { reason: 'The customer withdrew.', releasedWorkOrders: 0, draftWorkOrders: [] }).ok).toBe(true)
    expect(canTransition(salesOrderMachine, 'CONFIRMED', 'CANCELLED', { reason: '', releasedWorkOrders: 0 })).toMatchObject({ ok: false, missing: ['a reason for the cancellation'] })
    // SAL-211: production started — the cancel names what it leaves behind instead of refusing.
    expect(canTransition(salesOrderMachine, 'CONFIRMED', 'CANCELLED', { reason: 'Too late.', releasedWorkOrders: 1 }).ok).toBe(true)
    expect(canTransition(salesOrderMachine, 'IN_PRODUCTION', 'CANCELLED', { reason: 'Too late.', releasedWorkOrders: 1 }).ok).toBe(true)
    expect(canTransition(salesOrderMachine, 'READY', 'CANCELLED', { reason: 'Too late.' }).ok).toBe(true)
    expect(canTransition(salesOrderMachine, 'CONFIRMED', 'CANCELLED', { reason: 'Too late.', releasedWorkOrders: 0, draftWorkOrders: ['WO-00007'] })).toMatchObject({
      ok: false,
      missing: ['its draft work orders cancelled first (WO-00007)'],
    })
    expect(canTransition(salesOrderMachine, 'READY', 'CANCELLED', { reason: 'Too late.', cancelBlocks: ['a shipment cancelled first'] })).toMatchObject({ ok: false, missing: ['a shipment cancelled first'] })
    expect(canTransition(salesOrderMachine, 'PARTLY_SHIPPED', 'CANCELLED', { reason: 'Too late.' })).toMatchObject({ ok: false, reason: 'not_allowed' })
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

  // B-W2b-398 (LOG-067): a shipped order whose shipments all arrived is delivered, before it closes.
  it('moves a shipped order to DELIVERED once every shipment that left arrived, then closes a settled one from there', () => {
    expect(followMoves('SHIPPED', { shipped: 'ALL', delivered: true, settlement: unsettled })).toEqual(['DELIVERED'])
    expect(followMoves('SHIPPED', { shipped: 'ALL', delivered: true, settlement: settled })).toEqual(['DELIVERED', 'CLOSED'])
    expect(followMoves('PARTLY_SHIPPED', { shipped: 'ALL', delivered: true, settlement: unsettled })).toEqual(['SHIPPED', 'DELIVERED'])
    expect(followMoves('DELIVERED', { shipped: 'ALL', delivered: true, settlement: settled })).toEqual(['CLOSED'])
    expect(followMoves('SHIPPED', { shipped: 'ALL', delivered: false, settlement: unsettled })).toEqual([])
    expect(followMoves('PARTLY_SHIPPED', { shipped: 'PARTLY', delivered: true })).toEqual([])
    expect(canTransition(salesOrderMachine, 'SHIPPED', 'DELIVERED', { shipped: 'ALL', delivered: false })).toMatchObject({ ok: false, missing: ['every ordered piece shipped and every shipment that left delivered'] })
    expect(canTransition(salesOrderMachine, 'DELIVERED', 'SHIPPED', { shipped: 'ALL' })).toMatchObject({ ok: false, reason: 'not_allowed' })
  })
})

// ── B-OO-001 (order overview N4, Owner D2): the order follows quality; back to IN_PRODUCTION only on a reversal ─────────────
describe('the order follows quality: READY after the last release, back only when a release is taken back', () => {
  it('followMoves plans READY once every piece is released and nothing shipped; READY is skipped once anything shipped', () => {
    expect(followMoves('IN_PRODUCTION', { releasedWorkOrders: 1, released: true, shipped: 'NONE' })).toEqual(['READY'])
    expect(followMoves('IN_PRODUCTION', { releasedWorkOrders: 1, released: true, shipped: 'PARTLY' })).toEqual(['PARTLY_SHIPPED'])
    expect(followMoves('IN_PRODUCTION', { releasedWorkOrders: 1, released: false, shipped: 'NONE' })).toEqual([])
    expect(followMoves('READY', { releasedWorkOrders: 1, released: true, shipped: 'NONE' })).toEqual([])
  })

  it('followMoves never plans IN_PRODUCTION from READY: a later partial release or a work order released never undoes it', () => {
    expect(followMoves('READY', { releasedWorkOrders: 1, released: false, shipped: 'NONE' })).toEqual([])
    expect(followMoves('READY', { releasedWorkOrders: 2, released: false, shipped: 'NONE', draftWorkOrders: [] })).toEqual([])
  })

  it('the reversal rule plans IN_PRODUCTION only for a READY order not all released any more, with nothing shipped', () => {
    expect(reversalMoves('READY', { releasedWorkOrders: 1, released: false, shipped: 'NONE' })).toEqual(['IN_PRODUCTION'])
    expect(reversalMoves('READY', { releasedWorkOrders: 1 })).toEqual(['IN_PRODUCTION'])
    expect(reversalMoves('READY', { releasedWorkOrders: 1, released: true, shipped: 'NONE' })).toEqual([])
    expect(reversalMoves('READY', { releasedWorkOrders: 1, released: false, shipped: 'PARTLY' })).toEqual([])
    expect(reversalMoves('IN_PRODUCTION', { releasedWorkOrders: 1, released: false, shipped: 'NONE' })).toEqual([])
    expect(reversalMoves('PARTLY_SHIPPED', { releasedWorkOrders: 1, released: false, shipped: 'PARTLY' })).toEqual([])
    expect(reversalMoves('CONFIRMED', { releasedWorkOrders: 0, released: false, shipped: 'NONE' })).toEqual([])
    // A person's reason never takes part.
    expect(reversalMoves('READY', { releasedWorkOrders: 1, released: true, shipped: 'NONE', reason: 'should not count' })).toEqual([])
  })

  it('the machine lets READY go back to IN_PRODUCTION only as a reversal leaves it', () => {
    expect(canTransition(salesOrderMachine, 'READY', 'IN_PRODUCTION', { releasedWorkOrders: 1, released: false, shipped: 'NONE' }).ok).toBe(true)
    expect(canTransition(salesOrderMachine, 'READY', 'IN_PRODUCTION', { releasedWorkOrders: 1, released: true, shipped: 'NONE' })).toMatchObject({
      ok: false,
      missing: ['a quality release taken back, so not every piece is released any more, and nothing shipped yet'],
    })
    expect(canTransition(salesOrderMachine, 'READY', 'IN_PRODUCTION', { releasedWorkOrders: 1, released: false, shipped: 'PARTLY' }).ok).toBe(false)
    // From CONFIRMED the guard is still a released work order of its lines.
    expect(canTransition(salesOrderMachine, 'CONFIRMED', 'IN_PRODUCTION', { releasedWorkOrders: 0, released: false })).toMatchObject({ ok: false, missing: ['a released work order of its lines'] })
    expect(canTransition(salesOrderMachine, 'PARTLY_SHIPPED', 'IN_PRODUCTION', { released: false, shipped: 'NONE' })).toMatchObject({ ok: false, reason: 'not_allowed' })
  })
})
// ── end B-OO-001 ──

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
      { lineId: 'L1', seq: 10, size: '50', ordered: 2, inWorkOrders: 2, made: null, released: 2, shipped: 2, invoiced: '1', toShip: 0, closedShort: 0 },
      { lineId: 'L1', seq: 10, size: '52', ordered: 3, inWorkOrders: 3, made: null, released: 1, shipped: 0, invoiced: '0', toShip: 3, closedShort: 0 },
      // A made-to-measure unit has no size rows: everything of its line counts, whatever the size.
      { lineId: 'L2', seq: 20, size: null, ordered: 1, inWorkOrders: 1, made: null, released: 0, shipped: 0, invoiced: '0', toShip: 1, closedShort: 0 },
    ])
    expect(progress.lines.map((line) => [line.lineId, line.ordered, line.shipped, line.toShip])).toEqual([['L1', 5, 2, 3], ['L2', 1, 0, 1]])
    expect(progress.totals).toEqual({ ordered: 6, inWorkOrders: 6, made: null, released: 3, shipped: 2, invoiced: '1', toShip: 4, closedShort: 0 })
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

  it('a line closed short is done: its left pieces are closed short, nothing to ship (B-W2a-30, SAL-210)', () => {
    const facts = {
      lines,
      inWorkOrders: [],
      released: [{ lineId: 'L1', size: '50', quantity: 2 }, { lineId: 'L2', size: null, quantity: 1 }],
      shipped: [{ lineId: 'L1', size: '50', quantity: 2 }, { lineId: 'L2', size: null, quantity: 1 }],
      invoiced: [],
    }
    const open = orderProgress(facts)
    expect([open.shipped, open.totals.toShip, open.totals.closedShort]).toEqual(['PARTLY', 3, 0])
    const closed = orderProgress({ ...facts, closedShort: new Set(['L1']) })
    expect(closed.rows.find((row) => row.size === '52')).toMatchObject({ ordered: 3, shipped: 0, toShip: 0, closedShort: 3 })
    expect([closed.shipped, closed.released, closed.totals.toShip, closed.totals.closedShort]).toEqual(['ALL', true, 0, 3])
    // Every line closed and nothing shipped is not "shipped".
    expect(orderProgress({ lines: [lines[1]!], inWorkOrders: [], released: [], shipped: [], invoiced: [], closedShort: new Set(['L1']) }).shipped).toBe('NONE')
  })
})

describe('dates and the promise (SAL-206): the first promise is never overwritten', () => {
  it('late: days past the promise of an order not shipped yet', () => {
    expect(daysLate('IN_PRODUCTION', '2026-11-10', '2026-11-13')).toBe(3)
    expect(daysLate('IN_PRODUCTION', '2026-11-10', '2026-11-10')).toBe(0)
    expect(daysLate('SHIPPED', '2026-11-10', '2026-11-13')).toBeNull()
    expect(daysLate('CONFIRMED', null, '2026-11-13')).toBeNull()
  })

  it('a reason that fits (none is fine: B-OL-004), a day from today on, a different day, lines of this order once', () => {
    const base = { status: 'CONFIRMED' as const, current: '2026-12-10', promiseDate: '2026-12-20', reason: 'Leather arrives late.', lineIds: [], knownLineIds: ['L1', 'L2'], today: '2026-11-01' }
    expect(promiseProblems(base)).toEqual([])
    // B-OL-004 (order lines plan D2): no reason is fine (the API stores the automatic words); one too long is refused.
    expect(promiseProblems({ ...base, reason: ' ' })).toEqual([])
    expect(promiseProblems({ ...base, reason: undefined })).toEqual([])
    expect(promiseProblems({ ...base, reason: 'x'.repeat(1001) }).map((issue) => issue.path)).toEqual(['body/reason'])
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
  it('cancel is held by a draft or a block of the impact check; close waits for the settlement or a reason', () => {
    expect(orderActions('CONFIRMED', { releasedWorkOrders: 0, draftWorkOrders: [] })).toEqual([
      { action: 'changePromise', allowed: true, needsReason: true, held: null },
      { action: 'cancel', allowed: true, needsReason: true, held: null },
    ])
    expect(orderActions('IN_PRODUCTION', { releasedWorkOrders: 1 }).find((action) => action.action === 'cancel')).toMatchObject({ allowed: true })
    expect(orderActions('READY', { draftWorkOrders: ['WO-9'] }).find((action) => action.action === 'cancel')).toMatchObject({ allowed: false, held: expect.stringMatching(/draft work orders cancelled first/) })
    expect(orderActions('PARTLY_SHIPPED', {}).find((action) => action.action === 'cancel')).toBeUndefined()
    expect(orderActions('SHIPPED', { settlement: settled })).toEqual([
      { action: 'changePromise', allowed: true, needsReason: true, held: null },
      { action: 'close', allowed: true, needsReason: false, held: null },
    ])
    expect(orderActions('SHIPPED', { settlement: unsettled }).find((action) => action.action === 'close')).toMatchObject({ needsReason: true, held: expect.stringMatching(/^Not settled: A balance/) })
    expect(orderActions('CLOSED', {})).toEqual([])
  })
  // ── B-OO-003 (order overview N3): an order waiting for a yes is cancelled too ──
  it('a waiting order offers cancel (a reason asked); its impact check has no STATE block; shipped states keep theirs', () => {
    expect(CANCEL_STATUSES).toContain('PENDING_APPROVAL')
    expect(orderActions('PENDING_APPROVAL', {})).toEqual([
      { action: 'changePromise', allowed: true, needsReason: true, held: null },
      { action: 'cancel', allowed: true, needsReason: true, held: null },
    ])
    expect(canTransition(salesOrderMachine, 'PENDING_APPROVAL', 'CANCELLED', { reason: 'The customer withdrew while it waited.' }).ok).toBe(true)
    const waiting: CancelFacts = { status: 'PENDING_APPROVAL', workOrders: [], shipments: [], invoices: [], deposits: [{ id: 'd1', status: 'OPEN', amount: 18_300 }], milestones: [], reservations: [], purchaseOrders: [] }
    const impact = cancelImpact(waiting)
    expect(impact.blocks).toEqual([])
    expect(impact.cancellable).toBe(true)
    expect(impact.touches.map((item) => item.code)).toEqual(['DEPOSITS_CANCELLED'])
    // An order that shipped keeps its STATE block, in words that say goods left.
    expect(cancelImpact({ ...waiting, status: 'PARTLY_SHIPPED' }).blocks).toEqual([expect.objectContaining({ code: 'STATE', message: expect.stringMatching(/goods left/) })])
  })
  // ── end B-OO-003 ──
  // ── B-OO-002 (order overview N13, Owner D1): Mark ready listed while in production, allowed only after quality released every piece ──
  it('B-OO-002: markReady is listed for an order in production; held with the N of M words until quality released every piece', () => {
    const ready = (facts: Parameters<typeof orderActions>[1]) => orderActions('IN_PRODUCTION', facts).find((action) => action.action === 'markReady')
    expect(ready({ releasedWorkOrders: 1, released: false, releasedPieces: { released: 3, toRelease: 7 } })).toEqual({
      action: 'markReady',
      allowed: false,
      needsReason: true,
      held: 'Quality releases the garments: 3 of 7 released. The order turns Ready by itself when all are.',
    })
    // Released: the catch-up before the system's follow (a reason is still asked).
    expect(ready({ releasedWorkOrders: 1, released: true, releasedPieces: { released: 7, toRelease: 7 } })).toEqual({ action: 'markReady', allowed: true, needsReason: true, held: null })
    // No counts read: the same words without them.
    expect(ready({ released: false })).toMatchObject({ allowed: false, held: 'Quality releases the garments. The order turns Ready by itself when all are.' })
    // A reason in the facts never opens it.
    expect(ready({ released: false, reason: 'Quality signed the paper sheet.' })).toMatchObject({ allowed: false })
    // Only in production: never for another state.
    for (const status of ['CONFIRMED', 'READY', 'PARTLY_SHIPPED', 'SHIPPED', 'PENDING_APPROVAL'] as const) expect(orderActions(status, { released: true }).map((action) => action.action), status).not.toContain('markReady')
    // The words, it + en (the office web's held.readyQuality says the same).
    expect(READY_QUALITY_WORDS).toEqual({
      en: 'Quality releases the garments: {n} of {m} released. The order turns Ready by itself when all are.',
      it: "Il rilascio lo fa la qualità: {n} su {m} rilasciati. L'ordine diventa Pronto da solo quando lo sono tutti.",
    })
  })

  it('B-OO-002: releasedPiecesOf — each size up to what it has to release, closed short left out, fee lines never counted; agrees with orderProgress', () => {
    const row = (ordered: number, released: number, closedShort = 0) => ({ ordered, released, closedShort })
    // BLK 50 ×2 released 2, BLK 52 ×2 released 3 (one made extra: it never makes up for another size), RED 52 ×3 released 1.
    expect(releasedPiecesOf([{ kind: 'SIZE_GRID', rows: [row(2, 2), row(2, 3)] }, { kind: 'SIZE_GRID', rows: [row(3, 1)] }])).toEqual({ released: 5, toRelease: 7 })
    // A line closed short: what will not be made is not to release (2 ordered, 1 shipped and closed: 1 to release).
    expect(releasedPiecesOf([{ kind: 'SIZE_GRID', rows: [row(2, 1, 1)] }])).toEqual({ released: 1, toRelease: 1 })
    // A fee line (B-W2b-330) and a made-to-measure unit (one row, no size).
    expect(releasedPiecesOf([{ kind: 'FEE', rows: [row(1, 0)] }, { kind: 'MADE_TO_MEASURE', rows: [row(1, 0)] }])).toEqual({ released: 0, toRelease: 1 })
    // A reversal never counts below zero.
    expect(releasedPiecesOf([{ kind: 'SIZE_GRID', rows: [row(2, -1)] }])).toEqual({ released: 0, toRelease: 2 })
    expect(releasedPiecesOf([])).toEqual({ released: 0, toRelease: 0 })
    // The same answer as orderProgress's `released`: all of them released exactly when it says so.
    const facts = (released: number) => ({
      lines: [{ id: 'L1', seq: 10, quantity: 4, sizes: [{ size: '50', quantity: 2 }, { size: '52', quantity: 2 }] }],
      inWorkOrders: [],
      released: [{ lineId: 'L1', size: '50', quantity: 2 }, { lineId: 'L1', size: '52', quantity: released }],
      shipped: [],
      invoiced: [],
    })
    for (const released of [0, 1, 2, 3]) {
      const progress = orderProgress(facts(released))
      const pieces = releasedPiecesOf([{ kind: 'SIZE_GRID', rows: progress.rows }])
      expect(pieces.released === pieces.toRelease, String(released)).toBe(progress.released)
    }
  })
  // ── end B-OO-002 ──
  // F-SA-201: a delivered order offers Close order as a shipped one does (settled: no reason; not settled: held, a reason).
  it('a delivered order is closed like a shipped one', () => {
    expect(orderActions('DELIVERED', { settlement: settled })).toEqual([
      { action: 'changePromise', allowed: true, needsReason: true, held: null },
      { action: 'close', allowed: true, needsReason: false, held: null },
    ])
    expect(orderActions('DELIVERED', { settlement: unsettled }).find((action) => action.action === 'close')).toMatchObject({ needsReason: true, held: expect.stringMatching(/^Not settled: A balance/) })
    expect(canTransition(salesOrderMachine, 'DELIVERED', 'CLOSED', { settlement: settled, reason: null }).ok).toBe(true)
  })
})
