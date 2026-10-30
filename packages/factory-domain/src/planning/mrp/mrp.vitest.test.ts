import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { ROLE_TEMPLATES } from '../../auth/roles/templates'
import { netMaterial } from '../netting'
import { planRequirements, type PlanInput, type PlanItem, type PlanOrderLine } from '../explode'
import type { BomLineData } from '../../product/bom/rules'
import { peggingRowsOf, peggingTreeOf } from '../pegging/pegging'
import { firmInputProblems, firmProblem } from './firm'
import { pegMaterial, type DemandPart, type PlanReservation } from './net'
import { PLANNING_FIRM_PERMISSIONS } from './permissions'
import { PLANNING_EXCEPTIONS_PERMISSIONS } from '../exceptions/permissions'

/**
 * MRP every day (B-W2a-22): the netting part by part with reservations and firm planned orders (./net), the pegging rows
 * and tree (../pegging), the run's explosion into work-order parts (../explode), firm planned order rules (./firm).
 */

const part = (fields: Partial<DemandPart> & Pick<DemandPart, 'key' | 'quantity'>): DemandPart => ({
  orderId: 'so-1',
  orderNumber: 'SO-1',
  orderLineId: 'ol-1',
  lineSeq: 10,
  partyId: 'party-1',
  size: '52',
  workOrderId: null,
  workOrderNumber: null,
  pieces: 1,
  dueDate: '2026-12-01',
  issued: '0',
  ...fields,
})
const bomLine = (fields: Partial<BomLineData> & Pick<BomLineData, 'id' | 'seq' | 'itemId' | 'qty' | 'uom'>): BomLineData => ({
  placement: null,
  wastagePct: '0',
  sizeDependent: false,
  colourDependent: false,
  itemColourId: null,
  colourwayId: null,
  supplierId: null,
  note: null,
  sizes: [],
  colours: [],
  ...fields,
})
const lot = (id: string) => ({ id, qualityStatus: 'RELEASED' as const, requiresCrViTest: false, crViStatus: 'NOT_REQUIRED' as const })
const reservation = (fields: Partial<PlanReservation> & Pick<PlanReservation, 'id' | 'open'>): PlanReservation => ({
  itemId: 'leather',
  itemColourId: 'blk',
  lotId: null,
  hideId: null,
  workOrderId: null,
  salesOrderLineId: null,
  demandOpen: true,
  ...fields,
})
const base = { itemColourId: 'blk', lotOf: lot, runDate: '2026-11-01' } as const

describe('netting part by part (PLN-071): W1 numbers without reservations or firm orders', () => {
  it('gives netMaterial exactly, with each part told which supply covers it', () => {
    const parts = [part({ key: 'a', dueDate: '2026-12-01', quantity: '100' }), part({ key: 'b', orderLineId: 'ol-2', dueDate: '2026-12-10', quantity: '80' })]
    const stock = [{ itemColourId: 'blk', lotId: 'lot-1', quantity: '60', hides: 1 }]
    const purchases = [{ purchaseOrderLineId: 'po-1', purchaseOrderNumber: 'PO-1', openQuantity: '50', dueDate: '2026-11-20' }, { purchaseOrderLineId: 'po-2', purchaseOrderNumber: 'PO-2', openQuantity: '40', dueDate: '2026-12-20' }]
    const pegged = pegMaterial({ ...base, parts, stock, purchases })
    const w1 = netMaterial({ ...base, demands: parts.map((entry) => ({ dueDate: entry.dueDate, quantity: entry.quantity })), stock, purchases })
    expect([pegged.gross, pegged.usable, pegged.onOrder, pegged.net, pegged.needDate]).toEqual([w1.gross, w1.usable, w1.onOrder, w1.net, w1.needDate])
    expect(pegged.purchases.map((line) => line.why)).toEqual(w1.purchases.map((line) => line.why))
    expect(pegged.coverage.map((entry) => entry.supplies.map((supply) => [supply.kind, supply.quantity]))).toEqual([
      [['STOCK', '60.0000'], ['PURCHASE_ORDER', '40.0000']],
      [['PURCHASE_ORDER', '10.0000'], ['PLANNED', '70.0000']],
    ])
    expect(pegged.uncovered).toBe(pegged.net)
  })
})

