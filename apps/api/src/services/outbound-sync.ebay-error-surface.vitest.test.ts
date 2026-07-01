import { describe, it, expect } from 'vitest'
import { classifyEbayFailure } from './outbound-sync.service.js'

describe('classifyEbayFailure', () => {
  it('400 validation is listing-fatal, non-retryable, does not trip circuit', () => {
    expect(classifyEbayFailure(400)).toEqual({ code: 'EBAY_VALIDATION', retryable: false, tripsCircuit: false })
  })

  it('404 is also listing-fatal (no-offer / bad-resource)', () => {
    expect(classifyEbayFailure(404)).toEqual({ code: 'EBAY_VALIDATION', retryable: false, tripsCircuit: false })
  })

  it('409 is also listing-fatal (conflict)', () => {
    expect(classifyEbayFailure(409)).toEqual({ code: 'EBAY_VALIDATION', retryable: false, tripsCircuit: false })
  })

  it('422 is also listing-fatal (unprocessable entity)', () => {
    expect(classifyEbayFailure(422)).toEqual({ code: 'EBAY_VALIDATION', retryable: false, tripsCircuit: false })
  })

  it('429 / 500 / 503 / null are transient and trip the circuit', () => {
    for (const s of [429, 500, 503, null] as const) {
      expect(classifyEbayFailure(s as any).tripsCircuit).toBe(true)
    }
  })

  it('null (network/timeout) is transient', () => {
    expect(classifyEbayFailure(null)).toEqual({ code: 'EBAY_TRANSIENT', retryable: true, tripsCircuit: true })
  })

  it('401 (auth) is transient — should trip circuit and retry', () => {
    expect(classifyEbayFailure(401)).toEqual({ code: 'EBAY_TRANSIENT', retryable: true, tripsCircuit: true })
  })

  it('503 (service unavailable) is transient', () => {
    expect(classifyEbayFailure(503)).toEqual({ code: 'EBAY_TRANSIENT', retryable: true, tripsCircuit: true })
  })
})
