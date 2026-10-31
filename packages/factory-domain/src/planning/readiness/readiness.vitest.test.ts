import { describe, expect, it } from 'vitest'
import type { BomLineData } from '../../product/bom/rules'
import { planRequirements, type PlanInput, type PlanItem, type PlanOrderLine } from '../explode'
import { readinessOf } from './readiness'

/**
 * B-W2b-20: the material of a work order on the planning board is needed on its scheduled start (../explode
 * `workOrderStarts`), and readiness says per material the day it is needed and what arrives for it.
 */

const LEATHER = { baseUom: 'FT2', purchaseUom: 'HIDE', purchaseFactor: '52.5', consumptionUom: 'FT2', consumptionFactor: '1' } as const
const items: PlanItem[] = [{ id: 'leather', code: 'LEA-100', sourcing: 'BUY', units: LEATHER, defaultSupplierId: 'tannery' }]
const bomLine: BomLineData = {
  id: 'bl-10',
  seq: 10,
  itemId: 'leather',
  qty: '50',
  uom: 'FT2',
  placement: null,
  wastagePct: '0',
  sizeDependent: false,
  colourDependent: true,
  itemColourId: null,
  colourwayId: null,
  supplierId: null,
  note: null,
  sizes: [],
  colours: [{ colourwayId: 'cw-blk', itemColourId: 'blk' }],
}
const line: PlanOrderLine = { orderId: 'so-1', orderNumber: 'SO-1', orderLineId: 'ol-1', lineSeq: 10, styleId: 'style-1', colourwayId: 'cw-blk', revisionId: 'rev-1', sizes: [{ size: '52', pieces: 3 }], dueDate: '2026-12-01', partyId: 'party-1' }
const cells = [
  { workOrderId: 'wo-1', workOrderNumber: 'WO-1', status: 'RELEASED' as const, orderLineId: 'ol-1', size: '52', pieces: 1 },
  { workOrderId: 'wo-2', workOrderNumber: 'WO-2', status: 'RELEASED' as const, orderLineId: 'ol-1', size: '52', pieces: 2 },
]
const input = (fields: Partial<PlanInput> = {}): PlanInput => ({ runDate: '2026-11-01', orderLines: [line], revisions: [{ id: 'rev-1', lines: [bomLine] }], items, workOrderCells: cells, workOrderIssues: [], stock: [], lots: [], purchases: [], ...fields })

describe('need dates from the scheduled start (B-W2b-20)', () => {
  it("a work order on the board needs its material on its start; one not on the board on its order line's date", () => {
    const plain = planRequirements(input())
    expect(plain.netting[0]!.pegging.coverage.map((entry) => [entry.part.workOrderId, entry.day])).toEqual([
      ['wo-1', '2026-12-01'],
      ['wo-2', '2026-12-01'],
    ])
    const scheduled = planRequirements(input({ workOrderStarts: new Map([['wo-2', '2026-11-16']]) }))
    expect(scheduled.netting[0]!.pegging.coverage.map((entry) => [entry.part.workOrderId, entry.day])).toEqual([
      ['wo-2', '2026-11-16'],
      ['wo-1', '2026-12-01'],
    ])
    // The line's need date moves with it (the earliest part still short), so does the order-by date.
    expect(scheduled.requirements[0]!.needDate).toBe('2026-11-16')
    expect(plain.requirements[0]!.needDate).toBe('2026-12-01')
  })

  it('a purchase line due between the start and the order line date no longer covers the scheduled work order', () => {
    const purchases = [{ itemId: 'leather', itemColourId: 'blk', purchaseOrderLineId: 'pol-1', purchaseOrderNumber: 'PO-1', purchaseOrderStatus: 'SENT', openQuantity: '200', dueDate: '2026-11-25' }]
    const plain = planRequirements(input({ purchases: purchases as never }))
    const scheduled = planRequirements(input({ purchases: purchases as never, workOrderStarts: new Map([['wo-2', '2026-11-16']]) }))
    const supply = (result: ReturnType<typeof planRequirements>, workOrderId: string) => result.netting[0]!.pegging.coverage.find((entry) => entry.part.workOrderId === workOrderId)!.supplies.map((entry) => entry.kind)
    expect(supply(plain, 'wo-2')).toEqual(['PURCHASE_ORDER'])
    expect(supply(scheduled, 'wo-2')).toEqual(['PLANNED'])
  })
})

