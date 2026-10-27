/**
 * Reviews — the ONE rating (audit C3, B13; build spec ruling 5): every page counts a rating the same way. Pure.
 */
import { describe, expect, it } from 'vitest'
import { countsAsStars, isRatingDrop, ratingInMeasure, ratingMeasureOf, ratingOf } from './review-rating.js'

const r = (channel: string, rating: number | null, ingestSource: string | null = null, kind: string | null = null) => ({ channel, rating, ingestSource, kind })

describe('which rows count, and how', () => {
  it('stars: product reviews; Amazon only when a person imported them', () => {
    expect(ratingMeasureOf(r('SHOPIFY', 4, 'IMPORT_CSV'))).toBe('stars')
    expect(ratingMeasureOf(r('AMAZON', 4, 'IMPORT_CSV'))).toBe('stars')
    expect(ratingMeasureOf(r('AMAZON', 4, 'AMAZON_VOC'))).toBeNull()
    expect(ratingMeasureOf(r('AMAZON', 2, 'AMAZON_SELLER_FEEDBACK', 'SELLER'))).toBeNull()
  })

  it('eBay seller feedback is % positive, never stars', () => {
    expect(ratingMeasureOf(r('EBAY', 5, 'EBAY_API'))).toBe('positive')
    expect(countsAsStars(r('EBAY', 5, 'EBAY_API'))).toBe(false)
    // An eBay row the kind column calls a product review counts as stars.
    expect(ratingMeasureOf(r('EBAY', 5, 'EBAY_API', 'PRODUCT'))).toBe('stars')
  })
})

describe('ratingOf', () => {
  it('averages the stars, keeps eBay apart as % positive, and never averages Amazon seller feedback', () => {
    const rating = ratingOf([
      r('AMAZON', 5, 'IMPORT_CSV'), r('AMAZON', 3, 'IMPORT_CSV'), r('AMAZON', 1, 'AMAZON_VOC'),
      r('AMAZON', 1, 'AMAZON_SELLER_FEEDBACK', 'SELLER'), r('SHOPIFY', 4, 'IMPORT_CSV'),
      r('EBAY', 5, 'EBAY_API'), r('EBAY', 5, 'EBAY_API'), r('EBAY', 1, 'EBAY_API'), r('EBAY', 3, 'EBAY_API'),
    ])
    expect(rating).toMatchObject({ stars: 4, starsFrom: 3, positive: 66.7, positiveFrom: 3, amazonImported: true })
    expect(rating.words).toBe('4.0 stars from 3 reviews (Amazon: from imported reviews) · 66.7% positive from 3 eBay feedback')
    expect(rating.starsSource).toBe('3 reviews · Amazon: from imported reviews')
  })

  it('no rating is never a zero: Amazon without imports says so', () => {
    expect(ratingOf([r('AMAZON', 4, 'AMAZON_VOC')])).toMatchObject({ stars: null, positive: null, words: 'No rating data from Amazon — import reviews' })
    expect(ratingOf([])).toMatchObject({ stars: null, words: 'No rating yet', starsSource: 'No star ratings yet' })
    expect(ratingInMeasure([r('EBAY', 5, 'EBAY_API')], 'positive')).toBe(100)
    expect(ratingInMeasure([r('EBAY', 5, 'EBAY_API')], 'stars')).toBeNull()
  })
})

describe('the one "rating dropped" rule (audit C8)', () => {
  it('0.3 stars, or 6 points of eBay\'s % positive', () => {
    expect(isRatingDrop(-0.3, 'stars')).toBe(true)
    expect(isRatingDrop(-0.2, 'stars')).toBe(false)
    expect(isRatingDrop(-6, 'positive')).toBe(true)
    expect(isRatingDrop(-4, 'positive')).toBe(false)
    expect(isRatingDrop(null, 'stars')).toBe(false)
  })
})
