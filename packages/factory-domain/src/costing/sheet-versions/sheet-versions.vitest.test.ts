import { describe, expect, it } from 'vitest'
import { goalLinesOf, goalSeek } from '../goal-seek/rules'
import { splitBySize } from '../sheet-components/split'
import { pickWeights, sizeSurcharges, sizeWeightKey, weightedCost, weightsProblems } from '../size-weights/rules'
import { compareLines, compareSplits } from './compare'
import { changePctOf, costSheetKey, databaseVersionRefusal, marginPctOf } from './rules'
import { whatIf, whatIfNote, whatIfPctProblem, type WhatIfLine } from './what-if'

/**
 * Cost sheet versions, pure (B-W2b-420; FIN-013, FIN-014, FIN-016). A made-up jacket in sizes 50 / 52 / 54, every figure worked
 * out by hand: leather 57 / 59.5 / 62.5 ft² at 4.20 (239.40 / 249.90 / 262.50), a lining 1.6 m at 6.50 (10.40), cutting 14 and
 * sewing 96.5 minutes at 0.50 (7.00, 48.25), overhead 25 % of labour (13.8125), freight 3 % on the leather per size (7.182 /
 * 7.497 / 7.875), typed packaging 1.35 and a typed 5 % commission of 20.00. Size totals 347.3945 / 358.2095 / 371.1875.
 */

const S = ['50', '52', '54'] as const
const LEATHER = '00000000-0000-4000-8000-000000000001'
const LINING = '00000000-0000-4000-8000-000000000002'
const UPLIFT = '00000000-0000-4000-8000-000000000003'
const RULE = '00000000-0000-4000-8000-000000000004'
const uuid = (n: number) => `00000000-0000-4000-8000-${String(100 + n).padStart(12, '0')}`

const base = { sourceRecordType: null, workCentreKind: null, uom: null, note: null, label: null, itemId: null, sourceRecordId: null, pct: null, size: null } as const
const L = (n: number, line: Partial<WhatIfLine> & Pick<WhatIfLine, 'category' | 'source' | 'quantity' | 'unitCost' | 'cost'>): WhatIfLine => ({ ...base, id: uuid(n), seq: n, ...line })

const JACKET: WhatIfLine[] = [
  L(10, { category: 'LEATHER', source: 'BOM_LINE', itemId: LEATHER, label: 'Cowhide', size: '50', quantity: '57', uom: 'FT2', unitCost: '4.2', cost: '239.4' }),
  L(11, { category: 'LEATHER', source: 'BOM_LINE', itemId: LEATHER, label: 'Cowhide', size: '52', quantity: '59.5', uom: 'FT2', unitCost: '4.2', cost: '249.9' }),
  L(12, { category: 'LEATHER', source: 'BOM_LINE', itemId: LEATHER, label: 'Cowhide', size: '54', quantity: '62.5', uom: 'FT2', unitCost: '4.2', cost: '262.5' }),
  L(20, { category: 'MATERIAL', source: 'BOM_LINE', itemId: LINING, label: 'Lining', quantity: '1.6', uom: 'M', unitCost: '6.5', cost: '10.4' }),
  L(40, { category: 'LABOUR', source: 'ROUTING', workCentreKind: 'CUTTING', label: 'Cut', quantity: '14', unitCost: '0.5', cost: '7' }),
  L(50, { category: 'LABOUR', source: 'ROUTING', workCentreKind: 'SEWING', label: 'Sew', quantity: '96.5', unitCost: '0.5', cost: '48.25' }),
  L(60, { category: 'OVERHEAD', source: 'OVERHEAD_RULE', sourceRecordId: RULE, quantity: '1', unitCost: '13.8125', cost: '13.8125', pct: '25' }),
  L(70, { category: 'FREIGHT', source: 'UPLIFT', sourceRecordId: UPLIFT, itemId: LEATHER, size: '50', quantity: '1', unitCost: '7.182', cost: '7.182', pct: '3' }),
  L(71, { category: 'FREIGHT', source: 'UPLIFT', sourceRecordId: UPLIFT, itemId: LEATHER, size: '52', quantity: '1', unitCost: '7.497', cost: '7.497', pct: '3' }),
  L(72, { category: 'FREIGHT', source: 'UPLIFT', sourceRecordId: UPLIFT, itemId: LEATHER, size: '54', quantity: '1', unitCost: '7.875', cost: '7.875', pct: '3' }),
  L(80, { category: 'PACKAGING', source: 'TYPED', label: 'Polybag and carton', quantity: '1', unitCost: '1.35', cost: '1.35' }),
  L(90, { category: 'COMMISSION', source: 'TYPED', label: 'Agent', quantity: '1', unitCost: '20', cost: '20', pct: '5' }),
]
const FACTS = { lines: JACKET, sizes: S, covers: new Map<string, Set<string>>() }
const totals = (lines: readonly { category: WhatIfLine['category']; source: WhatIfLine['source']; size: string | null; cost: string }[]) => splitBySize(lines, S, []).map((size) => size.total)

