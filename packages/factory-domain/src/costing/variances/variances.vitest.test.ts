import { describe, expect, it } from 'vitest'
import { decimalOf } from '../../product/units/units'
import { recordValue, scrapAndRework } from './scrap-rework'
import { NO_BASIS_WORDS, outputStandard, splitVariances, type SplitEntry, type SplitFacts } from './split'

/**
 * The variance split of a close and the scrap and rework cost (B-W2b-411; FIN-029, FIN-030, FIN-034), pure. Every figure is
 * made up and worked out by hand in the comments (EUR, minor units = cents).
 */

const entry = (fields: Partial<SplitEntry> & Pick<SplitEntry, 'kind' | 'amount'>): SplitEntry => ({ itemId: null, quantity: null, minutes: null, unitCost: null, standardUnitCost: null, scrapRecord: false, ...fields })
const parts = (material: string, labour: string, subcontract: string, overhead: string) => ({ material: decimalOf(material), labour: decimalOf(labour), subcontract: decimalOf(subcontract), overhead: decimalOf(overhead) })

describe('the standard of the garments made (the flexible standard)', () => {
  it("is each cell's frozen standard × the garments it made, or the estimate in proportion to the garments made", () => {
    // 2 made at 50/20/0/7 and 1 at 52/20/0/7 → material 152, labour 60, overhead 21.
    const standard = outputStandard(
      'STANDARD',
      [
        { made: 2, standard: { materialCost: '50', labourCost: '20', subcontractCost: '0', overheadCost: '7' } },
        { made: 1, standard: { materialCost: '52', labourCost: '20', subcontractCost: '0', overheadCost: '7' } },
      ],
      null,
      4,
      3,
    )
    expect([standard!.material.toFixed(), standard!.labour.toFixed(), standard!.subcontract.toFixed(), standard!.overhead.toFixed()]).toEqual(['152', '60', '0', '21'])
    // The estimate for 4 planned (100 / 40 / 0 / 14), 3 made → 75 / 30 / 0 / 10.5.
    const estimate = outputStandard('ESTIMATE', [], parts('100', '40', '0', '14'), 4, 3)
    expect([estimate!.material.toFixed(), estimate!.labour.toFixed(), estimate!.overhead.toFixed()]).toEqual(['75', '30', '10.5'])
    // A cell without a standard, or no basis: none.
    expect(outputStandard('STANDARD', [{ made: 1, standard: null }], null, 1, 1)).toBeNull()
    expect(outputStandard(null, [], null, 4, 3)).toBeNull()
  })
})