describe('reservations hold stock for their own demand (B-W2a-11)', () => {
  const stock = [{ itemColourId: 'blk', lotId: 'lot-1', quantity: '50', hides: 1 }, { itemColourId: 'blk', lotId: 'lot-2', quantity: '30', hides: 1 }]
  it("covers its own work order's part first, whatever its date; what its demand does not need is nobody else's", () => {
    const parts = [part({ key: 'early', dueDate: '2026-11-20', quantity: '60' }), part({ key: 'wo', orderLineId: 'ol-2', workOrderId: 'wo-2', workOrderNumber: 'WO-2', dueDate: '2026-12-20', quantity: '20' })]
    const pegged = pegMaterial({ ...base, parts, stock, purchases: [], reservations: [reservation({ id: 'r-1', lotId: 'lot-1', open: '35', workOrderId: 'wo-2' })] })
    expect(pegged.coverage.find((entry) => entry.part.key === 'wo')!.supplies).toEqual([{ kind: 'RESERVATION', quantity: '20.0000', reservationId: 'r-1' }])
    // 80 usable: 35 held for WO-2 (20 used, 15 not counted for anyone else), 45 free for the early order.
    expect(pegged.coverage.find((entry) => entry.part.key === 'early')!.supplies).toEqual([{ kind: 'STOCK', quantity: '45.0000' }, { kind: 'PLANNED', quantity: '15.0000' }])
    expect(pegged).toMatchObject({ gross: '80.0000', usable: '65.0000', net: '15.0000', reservedForOthers: '15.0000' })
    expect(pegged.reservations).toEqual([{ id: 'r-1', open: '35.0000', backed: '35.0000', used: '20.0000', forPlan: true }])
  })

  it("an order line's reservation covers its work orders' parts too; another demand's holds stock away from the plan", () => {
    const parts = [part({ key: 'wo', workOrderId: 'wo-1', workOrderNumber: 'WO-1', quantity: '30' })]
    const pegged = pegMaterial({
      ...base,
      parts,
      stock,
      purchases: [],
      reservations: [reservation({ id: 'r-line', open: '10', salesOrderLineId: 'ol-1' }), reservation({ id: 'r-other', open: '60', workOrderId: 'wo-9' }), reservation({ id: 'r-closed', open: '80', workOrderId: 'wo-8', demandOpen: false })],
    })
    expect(pegged.coverage[0]!.supplies).toEqual([
      { kind: 'RESERVATION', quantity: '10.0000', reservationId: 'r-line' },
      { kind: 'STOCK', quantity: '10.0000' },
      { kind: 'PLANNED', quantity: '10.0000' },
    ])
    expect(pegged).toMatchObject({ usable: '20.0000', net: '10.0000', reservedForOthers: '60.0000' })
    expect(pegged.reservations.find((use) => use.id === 'r-other')).toMatchObject({ forPlan: false, used: '0.0000' })
  })

  it('a lot reservation is backed by its lot only; more reserved than stock backs is said', () => {
    const pegged = pegMaterial({ ...base, parts: [part({ key: 'wo', workOrderId: 'wo-1', quantity: '40' })], stock, purchases: [], reservations: [reservation({ id: 'r-lot2', lotId: 'lot-2', open: '40', workOrderId: 'wo-1' })] })
    expect(pegged.reservations[0]).toMatchObject({ open: '40.0000', backed: '30.0000', used: '30.0000' })
    expect(pegged.coverage[0]!.supplies).toEqual([{ kind: 'RESERVATION', quantity: '30.0000', reservationId: 'r-lot2' }, { kind: 'STOCK', quantity: '10.0000' }])
  })
})