describe('the series and the facts', () => {
  it('names the series as the database does, and works out a margin and a change', () => {
    expect(costSheetKey('s', 'c', null)).toBe('costsheet:s:c:none')
    expect(costSheetKey('s', 'c', 'z')).toBe('costsheet:s:c:z')
    expect(sizeWeightKey('s', null, '52')).toBe('sizeweight:s:all:52')
    // (520 − 358.2095) ÷ 520 = 31.11 %; 358.2095 on 347.3945 = +3.11 %.
    expect(marginPctOf('520', '358.2095')).toBe('31.11')
    expect(marginPctOf(null, '1')).toBeNull()
    expect(changePctOf('358.2095', '347.3945')).toBe('3.11')
    expect(changePctOf('1', '0')).toBeNull()
  })

  it("reads the database's refusals of a cost sheet back in words", () => {
    expect(databaseVersionRefusal('costing: cost sheet 0d9c2a4e-1111-4111-8111-111111111111 is approved and locked: it is never edited, only frozen; a change is a new version')).toEqual({
      code: 'LOCKED',
      message: 'Cost sheet is approved and locked: it is never edited, only frozen; a change is a new version.',
    })
    expect(databaseVersionRefusal('costing: cost sheet 0d9c2a4e-1111-4111-8111-111111111111 is approved by someone other than the person who made it (nobody approves their own)')?.code).toBe('OWN_SHEET')
    expect(databaseVersionRefusal('costing: leather cost basis x has a yield')).toBeNull()
  })
})

describe('what-if (FIN-014)', () => {
  it('leather +10 %: the leather lines move and the freight on them follows; labour, overhead and the typed commission stay', () => {
    const result = whatIf(FACTS, [{ target: 'CATEGORY', category: 'LEATHER', pct: '10' }])
    const byFrom = (n: number) => result.lines.filter((line) => line.fromId === uuid(n))
    // 4.20 × 1.10 = 4.62: 57 × 4.62 = 263.34, 59.5 × 4.62 = 274.89, 62.5 × 4.62 = 288.75.
    expect([10, 11, 12].map((n) => byFrom(n)[0]!.cost)).toEqual(['263.34', '274.89', '288.75'])
    // Freight 3 % of the new leather: 7.9002 / 8.2467 / 8.6625.
    expect([70, 71, 72].map((n) => [byFrom(n)[0]!.unitCost, byFrom(n)[0]!.before.unitCost])).toEqual([['7.9002', '7.182'], ['8.2467', '7.497'], ['8.6625', '7.875']])
    expect(byFrom(60)[0]).toMatchObject({ unitCost: '13.8125', changed: false })
    expect(byFrom(90)[0]).toMatchObject({ unitCost: '20', changed: false })
    expect(result).toMatchObject({ changed: 6, kept: [uuid(90)], unmatched: [] })
    // Size 50: 347.3945 + 23.94 + 0.7182 = 372.0527.
    expect(totals(result.lines)).toEqual(['372.0527', '383.9492', '398.225'])
  })

  it('labour +10 %: overhead on labour follows; a change aimed at a percent line moves its percent', () => {
    const labour = whatIf(FACTS, [{ target: 'CATEGORY', category: 'LABOUR', pct: '10' }])
    // 0.55 × 14 = 7.70, 0.55 × 96.5 = 53.075; 25 % of 60.775 = 15.19375.
    expect(labour.lines.find((line) => line.fromId === uuid(60))).toMatchObject({ unitCost: '15.19375', cost: '15.19375', pct: '25', changed: true })
    const overhead = whatIf(FACTS, [{ target: 'LINE', lineId: uuid(60), pct: '20' }])
    // 25 % × 1.2 = 30 % of 55.25 = 16.575.
    expect(overhead.lines.find((line) => line.fromId === uuid(60))).toMatchObject({ pct: '30', unitCost: '16.575' })
    // A typed percent line moved: by the ratio of its percent (5 % → 6 %: 20 × 6 ÷ 5 = 24).
    const commission = whatIf(FACTS, [{ target: 'LINE', lineId: uuid(90), pct: '20' }])
    expect(commission.lines.find((line) => line.fromId === uuid(90))).toMatchObject({ pct: '6', unitCost: '24' })
  })

  it('a material line for every size whose percent line differs by size is written per size; the most specific change wins', () => {
    const facts = { ...FACTS, lines: [JACKET[3]!, L(75, { category: 'FREIGHT', source: 'UPLIFT', sourceRecordId: UPLIFT, itemId: LINING, quantity: '1', unitCost: '0.312', cost: '0.312', pct: '3' })] }
    const result = whatIf(facts, [
      { target: 'CATEGORY', category: 'MATERIAL', pct: '50' },
      { target: 'ITEM', itemId: LINING, pct: '10' },
    ])
    // The lining's own +10 % wins over the category's +50 %: 6.50 → 7.15, 1.6 × 7.15 = 11.44; freight 3 % = 0.3432.
    expect(result.lines.map((line) => [line.category, line.size, line.cost])).toEqual([
      ['MATERIAL', null, '11.44'],
      ['FREIGHT', null, '0.3432'],
    ])
    expect(whatIf(FACTS, [{ target: 'ITEM', itemId: '00000000-0000-4000-8000-0000000000ff', pct: '5' }]).unmatched).toEqual([0])
  })

  it('a percent is checked and the changes are said in words', () => {
    expect(whatIfPctProblem('10')).toBeNull()
    expect(whatIfPctProblem('-100')).toBe('From −99.9999 % to +1000 %.')
    expect(whatIfPctProblem('0')).toBe('A change of 0 % changes nothing.')
    expect(whatIfPctProblem('1.23456')).toBe('A percent with at most 4 decimals.')
    expect(whatIfNote([{ target: 'CATEGORY', category: 'LEATHER', pct: '10' }, { target: 'ITEM', itemId: LINING, pct: '-5' }], (change) => (change.target === 'CATEGORY' ? 'leather' : 'lining'))).toBe('What-if: leather +10 %, lining -5 %')
  })
})

