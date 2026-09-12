import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse, validate, buildSchema } from 'graphql'

const fixture = vi.hoisted(() => {
  const assets = new Map<string, any>(), images = new Map<string, any>(), usages = new Map<string, any>()
  const db: any = {
    digitalAsset: {
      findUnique: vi.fn(async ({ where }: any) => assets.get(where.id) ?? null),
      findUniqueOrThrow: vi.fn(async ({ where }: any) => assets.get(where.id)),
      upsert: vi.fn(async ({ where, create, update }: any) => { const next = assets.has(where.id) ? { ...assets.get(where.id), ...update } : create; assets.set(where.id, next); return next }),
    },
    productImage: {
      findFirst: vi.fn(async ({ where }: any) => [...images.values()].find(row => row.productId === where.productId && where.OR.some((clause: any) => Object.entries(clause).every(([key, value]) => row[key] === value))) ?? null),
      aggregate: vi.fn(async () => ({ _max: { sortOrder: 3 } })),
      upsert: vi.fn(async ({ where, create, update }: any) => { images.set(where.id, images.has(where.id) ? { ...images.get(where.id), ...update } : create); return images.get(where.id) }),
      update: vi.fn(async ({ where, data }: any) => { images.set(where.id, { ...images.get(where.id), ...data }); return images.get(where.id) }),
    },
    assetUsage: { upsert: vi.fn(async (args: any) => { usages.set(JSON.stringify(args.where), args.create); return args.create }) },
  }
  db.$transaction = async (run: any) => run(db)
  return { db, assets, images, usages, list: vi.fn(), resolve: vi.fn(), graphql: vi.fn(), admin: vi.fn(), mode: vi.fn() }
})
vi.mock('../../db.js', () => ({ default: fixture.db }))
vi.mock('../connection-resolver.service.js', () => ({ listActiveConnections: fixture.list, resolveConnection: fixture.resolve }))
vi.mock('../shopify-publish-gate.service.js', () => ({ getShopifyPublishMode: fixture.mode }))
vi.mock('./admin-client.js', async original => ({ ...await original<object>(), shopifyAdmin: fixture.admin }))

import { withWorkspace } from '@nexus/database/workspace-context'
import { mediaSources, defaultShopifyMediaAccount, listShopifyFiles, normalizeShopifyFile, referenceShopifyFile, attachShopifyImage, uploadShopifyFile, SHOPIFY_FILE_FIELDS } from './media-library.service'

const store = (id = 'store-a', extra = {}) => ({ id, channelType: 'SHOPIFY', isActive: true, isPrimary: false, region: 'demo.myshopify.com', accountLabel: 'Demo', authStatus: 'connected', grantedScopes: ['read_files', 'write_files'], ...extra })
const remote = (extra = {}): any => ({ __typename: 'MediaImage', id: 'gid://shopify/MediaImage/1', alt: 'Front view', fileStatus: 'READY', createdAt: '2026-09-08T10:00:00Z', updatedAt: '2026-09-08T10:00:00Z', fileErrors: [], preview: { image: { url: 'https://cdn.shopify.com/s/files/1/front.jpg?width=640' } }, image: { url: 'https://cdn.shopify.com/s/files/1/front.jpg', width: 1600, height: 2000 }, mimeType: 'image/jpeg', imageOriginal: { fileSize: 5000 }, ...extra })
const workspace = (id: string, run: () => Promise<any>) => withWorkspace({ workspaceId: id, actorUserId: 'editor', membershipId: null, roleKeys: [] }, run)

