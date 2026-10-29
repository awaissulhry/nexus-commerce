import { describe, expect, it } from 'vitest'
import { canTransition } from '../../state/machine'
import {
  closeProblems,
  cleanList,
  completeActionProblems,
  dutiesOf,
  dutyDateProblems,
  editProblems,
  entryProblems,
  registerEntryMachine,
  type CloseFacts,
} from './rules'
import { buildTrace, leftShipmentNumbers, type TraceInput } from './trace'

const at = (iso: string) => new Date(iso)
const NOW = at('2026-11-30T10:00:00.000Z')

const done: CloseFacts['entry'] = {
  status: 'OPEN',
  risk: 'NO',
  actionTaken: 'Zip pulls replaced on every jacket of the batch.',
  actionCompletedAt: at('2026-11-28T09:00:00.000Z'),
  distributorsInformedAt: null,
  authorityNotifiedAt: null,
  authorityReference: null,
}
const codes = (facts: CloseFacts) => closeProblems(facts).map((problem) => problem.code)

describe('closing a register entry (Reg. (EU) 2016/425 art. 8(4), 8(8))', () => {
  it('closes with a reason, the risk decided and the corrective action done when nothing left the factory', () => {
    expect(closeProblems({ entry: done, reason: 'Fixed in the factory.', shippedGoods: false })).toEqual([])
    expect(canTransition(registerEntryMachine, 'OPEN', 'CLOSED', { entry: done, reason: 'Fixed.', shippedGoods: false }).ok).toBe(true)
  })

  it('refuses without a reason, with the risk still being assessed, or without the corrective action recorded and done', () => {
    expect(codes({ entry: done, reason: '  ', shippedGoods: false })).toEqual(['NO_REASON'])
    expect(codes({ entry: { ...done, risk: 'ASSESSING' }, reason: 'x', shippedGoods: false })).toEqual(['RISK_NOT_ASSESSED'])
    expect(codes({ entry: { ...done, actionTaken: null, actionCompletedAt: null }, reason: 'x', shippedGoods: false })).toEqual(['NO_CORRECTIVE_ACTION'])
    expect(codes({ entry: { ...done, actionCompletedAt: null }, reason: 'x', shippedGoods: false })).toEqual(['CORRECTIVE_ACTION_NOT_DONE'])
  })

  it('asks the distributors informed when garments it concerns have left, naming the shipments', () => {
    const problems = closeProblems({ entry: done, reason: 'x', shippedGoods: true, shipmentNumbers: ['SH-0001', 'SH-0004'] })
    expect(problems).toEqual([{ code: 'DISTRIBUTORS_NOT_INFORMED', message: expect.stringContaining('(SH-0001, SH-0004)') }])
    expect(closeProblems({ entry: { ...done, distributorsInformedAt: NOW }, reason: 'x', shippedGoods: true })).toEqual([])
  })

  it('asks the authority told, with the date and its reference, when the PPE may present a risk', () => {
    expect(codes({ entry: { ...done, risk: 'YES' }, reason: 'x', shippedGoods: false })).toEqual(['AUTHORITY_NOT_NOTIFIED'])
    expect(codes({ entry: { ...done, risk: 'YES', authorityNotifiedAt: NOW }, reason: 'x', shippedGoods: false })).toEqual(['AUTHORITY_REFERENCE_MISSING'])
    expect(codes({ entry: { ...done, risk: 'YES', authorityNotifiedAt: NOW, authorityReference: 'MSA-TEST-1' }, reason: 'x', shippedGoods: false })).toEqual([])
    const refused = canTransition(registerEntryMachine, 'OPEN', 'CLOSED', { entry: { ...done, risk: 'YES' }, reason: 'x', shippedGoods: false })
    expect(refused.ok).toBe(false)
  })

  it('never moves a closed entry', () => {
    expect(codes({ entry: { ...done, status: 'CLOSED' }, reason: 'x', shippedGoods: false })).toEqual(['CLOSED'])
    expect(canTransition(registerEntryMachine, 'CLOSED', 'OPEN', { entry: done, reason: 'x', shippedGoods: false }).ok).toBe(false)
  })

  it('lists the duties and whether the law asks them now', () => {
    expect(dutiesOf({ ...done, risk: 'YES' }, true).map((duty) => [duty.code, duty.required, duty.done])).toEqual([
      ['RISK_ASSESSMENT', true, true],
      ['CORRECTIVE_ACTION', true, true],
      ['DISTRIBUTORS', true, false],
      ['AUTHORITY', true, false],
    ])
    expect(dutiesOf({ ...done, risk: 'ASSESSING' }, false).filter((duty) => duty.required).map((duty) => duty.code)).toEqual(['RISK_ASSESSMENT', 'CORRECTIVE_ACTION'])
  })
})

