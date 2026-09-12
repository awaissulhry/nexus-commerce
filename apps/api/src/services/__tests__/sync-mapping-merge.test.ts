import { describe, it, expect, beforeEach, vi } from 'vitest'
const { resolve } = vi.hoisted(() => ({ resolve: vi.fn() }))
vi.mock('../pim/mapping/resolve-batch.service.js', () => ({ resolveBatch: resolve }))
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }))
import { getSyncMappingMode, mergeMappingIntoPayload, applyMappingToSyncPayload } from '../marketplaces/sync-mapping-merge.js'
const base = { sku: 'X', title: 'Old', price: 10, quantity: 0, attributes: { other: 'Keep' } }
const input = { productId: 'p', channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'account-b', aliasKey: 'alternate', legacyPayload: base }
beforeEach(() => {
  vi.resetAllMocks()
  resolve.mockResolvedValue({ catalogue: { schema: { present: true }, fields: [{ fieldKey: 'item_name', label: 'Title' }, { fieldKey: 'price', sourceOwner: { label: 'Pricing' } }] },
    products: [{ cells: { item_name: { value: 'Mapped title', status: 'mapped', errors: [] }, price: { value: 999, errors: [] } } }] })
})
describe('canonical sync payloads', () => {
  it('Amazon and eBay cannot silently bypass their active mappings', () => {
    expect(getSyncMappingMode('AMAZON')).toBe('merge')
    expect(getSyncMappingMode('EBAY')).toBe('merge')
  })
  it('uses the exact account and alias, while preserving pricing and inventory owners', async () => {
    const payload = await applyMappingToSyncPayload(input)
    expect(payload).toMatchObject({ title: 'Mapped title', price: 10, quantity: 0 })
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ channelConnectionId: 'account-b', aliasKey: 'alternate' }))
    expect(base.title).toBe('Old')
  })
  it('refuses unavailable resolution instead of serving legacy data', async () => {
    resolve.mockRejectedValue(new Error('Schema unavailable'))
    await expect(applyMappingToSyncPayload(input)).rejects.toThrow('Schema unavailable')
  })
  it('refuses invalid outputs, pending translations and missing market context', async () => {
    resolve.mockResolvedValue({ catalogue: { schema: { present: true }, fields: [{ fieldKey: 'title', label: 'Title' }] }, products: [{ cells: { title: { value: 'Source language', errors: [], needsTranslation: true } } }] })
    await expect(applyMappingToSyncPayload(input)).rejects.toThrow('pending')
    await expect(applyMappingToSyncPayload({ ...input, marketplace: '' })).rejects.toThrow('Choose a marketplace')
  })
  it('preserves explicit blanks and typed values without mutating the source payload', () => {
    const result = mergeMappingIntoPayload(base, { item_name: null, flag: false, count: 0, tags: ['A', 'B'] })
    expect(result.merged).toMatchObject({ title: null, attributes: { flag: false, count: 0, tags: ['A', 'B'], other: 'Keep' } })
    expect(base.title).toBe('Old')
  })
})
