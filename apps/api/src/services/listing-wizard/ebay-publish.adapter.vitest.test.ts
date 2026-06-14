/**
 * B1 — eBay fitment mapper. Pure, so the captured-fitment → Inventory API
 * product_compatibility shape is fully unit-testable without eBay creds.
 */
import { describe, it, expect, vi } from 'vitest'

// The adapter imports prisma + sibling services at module load; mock the DB so
// importing the pure mapper never spins up a real PrismaClient.
vi.mock('../../db.js', () => ({ default: {} }))

import { buildEbayCompatibilityBody } from './ebay-publish.adapter.js'

describe('B1 — buildEbayCompatibilityBody', () => {
  it('maps year/make/model/submodel → compatibilityProperties (stable order)', () => {
    const body = buildEbayCompatibilityBody({
      universal: false,
      fitments: [{ year: 2020, make: 'Honda', model: 'CBR600RR', submodel: 'ABS' }],
    })
    expect(body).not.toBeNull()
    expect(body!.compatibleProducts).toHaveLength(1)
    expect(body!.compatibleProducts[0].compatibilityProperties).toEqual([
      { name: 'Year', value: '2020' },
      { name: 'Make', value: 'Honda' },
      { name: 'Model', value: 'CBR600RR' },
      { name: 'Submodel', value: 'ABS' },
    ])
  })
  it('omits submodel when absent/null', () => {
    const body = buildEbayCompatibilityBody({ fitments: [{ year: '2019', make: 'Yamaha', model: 'R6', submodel: null }] })
    expect(body!.compatibleProducts[0].compatibilityProperties.map((p) => p.name)).toEqual(['Year', 'Make', 'Model'])
  })
  it('universal fit → null (no list sent)', () => {
    expect(buildEbayCompatibilityBody({ universal: true, fitments: [{ year: '2020', make: 'Honda', model: 'X' }] })).toBeNull()
  })
  it('no fitments / null / undefined → null', () => {
    expect(buildEbayCompatibilityBody({ universal: false, fitments: [] })).toBeNull()
    expect(buildEbayCompatibilityBody(null as any)).toBeNull()
    expect(buildEbayCompatibilityBody(undefined)).toBeNull()
  })
  it('drops fitments missing make or model', () => {
    const body = buildEbayCompatibilityBody({
      fitments: [
        { year: '2020', make: 'Honda', model: '' },       // no model → dropped
        { year: '2021', make: '', model: 'CBR' },          // no make → dropped
        { year: '2022', make: 'Honda', model: 'CBR1000' }, // valid
      ],
    })
    expect(body!.compatibleProducts).toHaveLength(1)
    expect(body!.compatibleProducts[0].compatibilityProperties).toContainEqual({ name: 'Model', value: 'CBR1000' })
  })
  it('multiple valid fitments → multiple compatibleProducts', () => {
    const body = buildEbayCompatibilityBody({
      fitments: [
        { year: '2020', make: 'Honda', model: 'CBR600' },
        { year: '2021', make: 'Kawasaki', model: 'Ninja' },
      ],
    })
    expect(body!.compatibleProducts).toHaveLength(2)
  })
})
