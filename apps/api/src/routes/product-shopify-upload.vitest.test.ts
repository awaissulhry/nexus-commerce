import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const f = vi.hoisted(() => ({
  product: vi.fn(), exact: vi.fn(), update: vi.fn(), create: vi.fn(),
  account: vi.fn(), upload: vi.fn(), attach: vi.fn(), cloud: vi.fn(), configured: vi.fn(), emit: vi.fn(),
}))
vi.mock('../db.js', () => ({ default: { product: { findUnique: f.product }, productImage: {
  findFirst: f.exact, findMany: vi.fn(async () => []), aggregate: vi.fn(async () => ({ _max: { sortOrder: null } })), update: f.update, create: f.create,
} } }))
vi.mock('../services/shopify/media-library.service.js', () => ({
  defaultShopifyMediaAccount: f.account, uploadReadyShopifyAsset: f.upload, attachShopifyImage: f.attach, attachShopifyMedia: f.attach,
  ShopifyMediaError: class extends Error { constructor(message: string, readonly statusCode = 409) { super(message) } },
}))
vi.mock('../services/cloudinary.service.js', () => ({
  isCloudinaryConfigured: f.configured, uploadBufferToCloudinary: f.cloud, buildAutoEnhanceUrl: vi.fn(), buildDerivedUrl: vi.fn(), deleteFromCloudinary: vi.fn(),
}))
vi.mock('../services/images/image-hash.service.js', () => ({
  sha256Buffer: () => 'exact-hash', aHashBuffer: async () => 'visual-hash', dHash256Buffer: async () => 'detail-hash', hammingHex: () => 100,
  DHASH256_NEAR_DUP_THRESHOLD: 26, NEAR_DUP_HAMMING_THRESHOLD: 6,
}))
vi.mock('../services/product-event.service.js', () => ({ productEventService: { emit: f.emit } }))
import routes from './product-images-crud.routes'
import assetsRoutes from './assets.routes'

const image = { id: 'image-1', productId: 'product-1', url: 'https://cdn.shopify.com/files/front.jpg', sourceAssetId: 'asset-1', publicId: null, type: 'ALT' }
const app = Fastify()
beforeEach(async () => {
  vi.clearAllMocks()
  f.product.mockResolvedValue({ id: 'product-1' }); f.exact.mockResolvedValue(null)
  f.account.mockResolvedValue('store-primary'); f.upload.mockResolvedValue({ asset: { id: 'asset-1' } })
  f.attach.mockResolvedValue({ image, reused: false }); f.update.mockImplementation(async ({ data }) => ({ ...image, ...data }))
  f.configured.mockReturnValue(false); f.emit.mockResolvedValue(undefined)
})
beforeAll(async () => {
  await app.register(multipart)
  await app.register(routes, { prefix: '/api' })
  await app.register(assetsRoutes, { prefix: '/api' })
  await app.ready()
})
afterEach(() => { vi.restoreAllMocks() })
afterAll(() => app.close())

function upload(kind: 'images' | 'videos' = 'images') {
  const name = kind === 'images' ? 'front.jpg' : 'demo.mp4', mime = kind === 'images' ? 'image/jpeg' : 'video/mp4'
  return app.inject({ method: 'POST', url: `/api/products/product-1/${kind}`, headers: { 'content-type': 'multipart/form-data; boundary=nexus-test' },
    payload: `--nexus-test\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\nsynthetic bytes\r\n--nexus-test--\r\n` })
}

it.each(['images', 'videos'] as const)('uploads product %s to the primary Shopify store without requiring Cloudinary', async kind => {
  const response = await upload(kind)
  expect(response.statusCode).toBe(201)
  expect(response.json()).toMatchObject({ ...image, contentHash: 'exact-hash' })
  expect(f.upload).toHaveBeenCalledWith('store-primary', Buffer.from('synthetic bytes'), kind === 'images' ? 'front.jpg' : 'demo.mp4')
  expect(f.cloud).not.toHaveBeenCalled(); expect(f.configured).not.toHaveBeenCalled()
  expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'IMAGES_UPDATED' }))
})

it.each(['images', 'videos'] as const)('does not fall back to Cloudinary when a Shopify %s upload fails', async kind => {
  f.upload.mockRejectedValue(new Error('Shopify unavailable'))
  const response = await upload(kind)
  expect(response.statusCode).toBe(502)
  expect(response.json().error).toContain('could not be confirmed')
  expect(f.cloud).not.toHaveBeenCalled(); expect(f.attach).not.toHaveBeenCalled()
})

it('retains the legacy provider when there is no connected Shopify store', async () => {
  f.account.mockResolvedValue(null); f.configured.mockReturnValue(true)
  f.cloud.mockResolvedValue({ url: 'https://res.cloudinary.com/demo/front.jpg', publicId: 'front', width: 800, height: 800, bytes: 1000, format: 'jpg' })
  f.create.mockImplementation(async ({ data }) => ({ id: 'legacy-image', ...data }))
  const response = await upload()
  expect(response.statusCode).toBe(201)
  expect(response.json().url).toContain('res.cloudinary.com')
  expect(f.upload).not.toHaveBeenCalled()
})

it('keeps content deduplication ahead of either upload provider', async () => {
  f.exact.mockResolvedValue(image)
  const response = await upload()
  expect(response.statusCode).toBe(200)
  expect(response.json()).toMatchObject({ id: image.id, reused: 'exact' })
  expect(f.upload).not.toHaveBeenCalled(); expect(f.cloud).not.toHaveBeenCalled()
})

function assetUpload(query = '') {
  return app.inject({ method: 'POST', url: `/api/assets/upload${query}`, headers: { 'content-type': 'multipart/form-data; boundary=asset-test' },
    payload: '--asset-test\r\nContent-Disposition: form-data; name="file"; filename="front.jpg"\r\nContent-Type: image/jpeg\r\n\r\nsynthetic bytes\r\n--asset-test--\r\n' })
}
it('defaults the shared upload endpoint to Shopify and retains its asset response contract', async () => {
  f.upload.mockResolvedValue({ asset: { id: 'asset-1', storageProvider: 'shopify' }, reused: true })
  const response = await assetUpload()
  expect(response.statusCode).toBe(200)
  expect(response.json()).toEqual({ asset: { id: 'asset-1', storageProvider: 'shopify' }, dedup: true })
  expect(f.upload).toHaveBeenCalledWith('store-primary', Buffer.from('synthetic bytes'), 'front.jpg')
  expect(f.configured).not.toHaveBeenCalled()
})
it('uses the explicitly selected Nexus provider without resolving a Shopify default', async () => {
  const response = await assetUpload('?source=nexus')
  expect(response.statusCode).toBe(503)
  expect(f.configured).toHaveBeenCalled()
  expect(f.account).not.toHaveBeenCalled(); expect(f.upload).not.toHaveBeenCalled()
})
it('never sends an unconfirmed shared upload to a different provider', async () => {
  f.upload.mockRejectedValue(new Error('Response lost'))
  expect((await assetUpload()).statusCode).toBe(502)
  expect(f.configured).not.toHaveBeenCalled(); expect(f.cloud).not.toHaveBeenCalled()
})
