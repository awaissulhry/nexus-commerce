import { describe, expect, it } from 'vitest'
import { parseGtin } from '../styles/sku'
import { allocationRefusal, candidates, GTIN_RANGE_ALLOCATION_ALLOWED, gtinOf, importVerdicts, planAllocation, rangeLeft, rangeProblems, usedRangeRefusal, type SkuFacts } from './rules'

// GS1 prefixes 200-299 are in-store numbers, never a company's: made up for sure.
const range = { gs1Prefix: '2009999', firstReference: 100, lastReference: 105, nextReference: 103 }

describe('GTINs of a range (PRD-006)', () => {
  it('builds the GTIN-13 of an item reference with its check digit, in the form the database accepts', () => {
    expect(gtinOf('2009999', 100)).toBe('2009999001003')
    expect(gtinOf('2009999', 101)).toBe('2009999001010')
    for (const reference of [0, 7, 99_999]) {
      const gtin = gtinOf('2009999', reference)
      expect(parseGtin(gtin)).toEqual({ ok: true, gtin })
    }
    // A longer prefix leaves fewer digits for the reference: 9 digits + 3.
    expect(gtinOf('200999999', 3)).toBe('2009999990031')
  })

  it('says what is wrong with a range in words', () => {
    expect(rangeProblems({ name: 'GS1 test', gs1Prefix: '2009999', firstReference: 0, lastReference: 99_999 })).toEqual([])
    expect(rangeProblems({ name: '', gs1Prefix: '123', firstReference: 0, lastReference: 1 }).map((issue) => issue.path)).toEqual(['name', 'gs1Prefix'])
    expect(rangeProblems({ name: 'x', gs1Prefix: '2009999', firstReference: 5, lastReference: 100_000 }).map((issue) => issue.path)).toEqual(['lastReference'])
    expect(rangeProblems({ name: 'x', gs1Prefix: '2009999', firstReference: 5, lastReference: 4 })[0]?.message).toMatch(/not before the first/)
    expect(rangeProblems({ name: 'x', gs1Prefix: '0000012', firstReference: 0, lastReference: 9 })[0]?.message).toMatch(/GTIN-8/)
  })

  it('keeps a used range\'s prefix and limits', () => {
    expect(rangeLeft(range)).toBe(3)
    expect(usedRangeRefusal(range, { lastReference: 200 })).toMatch(/given 3 GTIN/)
    expect(usedRangeRefusal(range, { lastReference: 105 })).toBeNull()
    expect(usedRangeRefusal({ ...range, nextReference: 100 }, { lastReference: 200 })).toBeNull()
  })

  it('gives the next free references in order and skips a GTIN already on a SKU (never twice)', () => {
    const skus = [
      { skuId: 'a', sku: 'S-A' },
      { skuId: 'b', sku: 'S-B' },
    ]
    const taken = new Set([gtinOf('2009999', 103)])
    const plan = planAllocation(range, skus, taken)
    expect(plan.assignments).toEqual([
      { skuId: 'a', sku: 'S-A', reference: 104, gtin: gtinOf('2009999', 104) },
      { skuId: 'b', sku: 'S-B', reference: 105, gtin: gtinOf('2009999', 105) },
    ])
    expect(plan.skipped).toEqual([{ reference: 103, gtin: gtinOf('2009999', 103) }])
    expect(plan).toMatchObject({ nextReference: 106, short: 0 })
    const short = planAllocation(range, [...skus, { skuId: 'c', sku: 'S-C' }, { skuId: 'd', sku: 'S-D' }], new Set())
    expect(short).toMatchObject({ nextReference: 106, short: 1 })
    expect(candidates(range, 104, 10)).toEqual([gtinOf('2009999', 104), gtinOf('2009999', 105)])
  })

  it('assigns from a range only in local and test runs until the Owner\'s word (GATE-SPEND)', () => {
    expect(GTIN_RANGE_ALLOCATION_ALLOWED).toBe(false)
    expect(allocationRefusal('test')).toBeNull()
    expect(allocationRefusal('local')).toBeNull()
    expect(allocationRefusal('staging')).toBe('GATE_SPEND')
    expect(allocationRefusal('production')).toBe('GATE_SPEND')
  })
})

describe("a brand's own barcodes, typed or imported", () => {
  const facts = new Map<string, SkuFacts>([
    ['S-1', { skuId: '1', styleId: 's', gtin: null, shipped: false, refusal: null }],
    ['S-2', { skuId: '2', styleId: 's', gtin: '2009999001010', shipped: true, refusal: null }],
    ['S-3', { skuId: '3', styleId: 's', gtin: '2009999001027', shipped: false, refusal: null }],
    ['S-4', { skuId: '4', styleId: 't', gtin: null, shipped: false, refusal: 'Style T is archived.' }],
  ])
  const holders = new Map([
    ['2009999001010', 'S-2'],
    ['2009999001027', 'S-3'],
  ])

  it('checks every row and says why a row is refused', () => {
    const verdicts = importVerdicts(
      [
        { line: 1, sku: 's-1', gtin: '200 9999 00103 4' },
        { line: 2, sku: 'S-2', gtin: '2009999001010' },
        { line: 3, sku: 'S-2', gtin: null },
        { line: 4, sku: 'S-3', gtin: '' },
        { line: 5, sku: 'S-9', gtin: '2009999001041' },
        { line: 6, sku: 'S-4', gtin: '2009999001058' },
        { line: 7, sku: 'S-1', gtin: '2009999001010' },
      ],
      facts,
      holders,
    )
    expect(verdicts.map((row) => [row.line, row.outcome])).toEqual([
      [1, 'REFUSED'],
      [2, 'REFUSED'],
      [3, 'REFUSED'],
      [4, 'CLEARED'],
      [5, 'REFUSED'],
      [6, 'REFUSED'],
      [7, 'REFUSED'],
    ])
    expect(verdicts[0]?.message).toMatch(/more than once/)
    expect(verdicts[4]?.message).toMatch(/No SKU S-9/)
    expect(verdicts[5]?.message).toBe('Style T is archived.')
  })

  it('keeps a shipped SKU\'s GTIN, refuses a GTIN on another SKU, a bad check digit and a repeat', () => {
    const one = (sku: string, gtin: string | null) => importVerdicts([{ line: 1, sku, gtin }], facts, holders)[0]!
    expect(one('S-2', null)).toMatchObject({ outcome: 'REFUSED', message: expect.stringMatching(/keeps its GTIN 2009999001010: garments with it have shipped/) })
    expect(one('S-2', '2009999001010')).toMatchObject({ outcome: 'UNCHANGED' })
    expect(one('S-1', '2009999001027')).toMatchObject({ outcome: 'REFUSED', message: expect.stringMatching(/on SKU S-3 already/) })
    expect(one('S-1', '2009999001035')).toMatchObject({ outcome: 'REFUSED', message: expect.stringMatching(/check digit/) })
    expect(one('S-1', '2009999001034')).toMatchObject({ outcome: 'SET', gtin: '2009999001034', before: null })
    const twice = importVerdicts(
      [
        { line: 1, sku: 'S-1', gtin: '2009999001034' },
        { line: 2, sku: 'S-3', gtin: '2009999001034' },
      ],
      facts,
      holders,
    )
    expect(twice.map((row) => row.outcome)).toEqual(['REFUSED', 'REFUSED'])
  })
})
