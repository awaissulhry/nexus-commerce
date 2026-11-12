import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { ROLE_TEMPLATES } from '../../auth/roles/templates'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { splitRefusal } from '../../production/work-orders/split'
import { SALES_SAMPLES_PERMISSIONS } from './permissions'
import {
  cellsForLines,
  cellsProblems,
  cellsWithoutLine,
  daysLate,
  lineRefusal,
  nextRoundNo,
  roundEditRefusal,
  roundLabel,
  shipmentDatesRefusal,
  shipmentRemoveRefusal,
  stageAfterShipment,
  stageMoveRefusal,
  storedCells,
  withoutLineRefusal,
} from './rules'

const BLK = '00000000-0000-4000-8000-000000000001'
const RED = '00000000-0000-4000-8000-000000000002'
const style = { code: 'JK-1', sizes: ['50', '52', '54'], colourwayIds: [BLK, RED] }
const at = (iso: string) => new Date(iso)

describe('sample rounds (B-W2b-246)', () => {
  it('moves by hand between the four manual stages in any order, never to DECIDED or CANCELLED, never once closed', () => {
    expect(stageMoveRefusal({ number: 'SR-1', stage: 'SENT' }, 'REQUESTED')).toBeNull()
    expect(stageMoveRefusal({ number: 'SR-1', stage: 'REQUESTED' }, 'UNDER_REVIEW')).toBeNull()
    expect(stageMoveRefusal({ number: 'SR-1', stage: 'SENT' }, 'SENT')?.code).toBe('SAME_STAGE')
    expect(stageMoveRefusal({ number: 'SR-1', stage: 'SENT' }, 'DECIDED')?.code).toBe('DECIDED_BY_DECISION')
    expect(stageMoveRefusal({ number: 'SR-1', stage: 'SENT' }, 'CANCELLED')?.code).toBe('CANCEL_WITH_REASON')
    expect(stageMoveRefusal({ number: 'SR-1', stage: 'DECIDED' }, 'SENT')).toMatchObject({ code: 'ROUND_CLOSED', message: 'Sample round SR-1 is decided: its stage no longer moves.' })
  })

  it('keeps the revision pinned once out of REQUESTED; a closed round changes no more', () => {
    expect(roundEditRefusal({ number: 'SR-1', stage: 'REQUESTED', revision: 2 }, ['revisionId'])).toBeNull()
    expect(roundEditRefusal({ number: 'SR-1', stage: 'IN_MAKING', revision: 2 }, ['revisionId'])?.message).toContain('made from revision 2 (pinned)')
    expect(roundEditRefusal({ number: 'SR-1', stage: 'IN_MAKING', revision: 2 }, ['cells', 'dueDate'])).toBeNull()
    expect(roundEditRefusal({ number: 'SR-1', stage: 'CANCELLED', revision: 2 }, ['dueDate'])?.code).toBe('ROUND_CLOSED')
  })

  it("checks the cells as the database does, and stores them without an 'any colourway' key", () => {
    expect(cellsProblems([{ colourwayId: BLK, size: '52', quantity: 2 }, { size: '52', quantity: 1 }], style, 'body/cells')).toEqual([])
    const problems = cellsProblems([{ colourwayId: BLK, size: '56', quantity: 0 }, { colourwayId: 'x', size: '52', quantity: 1 }, { colourwayId: 'x', size: '52', quantity: 1 }], style, 'body/cells')
    expect(problems.map((problem) => problem.path)).toEqual(['body/cells/0/size', 'body/cells/0/quantity', 'body/cells/1/colourwayId', 'body/cells/2/colourwayId', 'body/cells/2'])
    expect(cellsProblems([], style, 'body/cells')).toHaveLength(1)
    expect(storedCells([{ colourwayId: null, size: '52', quantity: 1 }, { colourwayId: BLK, size: '50', quantity: 2 }])).toEqual([{ size: '52', quantity: 1 }, { colourwayId: BLK, size: '50', quantity: 2 }])
    expect(roundLabel('FIT', 2)).toBe('Fit · round 2')
    expect(roundLabel('FIT', 2, 'it')).toBe('Fit · giro 2')
  })

  it("gives each order line the round's cells of its colourway; a cell of no colourway only with one line", () => {
    const cells = [
      { colourwayId: BLK, size: '52', quantity: 2 },
      { colourwayId: null, size: '52', quantity: 1 },
      { colourwayId: RED, size: '50', quantity: 1 },
    ]
    const black = { id: 'l1', colourwayId: BLK, orderNumber: 'SO-1', seq: 10 }
    const red = { id: 'l2', colourwayId: RED, orderNumber: 'SO-1', seq: 20 }
    const alone = cellsForLines(cells, [black], 'body/lines')
    expect(alone.problems).toEqual([])
    expect(alone.lines).toEqual([{ salesOrderLineId: 'l1', sizes: [{ size: '52', quantity: 3 }] }])
    expect(alone.left).toEqual([{ colourwayId: RED, size: '50', quantity: 1 }])
    const both = cellsForLines(cells, [black, red], 'body/lines')
    expect(both.problems.map((problem) => problem.path)).toEqual(['body/lines'])
    const none = cellsForLines([{ colourwayId: RED, size: '50', quantity: 1 }], [black], 'body/lines')
    expect(none.problems[0]).toMatchObject({ path: 'body/lines/0', message: 'SO-1 line 10: the round asks nothing in its colourway.' })
    expect(lineRefusal({ partyId: 'p1' }, { partyId: 'p2', orderNumber: 'SO-1', seq: 10 })?.code).toBe('LINE_OF_ANOTHER_PARTY')
    expect(lineRefusal({ partyId: null }, { partyId: 'p2', orderNumber: 'SO-1', seq: 10 })).toBeNull()
  })

  it('sets sent and received once each, received after sent; an outbound shipment moves its round forward only', () => {
    const fresh = { direction: 'OUTBOUND' as const, sentAt: null, receivedAt: null }
    expect(shipmentDatesRefusal(fresh, { sentAt: at('2026-11-09T09:00:00Z') })).toBeNull()
    expect(shipmentDatesRefusal(fresh, { receivedAt: at('2026-11-09T09:00:00Z') })?.code).toBe('RECEIVED_BEFORE_SENT')
    const sent = { ...fresh, sentAt: at('2026-11-09T09:00:00Z') }
    expect(shipmentDatesRefusal(sent, { sentAt: at('2026-11-09T09:00:00Z') })).toBeNull()
    expect(shipmentDatesRefusal(sent, { sentAt: at('2026-11-09T10:00:00Z') })?.code).toBe('SENT_ONCE')
    expect(shipmentDatesRefusal(sent, { receivedAt: at('2026-11-09T08:00:00Z') })?.code).toBe('RECEIVED_BEFORE_SENT')
    expect(shipmentDatesRefusal({ ...sent, receivedAt: at('2026-11-10T08:00:00Z') }, { receivedAt: at('2026-11-10T09:00:00Z') })?.code).toBe('RECEIVED_ONCE')
    expect(shipmentRemoveRefusal(sent)?.code).toBe('SHIPMENT_SENT')
    expect(stageAfterShipment('IN_MAKING', 'OUTBOUND', 'SENT')).toBe('SENT')
    expect(stageAfterShipment('SENT', 'OUTBOUND', 'RECEIVED')).toBe('UNDER_REVIEW')
    expect(stageAfterShipment('UNDER_REVIEW', 'OUTBOUND', 'SENT')).toBeNull()
    expect(stageAfterShipment('IN_MAKING', 'RETURN', 'SENT')).toBeNull()
  })

  it('counts days late of an open round and the next round number', () => {
    expect(daysLate('SENT', '2026-11-07', '2026-11-10')).toBe(3)
    expect(daysLate('DECIDED', '2026-11-07', '2026-11-10')).toBeNull()
    expect(daysLate('SENT', '2026-11-10', '2026-11-10')).toBeNull()
    expect(nextRoundNo([])).toBe(1)
    expect(nextRoundNo([1, 3, 2])).toBe(4)
  })

  it('declares its permissions, gives them to sales and the production manager, declares its events; a sample work order is not split', () => {
    for (const name of SALES_SAMPLES_PERMISSIONS) expect(FACTORY_PERMISSIONS.isDeclared(name)).toBe(true)
    const template = (key: string) => ROLE_TEMPLATES.find((entry) => entry.key === key)!.permissions as readonly string[]
    expect(template('sales')).toEqual(expect.arrayContaining(['sales.samples.view', 'sales.samples.manage']))
    expect(template('production_manager')).toEqual(expect.arrayContaining(['sales.samples.view', 'sales.samples.manage']))
    expect(template('planner')).toContain('sales.samples.view')
    expect(template('planner')).not.toContain('sales.samples.manage')
    for (const type of ['sample_round.requested', 'sample_round.changed', 'sample_shipment.changed']) expect(EVENT_CATALOGUE.find(type, 1)).toBeDefined()
    expect(splitRefusal({ number: 'WO-1', status: 'DRAFT', kind: 'SAMPLE' })).toContain('sample round')
  })

  it('B-W2b-284: makes an internal or uncharged proto, fit or salesman round without an order line, from its own cells', () => {
    expect(withoutLineRefusal({ number: 'SR-1', stage: 'REQUESTED', kind: 'PROTO', charged: false })).toBeNull()
    expect(withoutLineRefusal({ number: 'SR-1', stage: 'REQUESTED', kind: 'SALESMAN', charged: false })).toBeNull()
    expect(withoutLineRefusal({ number: 'SR-1', stage: 'REQUESTED', kind: 'FIT', charged: true })).toMatchObject({ code: 'ORDER_LINE_NEEDED', message: expect.stringContaining('charged to its customer') })
    for (const kind of ['PRE_PRODUCTION', 'CERTIFICATION', 'BRAND'] as const) expect(withoutLineRefusal({ number: 'SR-1', stage: 'REQUESTED', kind, charged: false })?.code).toBe('ORDER_LINE_NEEDED')
    const cells = [
      { colourwayId: BLK, size: '52', quantity: 2 },
      { colourwayId: null, size: '52', quantity: 1 },
      { colourwayId: RED, size: '50', quantity: 1 },
    ]
    // "Any colourway" takes the colourway asked; the same colourway and size add up (one cell per colourway and size).
    expect(cellsWithoutLine(cells, style, BLK, 'body')).toEqual({ cells: [{ colourwayId: BLK, size: '52', quantity: 3 }, { colourwayId: RED, size: '50', quantity: 1 }], problems: [] })
    expect(cellsWithoutLine(cells, style, null, 'body').problems).toEqual([{ path: 'body/colourwayId', message: "The round names sizes without a colourway: pick the colourway of style JK-1 they are made in." }])
    expect(cellsWithoutLine(cells, { ...style, colourwayIds: [BLK] }, null, 'body').cells[0]).toEqual({ colourwayId: BLK, size: '52', quantity: 3 })
    expect(cellsWithoutLine(cells, style, 'x', 'body').problems[0]?.path).toBe('body/colourwayId')
    expect(cellsWithoutLine([], style, null, 'body').problems).toHaveLength(1)
  })
})
