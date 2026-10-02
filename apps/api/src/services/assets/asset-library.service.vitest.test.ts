/**
 * MCP full control P3 — the image library reads moved from assets.routes.ts into asset-library.service.ts: the merged
 * library (DigitalAsset + ProductImage), the asset tags and the folder tree. Each route answers byte for byte what it
 * answered before (goldens recorded on the routes as they were), with business profiles off and on.
 *
 * And the one option only Claude's read passes: `liveProductsOnly` leaves out the photos of deleted products.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
// No Redis here: the queues are built at import time and would try to connect. These reads never enqueue.
vi.mock('../../lib/queue.js', () => ({
  redis: { connection: null }, outboundSyncQueue: null, channelSyncQueue: null, readCacheQueue: null, readinessQueue: null,
  searchIndexQueue: null, bulkJobQueue: null, adsSyncQueue: null, queueEvents: null, channelSyncQueueEvents: null,
  addJobSafely: vi.fn(), resetEnqueueCircuitForTests: vi.fn(), initializeQueue: vi.fn(), closeQueue: vi.fn(),
  getQueueStats: vi.fn(), getRedisRuntimeStatus: vi.fn(() => ({ configured: false, status: 'not-initialized' })), resolveRedisTarget: vi.fn(),
}))

import { expectGolden, freezeGoldenClock, goldenApp, GOLDEN_NOW, inGoldenBusiness } from '../../test-support/route-golden.js'
import assetsRoutes from '../../routes/assets.routes.js'
import { listAssetLibrary } from './asset-library.service.js'

const GOLDEN = './__golden__'
const at = (minutesAgo: number) => new Date(GOLDEN_NOW.getTime() - minutesAgo * 60_000)
const DAY = 24 * 60

let app: FastifyInstance
beforeAll(async () => {
  freezeGoldenClock()
  const db = state.db.client
  await inGoldenBusiness(async () => {
    await db.product.create({ data: { id: 'golden-product-1', sku: 'TEST-SKU-1', name: 'Golden jacket', brand: 'GoldenBrand', productType: 'JACKET', basePrice: '10.00', totalStock: 3 } })
    await db.product.create({ data: { id: 'golden-product-2', sku: 'TEST-SKU-2', name: 'Golden gloves', brand: 'OtherBrand', basePrice: '10.00', totalStock: 1 } })
    await db.product.create({ data: { id: 'golden-product-gone', sku: 'TEST-SKU-9', name: 'Deleted boots', basePrice: '10.00', totalStock: 0, deletedAt: at(60) } })

    await db.assetFolder.create({ data: { id: 'golden-folder-1', name: 'Shoots', order: 1 } })
    await db.assetFolder.create({ data: { id: 'golden-folder-2', name: 'Autumn', parentId: 'golden-folder-1', order: 0 } })
    await db.assetFolder.create({ data: { id: 'golden-folder-3', name: 'Archive', order: 0 } })

    await db.tag.create({ data: { id: 'golden-tag-1', name: 'hero', color: 'red' } })
    await db.tag.create({ data: { id: 'golden-tag-2', name: 'lifestyle' } })
    await db.tag.create({ data: { id: 'golden-tag-3', name: 'unused', icon: 'star' } })

    const asset = (id: string, minutesAgo: number, data: Record<string, unknown>) =>
      db.digitalAsset.create({ data: { id, label: '', mimeType: 'image/jpeg', sizeBytes: 1000, storageId: `store-${id}`, url: `https://cdn.example.test/${id}.jpg`, createdAt: at(minutesAgo), updatedAt: at(minutesAgo), ...data } })
    await asset('golden-asset-1', 10, { label: 'Hero shot', code: 'hero_shot', originalFilename: 'hero.jpg', folderId: 'golden-folder-1', metadata: { width: 2000, height: 1500, caption: 'golden hour', qualityWarnings: ['small'] } })
    await asset('golden-asset-2', 30, { type: 'video', mimeType: 'video/mp4', sizeBytes: 50_000, originalFilename: 'clip.mp4', folderId: 'golden-folder-2', metadata: { durationSeconds: 12.5, alt: 'a golden clip' } })
    await asset('golden-asset-3', 50, { type: 'document', mimeType: 'application/pdf', label: 'Size chart', metadata: { tags: ['golden'] } })
    await asset('golden-asset-4', 10 * DAY, { label: 'Old lifestyle', metadata: { width: 800 } })

    await db.assetTag.create({ data: { assetId: 'golden-asset-1', tagId: 'golden-tag-1' } })
    await db.assetTag.create({ data: { assetId: 'golden-asset-1', tagId: 'golden-tag-2' } })
    await db.assetTag.create({ data: { assetId: 'golden-asset-4', tagId: 'golden-tag-2' } })
    await db.productTag.create({ data: { productId: 'golden-product-1', tagId: 'golden-tag-1' } })

    await db.assetUsage.create({ data: { id: 'golden-usage-1', assetId: 'golden-asset-1', scope: 'product', productId: 'golden-product-1', role: 'main' } })
    await db.assetUsage.create({ data: { id: 'golden-usage-2', assetId: 'golden-asset-2', scope: 'product', productId: 'golden-product-2', role: 'alt' } })

    const image = (id: string, minutesAgo: number, data: Record<string, unknown>) =>
      db.productImage.create({ data: { id, url: `https://cdn.example.test/${id}.jpg`, createdAt: at(minutesAgo), updatedAt: at(minutesAgo), ...data } })
    await image('golden-image-1', 20, { productId: 'golden-product-1', type: 'MAIN', alt: 'Golden jacket front', publicId: 'pub-1' })
    await image('golden-image-2', 40, { productId: 'golden-product-1', type: 'ALT', alt: null, publicId: 'pub-2' })
    await image('golden-image-3', 60, { productId: 'golden-product-2', type: 'LIFESTYLE', alt: '' })
    await image('golden-image-gone', 70, { productId: 'golden-product-gone', type: 'MAIN', alt: 'Deleted boots photo', publicId: 'pub-gone' })
  })
  app = await goldenApp([{ plugin: assetsRoutes, prefix: '/api' }])
}, 60_000)

afterAll(async () => {
  await app?.close()
  vi.useRealTimers()
})

describe('P3 — image library: the routes answer exactly as before', () => {
  it('GET /api/assets/library, unfiltered and by type and source', async () => {
    await expectGolden(app, 'library', '/api/assets/library', GOLDEN)
    await expectGolden(app, 'library-types', '/api/assets/library?types=image,video', GOLDEN)
    await expectGolden(app, 'library-video', '/api/assets/library?type=video', GOLDEN)
    await expectGolden(app, 'library-bad-type', '/api/assets/library?type=sound&types=,image', GOLDEN)
    await expectGolden(app, 'library-product-images', '/api/assets/library?sources=product_image', GOLDEN)
    await expectGolden(app, 'library-digital-assets', '/api/assets/library?sources=digital_asset,nonsense', GOLDEN)
  })

  it('GET /api/assets/library by usage, alt, tags, folder, date and related product', async () => {
    await expectGolden(app, 'library-in-use', '/api/assets/library?usage=in_use', GOLDEN)
    await expectGolden(app, 'library-orphaned', '/api/assets/library?usage=orphaned', GOLDEN)
    await expectGolden(app, 'library-missing-alt', '/api/assets/library?missingAlt=1', GOLDEN)
    await expectGolden(app, 'library-tag', '/api/assets/library?tagIds=golden-tag-2', GOLDEN)
    await expectGolden(app, 'library-tags-all', '/api/assets/library?tagIds=golden-tag-1,golden-tag-2', GOLDEN)
    await expectGolden(app, 'library-unfiled', '/api/assets/library?folderId=unfiled', GOLDEN)
    await expectGolden(app, 'library-folder', '/api/assets/library?folderId=golden-folder-2', GOLDEN)
    await expectGolden(app, 'library-last-7d', '/api/assets/library?dateRange=last_7d', GOLDEN)
    await expectGolden(app, 'library-today', '/api/assets/library?dateRange=today&sources=digital_asset', GOLDEN)
    await expectGolden(app, 'library-related', '/api/assets/library?relatedBrand=goldenbrand', GOLDEN)
    await expectGolden(app, 'library-related-tag', '/api/assets/library?relatedProductType=jacket&tagIds=golden-tag-1', GOLDEN)
  })

  it('GET /api/assets/library by search and page', async () => {
    await expectGolden(app, 'library-search', '/api/assets/library?search=golden', GOLDEN)
    await expectGolden(app, 'library-search-sku', '/api/assets/library?search=TEST-SKU-1', GOLDEN)
    await expectGolden(app, 'library-search-missing-alt', '/api/assets/library?search=jacket&missingAlt=true', GOLDEN)
    await expectGolden(app, 'library-page-2', '/api/assets/library?pageSize=2&page=2', GOLDEN)
    await expectGolden(app, 'library-page-junk', '/api/assets/library?pageSize=0&page=-3', GOLDEN)
  })

  it('GET /api/asset-tags and /api/asset-folders', async () => {
    await expectGolden(app, 'asset-tags', '/api/asset-tags', GOLDEN)
    await expectGolden(app, 'asset-folders', '/api/asset-folders', GOLDEN)
  })
})

describe('P3 — image library: the photos of deleted products, for Claude', () => {
  const ids = (page: { items: Array<{ id: string }> }) => page.items.map((item) => item.id)

  it('liveProductsOnly leaves a deleted product\'s photo out of the rows and the total; without it the photo is listed (control)', async () => {
    const all = await inGoldenBusiness(() => listAssetLibrary({}))
    expect(ids(all)).toContain('pi_golden-image-gone')
    expect(all.total).toBe(8)
    const live = await inGoldenBusiness(() => listAssetLibrary({}, { liveProductsOnly: true }))
    expect(ids(live)).not.toContain('pi_golden-image-gone')
    expect(live.total).toBe(7)
    expect(ids(live)).toEqual(ids(all).filter((id) => id !== 'pi_golden-image-gone'))
  })

  it('it holds under every filter that can reach the photo: search, source and related product', async () => {
    for (const query of [{ search: 'boots' }, { sources: 'product_image' }, { relatedBrand: 'goldenbrand' }, { missingAlt: '1' }]) {
      const all = await inGoldenBusiness(() => listAssetLibrary(query))
      const live = await inGoldenBusiness(() => listAssetLibrary(query, { liveProductsOnly: true }))
      expect({ query, ids: ids(live), total: live.total }).toEqual({
        query,
        ids: ids(all).filter((id) => id !== 'pi_golden-image-gone'),
        total: all.total - (ids(all).includes('pi_golden-image-gone') ? 1 : 0),
      })
    }
    const searched = await inGoldenBusiness(() => listAssetLibrary({ search: 'boots' }))
    expect(ids(searched)).toEqual(['pi_golden-image-gone']) // control: the search does reach it without the option
  })
})
