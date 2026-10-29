import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../auth/permissions/catalogue'
import { EVENT_CATALOGUE } from '../events/catalogue'
import type { BomLineData } from '../product/bom/rules'
import { addDays, hidesFor, NO_SUPPLY_RULES, orderByOf, suggestionFor, supplyRulesFor } from './buy'
import { decisionNoteOf, decisionProblem, readDecisionNote, setAsideProblems } from './decisions'
import { bridgeOf, sentenceOf, whyLine, type LineNumbers } from './explain'
import { planRequirements, type PlanInput, type PlanItem, type PlanOrderLine } from './explode'
import { netMaterial, openQuantityOf, type LotFacts } from './netting'
import { PLANNING_PERMISSIONS } from './permissions'
import { usabilityOf } from './usable'

/* Every id, code and number here is made up. */

const LEATHER = { baseUom: 'FT2', purchaseUom: 'HIDE', purchaseFactor: '52.5', consumptionUom: 'FT2', consumptionFactor: '1' } as const
const LINING = { baseUom: 'M', purchaseUom: 'ROLL', purchaseFactor: '50', consumptionUom: 'M', consumptionFactor: '1' } as const
const PIECES = { baseUom: 'PCS', purchaseUom: 'PCS', purchaseFactor: '1', consumptionUom: 'PCS', consumptionFactor: '1' } as const

const lot = (id: string, fields: Partial<LotFacts> = {}): LotFacts => ({ id, qualityStatus: 'RELEASED', requiresCrViTest: false, crViStatus: 'NOT_REQUIRED', ...fields })

describe('only usable stock is netted (PLN-065; REACH Annex XVII entry 47)', () => {
  it('REACH entry 47: a RELEASED lot (with its Cr VI PASS when tested) or stock without a lot is usable; nothing else is', () => {
    expect(usabilityOf(null)).toEqual({ usable: true })
    expect(usabilityOf(lot('l', { requiresCrViTest: true, crViStatus: 'PASS' }))).toEqual({ usable: true })
    expect(usabilityOf(lot('l', { qualityStatus: 'QUARANTINE', requiresCrViTest: true, crViStatus: 'PENDING' }))).toEqual({ usable: false, reason: 'CR_VI_PENDING', held: true })
    expect(usabilityOf(lot('l', { qualityStatus: 'QUARANTINE', requiresCrViTest: true, crViStatus: 'FAIL' }))).toEqual({ usable: false, reason: 'CR_VI_FAILED', held: true })
    expect(usabilityOf(lot('l', { qualityStatus: 'QUARANTINE' }))).toEqual({ usable: false, reason: 'QUALITY_HOLD', held: true })
    expect(usabilityOf(lot('l', { qualityStatus: 'BLOCKED' }))).toEqual({ usable: false, reason: 'BLOCKED', held: true })
    expect(usabilityOf(lot('l', { qualityStatus: 'BLOCKED', requiresCrViTest: true, crViStatus: 'FAIL' }))).toEqual({ usable: false, reason: 'CR_VI_FAILED', held: true })
    expect(usabilityOf(lot('l', { qualityStatus: 'REJECTED' }))).toEqual({ usable: false, reason: 'REJECTED', held: false })
    // Never leaning on the trigger alone: a RELEASED lot that needs the test counts only with a PASS.
    expect(usabilityOf(lot('l', { requiresCrViTest: true, crViStatus: 'PENDING' }))).toEqual({ usable: false, reason: 'CR_VI_PENDING', held: true })
  })
})

describe('what open purchase orders still bring (PLN-064)', () => {
  it('counts the confirmed quantity (else the ordered one) less posted receipts, in the base unit, never below 0', () => {
    expect(openQuantityOf({ quantity: '420', baseQuantity: '420', confirmedQuantity: null, received: '105' })).toBe('315.0000')
    expect(openQuantityOf({ quantity: '420', baseQuantity: '420', confirmedQuantity: '400', received: '105' })).toBe('295.0000')
    expect(openQuantityOf({ quantity: '8', baseQuantity: '420', confirmedQuantity: '6', received: '0' })).toBe('315.0000')
    expect(openQuantityOf({ quantity: '24', baseQuantity: '24', confirmedQuantity: '0', received: '0' })).toBe('0.0000')
    expect(openQuantityOf({ quantity: '10', baseQuantity: '10', confirmedQuantity: null, received: '12' })).toBe('0.0000')
  })
})

