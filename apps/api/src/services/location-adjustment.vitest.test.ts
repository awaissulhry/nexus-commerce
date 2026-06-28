import { describe, it, expect } from 'vitest'
import { computeLocationAdjustment, LocationAdjustmentError } from './location-adjustment.js'

const base = { currentQuantity: 10, currentReserved: 2 }

describe('computeLocationAdjustment', () => {
  it('FBA location is read-only', () => {
    expect(() => computeLocationAdjustment({ ...base, locationType: 'AMAZON_FBA', value: 5 }))
      .toThrowError(expect.objectContaining({ code: 'FBA_READ_ONLY' }))
  })

  it('Shopify location is read-only', () => {
    expect(() => computeLocationAdjustment({ ...base, locationType: 'SHOPIFY_LOCATION', value: 5 }))
      .toThrowError(expect.objectContaining({ code: 'SHOPIFY_SYNCED_READ_ONLY' }))
  })

  it('rejects a negative or non-integer value', () => {
    expect(() => computeLocationAdjustment({ ...base, locationType: 'WAREHOUSE', value: -1 }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_VALUE' }))
    expect(() => computeLocationAdjustment({ ...base, locationType: 'WAREHOUSE', value: 3.5 }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_VALUE' }))
  })

  it('rejects setting on-hand below reserved', () => {
    expect(() => computeLocationAdjustment({ ...base, locationType: 'WAREHOUSE', value: 1 }))
      .toThrowError(expect.objectContaining({ code: 'BELOW_RESERVED' }))
  })

  it('returns noop when value equals current quantity', () => {
    expect(computeLocationAdjustment({ ...base, locationType: 'WAREHOUSE', value: 10 }))
      .toEqual({ change: 0, noop: true })
  })

  it('returns a positive delta when increasing', () => {
    expect(computeLocationAdjustment({ ...base, locationType: 'WAREHOUSE', value: 15 }))
      .toEqual({ change: 5, noop: false })
  })

  it('returns a negative delta when decreasing down to reserved', () => {
    expect(computeLocationAdjustment({ ...base, locationType: 'CHANNEL_RESERVED', value: 2 }))
      .toEqual({ change: -8, noop: false })
  })

  it('error is an instanceof LocationAdjustmentError', () => {
    try { computeLocationAdjustment({ ...base, locationType: 'AMAZON_FBA', value: 1 }) }
    catch (e) { expect(e).toBeInstanceOf(LocationAdjustmentError) }
  })
})
