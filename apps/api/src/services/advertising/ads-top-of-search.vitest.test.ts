import { describe, it, expect } from 'vitest'
import { buildSearchPlacementAdjustments } from './ads-top-of-search.service.js'

// PP — Top ↔ Rest are mutually exclusive search positions: setting one zeros the other,
// Product-page bias is preserved (engine never touches it).
const m = (adj: Array<{ placement: string; percentage: number }>) => Object.fromEntries(adj.map((a) => [a.placement, a.percentage]))

describe('buildSearchPlacementAdjustments (per-placement)', () => {
  it('Top active → sets Top, zeros Rest, preserves Product', () => {
    const r = m(buildSearchPlacementAdjustments([{ placement: 'PLACEMENT_TOP', percentage: 130 }, { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 0 }, { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 50 }], 'PLACEMENT_TOP', 100))
    expect(r.PLACEMENT_TOP).toBe(100); expect(r.PLACEMENT_REST_OF_SEARCH).toBe(0); expect(r.PLACEMENT_PRODUCT_PAGE).toBe(50)
  })
  it('Rest active → sets Rest, zeros Top, preserves Product', () => {
    const r = m(buildSearchPlacementAdjustments([{ placement: 'PLACEMENT_TOP', percentage: 400 }, { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 50 }], 'PLACEMENT_REST_OF_SEARCH', 30))
    expect(r.PLACEMENT_REST_OF_SEARCH).toBe(30); expect(r.PLACEMENT_TOP).toBe(0); expect(r.PLACEMENT_PRODUCT_PAGE).toBe(50)
  })
  it('non-search placement (Product) just sets itself, preserves Top/Rest', () => {
    const r = m(buildSearchPlacementAdjustments([{ placement: 'PLACEMENT_TOP', percentage: 100 }], 'PLACEMENT_PRODUCT_PAGE', 20))
    expect(r.PLACEMENT_PRODUCT_PAGE).toBe(20); expect(r.PLACEMENT_TOP).toBe(100)
  })
  it('clamps to 0..900', () => {
    expect(m(buildSearchPlacementAdjustments([], 'PLACEMENT_TOP', 9999)).PLACEMENT_TOP).toBe(900)
    expect(m(buildSearchPlacementAdjustments([], 'PLACEMENT_TOP', -5)).PLACEMENT_TOP).toBe(0)
  })
})
