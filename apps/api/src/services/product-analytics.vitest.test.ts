/**
 * Product studio — the analytics card's review numbers (Reviews PR F, 2026-10-26): from the product's visible Review rows,
 * never a live Amazon number (Amazon stars only from imported reviews), eBay seller feedback as % positive per channel and
 * never mixed into the star average. No database.
 */
import { describe, expect, it } from 'vitest'
import { productReviewSummary } from './product-analytics.service.js'

describe('the studio card’s reviews', () => {
  it('averages product reviews; Amazon only from imports; eBay feedback is % positive on its own line', () => {
    const summary = productReviewSummary([
      { channel: 'AMAZON', rating: 5, ingestSource: 'IMPORT_CSV' },
      { channel: 'AMAZON', rating: 4, ingestSource: 'IMPORT_CSV' },
      { channel: 'AMAZON', rating: 1, ingestSource: 'AMAZON_VOC' },
      { channel: 'SHOPIFY', rating: 3, ingestSource: 'IMPORT_CSV' },
      { channel: 'EBAY', rating: 5, ingestSource: 'EBAY_API' },
      { channel: 'EBAY', rating: 1, ingestSource: 'EBAY_API' },
      { channel: 'EBAY', rating: 3, ingestSource: 'EBAY_API' },
    ])
    expect(summary).toEqual({
      avgRating: 4,
      reviewCount: 3,
      byChannel: [
        { channel: 'EBAY', kind: 'positive', rating: 50, count: 3 },
        { channel: 'AMAZON', kind: 'stars', rating: 4.5, count: 2 },
        { channel: 'SHOPIFY', kind: 'stars', rating: 3, count: 1 },
      ],
    })
  })

  it('nothing to count: no rating (never 0) and no channels', () => {
    expect(productReviewSummary([])).toEqual({ avgRating: null, reviewCount: 0, byChannel: [] })
    expect(productReviewSummary([{ channel: 'AMAZON', rating: 5, ingestSource: null }])).toEqual({ avgRating: null, reviewCount: 0, byChannel: [] })
    expect(productReviewSummary([{ channel: 'SHOPIFY', rating: null, ingestSource: 'IMPORT_CSV' }])).toEqual({
      avgRating: null, reviewCount: 1, byChannel: [{ channel: 'SHOPIFY', kind: 'stars', rating: null, count: 1 }],
    })
  })
})