describe('the firm planned order a run carries (PLN-075)', () => {
  const parts = [part({ key: 'a', dueDate: '2026-12-01', quantity: '150' }), part({ key: 'b', orderLineId: 'ol-2', dueDate: '2026-12-18', quantity: '200' })]
  it('covers what is short by day; what it cannot cover is the suggestion; a firm date after a need is late', () => {
    const pegged = pegMaterial({ ...base, parts, stock: [], purchases: [], firm: { requirementId: 'old', baseQuantity: '210', date: '2026-12-10' } })
    expect(pegged).toMatchObject({ net: '350.0000', uncovered: '140.0000', firm: { inTime: '60.0000', late: '150.0000', firstLateDay: '2026-12-01', unused: '0.0000' } })
    expect(pegged.coverage.map((entry) => entry.supplies)).toEqual([
      [{ kind: 'FIRM', quantity: '150.0000', date: '2026-12-10', late: true }],
      [{ kind: 'FIRM', quantity: '60.0000', date: '2026-12-10', late: false }, { kind: 'PLANNED', quantity: '140.0000' }],
    ])
  })

  it('a firm order no demand needs is unused', () => {
    expect(pegMaterial({ ...base, parts: [], stock: [], purchases: [], firm: { requirementId: 'old', baseQuantity: '50', date: '2026-12-10' } }).firm).toMatchObject({ inTime: '0.0000', late: '0.0000', unused: '50.0000' })
  })

  it('is made firm only on an open line of the latest DONE plan, with a quantity above 0, not in the past', () => {
    expect(firmProblem({ decision: 'OPEN', action: 'BUY' }, 'DONE', 'FIRM', false)).toBeNull()
    expect(firmProblem({ decision: 'OPEN', action: 'BUY' }, 'SUPERSEDED', 'FIRM', false)).toMatch(/newer plan/)
    expect(firmProblem({ decision: 'IGNORED', action: 'BUY' }, 'DONE', 'FIRM', false)).toMatch(/set aside/)
    expect(firmProblem({ decision: 'ORDERED', action: 'BUY' }, 'DONE', 'FIRM', true)).toMatch(/ordered already/)
    expect(firmProblem({ decision: 'OPEN', action: 'MAKE' }, 'DONE', 'PLANNED', false)).toBe('The line is not firm.')
    expect(firmInputProblems({ quantity: '4', date: '2026-12-10' }, '2026-11-01')).toEqual([])
    expect(firmInputProblems({ quantity: '0', date: '2026-10-01' }, '2026-11-01').map((issue) => issue.path)).toEqual(['body/quantity', 'body/date'])
    expect(firmInputProblems({ quantity: '1.23456', date: '1 Dec' }, '2026-11-01').map((issue) => issue.path)).toEqual(['body/quantity', 'body/date'])
  })
})

describe('pegging rows and tree (PLN-071)', () => {
  it('one row per part × supply, by day; issued material is never pegged; the planned order carries its date', () => {
    const pegged = pegMaterial({
      ...base,
      parts: [part({ key: 'wo', workOrderId: 'wo-1', workOrderNumber: 'WO-1', quantity: '40', issued: '15' }), part({ key: 'mtm', orderLineId: 'ol-3', size: null, dueDate: '2026-12-05', quantity: '20' })],
      stock: [{ itemColourId: 'blk', lotId: 'lot-1', quantity: '10', hides: 1 }],
      purchases: [],
      firm: { requirementId: 'old', baseQuantity: '25', date: '2026-11-28' },
    })
    const rows = peggingRowsOf(pegged, '2026-12-01')
    expect(rows.map((row) => [row.seq, row.demandKind, row.workOrderId, row.size, row.quantity, row.supplyKind, row.supplyDate])).toEqual([
      [1, 'WORK_ORDER', 'wo-1', '52', '10.0000', 'STOCK', null],
      [2, 'WORK_ORDER', 'wo-1', '52', '15.0000', 'PLANNED', '2026-11-28'],
      [3, 'ORDER_LINE', null, null, '10.0000', 'PLANNED', '2026-11-28'],
      [4, 'ORDER_LINE', null, null, '10.0000', 'PLANNED', '2026-12-01'],
    ])
    expect(rows.every((row) => row.salesOrderLineId !== null && row.partyId === 'party-1')).toBe(true)
    const tree = peggingTreeOf(rows.map((row) => ({ ...row, requirementId: 'req-1' })))
    expect(tree.map((node) => [node.demandKind, node.quantity, node.planned, node.supplies.length])).toEqual([
      ['WORK_ORDER', '25.0000', '15.0000', 2],
      ['ORDER_LINE', '20.0000', '20.0000', 2],
    ])
  })
})

