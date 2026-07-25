/** Per-market image axis: the pick must scope to ONE market and never leak. */
import { describe, it, expect } from 'vitest'
import { normalizeMarket, IMAGE_AXIS_KEY } from './ebay-image-axis-preference.service.js'

describe('per-market image axis — market normalisation', () => {
  it('accepts bare, EBAY_-prefixed and lowercase market codes', () => {
    expect(normalizeMarket('IT')).toBe('IT')
    expect(normalizeMarket('it')).toBe('IT')
    expect(normalizeMarket('EBAY_IT')).toBe('IT')
    expect(normalizeMarket('EBAY-DE')).toBe('DE')
  })
  it('treats absent/blank as "no market" so callers fall back to the global pick', () => {
    expect(normalizeMarket(undefined)).toBeUndefined()
    expect(normalizeMarket(null)).toBeUndefined()
    expect(normalizeMarket('   ')).toBeUndefined()
  })
  it('stores under the same platformAttributes key family as the other per-market axis state', () => {
    expect(IMAGE_AXIS_KEY).toBe('_imageAxis')
    expect(IMAGE_AXIS_KEY.startsWith('_')).toBe(true)
  })
})