describe('the variance split of a close', () => {
  // 4 planned, 3 made good, 1 scrapped; the standard per garment 50.00 material, 20.00 labour, 7.00 overhead → the
  // garments made 150 / 60 / 0 / 21 (231.00). The work order's list: 40 ft² of leather L for the 4 at 4.00, 8 m of lining
  // N at 3.00 (no frozen standard: the need's price); 25 standard minutes a garment.
  const facts = (entries: SplitEntry[]): SplitFacts => ({
    currency: 'EUR',
    basis: 'STANDARD',
    output: parts('150', '60', '0', '21'),
    plannedGarments: 4,
    madeGarments: 3,
    needs: [
      { itemId: 'item-L', baseQuantity: '40', unitCost: '4' },
      { itemId: 'item-N', baseQuantity: '8', unitCost: '3' },
    ],
    minutesPerGarment: '25',
    entries,
  })
  const ledger: SplitEntry[] = [
    // 32 ft² issued at 4.20 (134.40) against 4.00; 2 ft² back (−8.40).
    entry({ kind: 'MATERIAL', itemId: 'item-L', quantity: '32', amount: 13_440, unitCost: '4.2', standardUnitCost: '4' }),
    entry({ kind: 'MATERIAL', itemId: 'item-L', quantity: '-2', amount: -840, unitCost: '4.2', standardUnitCost: '4' }),
    // 6 m of lining at 3.00 (18.00), no standard.
    entry({ kind: 'MATERIAL', itemId: 'item-N', quantity: '6', amount: 1_800, unitCost: '3' }),
    // The scrapped garment's leather: 10 ft², a record (0); 1 m of lining scrapped from stock (3.00).
    entry({ kind: 'SCRAP', itemId: 'item-L', quantity: '10', amount: 0, unitCost: '4.2', standardUnitCost: '4', scrapRecord: true }),
    entry({ kind: 'SCRAP', itemId: 'item-N', quantity: '1', amount: 300, unitCost: '3' }),
    // 100 standard minutes earned (65.00), a scan undone (−10 minutes, −6.50); overhead 20.00.
    entry({ kind: 'LABOUR', minutes: '100', amount: 6_500 }),
    entry({ kind: 'LABOUR', minutes: '-10', amount: -650 }),
    entry({ kind: 'OVERHEAD', amount: 2_000 }),
    // The 3 garments into finished goods at standard (−231.00).
    entry({ kind: 'COMPLETION', quantity: '-3', amount: -23_100 }),
  ]

  it('explains what is left on the work order by category; the closing entry takes the rest (here nothing)', () => {
    const split = splitVariances(facts(ledger))
    // Balance: 134.40 − 8.40 + 18.00 + 3.00 + 65.00 − 6.50 + 20.00 − 231.00 = −5.50.
    expect(split.balance).toBe(-550)
    expect(split.lines.map((line) => [line.category, line.itemId, line.amount])).toEqual([
      // L: 30 ft² cost 126.00 against 120.00 at standard → price +6.00.
      ['MATERIAL_PRICE', 'item-L', 600],
      // L: the scrapped garment's 10 ft² at 4.00 → scrap +40.00.
      ['SCRAP', 'item-L', 4_000],
      // L: used for the good garments 30 − 10 = 20 ft² against the need of the 3 made, 40 × 3 ÷ 4 = 30 ft², at 4.00 → −40.00.
      ['MATERIAL_USAGE', 'item-L', -4_000],
      // N: 1 m from stock at 3.00 → scrap +3.00 (its price and usage are 0: 6 m against 8 × 3 ÷ 4 = 6 m).
      ['SCRAP', 'item-N', 300],
      // The standard's material (150.00) against the list for the 3 made (30 × 4 + 6 × 3 = 138.00) → −12.00.
      ['MATERIAL_USAGE', null, -1_200],
      // 90 minutes earned against 3 × 25 = 75, at the standard's 60 ÷ 75 = 0.80 a minute → +12.00.
      ['LABOUR_EFFICIENCY', null, 1_200],
      // Labour 58.50 against 60.00 is −1.50; less the efficiency → rate −13.50 (0.65 a minute paid against 0.80).
      ['LABOUR_RATE', null, -1_350],
      // Overhead 20.00 against 21.00 → −1.00.
      ['OVERHEAD', null, -100],
    ])
    // The material lines add up to the material variance: 147.00 − 150.00 = −3.00.
    expect(split.lines.filter((line) => ['MATERIAL_PRICE', 'MATERIAL_USAGE', 'SCRAP'].includes(line.category)).reduce((sum, line) => sum + line.amount, 0)).toBe(-300)
    expect(split.explained).toBe(-550)
    expect(split.closing).toBe(0)
    expect(split.notSplit.map((row) => [row.category, row.code])).toEqual([
      ['REWORK', 'NOT_ON_LEDGER'],
      ['LOT_SIZE', 'NO_SET_UP'],
    ])
  })

  it('keeps the figures each line comes from: quantities, minutes and unit costs, each pair both or neither', () => {
    const split = splitVariances(facts(ledger))
    const line = (category: string, itemId: string | null) => split.lines.find((row) => row.category === category && row.itemId === itemId)!
    expect(line('MATERIAL_PRICE', 'item-L')).toMatchObject({ standardQuantity: '30', actualQuantity: '30', standardUnitCost: '4', actualUnitCost: '4.2' })
    expect(line('SCRAP', 'item-L')).toMatchObject({ standardQuantity: '0', actualQuantity: '10', standardUnitCost: '4', actualUnitCost: '4' })
    expect(line('MATERIAL_USAGE', 'item-L')).toMatchObject({ standardQuantity: '30', actualQuantity: '20', standardUnitCost: '4', actualUnitCost: '4' })
    expect(line('MATERIAL_USAGE', null)).toMatchObject({ standardQuantity: null, actualQuantity: null, standardUnitCost: null, actualUnitCost: null })
    expect(line('LABOUR_EFFICIENCY', null)).toMatchObject({ standardQuantity: '75', actualQuantity: '90', standardUnitCost: '0.8', actualUnitCost: '0.8' })
    expect(line('LABOUR_RATE', null)).toMatchObject({ standardQuantity: '90', actualQuantity: '90', standardUnitCost: '0.8', actualUnitCost: '0.65' })
    expect(line('OVERHEAD', null)).toMatchObject({ standardQuantity: '3', actualQuantity: '3', standardUnitCost: '7', actualUnitCost: '6.666667' })
  })

  it('leaves a hand adjustment and the value moved to stock against the standard to the closing entry', () => {
    // + an adjustment of 4.00, and the garments moved to stock at 232.00 instead of 231.00 (a cent of every kind).
    const split = splitVariances(facts([...ledger.slice(0, -1), entry({ kind: 'ADJUSTMENT', amount: 400 }), entry({ kind: 'COMPLETION', quantity: '-3', amount: -23_200 })]))
    // Balance −5.50 + 4.00 − 1.00 = −2.50; the lines still explain −5.50 → the closing entry −5.50 − (−2.50) = −3.00.
    expect(split.balance).toBe(-250)
    expect(split.explained).toBe(-550)
    expect(split.closing).toBe(-300)
    // After the variance entries (+5.50) and the closing entry the work order adds up to 0.
    expect(split.balance - split.explained + split.closing).toBe(0)
  })

  it('without standard minutes, all labour is against the standard; without a basis nothing is split', () => {
    const noMinutes = splitVariances({ ...facts(ledger), minutesPerGarment: '0' })
    expect(noMinutes.lines.filter((line) => line.category.startsWith('LABOUR')).map((line) => [line.category, line.amount, line.note !== null])).toEqual([['LABOUR_EFFICIENCY', -150, true]])
    expect(noMinutes.closing).toBe(0)
    const none = splitVariances({ ...facts(ledger), basis: null, output: null })
    expect(none).toMatchObject({ basis: null, lines: [], balance: -550, explained: 0, closing: 550, notSplit: [{ category: null, code: 'NO_BASIS', words: NO_BASIS_WORDS }] })
  })
})