describe('netting one material (PLN-064, PLN-065)', () => {
  const base = { itemColourId: 'blk', runDate: '2026-11-02', lotOf: (id: string) => LOTS.get(id) }
  const LOTS = new Map([
    ['released', lot('released')],
    ['held', lot('held', { qualityStatus: 'QUARANTINE', requiresCrViTest: true, crViStatus: 'PENDING' })],
    ['rejected', lot('rejected', { qualityStatus: 'REJECTED' })],
  ])

  it('short = need − usable − on order; held stock is shown, never netted; other colours and rejected stock are listed only', () => {
    const netting = netMaterial({
      ...base,
      demands: [{ dueDate: '2026-11-26', quantity: '420' }],
      stock: [
        { itemColourId: 'blk', lotId: 'released', quantity: '120', hides: 2 },
        { itemColourId: 'blk', lotId: 'held', quantity: '60', hides: 1 },
        { itemColourId: 'blk', lotId: 'rejected', quantity: '30', hides: 1 },
        { itemColourId: 'red', lotId: 'released', quantity: '55', hides: 1 },
      ],
      purchases: [{ purchaseOrderLineId: 'po1-10', purchaseOrderNumber: 'PO-1', openQuantity: '100', dueDate: '2026-11-20' }],
    })
    expect(netting).toMatchObject({ gross: '420.0000', usable: '120.0000', held: '60.0000', onOrder: '100.0000', net: '200.0000', needDate: '2026-11-26' })
    expect(netting.stock.map((line) => [line.entry.lotId, line.entry.itemColourId, line.notCounted, line.held])).toEqual([
      ['released', 'blk', null, false],
      ['held', 'blk', 'CR_VI_PENDING', true],
      ['rejected', 'blk', 'REJECTED', false],
      ['released', 'red', 'OTHER_COLOUR', false],
    ])
    expect(netting.purchases).toEqual([expect.objectContaining({ counted: '100.0000', notCounted: '0.0000', why: null })])
  })

  it('an open purchase line due after the need is "too late — not counted"; one due before a later order serves only that one', () => {
    const late = netMaterial({
      ...base,
      demands: [{ dueDate: '2026-11-26', quantity: '100' }],
      stock: [],
      purchases: [{ purchaseOrderLineId: 'po1-10', purchaseOrderNumber: 'PO-1', openQuantity: '100', dueDate: '2026-12-01' }],
    })
    expect(late).toMatchObject({ onOrder: '0.0000', net: '100.0000' })
    expect(late.purchases[0]).toMatchObject({ counted: '0.0000', notCounted: '100.0000', why: 'TOO_LATE' })

    const phased = netMaterial({
      ...base,
      demands: [
        { dueDate: '2026-11-10', quantity: '100' },
        { dueDate: '2026-12-10', quantity: '100' },
      ],
      stock: [{ itemColourId: 'blk', lotId: 'released', quantity: '50', hides: 1 }],
      purchases: [{ purchaseOrderLineId: 'po1-10', purchaseOrderNumber: 'PO-1', openQuantity: '150', dueDate: '2026-11-20' }],
    })
    // Stock 50 goes to the first order; the purchase (due 20 Nov) cannot serve 10 Nov, so 50 are short then; it serves
    // the December order with 100 and its last 50 are not needed.
    expect(phased).toMatchObject({ gross: '200.0000', usable: '50.0000', onOrder: '100.0000', net: '50.0000', needDate: '2026-11-10' })
    expect(phased.purchases[0]).toMatchObject({ counted: '100.0000', notCounted: '50.0000', why: 'TOO_LATE' })

    const covered = netMaterial({ ...base, demands: [{ dueDate: '2026-11-26', quantity: '40' }], stock: [{ itemColourId: 'blk', lotId: 'released', quantity: '120', hides: 2 }], purchases: [{ purchaseOrderLineId: 'po1-10', purchaseOrderNumber: 'PO-1', openQuantity: '100', dueDate: '2026-11-20' }] })
    expect(covered).toMatchObject({ usable: '120.0000', onOrder: '0.0000', net: '0.0000', needDate: '2026-11-26' })
    expect(covered.purchases[0]).toMatchObject({ why: 'NOT_NEEDED' })
  })

  it('a demand without a date is needed on the run day: a later purchase does not cover it', () => {
    const netting = netMaterial({ ...base, demands: [{ dueDate: null, quantity: '10' }], stock: [], purchases: [{ purchaseOrderLineId: 'x', purchaseOrderNumber: 'PO-1', openQuantity: '10', dueDate: '2026-11-03' }] })
    expect(netting).toMatchObject({ net: '10.0000', needDate: '2026-11-02' })
  })
})

