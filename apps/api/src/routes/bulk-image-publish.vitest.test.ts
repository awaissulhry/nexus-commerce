/**
 * EFX P6 — POST /products/bulk-image-publish body parsing (legacy plain-ids
 * shape AND the new items shape) + per-item activeAxis/marketplace
 * passthrough to publishEbayImagesViaInventory. All services + prisma are
 * mocked; assertions run via Fastify inject, no DB.
 *
 * Run: npx vitest run src/routes/bulk-image-publish.vitest.test.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const productFindMany = vi.fn()
const ebayPublish = vi.fn()
const amazonFeed = vi.fn()
const shopifyPublish = vi.fn()
const audit = vi.fn().mockResolvedValue(undefined)

vi.mock('../db.js', () => ({
  default: {
    product: {
      findMany: (...args: unknown[]) => productFindMany(...args),
    },
  },
}))
vi.mock('../services/images/ebay-inventory-image-publish.service.js', () => ({
  publishEbayImagesViaInventory: (...args: unknown[]) => ebayPublish(...args),
}))
vi.mock('../services/images/amazon-image-feed.service.js', () => ({
  submitAmazonImageFeed: (...args: unknown[]) => amazonFeed(...args),
}))
vi.mock('../services/images/shopify-image-publish.service.js', () => ({
  publishShopifyImages: (...args: unknown[]) => shopifyPublish(...args),
}))
vi.mock('../utils/image-publish-audit.js', () => ({
  recordImagePublishAudit: (...args: unknown[]) => audit(...args),
}))

import bulkImagePublishRoutes from './bulk-image-publish.routes.js'

let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  await app.register(bulkImagePublishRoutes)
  await app.ready()
})
afterAll(async () => {
  await app.close()
})

beforeEach(() => {
  productFindMany.mockReset()
  ebayPublish.mockReset()
  amazonFeed.mockReset()
  shopifyPublish.mockReset()
  audit.mockClear()
  // Default: every requested id exists.
  productFindMany.mockImplementation(async (q: { where: { id: { in: string[] } } }) =>
    q.where.id.in.map((id) => ({ id })))
  ebayPublish.mockResolvedValue({
    success: true,
    message: 'ok',
    pictureCount: 4,
    colorSetCount: 2,
    markets: ['IT'],
    requestedAxis: 'Colore',
    pictureAxis: 'Colore',
    realAxes: ['Colore', 'Taglia'],
    sharedGallery: false,
    warnings: ['curated set clamped to 12'],
  })
})

const post = (payload: unknown) =>
  app.inject({ method: 'POST', url: '/products/bulk-image-publish', payload: payload as object })

describe('legacy plain-ids shape', () => {
  it('publishes each id; no marketplace/axis → legacy fan-out (undefined args)', async () => {
    const res = await post({ productIds: ['p1', 'p2'], channel: 'EBAY' })
    expect(res.statusCode).toBe(200)
    expect(ebayPublish).toHaveBeenCalledTimes(2)
    expect(ebayPublish).toHaveBeenNthCalledWith(1, 'p1', undefined, undefined)
    expect(ebayPublish).toHaveBeenNthCalledWith(2, 'p2', undefined, undefined)
    const body = res.json()
    expect(body.summary).toEqual({ total: 2, ok: 2, failed: 0 })
  })

  it('body-level marketplace is forwarded for EBAY (market-specific publish)', async () => {
    const res = await post({ productIds: ['p1'], channel: 'EBAY', marketplace: 'it' })
    expect(res.statusCode).toBe(200)
    expect(ebayPublish).toHaveBeenCalledWith('p1', 'IT', undefined)
  })

  it('unknown product → per-item failure, loop continues', async () => {
    productFindMany.mockResolvedValueOnce([{ id: 'p2' }])
    const res = await post({ productIds: ['ghost', 'p2'], channel: 'EBAY' })
    const body = res.json()
    expect(body.results).toEqual([
      expect.objectContaining({ productId: 'ghost', ok: false, message: 'Product not found' }),
      expect.objectContaining({ productId: 'p2', ok: true }),
    ])
    expect(ebayPublish).toHaveBeenCalledTimes(1)
  })
})

describe('EFX P6 items shape', () => {
  it('forwards per-item activeAxis + marketplace; body marketplace is the fallback', async () => {
    const res = await post({
      channel: 'EBAY',
      marketplace: 'DE',
      items: [
        { productId: 'p1', activeAxis: 'Colore', marketplace: 'IT' },
        { productId: 'p2', activeAxis: '__shared__' },
        { productId: 'p3' },
      ],
    })
    expect(res.statusCode).toBe(200)
    expect(ebayPublish).toHaveBeenNthCalledWith(1, 'p1', 'IT', 'Colore')
    expect(ebayPublish).toHaveBeenNthCalledWith(2, 'p2', 'DE', '__shared__')
    expect(ebayPublish).toHaveBeenNthCalledWith(3, 'p3', 'DE', undefined)
  })

  it('echoes the P5 resolved-axis fields per eBay result', async () => {
    ebayPublish.mockResolvedValueOnce({
      success: true, message: 'ok', pictureCount: 3, colorSetCount: 0,
      requestedAxis: '__shared__', pictureAxis: null, realAxes: ['Taglia'],
      sharedGallery: true, warnings: [],
    })
    const res = await post({ channel: 'EBAY', items: [{ productId: 'p1', activeAxis: '__shared__', marketplace: 'IT' }] })
    const r = res.json().results[0]
    expect(r).toMatchObject({
      productId: 'p1',
      ok: true,
      pictureCount: 3,
      colorSetCount: 0,
      requestedAxis: '__shared__',
      pictureAxis: null,
      sharedGallery: true,
      realAxes: ['Taglia'],
    })
  })

  it('service failure surfaces per item without tanking the batch', async () => {
    ebayPublish
      .mockRejectedValueOnce(new Error('circuit open'))
      .mockResolvedValueOnce({ success: true, message: 'ok', pictureCount: 1, colorSetCount: 0 })
    const res = await post({ channel: 'EBAY', items: [{ productId: 'p1' }, { productId: 'p2' }] })
    const body = res.json()
    expect(body.results[0]).toMatchObject({ productId: 'p1', ok: false, message: 'circuit open' })
    expect(body.results[1]).toMatchObject({ productId: 'p2', ok: true })
    expect(body.summary).toEqual({ total: 2, ok: 1, failed: 1 })
  })

  it('AMAZON accepts per-item marketplace with no body-level one', async () => {
    amazonFeed.mockResolvedValue({ jobId: 'job-1' })
    const res = await post({ channel: 'AMAZON', items: [{ productId: 'p1', marketplace: 'IT' }] })
    expect(res.statusCode).toBe(200)
    expect(amazonFeed).toHaveBeenCalledWith({ productId: 'p1', marketplace: 'IT' })
  })

  it('AMAZON rejects when any entry resolves to no valid marketplace', async () => {
    const res = await post({ channel: 'AMAZON', items: [{ productId: 'p1', marketplace: 'IT' }, { productId: 'p2' }] })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('INVALID_MARKETPLACE')
  })
})

describe('validation', () => {
  it('empty body → 400 PRODUCT_IDS_REQUIRED (both shapes)', async () => {
    expect((await post({ channel: 'EBAY' })).statusCode).toBe(400)
    expect((await post({ channel: 'EBAY', productIds: [] })).statusCode).toBe(400)
    expect((await post({ channel: 'EBAY', items: [] })).statusCode).toBe(400)
    expect((await post({ channel: 'EBAY', items: [{ activeAxis: 'Colore' }] })).statusCode).toBe(400)
  })

  it('>50 entries → 400 TOO_MANY with the chunking message', async () => {
    const items = Array.from({ length: 51 }, (_, i) => ({ productId: `p${i}` }))
    const res = await post({ channel: 'EBAY', items })
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error).toBe('TOO_MANY')
    expect(body.message).toContain('Max 50')
  })

  it('invalid channel → 400', async () => {
    const res = await post({ productIds: ['p1'], channel: 'ETSY' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('INVALID_CHANNEL')
  })
})