beforeEach(() => {
  vi.clearAllMocks(); fixture.assets.clear(); fixture.images.clear(); fixture.usages.clear()
  fixture.list.mockResolvedValue([store()]); fixture.resolve.mockResolvedValue(store()); fixture.mode.mockReturnValue('live')
  fixture.admin.mockResolvedValue({ graphql: fixture.graphql, domain: 'demo.myshopify.com' })
  fixture.graphql.mockReset(); fixture.graphql.mockImplementation(async (query: string) => query.includes('NexusMediaFile') ? { node: remote() } : { files: { nodes: [remote()], pageInfo: { hasNextPage: false, endCursor: 'last' } } })
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('Shopify media source ownership', () => {
  it('defaults to the only Shopify store and retains Nexus when none is connected', async () => {
    expect(await defaultShopifyMediaAccount()).toBe('store-a')
    fixture.list.mockResolvedValue([])
    expect(await mediaSources()).toEqual({ stores: [], defaultSource: 'nexus' })
    expect(await defaultShopifyMediaAccount()).toBeNull()
  })
  it('uses a unique primary and refuses ambiguous or duplicate primaries', async () => {
    fixture.list.mockResolvedValue([store(), store('store-b')])
    expect((await mediaSources()).defaultSource).toBeNull()
    await expect(defaultShopifyMediaAccount()).rejects.toThrow('Choose a Shopify store')
    fixture.list.mockResolvedValue([store(), store('store-b', { isPrimary: true })])
    expect((await mediaSources()).defaultSource).toBe('store-b')
    fixture.list.mockResolvedValue([store('a', { isPrimary: true }), store('b', { isPrimary: true })])
    expect((await mediaSources()).defaultSource).toBeNull()
  })
  it('does not silently fall back when the primary needs reauthorization', async () => {
    fixture.list.mockResolvedValue([store('store-a', { authStatus: 'needs_reauth' })])
    expect(await mediaSources()).toMatchObject({ defaultSource: 'store-a', stores: [{ readIssue: expect.stringContaining('Reconnect') }] })
  })
  it.each([{ channelType: 'EBAY' }, { grantedScopes: ['read_products'] }, { authStatus: 'needs_reauth' }, { region: 'not-a-domain/path' }])('refuses an unavailable source before requesting files: %j', async extra => {
    fixture.resolve.mockResolvedValue(store('store-a', extra))
    await expect(listShopifyFiles({ accountId: 'store-a' })).rejects.toThrow()
    expect(fixture.admin).not.toHaveBeenCalled()
  })
  it('honors workspace rejection and never reaches another account’s credentials', async () => {
    fixture.resolve.mockRejectedValue(new Error('Account outside workspace'))
    await expect(listShopifyFiles({ accountId: 'foreign' })).rejects.toThrow('outside workspace')
    expect(fixture.resolve).toHaveBeenCalledWith({ accountId: 'foreign' })
    expect(fixture.admin).not.toHaveBeenCalled()
  })
  it('allows read-only file scopes while explaining disabled uploads', async () => {
    fixture.list.mockResolvedValue([store('store-a', { grantedScopes: ['read_files'] })])
    expect((await mediaSources()).stores[0]).toMatchObject({ readIssue: null, uploadIssue: expect.stringContaining('permission') })
  })
})

describe('Shopify file browsing', () => {
  it('paginates the selected account with filename filters kept inside a quoted value', async () => {
    fixture.graphql.mockResolvedValue({ files: { nodes: [remote()], pageInfo: { hasNextPage: true, endCursor: 'next' } } })
    const page = await listShopifyFiles({ accountId: 'store-b', type: 'image', search: 'front" OR media_type:VIDEO', after: 'before' })
    expect(fixture.resolve).toHaveBeenCalledWith({ accountId: 'store-b' })
    expect(fixture.graphql.mock.calls[0][1]).toEqual({ after: 'before', query: 'media_type:IMAGE AND filename:"front\\" OR media_type\\:VIDEO"' })
    expect(page).toMatchObject({ accountId: 'store-b', nextCursor: 'next', items: [{ accountId: 'store-b', width: 1600, sizeBytes: 5000 }] })
  })
  it('rejects malformed filters and stalled cursors', async () => {
    await expect(listShopifyFiles({ accountId: '', type: 'wat' })).rejects.toThrow('valid file filters')
    expect(fixture.admin).not.toHaveBeenCalled()
    fixture.graphql.mockResolvedValue({ files: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'same' } } })
    await expect(listShopifyFiles({ accountId: 'a', after: 'same' })).rejects.toThrow('pagination')
  })
  it('distinguishes a genuinely empty library from an API failure', async () => {
    fixture.graphql.mockResolvedValue({ files: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } })
    expect((await listShopifyFiles({ accountId: 'a' })).items).toEqual([])
    fixture.graphql.mockRejectedValue(new Error('Shopify unavailable'))
    await expect(listShopifyFiles({ accountId: 'a' })).rejects.toThrow('unavailable')
  })
  it('uses durable image URLs, plays MP4 renditions, and converts milliseconds once', () => {
    const image = normalizeShopifyFile(remote(), 'a')
    expect(image.url).toBe('https://cdn.shopify.com/s/files/1/front.jpg')
    const video = normalizeShopifyFile(remote({ __typename: 'Video', id: 'gid://shopify/Video/2', filename: 'walk.mp4', image: undefined, mimeType: undefined, imageOriginal: undefined, duration: 14500, videoSources: [
      { url: 'https://cdn.shopify.com/videos/walk.m3u8', mimeType: 'application/x-mpegURL' },
      { url: 'https://cdn.shopify.com/videos/walk.mp4', mimeType: 'video/mp4', width: 1920, height: 1080 },
    ] }), 'a')
    expect(video).toMatchObject({ type: 'video', durationSeconds: 14.5, mimeType: 'video/mp4', width: 1920, url: 'https://cdn.shopify.com/videos/walk.mp4' })
  })
  it('lists documents and models without inventing thumbnails or sizes', () => {
    const base = { image: undefined, mimeType: undefined, imageOriginal: undefined, preview: null }
    expect(normalizeShopifyFile(remote({ ...base, __typename: 'GenericFile', url: 'https://cdn.shopify.com/files/manual.pdf', mimeType: 'application/pdf', originalFileSize: 200 }), 'a')).toMatchObject({ type: 'document', label: 'manual.pdf', previewUrl: null, sizeBytes: 200 })
    expect(normalizeShopifyFile(remote({ ...base, __typename: 'Model3d', modelSources: [{ url: 'https://cdn.shopify.com/files/model.glb', mimeType: 'model/gltf-binary' }] }), 'a')).toMatchObject({ type: 'model3d', previewUrl: null, sizeBytes: null })
  })
  it.each(['UPLOADED', 'PROCESSING', 'FAILED'])('does not offer a usable URL for %s files', status => {
    expect(normalizeShopifyFile(remote({ fileStatus: status }), 'a')).toMatchObject({ status, url: null })
  })
  it('rejects unsafe delivery URLs', () => {
    expect(normalizeShopifyFile(remote({ image: { url: 'javascript:alert(1)' }, preview: null }), 'a').url).toBeNull()
  })
  it('keeps abstract File query fragments compatible across nullable source fields', () => {
    // The schema excerpt preserves Shopify’s differing original-source nullability.
    const schema = buildSchema(`scalar DateTime scalar URL
      type Query { node(id:ID!):File }
      interface File { id:ID! alt:String fileStatus:String! createdAt:DateTime! updatedAt:DateTime! fileErrors:[FileError!]! preview:Preview }
      type FileError { message:String! } input Transform { maxWidth:Int } type Image { url(transform:Transform):URL! width:Int height:Int } type Preview { image:Image }
      type ImageSource { fileSize:Int } type VideoSource { fileSize:Int! url:URL! mimeType:String! width:Int! height:Int! } type ModelSource { url:URL! mimeType:String! }
      type MediaImage implements File { id:ID! alt:String fileStatus:String! createdAt:DateTime! updatedAt:DateTime! fileErrors:[FileError!]! preview:Preview mimeType:String image:Image originalSource:ImageSource }
      type Video implements File { id:ID! alt:String fileStatus:String! createdAt:DateTime! updatedAt:DateTime! fileErrors:[FileError!]! preview:Preview filename:String! duration:Int sources:[VideoSource!]! originalSource:VideoSource }
      type GenericFile implements File { id:ID! alt:String fileStatus:String! createdAt:DateTime! updatedAt:DateTime! fileErrors:[FileError!]! preview:Preview url:URL mimeType:String originalFileSize:Int }
      type Model3d implements File { id:ID! alt:String fileStatus:String! createdAt:DateTime! updatedAt:DateTime! fileErrors:[FileError!]! preview:Preview filename:String! sources:[ModelSource!]! }
    `)
    expect(validate(schema, parse(`query { node(id:"1") { ${SHOPIFY_FILE_FIELDS} } }`))).toEqual([])
  })
})

