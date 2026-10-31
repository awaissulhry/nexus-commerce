import { describe, expect, it } from 'vitest'
import { decimalOf } from '../../product/units/units'
import { datedFor, entryKeys, labourEntry, methodWords, moveEntry, overheadEntry, perMinuteOf, reversalEntry, scrapRecords } from './entries'
import { actualOf, biggestReason, bridgeOf, estimateOf, isOver, minorParts, perGarment, standardOfCells, variancePct, type EntryFacts } from './variance'

/**
 * The work-order cost ledger and estimated vs actual (B-W2a-21; FIN-026, FIN-027, FIN-033, FIN-038), pure. Every figure is
 * made up and worked out by hand in the comments (EUR, minor units = cents).
 */

const at = new Date('2026-11-16T07:30:00.000Z')
let next = 0
const ids = () => `00000000-0000-7000-8000-${String(++next).padStart(12, '0')}`

describe('the entry a stock move of the work order posts', () => {
  it('charges an issue at its stock value, takes a return off, charges scrap from stock, moves a receipt out', () => {
    // The seed's issue: 53.2 ft² valued −223.44 (out of stock) → +223.44 onto the work order, compared with 4.20.
    const issue = moveEntry('e1', { id: 'm1', reason: 'ISSUE', itemId: 'leather', baseQuantity: '53.2000', occurredAt: at, valueAmount: -22_344, unitCost: '4.200000' }, { id: 's1', unitCost: '4.200000' })
    expect(issue).toMatchObject({ kind: 'MATERIAL', quantity: '53.2', amount: 22_344, unitCost: '4.2', standardUnitCost: '4.2', standardCostId: 's1', stockMoveId: 'm1', idempotencyKey: 'move:m1', reversalOfId: null })
    // 10 ft² back (+42.00 into stock) → −42.00 and −10 ft² off the work order.
    expect(moveEntry('e2', { id: 'm2', reason: 'RETURN', itemId: 'leather', baseQuantity: '10', occurredAt: at, valueAmount: 4_200, unitCost: '4.2' }, null)).toMatchObject({ kind: 'MATERIAL', quantity: '-10', amount: -4_200, standardUnitCost: null })
    // 2 ft² of leather scrapped from stock for the work order (−8.40) → the work order bears +8.40.
    expect(moveEntry('e3', { id: 'm3', reason: 'SCRAP', itemId: 'leather', baseQuantity: '2', occurredAt: at, valueAmount: -840, unitCost: '4.2' }, null)).toMatchObject({ kind: 'SCRAP', quantity: '2', amount: 840 })
    // One jacket into finished goods at its standard 350.00 → −350.00 and −1 piece off the work order.
    expect(moveEntry('e4', { id: 'm4', reason: 'PRODUCTION_RECEIPT', itemId: 'jacket', baseQuantity: '1', occurredAt: at, valueAmount: 35_000, unitCost: '350' }, { id: 's2', unitCost: '350' })).toMatchObject({ kind: 'COMPLETION', quantity: '-1', amount: -35_000 })
  })
})

describe('labour from scans', () => {
  it('is good garments × standard minutes at the cost per minute ÷ planned efficiency, never per person', () => {
    // Sewing at 0.40 a minute, planned at 80 %: 0.50 a standard minute.
    expect(perMinuteOf({ costPerMinute: '0.400000', plannedEfficiencyPct: '80.0000' })).toBe('0.5')
    expect(perMinuteOf({ costPerMinute: '0.42', plannedEfficiencyPct: '0' })).toBeNull()
    // The seed's standing sewing scan: 2 jackets × 96.5 minutes = 193 minutes × 0.50 = 96.50.
    const entry = labourEntry('e1', { id: 'scan3', goodQuantity: 2, serverTime: at }, '96.500', '0.5', 'EUR')
    expect(entry).toMatchObject({ kind: 'LABOUR', minutes: '193', unitCost: '0.5', amount: 9_650, operationScanId: 'scan3', idempotencyKey: 'scan:scan3', itemId: null, quantity: null })
    expect(Object.keys(entry)).not.toContain('workerId')
    // 3 × 14.333 minutes at 0.416667 a minute: 42.999 × 0.416667 = 17.916… → 17.92.
    expect(labourEntry('e2', { id: 's', goodQuantity: 3, serverTime: at }, '14.333', '0.416667', 'EUR').amount).toBe(1_792)
  })
})