describe('writing an entry', () => {
  const entry = { kind: 'COMPLAINT' as const, reportedAt: at('2026-11-21T10:00:00.000Z'), description: 'A zip pull came off.', investigation: null, actionTaken: null, batchNumbers: [], serials: [], lotIds: [], workOrderIds: [], shipmentIds: [] }

  it('needs a description and a past report time; a recall names what it calls back', () => {
    expect(entryProblems(entry, NOW)).toEqual([])
    expect(entryProblems({ ...entry, description: ' ', reportedAt: at('2026-12-01T00:00:00.000Z') }, NOW).map((issue) => issue.path)).toEqual(['body/description', 'body/reportedAt'])
    expect(entryProblems({ ...entry, kind: 'RECALL' }, NOW)).toEqual([{ path: 'body/batchNumbers', message: expect.stringContaining('A recall names what it calls back') }])
    expect(entryProblems({ ...entry, kind: 'RECALL', batchNumbers: ['BT-1'] }, NOW)).toEqual([])
  })

  it('cleans lists and keeps a done corrective action as it was done', () => {
    expect(cleanList([' BT-1 ', '', 'BT-2', 'BT-1'])).toEqual(['BT-1', 'BT-2'])
    expect(editProblems({ status: 'OPEN', actionTaken: 'Replace', actionCompletedAt: NOW }, { actionTaken: 'Something else' }).map((problem) => problem.code)).toEqual(['ACTION_DONE'])
    expect(editProblems({ status: 'OPEN', actionTaken: 'Replace', actionCompletedAt: NOW }, { actionTaken: 'Replace' })).toEqual([])
    expect(completeActionProblems({ status: 'OPEN', actionTaken: null, actionCompletedAt: null }).map((problem) => problem.code)).toEqual(['NO_CORRECTIVE_ACTION'])
  })

  it('dates a duty no later than now and no earlier than the day it was reported', () => {
    const reported = at('2026-11-21T10:00:00.000Z')
    expect(dutyDateProblems(at('2026-11-21T07:00:00.000Z'), reported, NOW, 'body/at')).toEqual([])
    expect(dutyDateProblems(at('2026-11-20T10:00:00.000Z'), reported, NOW, 'body/at')).toEqual([{ path: 'body/at', message: 'This is before the entry was reported (2026-11-21).' }])
    expect(dutyDateProblems(at('2026-12-01T10:00:00.000Z'), reported, NOW, 'body/at')).toEqual([{ path: 'body/at', message: 'This date is in the future.' }])
  })
})

