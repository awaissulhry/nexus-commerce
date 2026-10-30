import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { ROLE_TEMPLATES } from '../../auth/roles/templates'
import { PRODUCTION_FINISH } from './permissions'
import { finishBlockers, finishedCell, finishedItemDraft, nothingToReport, planReport, reportShapeProblems, reversalPlan, standardCostOn, tooManyWords, type FinishedCellFacts } from './rules'

/** Report finished to stock (B-W2a-12; GAP-003, MES-011): the rules by hand. */

const cell = (overrides: Partial<FinishedCellFacts> = {}): FinishedCellFacts => ({
  cellId: 'c1',
  label: 'BLK 52',
  quantity: 10,
  released: 6,
  reversed: 1,
  onShipments: 0,
  received: 0,
  heldSerials: 0,
  ...overrides,
})

describe('what a cell can report (GAP-003: only released garments go into stock)', () => {
  it('released less reversed, less in stock, on shipments and held; never past the cell', () => {
    expect(finishedCell(cell())).toMatchObject({ netReleased: 5, canReport: 5, why: null })
    expect(finishedCell(cell({ received: 2 })).canReport).toBe(3)
    expect(finishedCell(cell({ received: 2, onShipments: 1, heldSerials: 1 })).canReport).toBe(1)
    expect(finishedCell(cell({ quantity: 4, released: 6, reversed: 0, received: 3 })).canReport).toBe(1)
  })

  it('says why nothing is left, in words', () => {
    expect(finishedCell(cell({ released: 0, reversed: 0 })).why).toBe('BLK 52: no garment is released yet; only garments quality released go into finished goods.')
    expect(finishedCell(cell({ received: 10, released: 10, reversed: 0 })).why).toBe('BLK 52: all 10 garments of the cell are in finished goods already.')
    expect(finishedCell(cell({ released: 1, reversed: 0, onShipments: 1 })).why).toBe('BLK 52: 1 garment released, 0 in stock, 1 on shipments, so none is left to report.')
    // More shipped or in stock than released (a reversal after the report): never below 0.
    expect(finishedCell(cell({ released: 2, reversed: 1, received: 2 })).canReport).toBe(0)
  })

  it('MES-011 partial: any number up to what the cell can report; none named: every cell, all it can', () => {
    const cells = [finishedCell(cell()), finishedCell(cell({ cellId: 'c2', label: 'RED 50', released: 0, reversed: 0 }))]
    expect(planReport(cells, undefined)).toEqual({ lines: [{ cellId: 'c1', quantity: 5 }], refusals: [] })
    expect(planReport(cells, [{ cellId: 'c1', quantity: 2 }])).toEqual({ lines: [{ cellId: 'c1', quantity: 2 }], refusals: [] })
    expect(planReport(cells, [{ cellId: 'c1', quantity: 6 }]).refusals).toEqual([{ path: 'body/cells/0/quantity', message: 'BLK 52: 5 garments released, 0 in stock, so 5 can go into finished goods; 6 asked.' }])
    expect(planReport(cells, [{ cellId: 'c2', quantity: 1 }]).refusals[0]!.message).toBe('RED 50: no garment is released yet; only garments quality released go into finished goods. 1 asked.')
    expect(tooManyWords(finishedCell(cell({ received: 1, onShipments: 1, heldSerials: 1 })), 9)).toBe('BLK 52: 5 garments released, 1 in stock, 1 on shipments, 1 on quality hold, so 2 can go into finished goods; 9 asked.')
    expect(nothingToReport('WO-1', [cells[1]!])).toBe('Work order WO-1 has nothing to report to finished goods: RED 50: no garment is released yet; only garments quality released go into finished goods.')
  })

  it('checks the shape: a cell of the work order, once, whole garments from 1', () => {
    expect(reportShapeProblems([{ cellId: 'c1', quantity: 1 }, { cellId: 'c1', quantity: 0 }, { cellId: 'x', quantity: 1.5 }], new Set(['c1']))).toEqual([
      { path: 'body/cells/1/cellId', message: 'Name each cell once.' },
      { path: 'body/cells/1/quantity', message: 'Whole garments, from 1.' },
      { path: 'body/cells/2/cellId', message: 'Not a cell of this work order.' },
      { path: 'body/cells/2/quantity', message: 'Whole garments, from 1.' },
    ])
  })
})

