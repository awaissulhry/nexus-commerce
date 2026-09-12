import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ product: vi.fn(), listing: vi.fn(), asset: vi.fn(), destroy: vi.fn() }))
vi.mock('../../db.js', () => ({ default: { productImage: { count: mocks.product }, listingImage: { count: mocks.listing }, digitalAsset: { count: mocks.asset } } }))
vi.mock('../cloudinary.service.js', () => ({ deleteFromCloudinary: mocks.destroy }))
import { cleanUpUnreferencedMedia } from './media-file-cleanup.service.js'
const file = { publicId: 'gallery/video', url: 'https://cdn.example/video.mp4', mediaType: 'VIDEO' }
beforeEach(() => { for (const mock of Object.values(mocks)) { mock.mockReset(); mock.mockResolvedValue(0) } })
it('retains copied bytes referenced by another product, listing or media library', async () => {
  for (const reference of [mocks.product, mocks.listing, mocks.asset]) {
    reference.mockResolvedValue(1)
    expect(await cleanUpUnreferencedMedia(file)).toBe(false)
    reference.mockResolvedValue(0)
  }
  expect(mocks.destroy).not.toHaveBeenCalled()
})
it('uses the video resource type only after all reference checks pass', async () => {
  await cleanUpUnreferencedMedia(file)
  expect(mocks.destroy).toHaveBeenCalledWith('gallery/video', 'video')
})
