/**
 * FCF.6 — vitest coverage for computeAvailableToPublish, focused on the
 * pendingReserved (in-flight MCF) subtraction added in FCF.6. The original
 * FCF.2 pool-selection cases live in the legacy tsx runner
 * (available-to-publish.service.test.ts); these run in CI.
 */

import { describe, it, expect } from 'vitest'
import { computeAvailableToPublish } from '../available-to-publish.service.js'

describe('computeAvailableToPublish | pools', () => {
  it('FBM uses warehouseAvailable and ignores FBA', () => {
    const r = computeAvailableToPublish({ fulfillmentMethod: 'FBM', warehouseAvailable: 7, fbaSellable: 99, stockBuffer: 0 })
    expect(r).toMatchObject({ available: 7, pool: 'FBM_WAREHOUSE', poolQuantity: 7 })
  })

  it('FBA uses fbaSellable and ignores warehouse', () => {
    const r = computeAvailableToPublish({ fulfillmentMethod: 'FBA', warehouseAvailable: 99, fbaSellable: 5, stockBuffer: 0 })
    expect(r).toMatchObject({ available: 5, pool: 'FBA', poolQuantity: 5 })
  })
})

describe('computeAvailableToPublish | pendingReserved (FCF.6)', () => {
  it('subtracts pending MCF from the FBA pool', () => {
    const r = computeAvailableToPublish({ fulfillmentMethod: 'FBA', warehouseAvailable: 0, fbaSellable: 10, stockBuffer: 0, pendingReserved: 4 })
    expect(r.available).toBe(6)
    expect(r.reservedApplied).toBe(4)
  })

  it('applies reservation AND buffer together, clamped at 0', () => {
    const r = computeAvailableToPublish({ fulfillmentMethod: 'FBA', warehouseAvailable: 0, fbaSellable: 10, stockBuffer: 3, pendingReserved: 9 })
    // 10 - 9 - 3 = -2 → clamped to 0
    expect(r.available).toBe(0)
    expect(r.reservedApplied).toBe(9)
    expect(r.bufferApplied).toBe(3)
  })

  it('treats a negative pendingReserved as 0 (defensive)', () => {
    const r = computeAvailableToPublish({ fulfillmentMethod: 'FBA', warehouseAvailable: 0, fbaSellable: 8, stockBuffer: 0, pendingReserved: -5 })
    expect(r.available).toBe(8)
    expect(r.reservedApplied).toBe(0)
  })

  it('defaults pendingReserved to 0 when omitted', () => {
    const r = computeAvailableToPublish({ fulfillmentMethod: 'FBA', warehouseAvailable: 0, fbaSellable: 8, stockBuffer: 0 })
    expect(r.available).toBe(8)
    expect(r.reservedApplied).toBe(0)
  })
})