describe('the suggestion (PLN-066; PRD-030)', () => {
  it('buys in the purchase unit, whole hides, rolls and pieces, always rounded up; makes in the base unit', () => {
    expect(suggestionFor('200', 'BUY', LEATHER)).toMatchObject({ quantity: '4.0000', uom: 'HIDE', baseQuantity: '210.0000', roundingBase: '10.0000', steps: [{ rule: 'WHOLE_UNITS', quantity: '4.0000' }] })
    expect(suggestionFor('210', 'BUY', LEATHER)).toMatchObject({ quantity: '4.0000', roundingBase: '0.0000', steps: [] })
    expect(suggestionFor('12.6', 'BUY', LINING)).toMatchObject({ quantity: '1.0000', uom: 'ROLL', baseQuantity: '50.0000' })
    expect(suggestionFor('24', 'BUY', PIECES)).toMatchObject({ quantity: '24.0000', uom: 'PCS' })
    expect(suggestionFor('0', 'BUY', LEATHER)).toMatchObject({ quantity: '0.0000', uom: 'HIDE', baseQuantity: '0.0000' })
    expect(suggestionFor('12.34565', 'BUY', { ...LINING, purchaseUom: 'M', purchaseFactor: '1' })).toMatchObject({ quantity: '12.3457', uom: 'M' })
    expect(suggestionFor('2.5', 'MAKE', PIECES)).toMatchObject({ quantity: '3.0000', uom: 'PCS' })
  })

  it("applies the supplier's minimum, then its multiple, in the purchase unit", () => {
    expect(suggestionFor('24', 'BUY', PIECES, { leadTimeDays: null, minOrderQuantity: '50', orderMultiple: null })).toMatchObject({ quantity: '50.0000', steps: [{ rule: 'MINIMUM', quantity: '50.0000' }] })
    expect(suggestionFor('24', 'BUY', PIECES, { leadTimeDays: null, minOrderQuantity: null, orderMultiple: '10' })).toMatchObject({ quantity: '30.0000', steps: [{ rule: 'MULTIPLE', quantity: '30.0000' }] })
    expect(suggestionFor('60', 'BUY', PIECES, { leadTimeDays: null, minOrderQuantity: '50', orderMultiple: '20' })).toMatchObject({ quantity: '60.0000', steps: [] })
    expect(suggestionFor('101', 'BUY', LEATHER, { leadTimeDays: null, minOrderQuantity: '5', orderMultiple: '2' })).toMatchObject({ quantity: '6.0000', baseQuantity: '315.0000' })
    // A MAKE line knows no supplier's terms.
    expect(suggestionFor('3', 'MAKE', PIECES, { leadTimeDays: null, minOrderQuantity: '50', orderMultiple: null })).toMatchObject({ quantity: '3.0000' })
  })

  it('says about how many hides, from the item hide factor; none without one', () => {
    expect(hidesFor('210', LEATHER)).toBe(4)
    expect(hidesFor('210.1', LEATHER)).toBe(5)
    expect(hidesFor('210', { ...LEATHER, purchaseUom: 'FT2', purchaseFactor: '1' })).toBeNull()
  })

  it('takes the terms of the item for its default supplier (else that supplier’s lead time), and only the lead time of another supplier', () => {
    const item = { defaultSupplierId: 's1', leadTimeDays: 14, minOrderQty: '5', orderMultiple: '1' }
    expect(supplyRulesFor(item, { id: 's1', leadTimeDays: 30 })).toEqual({ leadTimeDays: 14, minOrderQuantity: '5', orderMultiple: '1' })
    expect(supplyRulesFor({ ...item, leadTimeDays: null }, { id: 's1', leadTimeDays: 30 })).toEqual({ leadTimeDays: 30, minOrderQuantity: '5', orderMultiple: '1' })
    expect(supplyRulesFor(item, { id: 's2', leadTimeDays: 7 })).toEqual({ leadTimeDays: 7, minOrderQuantity: null, orderMultiple: null })
    expect(supplyRulesFor(item, null)).toEqual({ leadTimeDays: 14, minOrderQuantity: '5', orderMultiple: '1' })
    expect(supplyRulesFor({ defaultSupplierId: null, leadTimeDays: -1, minOrderQty: '0', orderMultiple: 'x' }, null)).toEqual(NO_SUPPLY_RULES)
  })

  it('orders by the need date less the lead time; without one, by the need date, and says so', () => {
    expect(addDays('2026-11-26', -14)).toBe('2026-11-12')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(orderByOf('2026-11-26', { ...NO_SUPPLY_RULES, leadTimeDays: 14 }, '2026-11-13')).toEqual({ date: '2026-11-12', leadTimeDays: 14, passed: true })
    expect(orderByOf('2026-11-26', NO_SUPPLY_RULES, '2026-11-13')).toEqual({ date: '2026-11-26', leadTimeDays: null, passed: false })
  })
})

