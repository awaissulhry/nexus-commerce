import { describe, expect, it } from 'vitest'

import { foldStockRollup } from './list-products.service.js'

/**
 * The Available roll-up, which `stockRollupCte` computes in SQL and this folds in JS from rows the
 * page already fetched. The two must agree: filters, sorting, the KPI counts and the group totals
 * read the CTE, and the row's own field reads this.
 */
describe('foldStockRollup', () => {
  const parent = 'p1'
  const children = new Map([['c1', parent], ['c2', parent], ['c3', parent]])

  it("a parent's Available is the sum across its variations", () => {
    const out = foldStockRollup(
      [{ productId: 'c1', quantity: 10 }, { productId: 'c2', quantity: 5 }, { productId: 'c3', quantity: 1 }],
      children,
    )
    expect(out.get(parent)).toBe(16)
  })

  it('counts EVERY variation, not the ten the page previews inline', () => {
    // The preview cap is a rendering decision. A family of twelve holding one unit each has twelve.
    const many = new Map(Array.from({ length: 12 }, (_, i) => [`v${i}`, parent] as const))
    const rows = Array.from({ length: 12 }, (_, i) => ({ productId: `v${i}`, quantity: 1 }))
    expect(foldStockRollup(rows, many).get(parent)).toBe(12)
  })

  it("a parent counts its OWN stock as well as its variations'", () => {
    const out = foldStockRollup([{ productId: parent, quantity: 4 }, { productId: 'c1', quantity: 6 }], children)
    expect(out.get(parent)).toBe(10)
  })

  it('a variation reports its OWN stock, not zero', () => {
    // The regression this exists for: the FBA/FBM buckets are keyed by OWNER, so a variation whose
    // stock was folded onto its parent read 0 for itself.
    const out = foldStockRollup([{ productId: 'c1', quantity: 10 }, { productId: 'c2', quantity: 5 }], children)
    expect(out.get('c1')).toBe(10)
    expect(out.get('c2')).toBe(5)
  })

  it('a standalone product reports its own stock', () => {
    expect(foldStockRollup([{ productId: 'solo', quantity: 58 }], new Map()).get('solo')).toBe(58)
  })

  it('sums several StockLevel rows for one product (one per location)', () => {
    const out = foldStockRollup(
      [{ productId: 'c1', quantity: 3 }, { productId: 'c1', quantity: 7 }],
      children,
    )
    expect(out.get('c1')).toBe(10)
    expect(out.get(parent)).toBe(10)
  })

  it('reports nothing for a product with no StockLevel rows, so the caller can default to 0', () => {
    const out = foldStockRollup([], children)
    expect(out.has(parent)).toBe(false)
    expect(out.get(parent) ?? 0).toBe(0)
  })

  it('does not attribute one family’s stock to another', () => {
    const two = new Map([['c1', 'p1'], ['c2', 'p2']])
    const out = foldStockRollup([{ productId: 'c1', quantity: 10 }, { productId: 'c2', quantity: 5 }], two)
    expect(out.get('p1')).toBe(10)
    expect(out.get('p2')).toBe(5)
  })
})