describe('reversals, overhead, dating', () => {
  it('reverses an entry exactly: the same kind, the opposite amount, quantity and minutes, with its reason', () => {
    const entry = { id: 'e1', kind: 'LABOUR' as const, itemId: null, quantity: null, minutes: '193', unitCost: '0.5', standardUnitCost: null, standardCostId: null, amount: 9_650 }
    expect(reversalEntry('r1', entry, at, 'Scan undone.')).toMatchObject({ kind: 'LABOUR', minutes: '-193', amount: -9_650, reversalOfId: 'e1', reason: 'Scan undone.', idempotencyKey: entryKeys.reversal('e1') })
    const material = { ...entry, kind: 'MATERIAL' as const, itemId: 'leather', quantity: '53.2', minutes: null, amount: 22_344 }
    expect(reversalEntry('r2', material, at, 'Wrong hide.', { key: 'move:m9', stockMoveId: 'm9' })).toMatchObject({ quantity: '-53.2', amount: -22_344, stockMoveId: 'm9', idempotencyKey: 'move:m9' })
    // A record of scrap (amount 0) reverses to 0, not −0.
    expect(Object.is(reversalEntry('r3', { ...material, kind: 'SCRAP', amount: 0 }, at, 'x').amount, 0)).toBe(true)
  })

  it('applies overhead with material, stock scrap and labour, one rounding; none at 0 % or on a record', () => {
    // 96.50 × 10 % = 9.65; 3.33 × 12.5 % = 0.41625 → 0.42.
    expect(overheadEntry('o1', { id: 'e1', kind: 'LABOUR', amount: 9_650, occurredAt: at }, '10')).toMatchObject({ kind: 'OVERHEAD', amount: 965, sourceType: 'WorkOrderCostEntry', sourceId: 'e1', idempotencyKey: 'overhead:e1' })
    expect(overheadEntry('o2', { id: 'e2', kind: 'MATERIAL', amount: 333, occurredAt: at }, '12.5')?.amount).toBe(42)
    expect(overheadEntry('o3', { id: 'e3', kind: 'MATERIAL', amount: -333, occurredAt: at }, '12.5')?.amount).toBe(-42)
    expect(overheadEntry('o4', { id: 'e4', kind: 'LABOUR', amount: 9_650, occurredAt: at }, '0')).toBeNull()
    expect(overheadEntry('o5', { id: 'e5', kind: 'SCRAP', amount: 0, occurredAt: at }, '10')).toBeNull()
    expect(overheadEntry('o6', { id: 'e6', kind: 'COMPLETION', amount: -35_000, occurredAt: at }, '10')).toBeNull()
  })

  it('dates an event of a locked month now, and waits while today is locked too', () => {
    const september = [{ periodStart: '2026-09-01', periodEnd: '2026-09-30' }]
    const now = new Date('2026-10-30T10:00:00.000Z')
    expect(datedFor(at, now, september)).toEqual({ at, note: null })
    // The Europe/Rome day decides: 22:30 UTC on 30 September is 00:30 on 1 October in Rome (open); 21:30 UTC is 23:30 (locked).
    expect(datedFor(new Date('2026-09-30T22:30:00.000Z'), now, september)).toEqual({ at: new Date('2026-09-30T22:30:00.000Z'), note: null })
    expect(datedFor(new Date('2026-09-30T21:30:00.000Z'), now, september)?.at).toEqual(now)
    const late = datedFor(new Date('2026-09-15T08:00:00.000Z'), now, september)
    expect(late?.at).toEqual(now)
    expect(late?.note).toBe('Dated 2026-10-30: 2026-09-15 is in the locked period 2026-09-01 to 2026-09-30.')
    expect(datedFor(new Date('2026-09-15T08:00:00.000Z'), new Date('2026-09-20T08:00:00.000Z'), september)).toBeNull()
  })

  it('records scrapped garments per material: the area, its value per base unit at the issue, amount 0', () => {
    // 3.3333 + 1.6667 = 5 ft² of one leather, 14.00 + 7.00 = 21.00 at the issues → 4.20 a ft².
    const records = scrapRecords(
      ids,
      [
        { itemId: 'leather', area: '3.3333', value: 1_400 },
        { itemId: 'leather', area: '1.6667', value: 700 },
      ],
      { occurredAt: at, operationScanId: 'scan', key: (itemId) => entryKeys.scanScrap('scan', itemId), reason: '1 garment(s) scrapped', currency: 'EUR' },
      () => ({ id: 'std', unitCost: '4.1' }),
    )
    expect(records).toEqual([expect.objectContaining({ kind: 'SCRAP', itemId: 'leather', quantity: '5', unitCost: '4.2', standardUnitCost: '4.1', amount: 0, operationScanId: 'scan', idempotencyKey: 'scan-scrap:scan:leather' })])
    expect(scrapRecords(ids, [{ itemId: 'leather', area: '1', value: null }], { occurredAt: at, operationScanId: 's', key: () => 'k', reason: 'r', currency: 'EUR' }, () => null)[0]?.unitCost).toBeNull()
    // B-W2b-22: a rework opened by hand has no scan: the record names its rework order instead.
    expect(scrapRecords(ids, [{ itemId: 'leather', area: '3.3333', value: 1_400 }], { occurredAt: at, operationScanId: null, sourceType: 'ReworkOrder', sourceId: 'rework', key: (itemId) => entryKeys.reworkScrap('rework', itemId), reason: '1 garment(s) scrapped in rework', currency: 'EUR' }, () => null)).toEqual([
      expect.objectContaining({ kind: 'SCRAP', amount: 0, operationScanId: null, stockMoveId: null, sourceType: 'ReworkOrder', sourceId: 'rework', idempotencyKey: 'rework-scrap:rework:leather' }),
    ])
  })

  it('says the method in words: provisional until the accountant chooses, held once locked', () => {
    expect(methodWords('UNDECIDED', null)).toMatch(/not chosen yet.*provisional/)
    expect(methodWords('FIFO', null)).toBe('The costing method is FIFO. It locks with the first cost entry posted under it.')
    expect(methodWords('STANDARD', '2026-10-03')).toMatch(/locked since 2026-10-03: cost entries rely on it, and changing it would revalue them/)
  })
})