describe('Shopify file reuse', () => {
  it('keeps references separate across stores and workspaces without storing Cloudinary IDs', async () => {
    const first = await workspace('business-a', () => referenceShopifyFile('a', remote().id))
    const repeat = await workspace('business-a', () => referenceShopifyFile('a', remote().id))
    const otherStore = await workspace('business-a', () => referenceShopifyFile('b', remote().id))
    const otherBusiness = await workspace('business-b', () => referenceShopifyFile('a', remote().id))
    expect(repeat).toEqual(first)
    expect(new Set([first.assetId, otherStore.assetId, otherBusiness.assetId]).size).toBe(3)
    expect(fixture.assets.get(first.assetId)).toMatchObject({ storageProvider: 'shopify', storageId: remote().id, metadata: { shopifyAccountId: 'a' } })
  })
  it('refuses deleted or processing files without creating references', async () => {
    fixture.graphql.mockResolvedValue({ node: null })
    await expect(referenceShopifyFile('a', remote().id)).rejects.toThrow('no longer available')
    fixture.graphql.mockResolvedValue({ node: remote({ fileStatus: 'PROCESSING' }) })
    await expect(referenceShopifyFile('a', remote().id)).rejects.toThrow('not ready')
    expect(fixture.assets.size).toBe(0)
  })
  it('attaches the same image only once even when two imports overlap', async () => {
    await workspace('business-a', async () => {
      const reference = await referenceShopifyFile('a', remote().id)
      const asset = fixture.assets.get(reference.assetId)
      const results = await Promise.all([attachShopifyImage('product', asset, 'ALT'), attachShopifyImage('product', asset, 'ALT')])
      expect(results[0].image.id).toBe(results[1].image.id)
      expect(fixture.images.size).toBe(1); expect(fixture.usages.size).toBe(1)
      expect(results[0].image).toMatchObject({ publicId: null, sourceAssetId: reference.assetId, sortOrder: 4 })
      expect((await attachShopifyImage('product', asset, 'ALT')).reused).toBe(true)
    })
  })
  it('refreshes changed Shopify delivery metadata on reuse while preserving product edits', async () => {
    const reference = await referenceShopifyFile('a', remote().id)
    const asset = fixture.assets.get(reference.assetId)
    const first = await attachShopifyImage('product', asset, 'MAIN', 'Product-specific description')
    fixture.graphql.mockResolvedValue({ node: remote({ image: { url: 'https://cdn.shopify.com/s/files/1/front.jpg?v=2', width: 2000, height: 2400 } }) })
    const reused = await attachShopifyImage('product', asset, 'ALT')
    expect(reused.image).toMatchObject({ id: first.image.id, type: 'MAIN', alt: 'Product-specific description', url: 'https://cdn.shopify.com/s/files/1/front.jpg?v=2', width: 2000, sortOrder: first.image.sortOrder })
    expect(fixture.images.size).toBe(1)
  })
})

