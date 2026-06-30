/**
 * P5.2 — Unit tests for pure helpers in ebay-inventory-readback.service.ts
 *
 * Only the two stateless pure functions are tested here.  The
 * orchestrator (readBackEbayInventory) touches DB + HTTP and is not
 * unit-tested.
 */

import { describe, it, expect } from 'vitest'
import {
  ebayReadbackEventId,
  extractEbayPublishedQty,
} from './ebay-inventory-readback.service.js'

// ---------------------------------------------------------------------------
// ebayReadbackEventId
// ---------------------------------------------------------------------------

describe('ebayReadbackEventId', () => {
  it('produces the correct format', () => {
    const d = new Date('2026-07-01T14:35:00.000Z')
    expect(ebayReadbackEventId('ABC-123', d)).toBe('ebay-readback:ABC-123:2026-07-01T14')
  })

  it('is hour-bucketed — two dates in the same hour share the same id', () => {
    const d1 = new Date('2026-07-01T09:00:00.000Z')
    const d2 = new Date('2026-07-01T09:59:59.999Z')
    expect(ebayReadbackEventId('SKU-X', d1)).toBe(ebayReadbackEventId('SKU-X', d2))
  })

  it('differs across hours', () => {
    const d1 = new Date('2026-07-01T09:00:00.000Z')
    const d2 = new Date('2026-07-01T10:00:00.000Z')
    expect(ebayReadbackEventId('SKU-X', d1)).not.toBe(ebayReadbackEventId('SKU-X', d2))
  })

  it('differs across SKUs in the same hour', () => {
    const d = new Date('2026-07-01T09:00:00.000Z')
    expect(ebayReadbackEventId('SKU-A', d)).not.toBe(ebayReadbackEventId('SKU-B', d))
  })

  it('starts with the expected prefix', () => {
    const d = new Date('2026-07-01T00:00:00.000Z')
    expect(ebayReadbackEventId('MY-SKU', d)).toMatch(/^ebay-readback:MY-SKU:/)
  })
})

// ---------------------------------------------------------------------------
// extractEbayPublishedQty
// ---------------------------------------------------------------------------

describe('extractEbayPublishedQty', () => {
  it('returns the quantity when the full path is present', () => {
    const item = {
      availability: {
        shipToLocationAvailability: { quantity: 42 },
      },
    }
    expect(extractEbayPublishedQty(item)).toBe(42)
  })

  it('returns 0 when quantity is explicitly 0', () => {
    const item = {
      availability: {
        shipToLocationAvailability: { quantity: 0 },
      },
    }
    expect(extractEbayPublishedQty(item)).toBe(0)
  })

  it('coerces a numeric string to an integer', () => {
    const item = {
      availability: {
        shipToLocationAvailability: { quantity: '10' },
      },
    }
    expect(extractEbayPublishedQty(item)).toBe(10)
  })

  it('returns null when quantity is negative', () => {
    const item = {
      availability: {
        shipToLocationAvailability: { quantity: -1 },
      },
    }
    expect(extractEbayPublishedQty(item)).toBeNull()
  })

  it('returns null when quantity is missing', () => {
    const item = {
      availability: {
        shipToLocationAvailability: {},
      },
    }
    expect(extractEbayPublishedQty(item)).toBeNull()
  })

  it('returns null when shipToLocationAvailability is absent', () => {
    const item = { availability: {} }
    expect(extractEbayPublishedQty(item)).toBeNull()
  })

  it('returns null when availability is absent', () => {
    expect(extractEbayPublishedQty({})).toBeNull()
  })

  it('returns null for null input', () => {
    expect(extractEbayPublishedQty(null)).toBeNull()
  })

  it('returns null for undefined input', () => {
    expect(extractEbayPublishedQty(undefined)).toBeNull()
  })

  it('returns null for NaN quantity', () => {
    const item = {
      availability: {
        shipToLocationAvailability: { quantity: NaN },
      },
    }
    expect(extractEbayPublishedQty(item)).toBeNull()
  })

  it('returns null for a non-numeric string quantity', () => {
    const item = {
      availability: {
        shipToLocationAvailability: { quantity: 'many' },
      },
    }
    expect(extractEbayPublishedQty(item)).toBeNull()
  })

  it('returns null for a float quantity (non-integer)', () => {
    const item = {
      availability: {
        shipToLocationAvailability: { quantity: 3.7 },
      },
    }
    expect(extractEbayPublishedQty(item)).toBeNull()
  })
})
