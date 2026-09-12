import { beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ categorySchema: { findFirst: vi.fn() } }))
vi.mock('../../../db.js', () => ({ default: db }))
import { loadEtsyProductSpec, readEtsyProperties } from './etsy-loader.js'
import { etsyListingSchema } from './etsy-listing-schema.js'

const property = { property_id: 200, name: 'color', display_name: 'Primary color', is_required: true,
  supports_attributes: true, supports_variations: true, is_multivalued: false, max_values_allowed: 1,
  possible_values: [{ value_id: 4, name: 'Green' }], selected_values: [], scales: [] }
beforeEach(() => vi.clearAllMocks())
describe('cached Etsy taxonomy loading', () => {
  it('does not query categories or call Etsy for a native-only catalogue', async () => {
    const spec = await loadEtsyProductSpec()
    expect(spec.absent).toBe(false)
    expect(db.categorySchema.findFirst).not.toHaveBeenCalled()
  })
  it('retains native fields while reporting a missing exact category', async () => {
    db.categorySchema.findFirst.mockResolvedValue(null)
    const spec = await loadEtsyProductSpec('2838')
    expect(spec.absent).toBe(true)
    expect(spec.fields.some(f => f.key === 'title')).toBe(true)
    expect(db.categorySchema.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { channel: 'ETSY', marketplace: 'GLOBAL', productType: '2838', isActive: true } }))
  })
  it('keeps the selected category requirements and all native schema constraints together', async () => {
    db.categorySchema.findFirst.mockResolvedValue({ schemaDefinition: { count: 1, results: [property] }, fetchedAt: new Date('2026-09-10'), schemaVersion: 'live-version' })
    const spec = await loadEtsyProductSpec('2838')
    expect(spec.schemaVersion).toBe('live-version')
    expect(spec.absent).toBe(false)
    expect(spec.validationSchema?.required).toEqual(expect.arrayContaining([...etsyListingSchema.create.required, 'property_200']))
    expect(spec.fields.find(f => f.key === 'property_200')?.options).toEqual(['4'])
  })
  it.each([{ count: 2, results: [property] }, { count: 1 }, { count: 1, results: [{}] },
    { count: 2, results: [property, property] }, { count: 1, results: [{ ...property, supports_attributes: null }] }])('rejects incomplete or invalid definitions', body => {
    expect(() => readEtsyProperties(body)).toThrow()
  })
  it('accepts a complete empty category without inventing properties', () => {
    expect(readEtsyProperties({ count: 0, results: [] })).toEqual([])
  })
})