// ---- a whole run ---------------------------------------------------------------------------------------------------

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
const REVISION = {
  id: 'rev-1',
  lines: [
    bomLine({
      id: 'bl-10',
      seq: 10,
      itemId: 'leather',
      qty: '45',
      uom: 'FT2',
      wastagePct: '12',
      sizeDependent: true,
      colourDependent: true,
      sizes: [
        { size: '50', qty: '43' },
        { size: '52', qty: '45' },
        { size: '54', qty: '47.5' },
      ],
      colours: [
        { colourwayId: 'cw-blk', itemColourId: 'leather-blk' },
        { colourwayId: 'cw-red', itemColourId: 'leather-red' },
      ],
    }),
    bomLine({ id: 'bl-20', seq: 20, itemId: 'lining', qty: '1.8', uom: 'M', wastagePct: '5', itemColourId: 'lining-gry' }),
    bomLine({ id: 'bl-30', seq: 30, itemId: 'protector', qty: '2', uom: 'PCS' }),
  ],
}
const ITEMS: PlanItem[] = [
  { id: 'leather', code: 'LEA-100', sourcing: 'BUY', units: LEATHER, defaultSupplierId: 'tannery' },
  { id: 'lining', code: 'LIN-200', sourcing: 'BUY', units: LINING, defaultSupplierId: null },
  { id: 'protector', code: 'PRO-300', sourcing: 'BUY', units: PIECES, defaultSupplierId: 'tannery' },
]
const orderLine = (fields: Partial<PlanOrderLine> & Pick<PlanOrderLine, 'orderLineId' | 'colourwayId' | 'sizes'>): PlanOrderLine => ({
  orderId: 'so-1',
  orderNumber: 'SO-1',
  lineSeq: 10,
  styleId: 'style-1',
  revisionId: 'rev-1',
  dueDate: '2026-12-15',
  ...fields,
})
const GRID: PlanOrderLine[] = [
  orderLine({ orderLineId: 'so-1-10', colourwayId: 'cw-blk', sizes: [{ size: '50', pieces: 2 }, { size: '52', pieces: 4 }, { size: '54', pieces: 2 }] }),
  orderLine({ orderLineId: 'so-1-20', lineSeq: 20, colourwayId: 'cw-red', sizes: [{ size: '50', pieces: 1 }, { size: '52', pieces: 2 }, { size: '54', pieces: 1 }] }),
]
const input = (fields: Partial<PlanInput> = {}): PlanInput => ({
  runDate: '2026-11-02',
  orderLines: GRID,
  revisions: [REVISION],
  items: ITEMS,
  workOrderCells: [],
  workOrderIssues: [],
  stock: [],
  lots: [],
  purchases: [],
  ...fields,
})
const byMaterial = (result: ReturnType<typeof planRequirements>) => Object.fromEntries(result.requirements.map((line) => [`${line.itemId}/${line.itemColourId ?? '-'}`, line]))