describe('compare two versions (FIN-014)', () => {
  it('matches lines by what they are, and compares each size and category', () => {
    const v3 = whatIf(FACTS, [{ target: 'ITEM', itemId: LEATHER, pct: '4.7619' }]).lines.filter((line) => line.category !== 'COMMISSION')
    const rows = compareLines(JACKET, v3)
    expect(rows.filter((row) => row.change === 'CHANGED').map((row) => row.category)).toEqual(['LEATHER', 'LEATHER', 'LEATHER', 'FREIGHT', 'FREIGHT', 'FREIGHT'])
    expect(rows.find((row) => row.category === 'COMMISSION')).toMatchObject({ change: 'REMOVED', difference: '-20', b: null })
    expect(rows.find((row) => row.category === 'MATERIAL')).toMatchObject({ change: 'SAME', difference: '0' })
    const sizes = compareSplits(splitBySize(JACKET, S, []), splitBySize(v3, S, []), S)
    // 4.20 × 1.047619 = 4.3999998 → 4.40 (6 places): 57 × 4.40 = 250.80 (+11.40), freight 3 % of it 7.524 (+0.342), commission −20.
    expect(sizes[0]).toMatchObject({ size: '50', total: { a: '347.3945', b: '339.1365', difference: '-8.258' } })
    expect(sizes[0]!.categories.find((entry) => entry.category === 'COMMISSION')).toEqual({ category: 'COMMISSION', a: '20', b: '0', difference: '-20' })
  })
})

