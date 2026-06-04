/**
 * FM.4 — value-map service verifier.
 *
 * Mocks prisma + the Amazon enum mapper so the suite stays pure/fast.
 * Pins the lookup specificity (market over '*'), cache behaviour,
 * normalization, and the AI seeder's valid-only write contract.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const { mockPrisma, mockTranslate } = vi.hoisted(() => ({
  mockPrisma: {
    fieldValueMap: { findMany: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
    sizeScaleMap: { findMany: vi.fn(), upsert: vi.fn() },
  },
  mockTranslate: vi.fn(),
}))
vi.mock('../../db.js', () => ({ default: mockPrisma }))
vi.mock('../amazon/value-translate.service.js', () => ({ translateEnumValues: mockTranslate }))

import {
  loadValueMapLookup,
  loadSizeScaleLookup,
  upsertValueMap,
  seedValueMapsFromAI,
  clearValueMapCaches,
} from '../pim/value-map.service.js'

beforeEach(() => {
  vi.clearAllMocks()
  clearValueMapCaches()
})

describe('loadValueMapLookup', () => {
  it('overlays the specific market over the all-markets (*) maps', async () => {
    mockPrisma.fieldValueMap.findMany.mockResolvedValue([
      { marketplace: '*', attribute: 'color', fromValue: 'Rosso', toValue: 'Red' },
      { marketplace: 'DE', attribute: 'color', fromValue: 'Rosso', toValue: 'Rot' },
      { marketplace: '*', attribute: 'material', fromValue: 'Pelle', toValue: 'Leather' },
    ])
    const lookup = await loadValueMapLookup('AMAZON', 'DE')
    expect(lookup('color', 'Rosso')).toBe('Rot') // specific market wins
    expect(lookup('material', 'Pelle')).toBe('Leather') // inherited from '*'
    expect(lookup('color', 'Verde')).toBeNull() // miss
  })

  it('queries only the * bucket when no specific market', async () => {
    mockPrisma.fieldValueMap.findMany.mockResolvedValue([])
    await loadValueMapLookup('AMAZON')
    expect(mockPrisma.fieldValueMap.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { channel: 'AMAZON', marketplace: { in: ['*'] } } }),
    )
  })

  it('caches — a second call for the same coordinate does not re-query', async () => {
    mockPrisma.fieldValueMap.findMany.mockResolvedValue([])
    await loadValueMapLookup('AMAZON', 'IT')
    await loadValueMapLookup('AMAZON', 'IT')
    expect(mockPrisma.fieldValueMap.findMany).toHaveBeenCalledTimes(1)
  })
})

describe('loadSizeScaleLookup', () => {
  it('keys case-insensitively on scale/system, exact on value', async () => {
    mockPrisma.sizeScaleMap.findMany.mockResolvedValue([
      { scale: 'MENS_JACKET', fromSystem: 'EU', toSystem: 'ALPHA', fromValue: '52', toValue: 'XL' },
    ])
    const lookup = await loadSizeScaleLookup()
    expect(lookup('mens_jacket', 'eu', 'alpha', '52')).toBe('XL')
    expect(lookup('MENS_JACKET', 'EU', 'ALPHA', '99')).toBeNull()
  })
})

describe('upsertValueMap', () => {
  it('normalizes channel/marketplace + sets reviewedAt for a manual write', async () => {
    mockPrisma.fieldValueMap.upsert.mockResolvedValue({ id: 'x' })
    await upsertValueMap({ channel: 'amazon', marketplace: 'de', attribute: 'color', fromValue: 'Rosso', toValue: 'Rot' })
    const call = mockPrisma.fieldValueMap.upsert.mock.calls[0][0]
    expect(call.where.channel_marketplace_attribute_fromValue).toMatchObject({ channel: 'AMAZON', marketplace: 'DE' })
    expect(call.create.reviewedAt).toBeInstanceOf(Date)
  })

  it('defaults marketplace to * and reviewed=false leaves reviewedAt null', async () => {
    mockPrisma.fieldValueMap.upsert.mockResolvedValue({ id: 'x' })
    await upsertValueMap({ channel: 'AMAZON', attribute: 'color', fromValue: 'Rosso', toValue: 'Red', reviewed: false })
    const call = mockPrisma.fieldValueMap.upsert.mock.calls[0][0]
    expect(call.where.channel_marketplace_attribute_fromValue.marketplace).toBe('*')
    expect(call.create.reviewedAt).toBeNull()
  })
})

describe('seedValueMapsFromAI', () => {
  it('writes only valid matches, flags AI confidence + reviewedAt null', async () => {
    mockTranslate.mockResolvedValue({
      colLabel: 'color',
      mappings: {
        DE: {
          Rosso: { match: 'Rot', confidence: 'high', valid: true },
          Verde: { match: null, confidence: 'none', valid: false },
        },
        FR: { Rosso: { match: 'Rouge', confidence: 'medium', valid: true } },
      },
      targetOptions: {},
      errors: {},
    })
    mockPrisma.fieldValueMap.upsert.mockResolvedValue({ id: 'x' })

    const { written } = await seedValueMapsFromAI({
      attribute: 'color',
      productType: 'OUTERWEAR',
      values: ['Rosso', 'Verde'],
      targetMarkets: ['DE', 'FR'],
    })

    expect(written).toBe(2) // Rosso→Rot (DE) + Rosso→Rouge (FR); Verde skipped (invalid)
    const upserts = mockPrisma.fieldValueMap.upsert.mock.calls.map((c) => c[0])
    const de = upserts.find((u) => u.where.channel_marketplace_attribute_fromValue.marketplace === 'DE')
    expect(de.create).toMatchObject({ toValue: 'Rot', confidence: 'AI_HIGH', reviewedAt: null })
    expect(mockTranslate).toHaveBeenCalledWith(
      mockPrisma,
      expect.objectContaining({ sourceMarket: 'IT', colId: 'color', productType: 'OUTERWEAR' }),
    )
  })
})