describe('the BOM explosion per size and colour (PLN-062, PLN-063)', () => {
  it('leather per size and colourway in ft² with its wastage, lining in metres, protectors per piece; suggested in hides, rolls and pieces', () => {
    const result = planRequirements(input())
    expect(result.orderLines).toBe(2)
    expect(result.warnings).toEqual([])
    const lines = byMaterial(result)
    // BLK 2/4/2: 43, 45, 47.5 ft² × 1.12 → 96.32 + 201.6 + 106.4.
    expect(lines['leather/leather-blk']).toMatchObject({ seq: 1, action: 'BUY', uom: 'FT2', grossQuantity: '404.3200', netQuantity: '404.3200', suggestedQuantity: '8.0000', suggestedUom: 'HIDE', supplierId: 'tannery', needDate: '2026-12-15' })
    expect(lines['leather/leather-blk']!.sources.map((source) => [source.size, source.pieces, source.quantity])).toEqual([
      ['50', 2, '96.3200'],
      ['52', 4, '201.6000'],
      ['54', 2, '106.4000'],
    ])
    expect(lines['leather/leather-red']).toMatchObject({ grossQuantity: '202.1600', suggestedQuantity: '4.0000' })
    // 12 garments × 1.8 m × 1.05.
    expect(lines['lining/lining-gry']).toMatchObject({ uom: 'M', grossQuantity: '22.6800', suggestedQuantity: '1.0000', suggestedUom: 'ROLL', supplierId: null })
    expect(lines['protector/-']).toMatchObject({ uom: 'PCS', grossQuantity: '24.0000', suggestedQuantity: '24.0000', suggestedUom: 'PCS' })
    expect(result.requirements.map((line) => line.seq)).toEqual([1, 2, 3, 4])
  })

  it('nets usable stock and open purchase lines due in time; held stock is not netted', () => {
    const result = planRequirements(
      input({
        stock: [
          { itemId: 'leather', itemColourId: 'leather-blk', lotId: 'lot-ok', quantity: '51.8', hides: 1 },
          { itemId: 'leather', itemColourId: 'leather-blk', lotId: 'lot-q', quantity: '60', hides: 1 },
          { itemId: 'lining', itemColourId: 'lining-gry', lotId: 'lot-lin', quantity: '120', hides: 0 },
        ],
        lots: [lot('lot-ok', { requiresCrViTest: true, crViStatus: 'PASS' }), lot('lot-q', { qualityStatus: 'QUARANTINE', requiresCrViTest: true, crViStatus: 'PENDING' }), lot('lot-lin')],
        purchases: [{ itemId: 'leather', itemColourId: 'leather-blk', purchaseOrderLineId: 'po-10', purchaseOrderNumber: 'PO-1', openQuantity: '315', dueDate: '2026-11-13' }],
      }),
    )
    const lines = byMaterial(result)
    expect(lines['leather/leather-blk']).toMatchObject({ grossQuantity: '404.3200', usableStock: '51.8000', heldStock: '60.0000', onOrder: '315.0000', netQuantity: '37.5200', suggestedQuantity: '1.0000' })
    expect(lines['lining/lining-gry']).toMatchObject({ usableStock: '120.0000', netQuantity: '0.0000', suggestedQuantity: '0.0000' })
  })

  it("takes off what work orders already hold, never twice: made pieces need nothing, issued material only up to the work order's cells", () => {
    const result = planRequirements(
      input({
        workOrderCells: [
          { workOrderId: 'wo-1', workOrderNumber: 'WO-1', status: 'IN_PROGRESS', orderLineId: 'so-1-10', size: '50', pieces: 2 },
          { workOrderId: 'wo-1', workOrderNumber: 'WO-1', status: 'IN_PROGRESS', orderLineId: 'so-1-10', size: '52', pieces: 4 },
          { workOrderId: 'wo-2', workOrderNumber: 'WO-2', status: 'COMPLETED', orderLineId: 'so-1-20', size: '54', pieces: 1 },
          { workOrderId: 'wo-3', workOrderNumber: 'WO-3', status: 'CANCELLED', orderLineId: 'so-1-20', size: '50', pieces: 1 },
        ],
        workOrderIssues: [
          { workOrderId: 'wo-1', itemId: 'leather', itemColourId: 'leather-blk', quantity: '120' },
          // More lining than WO-1's cells need (6 garments × 1.89 m): the rest helps no other order.
          { workOrderId: 'wo-1', itemId: 'lining', itemColourId: 'lining-gry', quantity: '40' },
          { workOrderId: 'wo-3', itemId: 'leather', itemColourId: 'leather-red', quantity: '48.16' },
        ],
      }),
    )
    const lines = byMaterial(result)
    expect(lines['leather/leather-blk']!.sources.map((source) => [source.size, source.quantity, source.issued, source.workOrders])).toEqual([
      ['50', '96.3200', '96.3200', ['WO-1']],
      ['52', '201.6000', '23.6800', ['WO-1']],
      ['54', '106.4000', '0.0000', []],
    ])
    expect(lines['leather/leather-blk']).toMatchObject({ grossQuantity: '284.3200' })
    // RED 54 is made (WO-2): 202.16 − 53.2; the cancelled WO-3 changes nothing.
    expect(lines['leather/leather-red']).toMatchObject({ grossQuantity: '148.9600' })
    expect(lines['leather/leather-red']!.sources.find((source) => source.size === '54')).toBeUndefined()
    // 22.68 − 1.89 (made) − 11.34 (WO-1's six garments, of the 40 m issued).
    expect(lines['lining/lining-gry']).toMatchObject({ grossQuantity: '9.4500' })
    expect(lines['protector/-']).toMatchObject({ grossQuantity: '22.0000' })
  })

  it('warns, in words, about what it cannot plan, and plans the rest', () => {
    const result = planRequirements(
      input({
        orderLines: [
          ...GRID,
          orderLine({ orderLineId: 'so-2-10', orderId: 'so-2', orderNumber: 'SO-2', colourwayId: 'cw-blk', revisionId: null, sizes: [{ size: '52', pieces: 1 }] }),
          orderLine({ orderLineId: 'so-3-10', orderId: 'so-3', orderNumber: 'SO-3', colourwayId: 'cw-grn', dueDate: null, sizes: [{ size: '56', pieces: 1 }] }),
          orderLine({ orderLineId: 'so-4-10', orderId: 'so-4', orderNumber: 'SO-4', colourwayId: 'cw-blk', sizes: [] }),
        ],
      }),
    )
    expect(result.orderLines).toBe(3)
    expect(result.warnings.map((warning) => [warning.code, warning.orderLineId])).toEqual([
      ['NO_RELEASED_BOM', 'so-2-10'],
      ['NO_DATE', 'so-3-10'],
      ['COLOURWAY_NOT_IN_BOM', 'so-3-10'],
      ['NO_SIZE', 'so-4-10'],
    ])
    expect(result.warnings[0]!.message).toBe('SO-2 line 10 is not planned: its style has no released BOM.')
    // SO-3's lining and protector still count (on the run day); its leather has no colour for the colourway.
    expect(byMaterial(result)['protector/-']).toMatchObject({ grossQuantity: '26.0000', needDate: '2026-11-02' })
  })

  it("a part we make is a MAKE line without a supplier; a BOM line's own supplier wins when all agree", () => {
    const revision = { id: 'rev-1', lines: [bomLine({ id: 'bl-40', seq: 40, itemId: 'panel', qty: '1', uom: 'PCS' }), bomLine({ id: 'bl-30', seq: 30, itemId: 'protector', qty: '2', uom: 'PCS', supplierId: 'armour-co' })] }
    const result = planRequirements(input({ revisions: [revision], items: [...ITEMS, { id: 'panel', code: 'CMP-1', sourcing: 'MAKE', units: PIECES, defaultSupplierId: null }] }))
    expect(byMaterial(result)['panel/-']).toMatchObject({ action: 'MAKE', supplierId: null, suggestedUom: 'PCS', suggestedQuantity: '12.0000' })
    expect(byMaterial(result)['protector/-']).toMatchObject({ action: 'BUY', supplierId: 'armour-co' })
    expect(result.requirements.map((line) => line.action)).toEqual(['BUY', 'MAKE'])
  })

  it("rounds the buy to the supplier's minimum and multiple through the one terms lookup", () => {
    const result = planRequirements(input({ supplyRulesOf: (itemId) => (itemId === 'protector' ? { leadTimeDays: 10, minOrderQuantity: '50', orderMultiple: '25' } : NO_SUPPLY_RULES) }))
    expect(byMaterial(result)['protector/-']).toMatchObject({ netQuantity: '24.0000', suggestedQuantity: '50.0000' })
  })
})

