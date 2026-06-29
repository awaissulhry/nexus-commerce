import { describe, it, expect } from 'vitest'
import { summarizeProductStock } from './stock-summary.js'

describe('summarizeProductStock', () => {
  it('splits FBA vs everything-else and totals them', () => {
    expect(summarizeProductStock([
      { locationType: 'AMAZON_FBA', quantity: 12 },
      { locationType: 'WAREHOUSE', quantity: 5 },
      { locationType: 'CHANNEL_RESERVED', quantity: 3 },
      { locationType: 'SHOPIFY_LOCATION', quantity: 2 },
    ])).toEqual({ fbaStock: 12, fbmStock: 10, totalStock: 22 })
  })

  it('returns zeros for no levels', () => {
    expect(summarizeProductStock([])).toEqual({ fbaStock: 0, fbmStock: 0, totalStock: 0 })
  })

  it('handles FBA-only', () => {
    expect(summarizeProductStock([{ locationType: 'AMAZON_FBA', quantity: 7 }]))
      .toEqual({ fbaStock: 7, fbmStock: 0, totalStock: 7 })
  })
})
