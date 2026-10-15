/**
 * A photo that already is a file of this Shopify store is sent as that file, never uploaded again (no duplicate files on
 * the store); anything else takes today's copy path.
 */
import { describe, expect, it, vi } from 'vitest'
import { parse } from 'graphql'
vi.mock('../../db.js', () => ({ default: {} }))
import { shopifyStoreFiles } from './store-files.js'
import { publishContentImages } from './content-publisher.js'
import { emptyShopifyContent, type ShopifyContent } from '@nexus/shared/shopify-content'

const STORED = 'gid://shopify/MediaImage/55'
const asset = (over: Partial<ShopifyContent['assets'][number]> = {}): ShopifyContent['assets'][number] => ({ id: 'photo', url: 'https://cdn.shopify.com/s/files/1/a.jpg', type: 'IMAGE', alt: '', translations: {}, ...over })

function store(nodes: Record<string, { alt: string | null; fileStatus: string }>) {
  const calls: string[] = []
  const gql = vi.fn(async (query: string, variables: any = {}): Promise<any> => {
    parse(query)
    const name = query.match(/(?:query|mutation)\s+(\w+)/)![1]
    calls.push(name)
    if (name === 'NexusStoreFile') return { node: nodes[variables.id] ? { id: variables.id, ...nodes[variables.id] } : null }
    if (name === 'NexusImage') return { files: { nodes: [] } }
    if (name === 'NexusImageCreate') return { fileCreate: { files: [{ id: 'gid://shopify/MediaImage/900', fileStatus: 'READY' }], userErrors: [] } }
    throw new Error(`Unexpected ${name}`)
  })
  return { gql, calls }
}
const send = (gql: any, assets: ShopifyContent['assets'], storeFiles?: Record<string, string>) =>
  publishContentImages(gql, { ...emptyShopifyContent([]), assets }, async () => {}, undefined, storeFiles)

describe('shopifyStoreFiles', () => {
  it('names only photos whose source file is a media file of this very store', async () => {
    const db = {
      productImage: { findMany: vi.fn(async () => [{ id: 'a', sourceAssetId: 'dam-a' }, { id: 'b', sourceAssetId: 'dam-b' }, { id: 'c', sourceAssetId: 'dam-c' }]) },
      digitalAsset: { findMany: vi.fn(async () => [
        { id: 'dam-a', storageId: STORED, metadata: { shopifyAccountId: 'store-a' } },
        { id: 'dam-b', storageId: 'gid://shopify/MediaImage/56', metadata: { shopifyAccountId: 'store-b' } },
        { id: 'dam-c', storageId: 'gid://shopify/GenericFile/57', metadata: { shopifyAccountId: 'store-a' } },
      ]) },
    } as any
    expect(await shopifyStoreFiles(db, 'store-a', ['a', 'b', 'c', 'cloudinary'])).toEqual({ a: STORED })
    expect(db.digitalAsset.findMany.mock.calls[0][0].where.storageProvider).toBe('shopify')
    expect(await shopifyStoreFiles(db, 'store-a', [])).toEqual({})
  })
})

describe('publishContentImages', () => {
  it('reuses this store\'s file: no search, no upload, the same file id', async () => {
    const { gql, calls } = store({ [STORED]: { alt: null, fileStatus: 'READY' } })
    expect(await send(gql, [asset()], { photo: STORED })).toEqual({ photo: STORED })
    expect(calls).toEqual(['NexusStoreFile'])
  })
  it('a photo with no store file (Cloudinary) is uploaded exactly as before', async () => {
    const { gql, calls } = store({})
    expect(await send(gql, [asset({ url: 'https://res.cloudinary.com/x/image/upload/a.jpg' })])).toEqual({ photo: 'gid://shopify/MediaImage/900' })
    expect(calls).toEqual(['NexusImage', 'NexusImageCreate'])
  })
  it('copies instead when reuse would change a shared file or the file is unusable', async () => {
    for (const [nodes, over] of [
      [{ [STORED]: { alt: 'Store alt', fileStatus: 'READY' } }, {}], // another alt text
      [{ [STORED]: { alt: '', fileStatus: 'READY' } }, { translations: { it: 'Giacca' } }], // an alt translation to write
      [{ [STORED]: { alt: '', fileStatus: 'FAILED' } }, {}], // the file failed in Shopify
      [{}, {}], // the file is gone
    ] as const) {
      const { gql, calls } = store(nodes as any)
      expect(await send(gql, [asset(over as any)], { photo: STORED })).toEqual({ photo: 'gid://shopify/MediaImage/900' })
      expect(calls).toContain('NexusImageCreate')
    }
  })
  it('never reuses a file of another media type', async () => {
    const { gql, calls } = store({ [STORED]: { alt: '', fileStatus: 'READY' } })
    await send(gql, [asset({ type: 'VIDEO' })], { photo: STORED }).catch(() => undefined)
    expect(calls).not.toContain('NexusStoreFile')
  })
})