describe('the size-run weighted cost and size surcharges (FIN-016)', () => {
  it("weighs by the season's mix, else every season's, else the size curve", () => {
    const season = { '50': '30', '52': '45', '54': '25' }
    expect(pickWeights({ season, everySeason: { '52': '1' }, curve: null }, S)).toEqual({ source: 'SEASON', weights: { '50': '30.0000', '52': '45.0000', '54': '25.0000' } })
    expect(pickWeights({ season: null, everySeason: { '52': '1', '99': '4' }, curve: null }, S)).toEqual({ source: 'EVERY_SEASON', weights: { '52': '1.0000' } })
    expect(pickWeights({ season: null, everySeason: null, curve: { '50': '20.0000', '52': '60.0000', '54': '20.0000' } }, S).source).toBe('SIZE_CURVE')
    expect(pickWeights({ season: null, everySeason: null, curve: null }, S)).toEqual({ source: 'NONE', weights: null })
    expect(weightsProblems({ '52': '0', '99': '1' }, S).map((issue) => issue.path)).toEqual(['body/weights/52', 'body/weights/99'])
  })

  it('works out the weighted cost and suggests a surcharge for a size 2 % or more above the base size', () => {
    const split = splitBySize(JACKET, S, [])
    // (347.3945 × 30 + 358.2095 × 45 + 371.1875 × 25) ÷ 100 = 358.2095.
    const weighted = weightedCost(split, { '50': '30', '52': '45', '54': '25' })
    expect(weighted).toEqual({ weighted: '358.2095', missing: [], shares: [{ size: '50', weight: '30', sharePct: '30' }, { size: '52', weight: '45', sharePct: '45' }, { size: '54', weight: '25', sharePct: '25' }] })
    expect(weightedCost(split.map((size) => (size.size === '54' ? { ...size, total: null } : size)), { '54': '1' })).toMatchObject({ weighted: null, missing: ['54'] })
    // 54 is 12.978 above 52 (3.62 %): at a 45 % margin the price surcharge is 12.978 ÷ 0.55 = 23.596… → 23.60.
    expect(sizeSurcharges({ totals: split, sizes: S, baseSize: '52', targetMarginPct: '45', currency: 'EUR' })).toEqual([{ size: '54', extraCost: '12.978', extraPct: '3.62', priceSurcharge: '23.6' }])
    expect(sizeSurcharges({ totals: split, sizes: S, baseSize: '52', targetMarginPct: null, currency: 'EUR', fromPct: '4' })).toEqual([])
    expect(sizeSurcharges({ totals: split, sizes: S, baseSize: '50', targetMarginPct: null, currency: 'EUR' }).map((row) => [row.size, row.priceSurcharge])).toEqual([['52', null], ['54', null]])
  })
})

describe('target price and goal-seek (FIN-013)', () => {
  it('a target price and margin give the allowed cost, the gap and the cut each big line needs', () => {
    const weights = { '50': '30', '52': '45', '54': '25' }
    const lines = goalLinesOf(JACKET, { weights })
    // The leather written per size is one line here: 239.40 × 0.30 + 249.90 × 0.45 + 262.50 × 0.25 = 249.90.
    expect(lines.find((line) => line.category === 'LEATHER')).toMatchObject({ id: uuid(10), cost: '249.9', percent: false })
    const result = goalSeek({ cost: '358.2095', targetPrice: '520', targetMarginPct: '45', lines, currency: 'EUR' })
    // Allowed 520 × 0.55 = 286; gap 72.2095.
    expect(result).toMatchObject({ state: 'ABOVE', allowedCost: '286', gap: '72.2095', marginAtCost: '31.11', priceForMargin: '651.29' })
    // The leather alone: 72.2095 ÷ 249.90 = 28.9 %; shared over the five shown (316.90): 56.942739.
    expect(result.lines.map((line) => [line.category, line.cost, line.sharePct, line.cutAlonePct, line.cutShared])).toEqual([
      ['LEATHER', '249.9', '69.8', '28.9', '56.942739'],
      ['LABOUR', '48.25', '13.5', null, '10.994346'],
      ['MATERIAL', '10.4', '2.9', null, '2.369766'],
      ['LABOUR', '7', '2', null, '1.595035'],
      ['PACKAGING', '1.35', '0.4', null, '0.307614'],
    ])
  })

  it('within the target, a price or a margin alone, and no cost', () => {
    const lines = goalLinesOf(JACKET, { size: '52' })
    expect(goalSeek({ cost: '358.2095', targetPrice: '700', targetMarginPct: '45', lines, currency: 'EUR' })).toMatchObject({ state: 'WITHIN', allowedCost: '385', gap: '-26.7905' })
    expect(goalSeek({ cost: '358.2095', targetPrice: '520', targetMarginPct: null, lines, currency: 'EUR' })).toMatchObject({ state: 'PRICE_ONLY', allowedCost: null, marginAtCost: '31.11' })
    expect(goalSeek({ cost: '358.2095', targetPrice: null, targetMarginPct: '45', lines, currency: 'EUR' })).toMatchObject({ state: 'MARGIN_ONLY', priceForMargin: '651.29' })
    expect(goalSeek({ cost: null, targetPrice: '520', targetMarginPct: '45', lines, currency: 'EUR' })).toMatchObject({ state: 'NO_COST', lines: [] })
    expect(goalSeek({ cost: '1', targetPrice: null, targetMarginPct: null, lines, currency: 'EUR' }).state).toBe('NO_TARGET')
  })
})
