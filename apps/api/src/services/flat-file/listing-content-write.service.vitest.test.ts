import { describe, expect, it, vi } from 'vitest'
import {
  assertPatchableSnapshotKeys,
  mergeSnapshotPatch,
  resolveListingRegion,
  writeListingContent,
} from './listing-content-write.service.js'

describe('FFT.3a listing-content choke point', () => {
  it('refuses LIVE/system snapshot keys loudly', () => {
    for (const k of ['_dirty', 'item_sku', 'follow', 'it_price', 'de_item_id', 'purchasable_offer__our_price', 'fulfillment_availability__quantity', 'parent_sku', 'ebay_item_id']) {
      expect(() => assertPatchableSnapshotKeys({ [k]: 'x' }), k).toThrow(/LIVE\/system-owned/)
    }
    expect(() => assertPatchableSnapshotKeys({ item_name: 'ok', title: 'ok', bullet_point_1: 'ok' })).not.toThrow()
  })

  it('patches only over an EXISTING non-empty snapshot (never creates a partial one)', () => {
    expect(mergeSnapshotPatch(null, { item_name: 'x' })).toBeUndefined()
    expect(mergeSnapshotPatch({}, { item_name: 'x' })).toBeUndefined()
    expect(mergeSnapshotPatch({ item_name: 'old', brand: 'B' }, { item_name: 'new' }))
      .toEqual({ item_name: 'new', brand: 'B' })
    expect(mergeSnapshotPatch({ a: 1 }, undefined)).toBeUndefined()
  })

  it('resolves eBay UK to region GB; Amazon keeps marketplace', () => {
    expect(resolveListingRegion('EBAY', 'UK')).toBe('GB')
    expect(resolveListingRegion('EBAY', 'it')).toBe('IT')
    expect(resolveListingRegion('AMAZON', 'UK')).toBe('UK')
  })

  it('writes fields + merged snapshot through CAS on an existing listing', async () => {
    const update = vi.fn(async (args: any) => ({ id: 'cl1', ...args.data, version: 5 }))
    const db = {
      channelListing: {
        findUnique: vi.fn(),
        findFirst: vi.fn(async () => ({ id: 'cl1', version: 4, flatFileSnapshot: { title: 'old', description: 'd' } })),
        update,
        create: vi.fn(),
      },
    }
    const res = await writeListingContent(db as never, {
      target: { productId: 'p1', channel: 'EBAY', marketplace: 'IT' },
      fields: { title: 'new' },
      snapshotKeys: { title: 'new' },
    })
    expect(res).toEqual({ listingId: 'cl1', version: 5, created: false })
    const data = update.mock.calls[0][0].data
    expect(data.title).toBe('new')
    expect(data.flatFileSnapshot).toEqual({ title: 'new', description: 'd' })
    expect(data.version).toEqual({ increment: 1 })
  })

  it('skips the snapshot write when the listing has none, and creates when asked', async () => {
    const update = vi.fn(async (args: any) => ({ id: 'cl2', version: 1 }))
    const create = vi.fn(async (args: any) => ({ id: 'new1', version: 0 }))
    const db = {
      channelListing: {
        findUnique: vi.fn(),
        findFirst: vi.fn(async () => ({ id: 'cl2', version: 0, flatFileSnapshot: null })),
        update,
        create,
      },
    }
    await writeListingContent(db as never, {
      target: { productId: 'p1', channel: 'AMAZON', marketplace: 'IT' },
      fields: { title: 't' },
      snapshotKeys: { item_name: 't' },
    })
    expect(update.mock.calls[0][0].data.flatFileSnapshot).toBeUndefined()

    db.channelListing.findFirst = vi.fn(async () => null) as never
    const res = await writeListingContent(db as never, {
      target: { productId: 'p1', channel: 'AMAZON', marketplace: 'IT' },
      fields: { title: 't' },
      snapshotKeys: { item_name: 't' },
      createIfMissing: { productId: 'p1', channel: 'AMAZON', marketplace: 'IT', region: 'IT', channelMarket: 'AMAZON_IT', listingStatus: 'DRAFT' },
    })
    expect(res.created).toBe(true)
    expect(create.mock.calls[0][0].data.flatFileSnapshot).toBeUndefined()
  })
})
