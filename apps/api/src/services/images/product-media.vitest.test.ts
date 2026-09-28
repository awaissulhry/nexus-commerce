import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PRODUCT_MEDIA_KEY, type ProductMediaQuery } from '@nexus/shared/product-media'
const mocks = vi.hoisted(() => ({ products: [] as any[], listings: [] as any[], files: [] as any[], conflict: false, updates: [] as any[], destination: vi.fn(), ensure: vi.fn() }))
// Images rebuild P2b — these families are not on the media plan (its own guard is tested in media-plan-switch.vitest.test.ts).
vi.mock('./media-plan-switch.js', async original => ({ ...await original<object>(), isOnMediaPlan: async () => false, mediaPlanProducts: async () => new Set() }))
vi.mock('../../db.js', () => {
  const match = (row: any, where: any) => Object.entries(where).every(([key, value]) => value === undefined || row[key] === value)
  const db = {
    product: { findFirst: vi.fn(async ({ where }: any) => mocks.products.find(row => match(row, where)) ?? null), updateMany: vi.fn(async ({ where, data }: any) => {
      const row = mocks.products.find(row => match(row, where)); if (!row || mocks.conflict) return { count: 0 }
      mocks.updates.push({ where, data }); Object.assign(row, data, { version: row.version + 1 }); return { count: 1 }
    }) },
    channelListing: { create: vi.fn(async ({ data }: any) => { const row = { id: 'new-listing', version: 1, ...data }; mocks.listings.push(row); mocks.updates.push({ data }); return row }), findFirst: vi.fn(async ({ where }: any) => mocks.listings.find(row => match(row, where)) ?? null), updateMany: vi.fn(async ({ where, data }: any) => {
      const row = mocks.listings.find(row => match(row, where)); if (!row || mocks.conflict) return { count: 0 }
      mocks.updates.push({ where, data }); Object.assign(row, data, { version: row.version + 1 }); return { count: 1 }
    }) },
    productImage: { create: vi.fn(async ({ data }: any) => { const row = { id: `copy-${mocks.files.length}`, updatedAt: '1', ...data }; mocks.files.push(row); return row }), findMany: vi.fn(async ({ where }: any) => mocks.files.filter(file => where.productId.in.includes(file.productId))) },
    $transaction: vi.fn(async (fn: any) => fn(db)),
  }
  return { default: db }
})
vi.mock('../pim/workspace-destination.js', async importOriginal => ({ ...await importOriginal<object>(), resolveWorkspaceDestination: mocks.destination }))
// The draft creator's own rules run on PostgreSQL (draft-listing.service tests). Here it stands in for the one creator:
// it starts an inert draft row for the product (the family is the product alone in this fixture).
vi.mock('../pim/draft-listing.service.js', async importOriginal => ({ ...await importOriginal<object>(), ensureDraftListings: mocks.ensure }))
// The database is a stand-in here, so the live "media changed" event is too; media-popup-save.vitest.test.ts proves it
// (the real bus needs a business profile, which every real save has).
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: vi.fn() }))
import { readProductMedia, saveProductMedia, copyProductMedia } from './product-media.service.js'
const context = { productId: 'p1', scope: 'MASTER', market: 'GLOBAL', locale: 'it' }
const collection = { version: 1 as const, items: [{ assetId: 'video1', alt: 'Video italiano', captions: [{ language: 'it', label: 'Italiano', url: 'https://cdn.example/it.vtt' }] }] }
beforeEach(() => {
  mocks.products = [{ id: 'p1', parentId: null, deletedAt: null, sku: 'SKU1', name: 'Jacket', version: 1, localizedContent: { it: { title: 'Giacca' }, de: { title: 'Jacke' } } }]
  mocks.listings = ['a', 'b'].map(account => ({ id: `listing-${account}`, productId: 'p1', version: 1, channel: 'ETSY', channelConnectionId: account, marketplace: 'GLOBAL', platformAttributes: { title: account } }))
  mocks.files = [{ id: 'image1', productId: 'p1', mediaType: 'IMAGE', url: 'https://cdn.example/image.jpg', alt: 'Front', sortOrder: 0, updatedAt: '1' }, { id: 'video1', productId: 'p1', mediaType: 'VIDEO', url: 'https://cdn.example/movie.mp4', posterUrl: null, alt: '', sortOrder: 1, updatedAt: '1' }]
  mocks.conflict = false; mocks.updates = []; mocks.destination.mockReset(); mocks.destination.mockResolvedValue({ listing: { productId: 'p1' } })
  mocks.ensure.mockReset().mockImplementation(async (_tx: unknown, input: any) => input.productIds.map((productId: string) => {
    const row = { id: `draft-${productId}-${input.market}`, productId, version: 1, channel: input.channel, marketplace: input.market, channelConnectionId: input.accountId,
      aliasKey: input.aliasKey, listingStatus: 'DRAFT', isPublished: false, syncPaused: true, platformAttributes: null }
    mocks.listings.push(row)
    return { id: row.id, productId, version: 1, created: true }
  }))
})
describe('Product media persistence', () => {
  it('persists localized mixed media and preserves all source files and other languages', async () => {
    const before = await readProductMedia(context)
    const after = await saveProductMedia(context, { expectedRevision: before.revision, collection })
    expect(after.collection).toEqual(collection); expect(after.hasOverride).toBe(true)
    expect(after.revision).not.toBe(before.revision)
    expect(mocks.products[0].localizedContent).toMatchObject({ it: { title: 'Giacca', [PRODUCT_MEDIA_KEY]: collection }, de: { title: 'Jacke' } })
    expect(mocks.files).toHaveLength(2)
  })
  it('isolates two stores and languages on the same channel and marketplace', async () => {
    const a = { ...context, scope: 'ETSY', accountId: 'a', listingId: 'listing-a' } satisfies ProductMediaQuery & { productId: string }
    const before = await readProductMedia(a)
    await saveProductMedia(a, { expectedRevision: before.revision, collection })
    expect((await readProductMedia({ ...a, locale: 'de' })).hasOverride).toBe(false)
    expect((await readProductMedia({ ...a, accountId: 'b', listingId: 'listing-b' })).hasOverride).toBe(false)
    expect(mocks.listings[1].platformAttributes).toEqual({ title: 'b' })
    expect(mocks.updates[0].where).toMatchObject({ id: 'listing-a', channelConnectionId: 'a', marketplace: 'GLOBAL', version: 1 })
  })
  it('rejects a listing from another store or product before mutating', async () => {
    await expect(readProductMedia({ ...context, scope: 'ETSY', accountId: 'b', listingId: 'listing-a' })).rejects.toThrow(/destination/)
    mocks.destination.mockResolvedValue({ listing: { productId: 'other-product' } })
    await expect(readProductMedia({ ...context, scope: 'ETSY', accountId: 'a', listingId: 'listing-a' })).rejects.toThrow(/this product/)
    expect(mocks.updates).toHaveLength(0)
  })
  it('refuses stale revisions, concurrent updates and unknown asset references', async () => {
    const before = await readProductMedia(context)
    mocks.products[0].version++
    await expect(saveProductMedia(context, { expectedRevision: before.revision, collection })).rejects.toThrow(/changed/)
    const current = await readProductMedia(context)
    await expect(saveProductMedia(context, { expectedRevision: current.revision, collection: { version: 1, items: [{ assetId: 'foreign' }] } })).rejects.toThrow(/library/)
    mocks.conflict = true
    await expect(saveProductMedia(context, { expectedRevision: current.revision, collection })).rejects.toThrow(/changed/)
    expect(mocks.updates).toHaveLength(0)
  })
  it('supports explicit empty galleries and restoring inheritance', async () => {
    const before = await readProductMedia(context)
    const empty = await saveProductMedia(context, { expectedRevision: before.revision, collection: { version: 1, items: [] } })
    expect(empty.collection.items).toHaveLength(0)
    const inherited = await saveProductMedia(context, { expectedRevision: empty.revision, collection: null })
    expect(inherited.collection.items).toHaveLength(2); expect(inherited.hasOverride).toBe(false)
  })
  it('starts the listing draft only on save for an explicit unlisted coordinate, through the one creator', async () => {
    mocks.destination.mockResolvedValue({ listing: null })
    const unlisted = { ...context, scope: 'ETSY', market: 'DE', accountId: 'a', aliasKey: '' }
    const before = await readProductMedia(unlisted)
    expect(mocks.listings).toHaveLength(2)
    expect(mocks.ensure).not.toHaveBeenCalled()
    const saved = await saveProductMedia(unlisted, { expectedRevision: before.revision, collection })
    expect(saved.hasOverride).toBe(true)
    expect(mocks.ensure).toHaveBeenCalledWith(expect.anything(), { channel: 'ETSY', market: 'DE', accountId: 'a', aliasKey: '', productIds: ['p1'], family: true })
    // The gallery lands on the started draft, guarded on its fresh version.
    expect(mocks.updates.at(-1).where).toEqual({ id: 'draft-p1-DE', version: 1 })
    expect(mocks.listings[2]).toMatchObject({ productId: 'p1', marketplace: 'DE', channelConnectionId: 'a', aliasKey: '', listingStatus: 'DRAFT', isPublished: false, syncPaused: true, version: 2 })
    expect(mocks.products[0].localizedContent.it[PRODUCT_MEDIA_KEY]).toBeUndefined()
  })

  it('no account: the draft creator\'s sentence reaches the operator, and nothing is written', async () => {
    mocks.destination.mockResolvedValue({ listing: null })
    const { DraftListingError } = await import('../pim/draft-listing.service.js')
    mocks.ensure.mockRejectedValue(new DraftListingError('NO_ACTIVE_ACCOUNT', 'Connect an Etsy account before listing on DE.'))
    const unlisted = { ...context, scope: 'ETSY', market: 'DE', aliasKey: '' }
    const before = await readProductMedia(unlisted)
    await expect(saveProductMedia(unlisted, { expectedRevision: before.revision, collection })).rejects.toMatchObject({ statusCode: 409, message: 'Connect an Etsy account before listing on DE.' })
    expect(mocks.updates).toHaveLength(0)
  })
})


