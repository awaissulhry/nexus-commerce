import { beforeEach, describe, expect, it, vi } from 'vitest'
const { db, resolve } = vi.hoisted(() => ({ resolve: vi.fn(), db: {
  product: { findUnique: vi.fn() }, channelListing: { findMany: vi.fn(), updateMany: vi.fn() },
  channelListingOverride: { create: vi.fn() }, $transaction: vi.fn(),
} }))
vi.mock('../../../db.js', () => ({ default: db }))
vi.mock('./resolve-batch.service.js', () => ({ resolveBatch: resolve }))
import { planMappingPropagation } from '../mapping-propagation.service.js'
import { adoptMasterForCoordinate, scanProductDivergence } from '../reconcile-divergence.service.js'
const listing = { id: 'listing-a', productId: 'p', channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'account-a', aliasKey: '', version: 4, updatedAt: new Date('2026-09-07'), platformAttributes: { itemSpecifics: { Materiale: 'Pinned', Colore: 'Nero' } }, overrideData: {} }
const cell = (value: unknown, provenance = 'catalogRule') => ({ fieldKey: 'aspect_Materiale', rule: { source: 'material' }, value, provenance, appliedTransforms: [], errors: [], warnings: [], required: false })
beforeEach(() => {
  vi.resetAllMocks()
  db.product.findUnique.mockResolvedValue({ id: 'p', sku: 'SKU', productType: 'AMAZON_TYPE', version: 3 })
  db.channelListing.findMany.mockResolvedValue([listing])
  db.channelListing.updateMany.mockResolvedValue({ count: 1 })
  db.$transaction.mockImplementation(async fn => fn(db))
  resolve.mockImplementation(async input => ({ locale: 'it', products: [{ cells: { aspect_Materiale: cell(input.inheritMappedFields ? 'Leather' : input.masterChangesByProduct ? 'Proposed' : 'Pinned', input.inheritMappedFields ? 'catalogRule' : 'override') } }],
    catalogue: { fields: [{ fieldKey: 'aspect_Materiale', channelStore: { kind: 'platformAttributes', path: ['itemSpecifics', 'Materiale'] } }] } }))
})
describe('one mapping workflow across exact listing coordinates', () => {
  it('propagation uses canonical category/locale resolution and preserves account and alias identities', async () => {
    db.channelListing.findMany.mockResolvedValue([listing, { ...listing, id: 'listing-b', channelConnectionId: 'account-b', aliasKey: 'alternate' }])
    const result = await planMappingPropagation({ productId: 'p', changes: { material: 'Proposed' } })
    expect(result.entries.map(e => [e.listingId, e.channelConnectionId, e.aliasKey, e.language])).toEqual([
      ['listing-a', 'account-a', '', 'it'], ['listing-b', 'account-b', 'alternate', 'it'],
    ])
    expect(resolve.mock.calls.every(([args]) => args.productType === undefined && args.locale === undefined)).toBe(true)
  })
  it('divergence compares mapped destination overrides with the shared baseline', async () => {
    const result = await scanProductDivergence({ productId: 'p' })
    expect(result.entries).toEqual([expect.objectContaining({ listingId: 'listing-a', channelConnectionId: 'account-a', aliasKey: '', overrideValue: 'Pinned', masterValue: 'Leather' })])
  })
  it('adopts the destination aspect, preserving sibling aspects and recording the actor', async () => {
    await adoptMasterForCoordinate({ productId: 'p', channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'account-a', attribute: 'aspect_Materiale', expectedVersion: 4, actor: 'operator' })
    expect(db.channelListing.updateMany).toHaveBeenCalledWith({ where: { id: 'listing-a', version: 4, updatedAt: listing.updatedAt },
      data: { version: { increment: 1 }, overrideData: {}, platformAttributes: { itemSpecifics: { Colore: 'Nero' } } } })
    expect(db.channelListingOverride.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ changedBy: 'operator', fieldName: 'aspect_Materiale', isActive: false }) }))
  })
  it('rejects ambiguous accounts and stale versions without writing an override', async () => {
    db.channelListing.findMany.mockResolvedValue([listing, { ...listing, id: 'listing-b' }])
    await expect(adoptMasterForCoordinate({ productId: 'p', channel: 'EBAY', marketplace: 'IT', attribute: 'aspect_Materiale', expectedVersion: 4 })).rejects.toThrow('Select the listing account')
    db.channelListing.findMany.mockResolvedValue([listing])
    await expect(adoptMasterForCoordinate({ productId: 'p', channel: 'EBAY', marketplace: 'IT', attribute: 'aspect_Materiale', expectedVersion: 3 })).rejects.toThrow('listing changed')
    expect(db.channelListing.updateMany).not.toHaveBeenCalled()
  })
})
