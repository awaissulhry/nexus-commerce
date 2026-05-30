import { describe, it, expect } from 'vitest'
import { effectiveLeadTimeDays } from '../replenishment-math.service.js'

describe('S2 — effectiveLeadTimeDays', () => {
  it('falls back to legacy leadTimeDays when nothing is configured', () => {
    const r = effectiveLeadTimeDays({ legacyLeadTimeDays: 14 })
    expect(r).toEqual({ productionDays: 0, shippingDays: 0, leadTimeDays: 14, source: 'LEGACY' })
  })

  it('flat production + shipping sums to effective lead time', () => {
    const r = effectiveLeadTimeDays({
      productionTimeDays: 12,
      shippingTimeDays: 3,
      legacyLeadTimeDays: 14,
    })
    expect(r.source).toBe('PRODUCTION_SHIPPING')
    expect(r.productionDays).toBe(12)
    expect(r.shippingDays).toBe(3)
    expect(r.leadTimeDays).toBe(15)
  })

  it('rate-based production scales with order quantity', () => {
    const r = effectiveLeadTimeDays({
      productionUnitsPerDay: 100,
      shippingTimeDays: 3,
      expectedQty: 500,
      legacyLeadTimeDays: 14,
    })
    expect(r.productionDays).toBe(5) // ceil(500/100)
    expect(r.leadTimeDays).toBe(8)
  })

  it('rounds production days up for partial batches', () => {
    const r = effectiveLeadTimeDays({
      productionUnitsPerDay: 100,
      expectedQty: 450,
      legacyLeadTimeDays: 14,
    })
    expect(r.productionDays).toBe(5) // ceil(450/100)=5
  })

  it('rate wins when both flat days and a rate are set', () => {
    const r = effectiveLeadTimeDays({
      productionTimeDays: 2,
      productionUnitsPerDay: 50,
      expectedQty: 300,
      legacyLeadTimeDays: 14,
    })
    expect(r.productionDays).toBe(6) // ceil(300/50), not the flat 2
  })

  it('shipping-only still leaves legacy fallback behind', () => {
    const r = effectiveLeadTimeDays({ shippingTimeDays: 5, legacyLeadTimeDays: 14 })
    expect(r.source).toBe('PRODUCTION_SHIPPING')
    expect(r.leadTimeDays).toBe(5)
  })

  it('production-only (flat) ignores shipping when unset', () => {
    const r = effectiveLeadTimeDays({ productionTimeDays: 10, legacyLeadTimeDays: 14 })
    expect(r.leadTimeDays).toBe(10)
  })
})
