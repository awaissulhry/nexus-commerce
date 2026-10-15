/**
 * A Shopify store photo (linked from the store's Files for its own galleries) never reaches Amazon or eBay by default: the
 * older "all photos of the product" reads leave it out. Two of them, run against rows that hold one, prove the filter.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { STORE_PHOTO_ID_PREFIX } from '@nexus/shared/product-media'

const STORE = `${STORE_PHOTO_ID_PREFIX}abc`
let rows: Array<{ id: string; productId: string; url: string; type: string; isPrimary: boolean; sortOrder: number; mediaType: string; createdAt: Date }>
/** The where clauses these reads use: product id, media type, and NOT { id: { startsWith } }. */
const matches = (row: any, where: any = {}): boolean => Object.entries(where).every(([key, value]: [string, any]) => {
  if (key === 'NOT') return !matches(row, value)
  if (value && typeof value === 'object' && 'startsWith' in value) return String(row[key]).startsWith(value.startsWith)
  return row[key] === value
})
const enqueued: any[] = []
vi.mock('../../db.js', () => ({ default: {
  product: { findUnique: async () => ({ productType: 'JACKET' }) },
  productImage: { findMany: async (args: any) => rows.filter(row => matches(row, args.where)) },
  listingImage: { findMany: async () => [], findFirst: async () => null },
  channelListing: { findMany: async (args: any) => [{ id: 'l1', productId: 'p1', channel: 'EBAY', marketplace: 'IT', region: 'IT', externalListingId: '1', title: 'T', description: 'D',
    isPublished: true, offerActive: true, platformAttributes: { _autoPublishContent: true },
    product: { id: 'p1', name: 'T', description: 'D', images: rows.filter(row => matches(row, args.select.product.select.images.where)).slice(0, 10).map(row => ({ url: row.url })) } }] },
} }))
vi.mock('./amazon-slot-taxonomy.service.js', () => ({ resolveSlotTaxonomy: async () => ({ slots: Array.from({ length: 8 }, () => ({ kind: 'OTHER', writable: true })) }) }))
vi.mock('../pim/publish-review-gate.js', () => ({ assertListingContentReviewed: async () => undefined }))
vi.mock('../outbound-enqueue.js', () => ({ enqueueOutboundRowsInstant: async (_db: unknown, list: any[]) => { enqueued.push(...list) } }))
import { fillSlotsFromGallery } from './amazon-fill-gallery.service.js'
import { enqueueContentSyncIfEnabled } from '../content-auto-publish.service.js'

beforeEach(() => {
  const at = new Date(0)
  rows = [
    { id: 'own', productId: 'p1', url: 'https://res.cloudinary.com/x/own.jpg', type: 'MAIN', isPrimary: true, sortOrder: 0, mediaType: 'IMAGE', createdAt: at },
    { id: STORE, productId: 'p1', url: 'https://cdn.shopify.com/s/files/store.jpg', type: 'ALT', isPrimary: false, sortOrder: 1, mediaType: 'IMAGE', createdAt: at },
    { id: 'shopify_image_upload', productId: 'p1', url: 'https://cdn.shopify.com/s/files/upload-nexus-1.jpg', type: 'ALT', isPrimary: false, sortOrder: 2, mediaType: 'IMAGE', createdAt: at },
  ]
  enqueued.length = 0
})

describe('older all-photos reads leave store photos out', () => {
  it('Amazon "fill from gallery" maps every photo but the store photo', async () => {
    const result = await fillSlotsFromGallery({ productId: 'p1', dryRun: true })
    expect(result.plan.map(item => item.sourceProductImageId)).toEqual(['own', 'shopify_image_upload'])
  })
  it('content auto-publish sends every photo but the store photo', async () => {
    await enqueueContentSyncIfEnabled(['l1'])
    expect(enqueued[0].payload.images).toEqual(['https://res.cloudinary.com/x/own.jpg', 'https://cdn.shopify.com/s/files/upload-nexus-1.jpg'])
  })
})
