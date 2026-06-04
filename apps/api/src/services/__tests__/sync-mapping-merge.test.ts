/**
 * FM.7 — sync-mapping-merge verifier.
 *
 * Pins the per-channel mode flag, the pure payload merge (well-known →
 * top-level, rest → attributes), and the off/shadow/merge behaviour
 * (off serves legacy with NO preview call → byte-identical default).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { mockPreview } = vi.hoisted(() => ({ mockPreview: vi.fn() }))
vi.mock('../pim/payload-preview.js', () => ({ previewPayload: mockPreview }))
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
  getSyncMappingMode,
  mergeMappingIntoPayload,
  applyMappingToSyncPayload,
} from '../marketplaces/sync-mapping-merge.js'

const ORIGINAL_ENV = process.env
beforeEach(() => {
  vi.clearAllMocks()
  process.env = { ...ORIGINAL_ENV }
})
afterEach(() => {
  process.env = ORIGINAL_ENV
})

describe('getSyncMappingMode', () => {
  it('defaults to off', () => {
    delete process.env.FM_SYNC_AMAZON
    expect(getSyncMappingMode('AMAZON')).toBe('off')
  })
  it('reads merge/shadow case-insensitively', () => {
    process.env.FM_SYNC_AMAZON = 'MERGE'
    expect(getSyncMappingMode('amazon')).toBe('merge')
    process.env.FM_SYNC_EBAY = 'shadow'
    expect(getSyncMappingMode('EBAY')).toBe('shadow')
  })
  it('unknown value → off', () => {
    process.env.FM_SYNC_SHOPIFY = 'yes'
    expect(getSyncMappingMode('SHOPIFY')).toBe('off')
  })
})

describe('mergeMappingIntoPayload', () => {
  it('maps well-known fields to top-level + others to attributes', () => {
    const legacy = { sku: 'X', title: 'Old', description: 'd', price: 10, quantity: 1, attributes: { color: 'Rosso' } }
    const { merged, changedKeys } = mergeMappingIntoPayload(legacy, {
      item_name: 'New',
      material_type: 'Leather',
      our_price: 12,
    })
    expect(merged.title).toBe('New')
    expect(merged.price).toBe(12)
    expect((merged.attributes as Record<string, unknown>).material_type).toBe('Leather')
    expect((merged.attributes as Record<string, unknown>).color).toBe('Rosso') // preserved
    expect(changedKeys).toEqual(expect.arrayContaining(['title', 'price', 'attributes.material_type']))
  })
  it('does not mutate the legacy payload', () => {
    const legacy = { sku: 'X', attributes: { a: 1 } }
    mergeMappingIntoPayload(legacy, { item_name: 'N' })
    expect((legacy as Record<string, unknown>).title).toBeUndefined()
    expect(legacy.attributes).toEqual({ a: 1 })
  })
  it('reports no changes when mapped values equal legacy', () => {
    const legacy = { title: 'Same', attributes: {} }
    const { changedKeys } = mergeMappingIntoPayload(legacy, { item_name: 'Same' })
    expect(changedKeys).toEqual([])
  })
})

describe('applyMappingToSyncPayload', () => {
  const base = { sku: 'X', title: 'Old', description: 'd', price: 10, quantity: 1, attributes: {} }

  it('off → returns legacy untouched, never calls preview', async () => {
    delete process.env.FM_SYNC_AMAZON
    const out = await applyMappingToSyncPayload({ productId: 'p1', channel: 'AMAZON', marketplace: 'IT', legacyPayload: base })
    expect(out).toBe(base)
    expect(mockPreview).not.toHaveBeenCalled()
  })

  it('shadow → serves legacy but does call preview (to log the diff)', async () => {
    process.env.FM_SYNC_AMAZON = 'shadow'
    mockPreview.mockResolvedValue({ payload: { item_name: 'New' } })
    const out = await applyMappingToSyncPayload({ productId: 'p1', channel: 'AMAZON', marketplace: 'IT', legacyPayload: base })
    expect(out).toBe(base)
    expect(mockPreview).toHaveBeenCalledTimes(1)
  })

  it('merge → serves the mapping-merged payload', async () => {
    process.env.FM_SYNC_AMAZON = 'merge'
    mockPreview.mockResolvedValue({ payload: { item_name: 'New', material_type: 'Leather' } })
    const out = await applyMappingToSyncPayload({ productId: 'p1', channel: 'AMAZON', marketplace: 'IT', legacyPayload: base })
    expect(out).not.toBe(base)
    expect(out.title).toBe('New')
    expect((out.attributes as Record<string, unknown>).material_type).toBe('Leather')
  })

  it('preview failure → serves legacy (never throws)', async () => {
    process.env.FM_SYNC_AMAZON = 'merge'
    mockPreview.mockRejectedValue(new Error('boom'))
    const out = await applyMappingToSyncPayload({ productId: 'p1', channel: 'AMAZON', marketplace: 'IT', legacyPayload: base })
    expect(out).toBe(base)
  })

  it('empty marketplace → legacy, no preview', async () => {
    process.env.FM_SYNC_AMAZON = 'merge'
    const out = await applyMappingToSyncPayload({ productId: 'p1', channel: 'AMAZON', marketplace: '', legacyPayload: base })
    expect(out).toBe(base)
    expect(mockPreview).not.toHaveBeenCalled()
  })
})
