import { describe, expect, it } from 'vitest'

import type { SwitchPreview } from '@/app/settings/sharing/stockPoolApi'

import { stockTooltip } from './columns'
import { parseMatrixRead } from './source'
import { defaultStockChoice, stockSourcePlan, type StockSourceTarget } from './StockSourceDialog'

const XAVIA = { kind: 'pool' as const, grantId: 'g-xavia', lenderName: 'Xavia Racing' }
const sku = (id: string, source: StockSourceTarget['source'] = null): StockSourceTarget => ({ id, sku: `SKU-${id}`, source })
const preview = (productId: string, refusal: string | null = null): SwitchPreview =>
  ({ productId, sku: `SKU-${productId}`, from: 'own', to: 'pool', refusal, costPriceMissing: false, listings: [] })

describe('Stock source — which SKUs switch, and the default choice (shared stock by SKU)', () => {
  it('to a lent stock: SKUs already on it are left alone, refused ones are named, the rest switch', () => {
    const plan = stockSourcePlan([sku('a'), sku('b', XAVIA), sku('c')], 'g-xavia', [preview('a'), preview('b'), preview('c', 'Xavia Racing has no product with the SKU SKU-c, so this product cannot use its stock.')])
    expect(plan.will.map((x) => x.id)).toEqual(['a'])
    expect(plan.already.map((x) => x.id)).toEqual(['b'])
    expect(plan.refused).toEqual([{ ...sku('c'), reason: 'Xavia Racing has no product with the SKU SKU-c, so this product cannot use its stock.' }])
  })

  it('back to own stock: SKUs that already use their own are left alone', () => {
    const plan = stockSourcePlan([sku('a', XAVIA), sku('b')], 'own', [preview('a'), preview('b')])
    expect(plan.will.map((x) => x.id)).toEqual(['a'])
    expect(plan.already.map((x) => x.id)).toEqual(['b'])
  })

  it('a SKU on ANOTHER lent stock is not "already there" — the preview says why it cannot switch', () => {
    const other = { kind: 'pool' as const, grantId: 'g-other', lenderName: 'Helmet Shop' }
    const plan = stockSourcePlan([sku('a', other)], 'g-xavia', [preview('a', 'This product already uses shared stock from another business. Switch it to its own stock first.')])
    expect(plan.already).toEqual([])
    expect(plan.refused.map((x) => x.id)).toEqual(['a'])
  })

  it('before the preview answers, nothing is refused and nothing is counted as already there by mistake', () => {
    const plan = stockSourcePlan([sku('a'), sku('b', XAVIA)], 'g-xavia', null)
    expect(plan.will.map((x) => x.id)).toEqual(['a'])
    expect(plan.already.map((x) => x.id)).toEqual(['b'])
    expect(plan.refused).toEqual([])
  })

  it('the default: own stock when every SKU borrows; else the stock this family uses; else the first lent stock', () => {
    const grants = [{ id: 'g-helmet' }, { id: 'g-xavia' }]
    expect(defaultStockChoice([sku('a', XAVIA), sku('b', XAVIA)], grants, 'g-xavia')).toBe('own')
    expect(defaultStockChoice([sku('a'), sku('b', XAVIA)], grants, 'g-xavia')).toBe('g-xavia')
    expect(defaultStockChoice([sku('a')], grants, null)).toBe('g-helmet')
    // A suggestion that is no longer on (ended, paused) is not offered.
    expect(defaultStockChoice([sku('a')], grants, 'g-ended')).toBe('g-helmet')
    expect(defaultStockChoice([sku('a')], [], null)).toBe('own')
  })
})

describe('the Stock cell names where the number comes from', () => {
  it('own stock: the warehouses; lent stock: the lender, the warehouses, and that own stock is not used', () => {
    expect(stockTooltip({ available: 4, uncounted: false, locations: [{ code: 'MV-MAIN', available: 4 }], source: null })).toBe('MV-MAIN 4')
    expect(stockTooltip({ available: 9, uncounted: false, locations: [{ code: 'IT-MAIN', available: 9 }], source: XAVIA }))
      .toBe("Sells from Xavia Racing's shared stock: 9 available there. IT-MAIN 9. This business's own stock is not used.")
    expect(stockTooltip({ available: null, uncounted: true, locations: [], source: null })).toBe('No routed location holds this SKU — nothing is pushed')
  })

  it('the parse keeps a well-formed source and reads anything else as own stock', () => {
    const body = (source: unknown) => ({
      version: 1, productId: 'p', generatedAt: '2026-10-01T00:00:00Z', coordinates: [],
      rows: [{ id: 'r1', sku: 'S1', role: 'variant', stock: { available: 9, uncounted: false, locations: [], source }, basePrice: 10, status: 'ACTIVE', cells: {} }],
    })
    const read = (source: unknown) => { const r = parseMatrixRead(body(source), 'p'); if ('problem' in r) throw new Error(r.problem); return r.read.rows[0]!.stock.source }
    expect(read(XAVIA)).toEqual(XAVIA)
    expect(read(undefined)).toBeNull()
    expect(read({ kind: 'pool', grantId: 7 })).toBeNull()
    expect(read({ kind: 'own' })).toBeNull()
  })
})