describe('estimated vs actual', () => {
  // Two jackets: standard per garment 200.00 material + 50.00 labour.
  const cells = [
    { cellId: 'c1', quantity: 1, standard: { materialCost: '200', labourCost: '50', subcontractCost: '0', overheadCost: '0' } },
    { cellId: 'c2', quantity: 1, standard: { materialCost: '200', labourCost: '50', subcontractCost: '0', overheadCost: '0' } },
  ]
  const entries: EntryFacts[] = [
    // 100 ft² issued at 4.30 (standard 4.20): 430.00; 5 ft² back: −21.50.
    { kind: 'MATERIAL', amount: 43_000, quantity: '100', unitCost: '4.3', standardUnitCost: '4.2', scrapRecord: false },
    { kind: 'MATERIAL', amount: -2_150, quantity: '-5', unitCost: '4.3', standardUnitCost: '4.2', scrapRecord: false },
    { kind: 'LABOUR', amount: 9_650, quantity: null, unitCost: '0.5', standardUnitCost: null, scrapRecord: false },
    // 3 ft² in scrapped garments (a record), and 10.00 of leather scrapped from stock.
    { kind: 'SCRAP', amount: 0, quantity: '3', unitCost: '4.3', standardUnitCost: '4.2', scrapRecord: true },
    { kind: 'SCRAP', amount: 1_000, quantity: '2', unitCost: '5', standardUnitCost: '4.2', scrapRecord: false },
    { kind: 'COMPLETION', amount: -30_000, quantity: '-1', unitCost: '300', standardUnitCost: '300', scrapRecord: false },
  ]

  it('sums the standard of the cells, and is unknown when a cell has none', () => {
    expect(minorParts(standardOfCells(cells)!, 'EUR')).toEqual({ material: 40_000, labour: 10_000, subcontract: 0, overhead: 0, total: 50_000 })
    expect(standardOfCells([...cells, { cellId: 'c3', quantity: 1, standard: null }])).toBeNull()
  })

  it('takes the actual from the entries, the completion moved out apart', () => {
    // Material 430.00 − 21.50 + 10.00 = 418.50; labour 96.50; total 515.00; on the work order after 300.00 moved: 215.00.
    expect(actualOf(entries, 'EUR')).toEqual({ material: 41_850, labour: 9_650, subcontract: 0, overhead: 0, adjustment: 0, total: 51_500, movedToStock: -30_000, onWorkOrder: 21_500, scrapLost: 1_290, scrapFromStock: 1_000 })
  })

  it('splits the variance into reasons that add up to it exactly', () => {
    const basis = minorParts(standardOfCells(cells)!, 'EUR')
    const actual = actualOf(entries, 'EUR')
    const steps = bridgeOf(basis, actual, entries, 'EUR')
    // Price: 408.50 issued less 95 ft² × 4.20 = 399.00 → +9.50. Scrap: 10.00 from stock + 3 × 4.20 = 12.60 → +22.60.
    // Usage: 418.50 − 400.00 − 9.50 − 22.60 = −13.60. Labour: 96.50 − 100.00 = −3.50 (not every garment earned yet).
    expect(steps).toEqual([
      { reason: 'MATERIAL_PRICE', amount: 950 },
      { reason: 'MATERIAL_USAGE', amount: -1_360 },
      { reason: 'SCRAP', amount: 2_260 },
      { reason: 'LABOUR', amount: -350 },
      { reason: 'SUBCONTRACT', amount: 0 },
      { reason: 'OVERHEAD', amount: 0 },
      { reason: 'ADJUSTMENT', amount: 0 },
    ])
    expect(steps.reduce((sum, step) => sum + step.amount, 0)).toBe(actual.total - basis.total)
    expect(biggestReason(steps)).toBe('SCRAP')
    expect(variancePct(1_500, 50_000)).toBe('3.00')
    expect(variancePct(1_500, 0)).toBeNull()
    expect(isOver(1_500, 50_000)).toBe(false)
    expect(isOver(2_501, 50_000)).toBe(true)
    expect(biggestReason(steps.map((step) => ({ ...step, amount: 0 })))).toBeNull()
  })

  it('lands the cents of the basis rounding in usage, so the bridge still adds up', () => {
    // Material 1.005 and labour 1.005 round to 1.01 each (2.02 together), their exact total 2.01 to 2.01: a cent apart.
    const basis = minorParts({ material: decimalOf('1.005'), labour: decimalOf('1.005'), subcontract: decimalOf('0'), overhead: decimalOf('0') }, 'EUR')
    expect(basis).toEqual({ material: 101, labour: 101, subcontract: 0, overhead: 0, total: 201 })
    const actual = actualOf([{ kind: 'MATERIAL', amount: 100, quantity: '1', unitCost: '1', standardUnitCost: null, scrapRecord: false }], 'EUR')
    const steps = bridgeOf(basis, actual, [], 'EUR')
    expect(steps.reduce((sum, step) => sum + step.amount, 0)).toBe(100 - 201)
  })

  it('estimates at release from the frozen need and minutes, and says what is missing', () => {
    // 100 ft² × 4.20 = 420.00; 193 minutes × 0.50 = 96.50; overhead 10 % of 516.50 = 51.65.
    const estimate = estimateOf({
      materials: [
        { itemId: 'leather', baseQuantity: '100', unitCost: '4.2' },
        { itemId: 'zip', baseQuantity: '2', unitCost: null },
      ],
      operations: [{ operationId: 'sew', minutes: '193', perMinute: '0.5' }],
      overheadPct: '10',
    })
    expect(minorParts(estimate.parts, 'EUR')).toEqual({ material: 42_000, labour: 9_650, subcontract: 0, overhead: 5_165, total: 56_815 })
    expect(estimate).toMatchObject({ complete: false, missingItems: ['zip'], missingOperations: [] })
    expect(perGarment(51_500, 2)).toBe(25_750)
    expect(perGarment(1, 2)).toBe(1)
    expect(perGarment(1, 0)).toBeNull()
  })
})