describe('why this number (design 02, the Why cell and drawer)', () => {
  const line: LineNumbers = { action: 'BUY', uom: 'FT2', grossQuantity: '420.0000', usableStock: '120.0000', heldStock: '60.0000', onOrder: '100.0000', netQuantity: '200.0000', needDate: '2026-11-26' }
  const suggestion = suggestionFor('200', 'BUY', LEATHER)

  it('says the netting in one line and as a ladder, without money', () => {
    expect(whyLine(line)).toBe('Need 420 − usable 120 − on order 100 = short 200 ft²')
    expect(bridgeOf(line, suggestion).map((step) => [step.step, step.quantity])).toEqual([
      ['NEED', '420.0000'],
      ['USABLE', '-120.0000'],
      ['ON_ORDER', '-100.0000'],
      ['SHORT', '200.0000'],
      ['ROUNDING', '10.0000'],
      ['BUY', '210.0000'],
    ])
  })

  it('says it as sentences: held stock, late goods, the buy in hides and the order-by date', () => {
    const facts = { orders: 2, issued: '0', otherColours: '0', rejected: '0', tooLate: '40', suggestion, hides: 4, orderBy: orderByOf('2026-11-26', { ...NO_SUPPLY_RULES, leadTimeDays: 14 }, '2026-11-02') }
    expect(sentenceOf(line, facts)).toBe(
      'We need 420 ft² for 2 orders. 120 ft² in stock can be used. 60 ft² more are held (quality hold, chromium VI test or blocked) and not counted. ' +
        '100 ft² are already ordered and arrive in time. 40 ft² more on order arrive after they are needed and are not counted. We are 200 ft² short. ' +
        "Buy 4 hides (about 210 ft²). Order by 2026-11-12 to have it by 2026-11-26 (14 days' lead time).",
    )
    expect(sentenceOf({ ...line, netQuantity: '0.0000', onOrder: '300.0000' }, { ...facts, tooLate: '0' })).toMatch(/Nothing is short/)
    expect(sentenceOf(line, { ...facts, orderBy: orderByOf('2026-11-26', NO_SUPPLY_RULES, '2026-11-02') })).toMatch(/No lead time is on record: order by 2026-11-26, the day it is needed\.$/)
    expect(sentenceOf(line, facts)).not.toMatch(/€|EUR|price|cost/i)
  })
})