describe('the cost of scrap and rework per reason (FIN-029)', () => {
  it("counts each source's garments once, values scrap at the issue and stock, prices rework minutes at the rate in force", () => {
    const result = scrapAndRework(
      [
        // Scan s1 scrapped 2 garments for an open seam: their leather 30.00 and their lining 10.00 (two records).
        { source: 'SCAN', sourceId: 's1', reasonCode: 'SEAM', garments: 2, value: 3_000 },
        { source: 'SCAN', sourceId: 's1', reasonCode: 'SEAM', garments: 2, value: 1_000 },
        // Rework r1 (an open seam) ended with 1 garment scrapped: 5.00.
        { source: 'REWORK', sourceId: 'r1', reasonCode: 'SEAM', garments: 1, value: 500 },
        // Leather damaged on the shelf for the work order: 3.00.
        { source: 'STOCK', sourceId: 'm1', reasonCode: 'DAMAGED', garments: 0, value: 300 },
        // Scan s2 scrapped 1 without a reason, not valued yet.
        { source: 'SCAN', sourceId: 's2', reasonCode: null, garments: 1, value: 0 },
      ],
      [
        // r1: 3 garments × 8 minutes at 0.50 → 24 minutes, 12.00.
        { reworkId: 'r1', reasonCode: 'SEAM', garments: 3, minutesPerGarment: '8', perMinute: '0.5' },
        // r2: 2 garments × 10.5 minutes, no rate in force → 21 minutes, no cost.
        { reworkId: 'r2', reasonCode: 'STAIN', garments: 2, minutesPerGarment: '10.5', perMinute: null },
      ],
      'EUR',
    )
    expect(result.rows).toEqual([
      { reasonCode: 'DAMAGED', scrappedGarments: 0, scrapValue: 0, stockScrapValue: 300, reworkGarments: 0, reworkMinutes: '0', reworkCost: 0, total: 300 },
      { reasonCode: 'NO_REASON', scrappedGarments: 1, scrapValue: 0, stockScrapValue: 0, reworkGarments: 0, reworkMinutes: '0', reworkCost: 0, total: 0 },
      { reasonCode: 'SEAM', scrappedGarments: 3, scrapValue: 4_500, stockScrapValue: 0, reworkGarments: 3, reworkMinutes: '24', reworkCost: 1_200, total: 5_700 },
      { reasonCode: 'STAIN', scrappedGarments: 0, scrapValue: 0, stockScrapValue: 0, reworkGarments: 2, reworkMinutes: '21', reworkCost: null, total: null },
    ])
    expect(result.totals).toEqual({ scrappedGarments: 4, scrapValue: 4_500, stockScrapValue: 300, reworkGarments: 5, reworkMinutes: '45', reworkCost: null, total: null })
  })

  it("values a scrap record at its base quantity × the issue's unit cost, rounded once", () => {
    expect(recordValue('10.0000', '4.200000', 'EUR')).toBe(4_200)
    expect(recordValue('0.3333', '1.000000', 'EUR')).toBe(33)
    expect(recordValue(null, '4.2', 'EUR')).toBe(0)
  })
})