describe('Media cell copying', () => {
  it('uses the same revision for equivalent route and clipboard key ordering', async () => {
    const direct = await readProductMedia(context)
    const route = await readProductMedia({scope:'MASTER',market:'GLOBAL',locale:'it',productId:'p1'})
    expect(route.revision).toBe(direct.revision)
  })
  async function setup() {
    mocks.products.push({ id: 'p2', parentId: null, deletedAt: null, sku: 'SKU2', name: 'Second jacket', version: 1, localizedContent: { fr: { title: 'Veste' } } })
    const before = await readProductMedia(context)
    const source = await saveProductMedia(context, { expectedRevision: before.revision, collection: { version: 1, items: [{...collection.items[0], transcript: 'Italian transcript'}, {assetId: 'image1'}] } })
    const targetInput = { ...context, productId: 'p2' }, target = await readProductMedia(targetInput)
    return { source, target, targetInput, body: { expectedRevision: target.revision, source: { productId: 'p1', context: {scope:'MASTER', market:'GLOBAL', locale:'it'}, expectedRevision: source.revision } } }
  }
  it('copies mixed media, order and localized metadata without deleting files or replacing other-language fallbacks', async () => {
    const { targetInput, body } = await setup()
    const after = await copyProductMedia(targetInput, body)
    expect(after.collection.items).toHaveLength(2)
    expect(after.collection.items[0]).toMatchObject({alt:'Video italiano', transcript:'Italian transcript', captions:collection.items[0].captions})
    expect(after.assets.map(asset => asset.type)).toEqual(['VIDEO','IMAGE'])
    expect(mocks.files.filter(file => file.productId === 'p1')).toHaveLength(2)
    expect((await readProductMedia({...targetInput,locale:'fr'})).collection.items).toEqual([])
    expect(mocks.products[1].localizedContent.fr.title).toBe('Veste')
    const again = await copyProductMedia(targetInput, {...body,expectedRevision:after.revision})
    expect(again.collection).toEqual(after.collection)
    expect(mocks.files).toHaveLength(4)
  })
  it('rejects stale source and target observations before creating references', async () => {
    const {targetInput,body} = await setup()
    mocks.products[0].version++
    await expect(copyProductMedia(targetInput,body)).rejects.toThrow(/changed/)
    expect(mocks.files).toHaveLength(2)
    const source = await readProductMedia(context)
    mocks.products[1].version++
    await expect(copyProductMedia(targetInput,{...body,source:{...body.source,expectedRevision:source.revision}})).rejects.toThrow(/changed/)
    expect(mocks.files).toHaveLength(2)
  })
  it('copies into exactly one store and marketplace draft and retains other stores', async () => {
    const {source} = await setup()
    mocks.destination.mockImplementation(async (input:any) => ({listing:input.listingId ? {productId:input.productId} : null}))
    const targetInput = {...context, productId:'p2', scope:'ETSY',market:'DE',accountId:'a',aliasKey:''}
    const target = await readProductMedia(targetInput)
    await copyProductMedia(targetInput,{expectedRevision:target.revision,source:{productId:'p1',context:{scope:'MASTER',market:'GLOBAL',locale:'it'},expectedRevision:source.revision}})
    expect(mocks.listings.at(-1)).toMatchObject({productId:'p2',channel:'ETSY',marketplace:'DE',channelConnectionId:'a',isPublished:false})
    expect((await readProductMedia({...targetInput,accountId:'b'})).collection.items).toEqual([])
    expect((await readProductMedia({...targetInput,locale:'fr'})).collection.items).toEqual([])
  })
})