describe('the work order (the database: IN_PROGRESS or COMPLETED, never ON_HOLD)', () => {
  const order = { number: 'WO-1', kind: 'SIZE_GRID' as const, status: 'IN_PROGRESS' as const, holdReason: null, qualityHolds: [], siteCode: 'A1', places: 1 }
  it('passes in progress or completed with a finished-goods place', () => {
    expect(finishBlockers(order)).toEqual([])
    expect(finishBlockers({ ...order, status: 'COMPLETED' })).toEqual([])
  })
  it('refuses every other state, a hold, a quality hold, a site without a place, and a repair, in words', () => {
    expect(finishBlockers({ ...order, status: 'RELEASED' })).toEqual(['Work order WO-1 is RELEASED; its garments go into finished goods once it is IN_PROGRESS (its first issue, cut or scan starts it).'])
    expect(finishBlockers({ ...order, status: 'ON_HOLD', holdReason: 'Seam check' })).toEqual(['Work order WO-1 is on hold (Seam check): its garments go into finished goods once the hold is lifted.'])
    expect(finishBlockers({ ...order, status: 'CLOSED' })).toEqual(['Work order WO-1 is CLOSED: nothing more goes into finished goods from it.'])
    expect(finishBlockers({ ...order, qualityHolds: ['STAIN', 'STAIN'], places: 0 })).toEqual([
      'Work order WO-1 is on quality hold (STAIN): its garments go into finished goods once the hold is released.',
      'Site A1 has no finished-goods place: add a location of kind Finished goods (Warehouse › Locations) first.',
    ])
    expect(finishBlockers({ ...order, kind: 'REPAIR' })).toEqual(["Work order WO-1 repairs a customer's garment: it goes back with its repair's transport document (DDT), never into finished goods."])
  })
})

describe('the finished-goods item of a SKU and its standard cost', () => {
  it('one FINISHED item per SKU, its code the SKU, counted in pieces; a serial style says SERIAL', () => {
    expect(finishedItemDraft({ sku: 'JKT-BLK-52', styleName: 'Jacket', colourwayName: 'Black', size: '52', garmentTracking: 'BATCH' })).toEqual({
      code: 'JKT-BLK-52',
      name: 'Jacket, Black, size 52',
      kind: 'FINISHED',
      sourcing: 'MAKE',
      tracking: 'NONE',
      baseUom: 'PCS',
      purchaseUom: 'PCS',
      consumptionUom: 'PCS',
    })
    expect(finishedItemDraft({ sku: 'X', styleName: 'S', colourwayName: 'C', size: '1', garmentTracking: 'SERIAL' }).tracking).toBe('SERIAL')
  })

  it('the FROZEN standard in force on the day, the latest to start, in the item currency', () => {
    const rows = [
      { id: 'a', status: 'FROZEN', validFrom: '2026-01-01', validTo: '2026-06-30', unitCost: '80', currency: 'EUR' },
      { id: 'b', status: 'FROZEN', validFrom: '2026-07-01', validTo: null, unitCost: '90', currency: 'EUR' },
      { id: 'c', status: 'DRAFT', validFrom: '2026-10-01', validTo: null, unitCost: '99', currency: 'EUR' },
      { id: 'd', status: 'FROZEN', validFrom: '2026-10-01', validTo: null, unitCost: '70', currency: 'USD' },
    ]
    expect(standardCostOn(rows, '2026-03-01', 'EUR')?.id).toBe('a')
    expect(standardCostOn(rows, '2026-10-30', 'EUR')?.id).toBe('b')
    expect(standardCostOn(rows, '2025-12-31', 'EUR')).toBeNull()
  })
})

describe('taking a report back', () => {
  it('what is still in stock of it, or why nothing is', () => {
    expect(reversalPlan('r', [{ moveId: 'm1', reversed: true }, { moveId: 'm2', reversed: false }])).toEqual({ moveIds: ['m2'], problem: null })
    expect(reversalPlan('r', [{ moveId: 'm1', reversed: true }]).problem).toBe('This report was taken back already: its garments left finished goods.')
    expect(reversalPlan('r', []).problem).toBe('Report r is not a report of this work order.')
  })
})

describe('production.finish', () => {
  it('is declared, office, and given to the production manager and the warehouse (the owner holds every one)', () => {
    expect(FACTORY_PERMISSIONS.get(PRODUCTION_FINISH)).toMatchObject({ name: 'production.finish', area: 'production', risk: 'write' })
    const holders = ROLE_TEMPLATES.filter((role) => role.permissions.includes(PRODUCTION_FINISH)).map((role) => role.key)
    expect(holders.sort()).toEqual(['owner', 'production_manager', 'warehouse'])
  })
})