describe('readiness per component with arrival dates (B-W2b-20)', () => {
  const purchaseOf = (id: string) =>
    ({
      'pol-1': { purchaseOrderNumber: 'PO-1', purchaseOrderStatus: 'SENT', dueDate: '2026-11-25' },
      'pol-2': { purchaseOrderNumber: 'PO-2', purchaseOrderStatus: 'DRAFT', dueDate: '2026-11-10' },
      'pol-3': { purchaseOrderNumber: 'PO-3', purchaseOrderStatus: 'SENT', dueDate: '2026-12-20' },
    })[id]

  it('says the day it is needed and each purchase line it counts on, in time', () => {
    const purchases = [{ itemId: 'leather', itemColourId: 'blk', purchaseOrderLineId: 'pol-1', purchaseOrderNumber: 'PO-1', openQuantity: '200', dueDate: '2026-11-25' }]
    const plan = planRequirements(input({ purchases: purchases as never }))
    const [wo1] = readinessOf(['wo-1'], [{ itemId: 'leather', itemColourId: 'blk', label: 'LEA-100 BLK', uom: 'FT2', pegging: plan.netting[0]!.pegging }], purchaseOf, '2026-11-01')
    expect(wo1!.word).toBe('EXPECTED')
    expect(wo1!.materials[0]).toMatchObject({ neededOn: '2026-12-01', arrivals: [{ kind: 'PURCHASE_ORDER', purchaseOrderLineId: 'pol-1', purchaseOrderNumber: 'PO-1', draft: false, date: '2026-11-25', quantity: '50.0000', state: 'IN_TIME' }] })
  })

  it('names a line past its date as OVERDUE, a draft as draft, and a line after the need as LATE (not counted)', () => {
    const purchases = [
      { itemId: 'leather', itemColourId: 'blk', purchaseOrderLineId: 'pol-2', purchaseOrderNumber: 'PO-2', openQuantity: '50', dueDate: '2026-11-10' },
      { itemId: 'leather', itemColourId: 'blk', purchaseOrderLineId: 'pol-3', purchaseOrderNumber: 'PO-3', openQuantity: '500', dueDate: '2026-12-20' },
    ]
    const plan = planRequirements(input({ purchases: purchases as never, workOrderStarts: new Map([['wo-1', '2026-11-16']]) }))
    const material = { itemId: 'leather', itemColourId: 'blk', label: 'LEA-100 BLK', uom: 'FT2' as const, pegging: plan.netting[0]!.pegging }
    const [wo1, wo2] = readinessOf(['wo-1', 'wo-2'], [material], purchaseOf, '2026-11-12')
    // wo-1 (needed 16 Nov) takes the draft PO-2 line (due 10 Nov: in time, a draft is not overdue).
    expect(wo1!.materials[0]).toMatchObject({ word: 'REQUESTED', neededOn: '2026-11-16', arrivals: [{ purchaseOrderNumber: 'PO-2', draft: true, date: '2026-11-10', state: 'IN_TIME' }] })
    // wo-2 (needed 1 Dec) is short: PO-3 comes 20 Dec, after the need.
    expect(wo2!.materials[0]!.word).toBe('DELAYED')
    expect(wo2!.materials[0]!.arrivals).toEqual([{ kind: 'PURCHASE_ORDER', purchaseOrderLineId: 'pol-3', purchaseOrderNumber: 'PO-3', draft: false, date: '2026-12-20', quantity: '500.0000', state: 'LATE' }])
    // The same draft once its order is sent and the date has passed: OVERDUE.
    const sent = (id: string) => (id === 'pol-2' ? { purchaseOrderNumber: 'PO-2', purchaseOrderStatus: 'SENT', dueDate: '2026-11-10' } : purchaseOf(id))
    const [late] = readinessOf(['wo-1'], [material], sent, '2026-11-12')
    expect(late!.materials[0]).toMatchObject({ word: 'DELAYED', arrivals: [{ purchaseOrderNumber: 'PO-2', draft: false, state: 'OVERDUE' }] })
  })

  it('a firm planned order is an arrival too, LATE when dated after the need', () => {
    const firm = { requirementId: 'old', itemId: 'leather', itemColourId: 'blk', action: 'BUY' as const, quantity: '3.0000', uom: 'HIDE', baseQuantity: '157.5000', date: '2026-12-05', supplierId: 'tannery', firmedAt: new Date('2026-10-20T08:00:00Z'), firmedById: 'planner' }
    const plan = planRequirements(input({ firmSupply: [firm] }))
    const [wo1] = readinessOf(['wo-1'], [{ itemId: 'leather', itemColourId: 'blk', label: 'LEA-100 BLK', uom: 'FT2', pegging: plan.netting[0]!.pegging }], purchaseOf, '2026-11-01')
    expect(wo1!.materials[0]!.arrivals).toEqual([{ kind: 'FIRM', purchaseOrderLineId: null, purchaseOrderNumber: null, draft: false, date: '2026-12-05', quantity: '50.0000', state: 'LATE' }])
  })
})
