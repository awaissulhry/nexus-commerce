/**
 * AE.3c — copying a shared product's images into the follower business, on a real disposable
 * PostgreSQL with the generated policies, profiles ON.
 *
 * Mocked: the network (fetch), Cloudinary's upload and the Shopify media library — the two storage
 * providers are one production account each (plan §16.5). Real: the image rows, the content hash, the
 * placement rules and the refusals.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
// db.ts exports contextualDatabase(prisma); the mock keeps that wrapper.
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: Record<string, unknown> | null = null
  return {
    default: new Proxy({} as Record<string, unknown>, {
      get: (_t, property) => (wrapped ??= contextualDatabase(database.client as never) as unknown as Record<string, unknown>)[property as string],
    }),
  }
})
vi.mock('../../lib/queue.js', () => {
  const queue = { add: async () => ({}), addBulk: async () => [], getJobCounts: async () => ({}), close: async () => {} }
  return {
    resolveRedisTarget: () => ({ kind: 'disabled' }), getRedisRuntimeStatus: () => ({ status: 'disabled' }), redis: { connection: null },
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: () => {} }, channelSyncQueueEvents: { on: () => {} },
    addJobSafely: async () => undefined, resetEnqueueCircuitForTests: () => {}, initializeQueue: async () => {}, closeQueue: async () => {}, getQueueStats: async () => ({}),
  }
})
const storage = vi.hoisted(() => ({
  cloudinaryConfigured: true,
  uploads: [] as Array<{ folder: string; bytes: number }>,
  shopify: { account: null as string | null, refusal: null as string | null, uploads: [] as string[] },
}))
vi.mock('../cloudinary.service.js', () => ({
  isCloudinaryConfigured: () => storage.cloudinaryConfigured,
  uploadBufferToCloudinary: async (buffer: Buffer, options: { folder: string }) => {
    storage.uploads.push({ folder: options.folder, bytes: buffer.length })
    const n = storage.uploads.length
    return { url: `https://res.cloudinary.com/follower/image/upload/v1/${options.folder}/copy-${n}.png`, publicId: `${options.folder}/copy-${n}`, width: 1, height: 1, format: 'png', bytes: buffer.length }
  },
}))
vi.mock('../shopify/media-library.service.js', async () => {
  const { ShopifyMediaError } = await vi.importActual<typeof import('../shopify/media-library.service.js')>('../shopify/media-library.service.js')
  return {
    ShopifyMediaError,
    defaultShopifyMediaAccount: async () => {
      if (storage.shopify.refusal) throw new ShopifyMediaError(storage.shopify.refusal)
      return storage.shopify.account
    },
    uploadReadyShopifyAsset: async (_account: string, _buffer: Buffer, name: string) => {
      storage.shopify.uploads.push(name)
      return { asset: { id: `asset-${storage.shopify.uploads.length}`, storageId: 'gid://shopify/MediaImage/1', metadata: { shopifyAccountId: 'acct' } }, reused: false }
    },
    // The real attach writes a ProductImage row with no publicId; so does this stand-in.
    attachShopifyImage: async (productId: string, asset: { id: string }, type: string, alt: string | null) => {
      const prisma = (await import('../../db.js')).default
      const image = await prisma.productImage.create({ data: { productId, url: `https://cdn.shopify.com/s/files/follower/${asset.id}.png`, publicId: null, sourceAssetId: asset.id, type, alt, sortOrder: 50 } })
      return { ok: true, image, reused: false }
    },
  }
})

const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const B = 'ws_b_ae3_media'

// A valid 1×1 PNG; each URL gets its own trailing bytes, so each file has its own content hash.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const bytesFor = (url: string) => Buffer.concat([PNG, Buffer.from(url)])
const sha256 = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex')

describe('AE.3c — images arrive in the follower business', () => {
  let media: typeof import('./copy-media.service.js')
  const fetched: Array<{ url: string; redirect: unknown }> = []
  let respond: (url: string) => Response = (url) => new Response(bytesFor(url), { status: 200, headers: { 'content-type': 'image/png' } })

  const inB = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: B, actorUserId: null, membershipId: null, roleKeys: [] }, work)
  const sql = async (text: string, params: unknown[] = []) => (await database.db.query(text, params)).rows as Array<Record<string, unknown>>
  const newProduct = async (sku: string) => {
    const id = randomUUID()
    await sql(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "updatedAt") VALUES ($1,$2,$3,$3,1,CURRENT_TIMESTAMP)`, [id, B, sku])
    return id
  }
  const rows = (productId: string) => sql(`SELECT url, "publicId", type, "isPrimary", "contentHash", "sortOrder" FROM "ProductImage" WHERE "productId" = $1 ORDER BY "sortOrder", url`, [productId])
  const image = (over: Partial<import('./copy-media.service.js').PlannedImage> & { url: string }) => ({
    id: randomUUID(), alt: null, type: 'ALT', isPrimary: false, sortOrder: 0, width: 1, height: 1, mimeType: 'image/png', fileSize: 100, ...over,
  })
  const MAIN_FILE = 'https://res.cloudinary.com/owner/image/upload/v1/product-images/a/main.png'
  const SIDE_ADDRESS = 'https://m.media-amazon.com/images/I/side.jpg'

  beforeAll(async () => {
    database = await formulaDatabase()
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    media = await import('./copy-media.service.js')
    await sql(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1,'Business B','active','ae3c',$1,CURRENT_TIMESTAMP)`, [B])
  }, 180_000)

  beforeEach(() => {
    storage.cloudinaryConfigured = true
    storage.uploads.length = 0
    storage.shopify = { account: null, refusal: null, uploads: [] }
    fetched.length = 0
    respond = (url) => new Response(bytesFor(url), { status: 200, headers: { 'content-type': 'image/png' } })
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      fetched.push({ url: String(input), redirect: init?.redirect })
      return respond(String(input))
    })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  }, 30_000)

  it('downloads only from the two storage hosts, over https', () => {
    expect(media.imageOrigin(MAIN_FILE)).toBe('file')
    expect(media.imageOrigin('https://cdn.shopify.com/s/files/1/0/main.png')).toBe('file')
    expect(media.imageOrigin(SIDE_ADDRESS)).toBe('address')
    expect(media.imageOrigin('http://res.cloudinary.com/owner/image/upload/main.png')).toBe('address')
    expect(media.imageOrigin('https://res.cloudinary.com.attacker.example/main.png')).toBe('address')
    expect(media.imageOrigin('https://169.254.169.254/latest/meta-data')).toBe('address')
    expect(media.imageOrigin('not a url')).toBe('address')
  })

  it('CONTROL — a stored file is copied into Cloudinary with its own content hash; an outside address is carried, never fetched', async () => {
    const productId = await newProduct('MEDIA-1')
    const main = image({ url: MAIN_FILE, type: 'MAIN', isPrimary: true, sortOrder: 0 })
    const side = image({ url: SIDE_ADDRESS, type: 'ALT', sortOrder: 1 })
    const result = await inB(() => media.copyImages(productId, [main, side]))
    const { pairs, ...counts } = result
    expect(counts).toEqual({ copied: 1, reused: 0, addressed: 1, failed: [], held: 0 })
    // AE.4 — each source image names the follower image that now shows it.
    const idByUrl = new Map((await sql(`SELECT id, url FROM "ProductImage" WHERE "productId" = $1`, [productId])).map((row) => [row.url, row.id]))
    expect(pairs).toEqual([
      { source: main.id, target: idByUrl.get(`https://res.cloudinary.com/follower/image/upload/v1/product-images/${productId}/copy-1.png`) },
      { source: side.id, target: idByUrl.get(SIDE_ADDRESS) },
    ])
    expect(fetched).toEqual([{ url: MAIN_FILE, redirect: 'error' }])
    expect(storage.uploads).toEqual([{ folder: `product-images/${productId}`, bytes: bytesFor(MAIN_FILE).length }])
    expect(await rows(productId)).toEqual([
      { url: `https://res.cloudinary.com/follower/image/upload/v1/product-images/${productId}/copy-1.png`, publicId: `product-images/${productId}/copy-1`, type: 'MAIN', isPrimary: true, contentHash: sha256(bytesFor(MAIN_FILE)), sortOrder: 0 },
      { url: SIDE_ADDRESS, publicId: null, type: 'ALT', isPrimary: false, contentHash: null, sortOrder: 1 },
    ])
    // The follower's file is its own: nothing in the follower points at the owner's file.
    expect((await rows(productId)).some((row) => row.url === MAIN_FILE)).toBe(false)

    // Again: the same bytes and the same address are recognised; nothing is uploaded or added.
    const again = await inB(() => media.copyImages(productId, [main, side]))
    expect(again).toEqual({ copied: 0, reused: 2, addressed: 0, failed: [], held: 0, pairs }) // a reused image names the same row
    expect(storage.uploads).toHaveLength(1)
    expect(await rows(productId)).toHaveLength(2)
  })

  it('never takes over what the follower has: a copied MAIN becomes ALT, and the hero flag stays with the follower image', async () => {
    const productId = await newProduct('MEDIA-2')
    await sql(`INSERT INTO "ProductImage" (id, "workspaceId", "productId", url, type, "isPrimary", "sortOrder", "updatedAt") VALUES ($1,$2,$3,'https://res.cloudinary.com/follower/own.png','MAIN',true,0,CURRENT_TIMESTAMP)`, [randomUUID(), B, productId])
    const result = await inB(() => media.copyImages(productId, [image({ url: MAIN_FILE, type: 'MAIN', isPrimary: true })]))
    expect(result.copied).toBe(1)
    expect((await rows(productId)).map((row) => [row.url, row.type, row.isPrimary, row.sortOrder])).toEqual([
      ['https://res.cloudinary.com/follower/own.png', 'MAIN', true, 0],
      [`https://res.cloudinary.com/follower/image/upload/v1/product-images/${productId}/copy-1.png`, 'ALT', false, 1],
    ])
  })

  it('refuses what is not an image, too large, or not there — and uploads nothing for them', async () => {
    const productId = await newProduct('MEDIA-3')
    const cases: Array<[string, (url: string) => Response, RegExp]> = [
      ['https://res.cloudinary.com/owner/a.png', () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }), /does not hold an image/],
      ['https://res.cloudinary.com/owner/b.png', () => new Response('x', { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(21 * 1024 * 1024) } }), /larger than 20 MB/],
      // No declared length: the body itself is counted while it is read.
      ['https://res.cloudinary.com/owner/c.png', () => new Response(new ReadableStream({ start(c) { for (let i = 0; i < 21; i++) c.enqueue(new Uint8Array(1024 * 1024)); c.close() } }), { status: 200, headers: { 'content-type': 'image/png' } }), /larger than 20 MB/],
      ['https://res.cloudinary.com/owner/d.png', () => new Response('gone', { status: 404, headers: { 'content-type': 'image/png' } }), /no longer exists at its address/],
    ]
    for (const [url, response, message] of cases) {
      respond = response
      const result = await inB(() => media.copyImages(productId, [image({ url })]))
      expect(result.failed, url).toHaveLength(1)
      expect(result.failed[0], url).toMatch(message)
    }
    expect(storage.uploads).toEqual([])
    expect(await rows(productId)).toEqual([])
  })

  it('a business with a Shopify store gets the file in Shopify, not Cloudinary; an unclear store choice is refused, never switched', async () => {
    const productId = await newProduct('MEDIA-4')
    storage.shopify.account = 'acct'
    const shopifyImage = image({ url: 'https://res.cloudinary.com/owner/image/upload/v1/p/transform/main', type: 'MAIN', isPrimary: true })
    const result = await inB(() => media.copyImages(productId, [shopifyImage]))
    expect(result).toMatchObject({ copied: 1, reused: 0, addressed: 0, failed: [] })
    expect(result.pairs).toEqual([{ source: shopifyImage.id, target: (await sql(`SELECT id FROM "ProductImage" WHERE "productId" = $1`, [productId]))[0].id }])
    expect(storage.uploads).toEqual([])
    expect(storage.shopify.uploads).toEqual(['main.png']) // a transformation URL has no extension: the file gets one
    const [row] = await rows(productId)
    expect(row).toMatchObject({ type: 'MAIN', isPrimary: true, contentHash: sha256(bytesFor('https://res.cloudinary.com/owner/image/upload/v1/p/transform/main')) })

    const other = await newProduct('MEDIA-5')
    storage.shopify = { account: null, refusal: 'Choose a Shopify store in the media library to upload there, or mark one store as primary in Connections.', uploads: [] }
    const refused = await inB(() => media.copyImages(other, [image({ url: MAIN_FILE })]))
    expect(refused.failed).toEqual(['image 1: Choose a Shopify store in the media library to upload there, or mark one store as primary in Connections.'])
    expect(storage.uploads).toEqual([])
    expect(await rows(other)).toEqual([])
  })

  it('a business with no image storage is told so, and an outside address still arrives', async () => {
    const productId = await newProduct('MEDIA-6')
    storage.cloudinaryConfigured = false
    const result = await inB(() => media.copyImages(productId, [image({ url: MAIN_FILE, sortOrder: 0 }), image({ url: SIDE_ADDRESS, sortOrder: 1 })]))
    expect(result.failed).toEqual(['image 1: This business has no image storage. Connect a Shopify store or configure Cloudinary.'])
    expect(result.addressed).toBe(1)
    expect((await rows(productId)).map((row) => row.url)).toEqual([SIDE_ADDRESS])
  })

  it('a family on the media plan gets no photo written here: the photos wait for the Media page, and the result says how many', async () => {
    const parent = await newProduct('MEDIA-7')
    const child = randomUUID()
    await sql(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "parentId", "updatedAt") VALUES ($1,$2,'MEDIA-7-S','MEDIA-7-S',1,$3,CURRENT_TIMESTAMP)`, [child, B, parent])
    await sql(`INSERT INTO "ProductMediaPlan" (id, "workspaceId", "productId", layer, plan, "updatedAt") VALUES ($1,$2,$3,'SHARED','{}'::jsonb,CURRENT_TIMESTAMP)`, [randomUUID(), B, parent])
    // The variation's family is on the plan through its parent.
    const result = await inB(() => media.copyImages(child, [image({ url: MAIN_FILE, sortOrder: 0 }), image({ url: SIDE_ADDRESS, sortOrder: 1 })]))
    expect(result).toEqual({ copied: 0, reused: 0, addressed: 0, failed: [], held: 2, pairs: [] })
    expect(await rows(child)).toEqual([])
    expect(fetched).toEqual([])
    expect(storage.uploads).toEqual([])
  })
})
