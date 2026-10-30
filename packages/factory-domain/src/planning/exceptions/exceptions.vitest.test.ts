import { describe, expect, it } from 'vitest'
import { pegMaterial, type DemandPart } from '../mrp/net'
import { readinessOf, type ReadinessMaterial } from '../readiness/readiness'
import { detectExceptions, EVALUATED_KINDS, type DetectMaterial } from './detect'
import { acknowledgeProblem, isSnoozed, refreshOf, resolveProblems, snoozeProblems } from './lifecycle'

/**
 * Material readiness (../readiness, PLN-086) and the exception list of a run (./detect, ./lifecycle, PLN-193), pure.
 */

const part = (fields: Partial<DemandPart> & Pick<DemandPart, 'key' | 'quantity'>): DemandPart => ({
  orderId: 'so-1',
  orderNumber: 'SO-1',
  orderLineId: 'ol-1',
  lineSeq: 10,
  partyId: 'party-1',
  size: '52',
  workOrderId: 'wo-1',
  workOrderNumber: 'WO-1',
  pieces: 1,
  dueDate: '2026-12-01',
  issued: '0',
  ...fields,
})
const lot = (id: string) => ({ id, qualityStatus: 'RELEASED' as const, requiresCrViTest: false, crViStatus: 'NOT_REQUIRED' as const })
const peg = (fields: Partial<Parameters<typeof pegMaterial>[0]>) =>
  pegMaterial({ itemColourId: 'blk', parts: [], stock: [], lotOf: lot, purchases: [], runDate: '2026-11-01', ...fields })
const material = (label: string, pegging: ReturnType<typeof peg>): ReadinessMaterial => ({ itemId: label, itemColourId: 'blk', label, uom: 'FT2', pegging })
const purchaseOf = (statuses: Record<string, string>) => (id: string) => (statuses[id] ? { purchaseOrderNumber: id.toUpperCase(), purchaseOrderStatus: statuses[id]!, dueDate: '2026-11-20' } : undefined)
const stock = (quantity: string) => [{ itemColourId: 'blk', lotId: 'lot-1', quantity, hides: 1 }]
const po = (id: string, quantity: string, dueDate: string) => ({ purchaseOrderLineId: id, purchaseOrderNumber: id.toUpperCase(), openQuantity: quantity, dueDate })

describe('material readiness: one word per work order (PLN-086)', () => {
  const today = '2026-11-01'
  it('says each material in a word and the work order by its worst one', () => {
    const received = material('LEA-1', peg({ parts: [part({ key: 'a', quantity: '20', issued: '5' })], stock: stock('15'), reservations: [{ id: 'r', itemId: 'LEA-1', itemColourId: 'blk', lotId: null, hideId: null, open: '15', workOrderId: 'wo-1', salesOrderLineId: null, demandOpen: true }] }))
    const notBooked = material('LIN-1', peg({ parts: [part({ key: 'a', quantity: '10' })], stock: stock('10') }))
    const expected = material('PRO-1', peg({ parts: [part({ key: 'a', quantity: '10' })], purchases: [po('po-sent', '10', '2026-11-20')] }))
    const requested = material('ZIP-1', peg({ parts: [part({ key: 'a', quantity: '4' })], purchases: [po('po-draft', '4', '2026-11-25')] }))
    const statuses = purchaseOf({ 'po-sent': 'CONFIRMED', 'po-draft': 'DRAFT' })
    const [only] = readinessOf(['wo-1'], [received, notBooked, expected], statuses, today)
    expect(only!.materials.map((row) => [row.label, row.word])).toEqual([
      ['PRO-1', 'EXPECTED'],
      ['LIN-1', 'NOT_BOOKED'],
      ['LEA-1', 'RECEIVED'],
    ])
    expect(only).toMatchObject({ word: 'EXPECTED', label: 'Expected 2026-11-20', date: '2026-11-20' })
    const [more] = readinessOf(['wo-1'], [received, notBooked, expected, requested], statuses, today)
    expect(more).toMatchObject({ word: 'REQUESTED', reason: 'ZIP-1: 4 ft² in draft PO-DRAFT, not sent to the supplier yet. 1 more material needs attention.' })
    expect(readinessOf(['wo-1'], [received], statuses, today)[0]).toMatchObject({ word: 'RECEIVED', label: 'Received' })
  })

  it('NOT_ENOUGH when nothing covers it; DELAYED when the purchase line comes late or is past its date', () => {
    const short = material('LEA-1', peg({ parts: [part({ key: 'a', quantity: '30' })], stock: stock('10') }))
    expect(readinessOf(['wo-1'], [short], purchaseOf({}), today)[0]).toMatchObject({ word: 'NOT_ENOUGH', reason: 'LEA-1: 20 ft² short and nothing ordered for it yet.' })
    const late = material('LEA-1', peg({ parts: [part({ key: 'a', quantity: '30' })], purchases: [po('po-late', '30', '2026-12-15')] }))
    expect(readinessOf(['wo-1'], [late], purchaseOf({ 'po-late': 'SENT' }), today)[0]).toMatchObject({ word: 'DELAYED', date: '2026-12-15', reason: 'LEA-1: PO-LATE arrives 2026-12-15, after it is needed on 2026-12-01.' })
    const overdue = material('LEA-1', peg({ parts: [part({ key: 'a', quantity: '30' })], purchases: [po('po-old', '30', '2026-10-28')] }))
    expect(readinessOf(['wo-1'], [overdue], purchaseOf({ 'po-old': 'CONFIRMED' }), today)[0]).toMatchObject({ word: 'DELAYED', date: '2026-10-28', reason: 'LEA-1: PO-OLD was due 2026-10-28 and is not received yet.' })
    const firmLate = material('LEA-1', peg({ parts: [part({ key: 'a', quantity: '30' })], firm: { requirementId: 'f', baseQuantity: '30', date: '2026-12-05' } }))
    expect(readinessOf(['wo-1'], [firmLate], purchaseOf({}), today)[0]).toMatchObject({ word: 'DELAYED', date: '2026-12-05' })
    expect(readinessOf(['wo-9'], [short], purchaseOf({}), today)[0]).toMatchObject({ word: 'NOT_PLANNED', materials: [] })
  })
})

