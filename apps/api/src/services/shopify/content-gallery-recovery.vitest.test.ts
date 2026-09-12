import { describe, expect, it, vi } from 'vitest'
import { publishContentImages, resumeContentGallery } from './content-publisher.js'
import { emptyShopifyContent } from '@nexus/shared/shopify-content'
import { advanceMediaOrder } from './information-gateway.js'
vi.mock('./information-gateway.js', () => ({ advanceMediaOrder: vi.fn(), readInformationMedia: vi.fn() }))
const edit = { productId: 'gid://shopify/Product/1', ownerLabel: 'Fixture', value: ['gid://shopify/MediaImage/1'], nextValue: ['gid://shopify/MediaImage/1'] }
describe('Publication media recovery', () => {
  it.each([['VIDEO', 'Video', 'mp4'], ['MODEL_3D', 'Model3d', 'glb'], ['IMAGE', 'MediaImage', 'jpg']] as const)('uploads and checkpoints %s files without treating them as images', async (type, owner, extension) => {
    const content = emptyShopifyContent([]), checkpoint = vi.fn()
    content.assets = [{ id: 'source', type, url: `https://cdn.example/media.${extension}`, alt: 'Accessible description', translations: {} }]
    const id = `gid://shopify/${owner}/10`
    const gql = vi.fn(async (query: string, _variables?: Record<string, unknown>) => query.includes('NexusImageCreate') ? { fileCreate: { files: [{ id, fileStatus: 'READY' }], userErrors: [] } } : { files: { nodes: [] } })
    expect(await publishContentImages(gql, content, checkpoint)).toEqual({ source: id })
    expect(checkpoint).toHaveBeenCalledWith({ mediaIds: { source: id } })
    expect(gql.mock.calls[1][1]).toMatchObject({ files: [expect.objectContaining({ contentType: type })] })
  })
  it('resumes the exact saved job before acknowledging verification', async () => {
    const checkpoint = vi.fn(), state = { submitted: true, jobId: 'gid://shopify/Job/1' }
    vi.mocked(advanceMediaOrder).mockResolvedValueOnce(true)
    await resumeContentGallery(vi.fn(), { edit, state }, edit.productId, checkpoint)
    expect(advanceMediaOrder).toHaveBeenLastCalledWith(expect.any(Function), edit, state, expect.any(Function))
    expect(checkpoint).toHaveBeenCalledWith({ galleryOperation: { edit, state, verified: true } })
  })
  it('keeps an uncertain response unverified instead of submitting a new operation', async () => {
    const checkpoint = vi.fn(), state = { submitted: true }
    vi.mocked(advanceMediaOrder).mockRejectedValueOnce(new Error('Uncertain result'))
    await expect(resumeContentGallery(vi.fn(), { edit, state }, edit.productId, checkpoint)).rejects.toThrow('Uncertain result')
    expect(checkpoint).not.toHaveBeenCalled()
  })
  it('refuses recovery against another destination product', async () => {
    await expect(resumeContentGallery(vi.fn(), { edit }, 'gid://shopify/Product/2', vi.fn())).rejects.toThrow('different Shopify product')
  })
})