describe("the run's explosion into work-order parts (../explode)", () => {
  const LEATHER = { baseUom: 'FT2', purchaseUom: 'HIDE', purchaseFactor: '52.5', consumptionUom: 'FT2', consumptionFactor: '1' } as const
  const items: PlanItem[] = [{ id: 'leather', code: 'LEA-100', sourcing: 'BUY', units: LEATHER, defaultSupplierId: 'tannery' }]
  const revision = { id: 'rev-1', lines: [bomLine({ id: 'bl-10', seq: 10, itemId: 'leather', qty: '50', uom: 'FT2', colourDependent: true, colours: [{ colourwayId: 'cw-blk', itemColourId: 'blk' }] })] }
  const line: PlanOrderLine = { orderId: 'so-1', orderNumber: 'SO-1', orderLineId: 'ol-1', lineSeq: 10, styleId: 'style-1', colourwayId: 'cw-blk', revisionId: 'rev-1', sizes: [{ size: '52', pieces: 3 }], dueDate: '2026-12-01', partyId: 'party-1' }
  const input = (fields: Partial<PlanInput> = {}): PlanInput => ({ runDate: '2026-11-01', orderLines: [line], revisions: [revision], items, workOrderCells: [], workOrderIssues: [], stock: [], lots: [], purchases: [], ...fields })

  it('splits a source over its open work orders (as many pieces as the order still needs) and the pieces no work order makes', () => {
    const result = planRequirements(
      input({
        workOrderCells: [
          { workOrderId: 'wo-1', workOrderNumber: 'WO-1', status: 'IN_PROGRESS', orderLineId: 'ol-1', size: '52', pieces: 1 },
          { workOrderId: 'wo-2', workOrderNumber: 'WO-2', status: 'DRAFT', orderLineId: 'ol-1', size: '52', pieces: 5 },
        ],
        workOrderIssues: [{ workOrderId: 'wo-1', itemId: 'leather', itemColourId: 'blk', quantity: '30' }],
      }),
    )
    const [black] = result.requirements
    expect(black).toMatchObject({ grossQuantity: '120.0000', netQuantity: '120.0000' })
    const parts = result.netting[0]!.pegging.coverage.map((entry) => [entry.part.workOrderId, entry.part.pieces, entry.part.quantity, entry.part.issued])
    expect(parts).toEqual([
      ['wo-1', 1, '50.0000', '30.0000'],
      ['wo-2', 2, '100.0000', '0.0000'],
    ])
  })

  it('carries a firm planned order: its unit for the suggestion (the whole net need); one with no demand any more is a line of its own', () => {
    const firm = { requirementId: 'old', itemId: 'leather', itemColourId: 'blk', action: 'BUY' as const, quantity: '2.0000', uom: 'HIDE', baseQuantity: '105.0000', date: '2026-11-25', supplierId: 'tannery', firmedAt: new Date('2026-10-20T08:00:00Z'), firmedById: 'planner' }
    const carried = planRequirements(input({ firmSupply: [firm] }))
    expect(carried.requirements[0]).toMatchObject({ netQuantity: '150.0000', suggestedQuantity: '3.0000', suggestedUom: 'HIDE' })
    expect(carried.netting[0]!.pegging).toMatchObject({ uncovered: '45.0000', firm: { inTime: '105.0000', late: '0.0000' } })
    expect(carried.netting[0]!.carried).toBe(firm)
    const alone = planRequirements(input({ orderLines: [], firmSupply: [firm] }))
    expect(alone.requirements).toEqual([expect.objectContaining({ itemId: 'leather', grossQuantity: '0.0000', netQuantity: '0.0000', suggestedQuantity: '0.0000', suggestedUom: 'HIDE', needDate: '2026-11-25', supplierId: 'tannery', sources: [] })])
    expect(alone.netting[0]!.pegging.firm).toMatchObject({ unused: '105.0000' })
  })
})

describe('declared', () => {
  it('planning.firm and planning.exceptions.manage are in the catalogue, given to the planner and the buyer', () => {
    for (const permission of [...PLANNING_FIRM_PERMISSIONS, ...PLANNING_EXCEPTIONS_PERMISSIONS]) {
      expect(FACTORY_PERMISSIONS.isDeclared(permission)).toBe(true)
      for (const key of ['planner', 'buyer']) expect(ROLE_TEMPLATES.find((template) => template.key === key)!.permissions).toContain(permission)
    }
  })
})