const detect = (fields: Partial<DetectMaterial> & Pick<DetectMaterial, 'pegging'>): DetectMaterial => ({ seq: 1, itemId: 'leather', itemColourId: 'blk', action: 'BUY', label: 'LEA-1 BLK', uom: 'FT2', leadTimeDays: 14, keptInStock: false, safetyStock: null, ...fields })
const purchases = (id: string) => ({ purchaseOrderId: `order-${id}`, purchaseOrderNumber: id.toUpperCase() })

describe('the exception list of a run (PLN-193)', () => {
  const runDate = '2026-11-25'
  it('SHORT with the orders it touches and how late an order today would be; SUPPLY_LATE for a purchase line after the need', () => {
    const pegging = pegMaterial({ itemColourId: 'blk', parts: [part({ key: 'a', quantity: '100' }), part({ key: 'b', orderId: 'so-2', orderNumber: 'SO-2', orderLineId: 'ol-2', workOrderId: null, workOrderNumber: null, dueDate: '2026-12-20', quantity: '50' })], stock: [], lotOf: lot, purchases: [po('po-1', '100', '2026-12-10')], runDate })
    const found = detectExceptions({ runDate, materials: [detect({ pegging })], purchaseOf: purchases })
    expect(found.map((condition) => [condition.kind, condition.key])).toEqual([
      ['SHORT', 'SHORT:blk'],
      ['SUPPLY_LATE', 'SUPPLY_LATE:po-1'],
    ])
    expect(found[0]).toMatchObject({ ordersAffected: 1, daysLate: 8, record: { type: 'WorkOrder', id: 'wo-1' }, facts: { quantity: '100.0000', needDate: '2026-12-01', earliestArrival: '2026-12-09' } })
    expect(found[1]).toMatchObject({ daysLate: 9, record: { type: 'PurchaseOrder', id: 'order-po-1' }, facts: { supplyDate: '2026-12-10', needDate: '2026-12-01', overdue: false } })
    expect(found[0]!.sentence).toBe('LEA-1 BLK: 100 FT2 short for SO-1, needed 2026-12-01; nothing is ordered for it yet. Ordered today it would be 8 days late.')
  })

  it('PAST_DUE, overdue purchase lines, EXCESS and CANCEL; nothing for stock a reorder rule keeps', () => {
    const pegging = pegMaterial({
      itemColourId: 'blk',
      parts: [part({ key: 'a', dueDate: '2026-11-20', quantity: '40' })],
      stock: [],
      lotOf: lot,
      purchases: [po('po-1', '30', '2026-11-10'), po('po-2', '25', '2026-11-12')],
      firm: { requirementId: 'f', baseQuantity: '20', date: '2026-11-30' },
      runDate,
    })
    const kinds = detectExceptions({ runDate, materials: [detect({ pegging })], purchaseOf: purchases }).map((condition) => condition.key)
    expect(kinds).toEqual(['SUPPLY_LATE:po-1', 'SUPPLY_LATE:po-2', 'PAST_DUE:ol-1', 'EXCESS:po-2', 'CANCEL:blk'])
    const kept = detectExceptions({ runDate, materials: [detect({ pegging, keptInStock: true })], purchaseOf: purchases }).map((condition) => condition.kind)
    expect(kept).not.toContain('EXCESS')
    expect(kept).not.toContain('CANCEL')
  })

  it('BELOW_SAFETY_STOCK when the projected stock dips below it; NEGATIVE_STOCK when more is reserved than stock backs; lanes', () => {
    const pegging = pegMaterial({ itemColourId: 'blk', parts: [part({ key: 'a', dueDate: '2026-12-01', quantity: '50' })], stock: stock('60'), lotOf: lot, purchases: [], runDate, reservations: [{ id: 'r', itemId: 'leather', itemColourId: 'blk', lotId: 'lot-2', hideId: null, open: '5', workOrderId: 'wo-1', salesOrderLineId: null, demandOpen: true }] })
    const found = detectExceptions({
      runDate,
      materials: [detect({ pegging, safetyStock: '20' })],
      purchaseOf: purchases,
      safetyOnly: [{ itemId: 'zip', itemColourId: null, label: 'ZIP-1', uom: 'PCS', safetyStock: '10', usable: '4', arrivals: [] }],
      overloads: [{ laneKind: 'LINE', laneId: 'line-1', laneCode: 'L1', bucketKey: '2026-W49', from: '2026-11-30', to: '2026-12-06', loadPct: '120.5', availableMinutes: '1000.0', bookedMinutes: '1205.0' }],
    })
    expect(found.map((condition) => [condition.kind, condition.key])).toEqual([
      ['LANE_OVERLOADED', 'LANE_OVERLOADED:line-1:2026-W49'],
      ['BELOW_SAFETY_STOCK', 'BELOW_SAFETY_STOCK:blk'],
      ['BELOW_SAFETY_STOCK', 'BELOW_SAFETY_STOCK:zip'],
      ['NEGATIVE_STOCK', 'NEGATIVE_STOCK:blk'],
    ])
    expect(found[1]!.facts).toMatchObject({ safetyStock: '20.0000', projected: '10.0000', date: '2026-12-01' })
    expect(found[2]!.facts).toMatchObject({ projected: '4.0000', date: runDate })
    expect(found[3]!.facts).toMatchObject({ quantity: '5.0000' })
    expect(found[0]!.record).toEqual({ type: 'Line', id: 'line-1' })
  })

  it("a run's refresh: found again keeps its row (a snooze until the next run ends), found first is raised, gone is cleared (its kinds only)", () => {
    const at = new Date('2026-11-20T08:00:00Z')
    const open = [
      { id: 'e1', kind: 'SHORT' as const, dedupeKey: 'SHORT:blk', status: 'ACKNOWLEDGED' as const, snoozedAt: at, snoozedUntil: null },
      { id: 'e2', kind: 'SUPPLY_LATE' as const, dedupeKey: 'SUPPLY_LATE:po-1', status: 'NEW' as const, snoozedAt: null, snoozedUntil: null },
      { id: 'e3', kind: 'LANE_UNDERUSED' as const, dedupeKey: 'LANE_UNDERUSED:l1:w1', status: 'NEW' as const, snoozedAt: null, snoozedUntil: null },
    ]
    const conditions = [
      { kind: 'SHORT' as const, key: 'SHORT:blk', itemId: 'leather', itemColourId: 'blk', requirementSeq: 1, record: null, facts: {}, ordersAffected: 1, daysLate: null, sentence: '' },
      { kind: 'PAST_DUE' as const, key: 'PAST_DUE:ol-1', itemId: null, itemColourId: null, requirementSeq: null, record: null, facts: {}, ordersAffected: 1, daysLate: 3, sentence: '' },
    ]
    const refresh = refreshOf(open, conditions, EVALUATED_KINDS)
    expect(refresh.found.map((entry) => [entry.row.id, entry.endSnooze])).toEqual([['e1', true]])
    expect(refresh.raised.map((condition) => condition.key)).toEqual(['PAST_DUE:ol-1'])
    expect(refresh.cleared.map((row) => row.id)).toEqual(['e2'])
  })

  it('acknowledge once, snooze ahead or until the next run, resolve with a note', () => {
    const now = new Date('2026-11-20T08:00:00Z')
    expect(acknowledgeProblem({ status: 'NEW' })).toBeNull()
    expect(acknowledgeProblem({ status: 'ACKNOWLEDGED' })).toMatch(/already/)
    expect(snoozeProblems({ status: 'NEW' }, null, now)).toEqual({ conflict: null, issues: [] })
    expect(snoozeProblems({ status: 'NEW' }, new Date('2026-11-19T00:00:00Z'), now).issues).toHaveLength(1)
    expect(snoozeProblems({ status: 'RESOLVED' }, null, now).conflict).toMatch(/resolved/)
    expect(resolveProblems({ status: 'ACKNOWLEDGED' }, 'Chased: ships Monday').issues).toEqual([])
    expect(resolveProblems({ status: 'NEW' }, ' ok ').issues).toHaveLength(1)
    expect(isSnoozed({ snoozedAt: now, snoozedUntil: null }, now)).toBe(true)
    expect(isSnoozed({ snoozedAt: now, snoozedUntil: new Date('2026-11-20T07:00:00Z') }, now)).toBe(false)
  })
})