describe('deciding lines (set aside, open again, ordered)', () => {
  it('keeps the set-aside reason with its note, and reads it back', () => {
    expect(decisionNoteOf('CUSTOMER_SUPPLIES', '  ')).toBe('CUSTOMER_SUPPLIES')
    expect(decisionNoteOf('OTHER', 'Sample stock')).toBe('OTHER: Sample stock')
    expect(readDecisionNote('SUBSTITUTE: lining B')).toEqual({ reason: 'SUBSTITUTE', note: 'lining B' })
    expect(readDecisionNote('typed by hand')).toEqual({ reason: 'OTHER', note: 'typed by hand' })
    expect(setAsideProblems({ reason: 'OTHER', note: ' ' })).toEqual([{ path: 'body/note', message: 'Say why the lines are set aside.' }])
    expect(setAsideProblems({ reason: 'CUSTOMER_SUPPLIES' })).toEqual([])
  })

  it('decides only lines of a DONE run, from the right decision', () => {
    expect(decisionProblem({ decision: 'OPEN', action: 'BUY' }, 'DONE', 'IGNORED')).toBeNull()
    expect(decisionProblem({ decision: 'IGNORED', action: 'BUY' }, 'DONE', 'OPEN')).toBeNull()
    expect(decisionProblem({ decision: 'OPEN', action: 'BUY' }, 'DONE', 'ORDERED')).toBeNull()
    expect(decisionProblem({ decision: 'OPEN', action: 'BUY' }, 'SUPERSEDED', 'IGNORED')).toMatch(/newer plan/)
    expect(decisionProblem({ decision: 'ORDERED', action: 'BUY' }, 'DONE', 'IGNORED')).toMatch(/ordered already/)
    expect(decisionProblem({ decision: 'OPEN', action: 'MAKE' }, 'DONE', 'ORDERED')).toMatch(/Only a line to buy/)
    expect(decisionProblem({ decision: 'OPEN', action: 'BUY' }, 'DONE', 'OPEN')).toMatch(/open already/)
  })
})

describe('declared', () => {
  it('the permissions and events are in the catalogues; no event carries money', () => {
    for (const permission of PLANNING_PERMISSIONS) expect(FACTORY_PERMISSIONS.isDeclared(permission)).toBe(true)
    expect(EVENT_CATALOGUE.types().filter((type) => type.startsWith('planning.'))).toEqual(['planning.requirements_decided', 'planning.run_failed', 'planning.run_finished'])
  })
})
