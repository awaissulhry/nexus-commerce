import { describe, expect, it } from 'vitest'
import { areaM2, basisWords, categoryOfKind, dependsOnMethod, totalsOf, unitCostOf, valuationMethodWords, valuationRows, valuePerM2, wipRows, type KeyBalance } from './rules'

/**
 * Stock valuation at any date and value by hide area (B-W2a-29; FIN-039, SCM-256): the rows are the ledger's sums, hides
 * roll into their lot, gone stock with a value left is a residue, and no figure is recomputed by a method. Every figure
 * is made up and worked out by hand.
 */

const key = (over: Partial<KeyBalance>): KeyBalance => ({
  companyId: 'c',
  siteId: 's',
  itemId: 'leather',
  itemColourId: 'blk',
  lotId: 'lot1',
  hideId: null,
  quantity: '0',
  valuedQuantity: '0',
  value: 0,
  unvaluedMoves: 0,
  methods: [],
  currencies: ['EUR'],
  ...over,
})

describe('the valuation rows', () => {
  it('roll the hides into their lot, count the hides with stock and add their ledger values', () => {
    // Hide 1: 53.2 ft² received at 4.20 (223.44) and issued whole (−223.44); hide 2: 51.8 ft² at 4.20 (217.56).
    const { rows, residues } = valuationRows([
      key({ hideId: 'h1', quantity: '0', valuedQuantity: '0', value: 0, methods: ['PURCHASE_PRICE', 'LOT_COST'] }),
      key({ hideId: 'h2', quantity: '51.8', valuedQuantity: '51.8', value: 21_756, methods: ['PURCHASE_PRICE'] }),
    ])
    expect(residues).toEqual([])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ lotId: 'lot1', hides: 1, value: 21_756, valued: 'FULL', methods: ['LOT_COST', 'PURCHASE_PRICE'], currency: 'EUR' })
    expect(rows[0]!.quantity.toFixed(4)).toBe('51.8000')
    expect(unitCostOf(21_756, '51.8', 'EUR')).toBe('4.200000')
  })

  it('keep stock that is gone but still holds a value apart (the rows and residues add up to the ledger)', () => {
    // 2 m received at 1.005 (2.01) and issued 1 m at a time at the lot's 1.005 (1.01 each): −1 cent left on nothing.
    const { rows, residues } = valuationRows([key({ itemId: 'thread', lotId: 'lot2', quantity: '0', valuedQuantity: '0', value: 201 - 101 - 101, methods: ['LOT_COST', 'PURCHASE_PRICE'] })])
    expect(rows).toEqual([])
    expect(residues).toEqual([{ companyId: 'c', siteId: 's', itemId: 'thread', itemColourId: 'blk', lotId: 'lot2', value: -1, currency: 'EUR' }])
  })

  it('say how much rests on valued moves: all, part or none', () => {
    const { rows } = valuationRows([
      key({ itemId: 'a', lotId: null, quantity: '10', valuedQuantity: '10', value: 3_100, methods: ['STANDARD_COST'] }),
      key({ itemId: 'b', lotId: null, quantity: '10', valuedQuantity: '6', value: 1_860, unvaluedMoves: 1, methods: ['STANDARD_COST'] }),
      key({ itemId: 'c', lotId: null, quantity: '4', valuedQuantity: '0', value: 0, unvaluedMoves: 2, methods: [], currencies: [] }),
    ])
    expect(rows.map((row) => [row.itemId, row.valued, row.unvaluedMoves])).toEqual([
      ['a', 'FULL', 0],
      ['b', 'PART', 1],
      ['c', 'NONE', 2],
    ])
    expect(rows[2]!.currency).toBeNull()
    // The unit cost of a part-valued row is that of its valued quantity: 18.60 ÷ 6 = 3.10.
    expect(unitCostOf(1_860, '6', 'EUR')).toBe('3.100000')
    expect(unitCostOf(0, '0', 'EUR')).toBeNull()
    expect(basisWords([], 'NONE', 2)).toMatch(/No value: 2 move\(s\)/)
    expect(basisWords(['STANDARD_COST'], 'PART', 1)).toMatch(/standard cost.*1 move\(s\) have no cost yet/)
  })

  it('put an item in its category: leather, materials, trims, packaging, finished goods', () => {
    expect(['LEATHER', 'LINING', 'PROTECTOR', 'THREAD', 'TRIM', 'LABEL', 'PACKAGING', 'FINISHED'].map(categoryOfKind)).toEqual(['LEATHER', 'MATERIALS', 'MATERIALS', 'TRIMS', 'TRIMS', 'TRIMS', 'PACKAGING', 'FINISHED_GOODS'])
  })
})

describe('the costing method beside the figures (never applied here)', () => {
  it('marks every figure "depends on the method" while UNDECIDED, and under moving average or FIFO', () => {
    expect(dependsOnMethod('UNDECIDED', ['STANDARD_COST'])).toBe(true)
    expect(dependsOnMethod('MOVING_AVERAGE', ['LOT_COST'])).toBe(true)
    expect(dependsOnMethod('FIFO', ['PURCHASE_PRICE'])).toBe(true)
  })

  it('under standard cost, only a figure that rests on anything but the standard cost', () => {
    expect(dependsOnMethod('STANDARD', ['STANDARD_COST'])).toBe(false)
    expect(dependsOnMethod('STANDARD', ['STANDARD_COST', 'PURCHASE_PRICE'])).toBe(true)
    expect(dependsOnMethod('STANDARD', [])).toBe(true)
  })

  it('names the accountant\'s open question in words', () => {
    expect(valuationMethodWords('UNDECIDED')).toMatch(/not chosen yet.*provisional.*whether to revalue.*accountant/)
    expect(valuationMethodWords('FIFO')).toMatch(/FIFO.*depends on the method/)
  })
})

describe('work in progress', () => {
  it('lists every work order whose cost ledger does not add up to 0', () => {
    // WO1: hide 223.44 + labour 96.50 = 319.94; WO2: received to stock at the standard, nothing left.
    expect(wipRows([
      { workOrderId: 'wo1', value: 31_994, entries: 2 },
      { workOrderId: 'wo2', value: 0, entries: 4 },
    ])).toEqual([{ workOrderId: 'wo1', value: 31_994, entries: 2 }])
  })
})

describe('value by area (SCM-256)', () => {
  it('turns an area unit into square metres exactly and values the leather per m²', () => {
    // 51.8 ft² × 0.09290304 = 4.812377472 m²; 217.56 ÷ 4.812377472 = 45.208424… per m².
    expect(areaM2('51.8', 'FT2')!.toFixed()).toBe('4.812377472')
    expect(areaM2('250', 'DM2')!.toFixed()).toBe('2.5')
    expect(areaM2('12', 'M')).toBeNull()
    expect(valuePerM2(21_756, areaM2('51.8', 'FT2'), 'EUR')).toBe('45.208424')
    expect(valuePerM2(21_756, null, 'EUR')).toBeNull()
  })
})

describe('totals', () => {
  it('add up one currency and refuse to add two', () => {
    expect(totalsOf([{ value: 100, currency: 'EUR' }, { value: 50, currency: 'EUR' }, { value: 0, currency: null }])).toEqual({ value: 150, currency: 'EUR', words: null })
    expect(totalsOf([{ value: 100, currency: 'EUR' }, { value: 50, currency: 'CHF' }])).toMatchObject({ value: null, currency: null })
    expect(totalsOf([])).toEqual({ value: 0, currency: null, words: null })
  })
})