describe('Shopify uploads', () => {
  it('blocks read-only and gated uploads before staging bytes', async () => {
    fixture.resolve.mockResolvedValue(store('a', { grantedScopes: ['read_files'] }))
    await expect(uploadShopifyFile('a', Buffer.from('image'), 'front.jpg')).rejects.toThrow('permission')
    expect(fixture.graphql).not.toHaveBeenCalled()
    fixture.resolve.mockResolvedValue(store()); fixture.mode.mockReturnValue('dry-run')
    await expect(uploadShopifyFile('a', Buffer.from('image'), 'front.jpg')).rejects.toThrow('publish settings')
  })
  it.each([['private.html', 5], ['image.jpg', 0], ['image.jpg', 21 * 1024 * 1024], ['video.mp4', 201 * 1024 * 1024]])('rejects %s with %i bytes before any Shopify calls', async (name, size) => {
    await expect(uploadShopifyFile('a', Buffer.alloc(size), name)).rejects.toThrow()
    expect(fixture.admin).not.toHaveBeenCalled()
  })
  it('reconciles repeated uploads before staging and never overwrites existing files', async () => {
    const result = await uploadShopifyFile('a', Buffer.from('image'), 'front.jpg')
    expect(result.reused).toBe(true)
    expect(fixture.graphql).toHaveBeenCalledTimes(1)
  })
  it('stages bytes without Shopify credentials, registers once and returns processing honestly', async () => {
    fixture.graphql.mockImplementation(async (query: string) => query.includes('NexusUploadedFile') ? { files: { nodes: [] } }
      : query.includes('NexusStageMedia') ? { stagedUploadsCreate: { userErrors: [], stagedTargets: [{ url: 'https://storage.googleapis.com/shopify/upload', resourceUrl: 'https://cdn.shopify.com/staged/file', parameters: [{ name: 'key', value: 'upload-key' }] }] } }
      : { fileCreate: { userErrors: [], files: [remote({ fileStatus: 'PROCESSING', image: null })] } })
    const fetcher = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal('fetch', fetcher)
    const result = await uploadShopifyFile('a', Buffer.from('image'), 'front.jpg')
    expect(result.file).toMatchObject({ status: 'PROCESSING', url: null })
    expect(fetcher.mock.calls[0][1].headers).toBeUndefined()
    expect(fetcher.mock.calls[0][1].body.get('key')).toBe('upload-key')
    const create = fixture.graphql.mock.calls.find(([query]) => query.includes('NexusCreateMedia'))![1]
    expect(create.files[0]).toMatchObject({ originalSource: 'https://cdn.shopify.com/staged/file', duplicateResolutionMode: 'RAISE_ERROR', contentType: 'IMAGE' })
  })
  it('recovers a lost registration response with a read instead of a second mutation', async () => {
    let registered = false
    fixture.graphql.mockImplementation(async (query: string) => {
      if (query.includes('NexusUploadedFile')) return { files: { nodes: registered ? [remote()] : [] } }
      if (query.includes('NexusStageMedia')) return { stagedUploadsCreate: { userErrors: [], stagedTargets: [{ url: 'https://storage.googleapis.com/shopify/upload', resourceUrl: 'https://cdn.shopify.com/staged/file', parameters: [] }] } }
      registered = true
      throw new Error('Response lost after commit')
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    expect(await uploadShopifyFile('a', Buffer.from('image'), 'front.jpg')).toMatchObject({ reused: true, file: { id: remote().id } })
    expect(fixture.graphql.mock.calls.filter(([query]) => query.includes('NexusCreateMedia'))).toHaveLength(1)
  })
})