describe('the trace from batches, serials and lots to shipments and customers', () => {
  const style = 'style-a'
  const base: TraceInput = {
    concern: { styleId: style, batchNumbers: [], serials: [], lotIds: [], workOrderIds: [], shipmentIds: [] },
    workOrders: [
      { id: 'wo-1', number: 'WO-0001', batchNumber: 'BT-0001', styleId: style, styleCode: 'JKT-02', revision: 1, status: 'IN_PROGRESS' },
      { id: 'wo-3', number: 'WO-0003', batchNumber: 'BT-0003', styleId: style, styleCode: 'JKT-02', revision: 1, status: 'RELEASED' },
      { id: 'wo-9', number: 'WO-0009', batchNumber: 'BT-0009', styleId: 'style-b', styleCode: 'PNT-01', revision: 1, status: 'RELEASED' },
    ],
    serials: [
      { serial: 'S-1', status: 'SHIPPED', workOrderId: 'wo-3', workOrderSizeId: 'c3', shipmentLineId: 'l3' },
      { serial: 'S-2', status: 'RELEASED', workOrderId: 'wo-3', workOrderSizeId: 'c3', shipmentLineId: null },
    ],
    lots: [{ id: 'lot-1', code: 'LOT-HIDE-1' }],
    lotIssues: [
      { lotId: 'lot-1', workOrderId: 'wo-1' },
      { lotId: 'lot-1', workOrderId: 'wo-9' },
    ],
    cells: [
      { id: 'c1', workOrderId: 'wo-1', colourwayCode: 'BLK', size: '50', quantity: 2 },
      { id: 'c2', workOrderId: 'wo-1', colourwayCode: 'RED', size: '52', quantity: 1 },
      { id: 'c3', workOrderId: 'wo-3', colourwayCode: 'BLK', size: '52', quantity: 4 },
    ],
    released: [
      { workOrderSizeId: 'c1', quantity: 2 },
      { workOrderSizeId: 'c2', quantity: 1 },
      { workOrderSizeId: 'c3', quantity: 2 },
    ],
    reversed: [{ workOrderSizeId: 'c1', quantity: 1 }],
    lines: [
      { id: 'l1', shipmentId: 'sh-1', workOrderId: 'wo-1', workOrderSizeId: 'c1', quantity: 1 },
      { id: 'l2', shipmentId: 'sh-1', workOrderId: 'wo-1', workOrderSizeId: 'c2', quantity: 1 },
      { id: 'l3', shipmentId: 'sh-2', workOrderId: 'wo-3', workOrderSizeId: 'c3', quantity: 1 },
      { id: 'l4', shipmentId: 'sh-3', workOrderId: 'wo-3', workOrderSizeId: 'c3', quantity: 1 },
    ],
    shipments: [
      { id: 'sh-1', number: 'SH-0001', status: 'SHIPPED', shippedAt: '2026-11-24T08:00:00.000Z', deliveredAt: null, partyId: 'p1', ddtNumbers: ['144/2026'] },
      { id: 'sh-2', number: 'SH-0002', status: 'DELIVERED', shippedAt: '2026-11-25T08:00:00.000Z', deliveredAt: '2026-11-26T08:00:00.000Z', partyId: 'p2', ddtNumbers: ['150/2026'] },
      { id: 'sh-3', number: 'SH-0003', status: 'PACKED', shippedAt: null, deliveredAt: null, partyId: 'p1', ddtNumbers: [] },
    ],
    parties: [
      { id: 'p1', code: 'P1', name: 'Customer One' },
      { id: 'p2', code: 'P2', name: 'Customer Two' },
    ],
  }

  it('follows a batch to every garment of its work order: the shipment that left, its DDT and the customer', () => {
    const trace = buildTrace({ ...base, concern: { ...base.concern, batchNumbers: ['BT-0001'] } })
    expect(trace.workOrders.map((workOrder) => [workOrder.number, workOrder.reach, workOrder.via])).toEqual([['WO-0001', 'WHOLE', ['BATCH']]])
    expect(trace.workOrders[0]!.cells.map((cell) => [cell.colourwayCode, cell.size, cell.concerned, cell.released, cell.shipped])).toEqual([
      ['BLK', '50', 2, 1, 1],
      ['RED', '52', 1, 1, 1],
    ])
    expect(trace.shipments).toMatchObject([{ number: 'SH-0001', left: true, garments: 2, ddtNumbers: ['144/2026'], partyCode: 'P1' }])
    expect(trace.customers).toEqual([{ partyId: 'p1', code: 'P1', name: 'Customer One', garments: 2, shipmentNumbers: ['SH-0001'], ddtNumbers: ['144/2026'] }])
    expect(trace.shippedGoods).toBe(true)
    expect(leftShipmentNumbers(trace)).toEqual(['SH-0001'])
  })

  it('follows serials only to the lines that hold them', () => {
    const trace = buildTrace({ ...base, concern: { ...base.concern, serials: ['S-1', 'S-2'] } })
    expect(trace.workOrders.map((workOrder) => [workOrder.number, workOrder.reach])).toEqual([['WO-0003', 'PART']])
    const cell = trace.workOrders[0]!.cells[0]!
    expect([cell.pieces, cell.concerned, cell.shipped, cell.packed]).toEqual([4, 2, 1, 0])
    expect(cell.serials).toEqual([
      { serial: 'S-1', status: 'SHIPPED', shipmentId: 'sh-2', shipmentNumber: 'SH-0002' },
      { serial: 'S-2', status: 'RELEASED', shipmentId: null, shipmentNumber: null },
    ])
    // SH-0003 holds another garment of the cell, not a named serial.
    expect(trace.shipments.map((shipment) => shipment.number)).toEqual(['SH-0002'])
    expect(trace.customers.map((customer) => customer.code)).toEqual(['P2'])
  })

  it('follows a material lot to the work orders of the style it was issued to, and says what it could not follow', () => {
    const trace = buildTrace({ ...base, concern: { ...base.concern, lotIds: ['lot-1', 'lot-x'], batchNumbers: ['BT-0009', 'BT-NONE'], serials: ['S-404'] } })
    expect(trace.workOrders.map((workOrder) => [workOrder.number, workOrder.via])).toEqual([['WO-0001', ['LOT']]])
    expect(trace.lots).toEqual([{ id: 'lot-1', code: 'LOT-HIDE-1', workOrderNumbers: ['WO-0001'] }])
    expect(trace.problems.map((problem) => [problem.path, problem.code])).toEqual([
      ['concern/batchNumbers/0', 'OTHER_STYLE_BATCH'],
      ['concern/batchNumbers/1', 'UNKNOWN_BATCH'],
      ['concern/serials/0', 'UNKNOWN_SERIAL'],
      ['concern/lotIds/1', 'UNKNOWN_LOT'],
    ])
  })

  it('follows a named shipment to its garments of the style only, beside named serials', () => {
    const trace = buildTrace({ ...base, concern: { ...base.concern, shipmentIds: ['sh-3', 'sh-x'], serials: ['S-1'] } })
    expect(trace.workOrders.map((workOrder) => [workOrder.number, workOrder.reach, workOrder.via])).toEqual([['WO-0003', 'PART', ['SERIAL', 'SHIPMENT']]])
    expect(trace.workOrders[0]!.cells[0]).toMatchObject({ concerned: 2, packed: 1, shipped: 1 })
    expect(trace.shipments.map((shipment) => [shipment.number, shipment.garments])).toEqual([
      ['SH-0002', 1],
      ['SH-0003', 1],
    ])
    expect(trace.problems).toEqual([{ path: 'concern/shipmentIds/1', code: 'UNKNOWN_SHIPMENT', message: 'No shipment of this company has this id.' }])
    const other = buildTrace({ ...base, concern: { ...base.concern, styleId: 'style-b', shipmentIds: ['sh-1'] } })
    expect(other.problems.map((problem) => problem.code)).toEqual(['SHIPMENT_OTHER_STYLE'])
    expect(other.workOrders).toEqual([])
  })

  it('reports goods on packed shipments as packed, not shipped: no distributor to inform yet', () => {
    const trace = buildTrace({ ...base, lines: base.lines.filter((line) => line.id === 'l4'), concern: { ...base.concern, batchNumbers: ['BT-0003'] } })
    expect(trace.counts).toMatchObject({ workOrders: 1, concerned: 4, packed: 1, shipped: 0, customers: 0 })
    expect(trace.shippedGoods).toBe(false)
  })
})
