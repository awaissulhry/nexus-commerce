/**
 * W3-A — one percent rule everywhere (AM-4, AM-11).
 *
 *  · `pct` takes a FRACTION and never guesses: the old `n <= 1 ? n * 100 : n` printed an eBay ACOS of
 *    150 % (1.5) as "1.50%".
 *  · `acosRank` / `acosFilterValue` are the ONE sort/filter rule: spend with no sales is the worst
 *    ACoS (never 0 %), and no spend + no sales has no ACoS at all.
 *
 * The filter and sort arms run through the design system's own `filterRows` / `compareSortValues`,
 * the code every console grid uses, so these prove what an operator sees, not just the helper.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { filterRows } from '@/design-system/patterns/workspace-grid/filterRows'
import { compareSortValues } from '@/design-system/grid/sortValues'
import { pct, acosRank, acosFilterValue, NO_SALES_ACOS } from './format'
import { TargetAcosCell } from '../../_shared/RuleColumnCells'

describe('pct — a fraction in, a percent out, no guessing (AM-4)', () => {
  it('prints an ACoS above 100 % as itself, not two orders of magnitude smaller', () => {
    expect(pct(1.5)).toBe('150.00%')
    expect(pct(150 / 100)).toBe('150.00%') // the eBay call sites: percent points ÷ 100
    expect(pct(1)).toBe('100.00%')
    expect(pct(2.375)).toBe('237.50%')
  })
  it('keeps the ordinary readings and negatives', () => {
    expect(pct(0.25)).toBe('25.00%')
    expect(pct(0.002)).toBe('0.20%')
    expect(pct(0)).toBe('0.00%')
    expect(pct(-0.05)).toBe('-5.00%')
  })
  it('takes the decimals from the caller, and says "—" for no value', () => {
    expect(pct(0.384, 0)).toBe('38%')
    expect(pct(null)).toBe('—')
    expect(pct(undefined)).toBe('—')
    expect(pct('')).toBe('—')
    expect(pct('x')).toBe('—')
  })
})

describe('TargetAcosCell — the Owner’s own target is printed as he set it', () => {
  const html = (fraction: number | null) => renderToStaticMarkup(createElement(TargetAcosCell, { fraction }))
  it('shows a 150 % target as 150.00%, not 1.50% (the editor accepts up to 500 %)', () => {
    expect(html(1.5)).toContain('150.00%')
    expect(html(1.5)).not.toContain('>1.50%')
  })
  it('shows 30 % as 30.00%, and an unset target as None', () => {
    expect(html(0.3)).toContain('30.00%')
    expect(html(null)).toContain('None')
  })
})

describe('acosRank — one ACoS sort/filter rule, in percent points (AM-11)', () => {
  it('reads the API fraction as a percent — 1.5 is 150, never 1.5', () => {
    expect(acosRank(1.5, 150, 100)).toBe(150)
    expect(acosRank(0.25, 0, 0)).toBe(25)
    expect(acosRank('0.4', 0, 0)).toBeCloseTo(40)
  })
  it('derives spend ÷ sales when the API sent no fraction', () => {
    expect(acosRank(null, 30, 100)).toBe(30)
    expect(acosRank(undefined, 0, 100)).toBe(0) // sold with no spend: a real 0 %
  })
  it('ranks spend with no sales as the WORST value, never 0 %', () => {
    expect(acosRank(null, 12.5, 0)).toBe(NO_SALES_ACOS)
    expect(acosRank(null, 12.5, 0)!).toBeGreaterThan(acosRank(9.99, 999, 100)!)
  })
  it('has no ACoS when nothing was spent and nothing sold', () => {
    expect(acosRank(null, 0, 0)).toBeNull()
    expect(acosFilterValue(null, 0, 0)).toBeNaN()
  })
  it('stays a comparator: two no-sales rows compare equal, not NaN', () => {
    expect(NO_SALES_ACOS - NO_SALES_ACOS).toBe(0)
  })
})

type Row = { id: string; spend: number; sales: number; acos: number | null }
const rows: Row[] = [
  { id: 'good', spend: 20, sales: 100, acos: 0.2 },
  { id: 'over-100', spend: 150, sales: 100, acos: 1.5 },
  { id: 'spent-no-sales', spend: 25, sales: 0, acos: null },
  { id: 'idle', spend: 0, sales: 0, acos: null },
]
const columns = [{ key: 'acos', label: 'ACoS', render: () => null, filterValue: (r: Row) => acosFilterValue(r.acos, r.spend, r.sales) }]
const filters = [{ key: 'acos', label: 'ACoS', kind: 'range' as const }]
const filterIds = (min: string, max: string) => filterRows(rows, filters, { acos: { min, max } }, columns).map((r) => r.id)

describe('the ACoS filter, through the grid’s own filterRows', () => {
  it('"ACoS max 30 %" drops the campaign that spent and sold nothing', () => {
    expect(filterIds('', '30')).toEqual(['good'])
  })
  it('"ACoS min 100 %" keeps the 150 % row and the no-sales spender (worse than any ACoS)', () => {
    expect(filterIds('100', '')).toEqual(['over-100', 'spent-no-sales'])
  })
  it('a 150 % row does not pass "ACoS max 30 %" as if it were 1.5 %', () => {
    expect(filterIds('', '30')).not.toContain('over-100')
  })
})

describe('the ACoS sort, through the grid’s own compareSortValues', () => {
  const sorted = (dir: 'asc' | 'desc') => [...rows]
    .sort((a, b) => compareSortValues(acosRank(a.acos, a.spend, a.sales), acosRank(b.acos, b.spend, b.sales), dir))
    .map((r) => r.id)
  it('lowest first: the no-sales spender comes after every real ACoS; the idle row sinks', () => {
    expect(sorted('asc')).toEqual(['good', 'over-100', 'spent-no-sales', 'idle'])
  })
  it('highest first: the no-sales spender leads; the idle row still sinks', () => {
    expect(sorted('desc')).toEqual(['spent-no-sales', 'over-100', 'good', 'idle'])
  })
})
