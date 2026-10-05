import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AMAZON_ALIAS_PHOTOS } from '@nexus/shared/product-media'

/**
 * Owner 2026-10-05 — the product sheet manages every listing alias, photos included, and an alias is named by its ALIAS ID.
 * (1) Amazon keeps one photo set per product: Product media on an Amazon alias shows the main listing's list, read-only, and
 * a save or a copy onto it is refused with the reason. (2) An older address that sends the alias id as `listingId` reads
 * and saves that alias's listing row (the variant's own one on a variant), never the raw id. Fake ids only.
 */
const mocks = vi.hoisted(() => ({ products: [] as any[], listings: [] as any[], files: [] as any[], updates: [] as any[], destination: vi.fn() }))
vi.mock('./media-plan-switch.js', async original => ({ ...await original<object>(), isOnMediaPlan: async () => false, mediaPlanProducts: async () => new Set() }))
vi.mock('../../db.js', () => {
  const match = (row: any, where: any) => Object.entries(where).every(([key, value]) => value === undefined || row[key] === value)
  const db = {
    product: { findFirst: vi.fn(async ({ where }: any) => mocks.products.find(row => match(row, where)) ?? null), updateMany: vi.fn(async ({ where, data }: any) => {
      const row = mocks.products.find(row => match(row, where)); if (!row) return { count: 0 }
      mocks.updates.push({ where, data }); Object.assign(row, data, { version: row.version + 1 }); return { count: 1 }
    }) },
    channelListing: { findFirst: vi.fn(async ({ where }: any) => mocks.listings.find(row => match(row, where)) ?? null), updateMany: vi.fn(async ({ where, data }: any) => {
      const row = mocks.listings.find(row => match(row, where)); if (!row) return { count: 0 }
      mocks.updates.push({ where, data }); Object.assign(row, data, { version: row.version + 1 }); return { count: 1 }
    }) },
    productImage: { create: vi.fn(async ({ data }: any) => { const row = { id: `copy-${mocks.files.length}`, updatedAt: '1', ...data }; mocks.files.push(row); return row }),
      findMany: vi.fn(async ({ where }: any) => mocks.files.filter(file => where.productId.in.includes(file.productId))) },
    $transaction: vi.fn(async (fn: any) => fn(db)),
  }
  return { default: db }
})
vi.mock('../pim/workspace-destination.js', async importOriginal => ({ ...await importOriginal<object>(), resolveWorkspaceDestination: mocks.destination }))
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: vi.fn() }))
import { readProductMedia, saveProductMedia, copyProductMedia } from './product-media.service.js'

const list = (...ids: string[]) => ({ version: 1 as const, items: ids.map(assetId => ({ assetId })) })
const media = (...ids: string[]) => ({ it: { _productMedia: list(...ids) } })
const listing = (id: string, productId: string, channel: string, aliasKey: string, platformAttributes: unknown, externalListingId: string | null = null) =>
  ({ id, productId, version: 1, channel, marketplace: 'IT', channelConnectionId: 'acct', aliasKey, platformAttributes, externalListingId })
const amazon = (extra: Record<string, unknown> = {}) => ({ productId: 'root', scope: 'AMAZON', market: 'IT', locale: 'it', accountId: 'acct', ...extra })
beforeEach(() => {
  mocks.products = [
    { id: 'root', parentId: null, deletedAt: null, sku: 'ROOT', name: 'Jacket', version: 1, localizedContent: {} },
    { id: 'child', parentId: 'root', deletedAt: null, sku: 'ROOT-M', name: 'Jacket M', version: 1, localizedContent: {} },
  ]
  mocks.files = ['img-main', 'img-alias', 'img-other'].map((id, sortOrder) => ({ id, productId: 'root', mediaType: 'IMAGE', url: `https://cdn.test/${id}.jpg`, alt: '', sortOrder, updatedAt: '1' }))
  mocks.listings = [
    listing('l-main', 'root', 'AMAZON', '', { _productMediaLocales: media('img-main') }, 'B0TESTMAIN'),
    // An older per-alias save (before 2026-10-05): kept, never shown or sent. No ASIN yet: the Main listing's product page.
    listing('l-alias', 'root', 'AMAZON', 'alias-1', { _productMediaLocales: media('img-alias'), other: 'kept' }),
    // An adopted listing of another product page (its own ASIN): its own photos, as before.
    listing('l-own', 'root', 'AMAZON', 'alias-3', { _productMediaLocales: media('img-other') }, 'B0TESTOTHER'),
    // A variation of alias-4 not on Amazon yet: its alias root row decides.
    listing('m-kid', 'child', 'AMAZON', '', { _productMediaLocales: media('img-main') }, 'B0TESTMKID'),
    listing('a-root', 'root', 'AMAZON', 'alias-4', {}, 'B0TESTAROOT'),
    listing('a-kid', 'child', 'AMAZON', 'alias-4', { _productMediaLocales: media('img-alias') }),
    listing('e-main', 'root', 'EBAY', '', {}),
    listing('e-alias', 'root', 'EBAY', 'alias-2', { _productMediaLocales: media('img-alias') }),
    listing('e-alias-child', 'child', 'EBAY', 'alias-2', { _productMediaLocales: media('img-other') }),
  ]
  mocks.updates = []
  mocks.destination.mockReset().mockImplementation(async (input: any) => {
    // The resolver's legacy link: an alias id names the FAMILY ROOT's listing of that alias.
    const row = mocks.listings.find(l => l.id === input.listingId) ?? mocks.listings.find(l => l.productId === 'root' && l.channel === input.channel && l.aliasKey === input.listingId)
    return { accountId: 'acct', aliasKey: row?.aliasKey ?? input.aliasKey ?? null, listing: row ? { id: row.id, productId: row.productId, aliasKey: row.aliasKey, version: row.version } : null }
  })
})

describe('an Amazon alias shows the main listing\'s photos, read-only (Owner 2026-10-05)', () => {
  it('GET on the alias: the main listing\'s list and the reason; the main listing reads as before', async () => {
    const alias = await readProductMedia(amazon({ listingId: 'l-alias' }))
    expect(alias.collection).toEqual(list('img-main'))
    expect(alias.readOnly).toBe(AMAZON_ALIAS_PHOTOS)
    const byAliasKey = await readProductMedia(amazon({ aliasKey: 'alias-1' }))
    expect(byAliasKey.collection).toEqual(list('img-main'))
    expect(byAliasKey.readOnly).toBe(AMAZON_ALIAS_PHOTOS)
    const main = await readProductMedia(amazon({ listingId: 'l-main' }))
    expect(main.collection).toEqual(list('img-main'))
    expect(main.readOnly).toBeUndefined()
  })

  it('a save onto the alias is refused with the reason (422); nothing is written', async () => {
    const before = await readProductMedia(amazon({ listingId: 'l-alias' }))
    await expect(saveProductMedia(amazon({ listingId: 'l-alias' }), { expectedRevision: before.revision, collection: list('img-other') }))
      .rejects.toMatchObject({ statusCode: 422, message: AMAZON_ALIAS_PHOTOS })
    expect(mocks.updates).toEqual([])
  })

  it('a copy onto the alias is refused with the reason (422); no file is created; a copy FROM the alias copies the main\'s list', async () => {
    const source = await readProductMedia(amazon({ listingId: 'e-alias', scope: 'EBAY' }))
    const target = await readProductMedia(amazon({ listingId: 'l-alias' }))
    const files = mocks.files.length
    await expect(copyProductMedia(amazon({ listingId: 'l-alias' }), { expectedRevision: target.revision,
      source: { productId: 'root', context: { scope: 'EBAY', market: 'IT', locale: 'it', accountId: 'acct', listingId: 'e-alias' }, expectedRevision: source.revision } }))
      .rejects.toMatchObject({ statusCode: 422, message: AMAZON_ALIAS_PHOTOS })
    expect(mocks.files).toHaveLength(files)
    expect(mocks.updates).toEqual([])
    const from = await readProductMedia(amazon({ listingId: 'l-alias' })), to = await readProductMedia(amazon({ listingId: 'e-main', scope: 'EBAY' }))
    const copied = await copyProductMedia(amazon({ listingId: 'e-main', scope: 'EBAY' }), { expectedRevision: to.revision,
      source: { productId: 'root', context: { scope: 'AMAZON', market: 'IT', locale: 'it', accountId: 'acct', listingId: 'l-alias' }, expectedRevision: from.revision } })
    expect(copied.collection.items.map(item => item.assetId)).toEqual(['img-main'])
  })

  it('an alias on the Main listing\'s ASIN follows it; one on its own ASIN keeps, and saves, its own list', async () => {
    mocks.listings.find(l => l.id === 'l-alias').externalListingId = 'B0TESTMAIN'
    expect(await readProductMedia(amazon({ listingId: 'l-alias' }))).toMatchObject({ collection: list('img-main'), readOnly: AMAZON_ALIAS_PHOTOS })
    const own = await readProductMedia(amazon({ listingId: 'l-own' }))
    expect(own.collection).toEqual(list('img-other'))
    expect(own.readOnly).toBeUndefined()
    await saveProductMedia(amazon({ listingId: 'l-own' }), { expectedRevision: own.revision, collection: list('img-alias') })
    expect(mocks.updates[0].where).toMatchObject({ id: 'l-own' })
  })

  it('a variation not on Amazon yet follows its alias root row: its own list on another page, the Main listing\'s on the Main page', async () => {
    const kid = amazon({ productId: 'child', listingId: 'a-kid' })
    const own = await readProductMedia(kid)
    expect(own.collection).toEqual(list('img-alias'))
    expect(own.readOnly).toBeUndefined()
    mocks.listings.find(l => l.id === 'a-root').externalListingId = 'B0TESTMAIN'
    expect(await readProductMedia(kid)).toMatchObject({ collection: list('img-main'), readOnly: AMAZON_ALIAS_PHOTOS })
    mocks.listings.find(l => l.id === 'a-root').externalListingId = null
    expect(await readProductMedia(kid)).toMatchObject({ collection: list('img-main'), readOnly: AMAZON_ALIAS_PHOTOS })
  })

  it('a reset on the alias clears its own older list (every language), and it still shows the Main listing\'s', async () => {
    mocks.listings.find(l => l.id === 'l-alias').platformAttributes._productMediaLocales.de = { _productMedia: list('img-other') }
    const before = await readProductMedia(amazon({ listingId: 'l-alias' }))
    const after = await saveProductMedia(amazon({ listingId: 'l-alias' }), { expectedRevision: before.revision, collection: null })
    expect(mocks.listings.find(l => l.id === 'l-alias').platformAttributes).toEqual({ other: 'kept' })
    expect(after).toMatchObject({ collection: list('img-main'), readOnly: AMAZON_ALIAS_PHOTOS })
    // Nothing left to clear: a second reset writes nothing.
    await saveProductMedia(amazon({ listingId: 'l-alias' }), { expectedRevision: after.revision, collection: null })
    expect(mocks.updates).toHaveLength(1)
  })

  it('NEGATIVE CONTROL: an eBay alias keeps and saves its own list', async () => {
    const alias = await readProductMedia(amazon({ scope: 'EBAY', listingId: 'e-alias' }))
    expect(alias.collection).toEqual(list('img-alias'))
    expect(alias.readOnly).toBeUndefined()
    await saveProductMedia(amazon({ scope: 'EBAY', listingId: 'e-alias' }), { expectedRevision: alias.revision, collection: list('img-other') })
    expect(mocks.updates[0].where).toMatchObject({ id: 'e-alias' })
  })
})

describe('an older address that names the alias by its id in listingId (Owner 2026-10-05)', () => {
  it('the family root: reads and saves the root\'s listing of that alias, never the raw id', async () => {
    const read = await readProductMedia(amazon({ scope: 'EBAY', listingId: 'alias-2' }))
    expect(read.collection).toEqual(list('img-alias'))
    expect(read.context.listingId).toBe('e-alias')
    await saveProductMedia(amazon({ scope: 'EBAY', listingId: 'alias-2' }), { expectedRevision: read.revision, collection: list('img-main') })
    expect(mocks.updates[0].where).toMatchObject({ id: 'e-alias', productId: 'root' })
  })

  it('a variant: its OWN listing of that alias (the resolver links the id to the root\'s listing)', async () => {
    const read = await readProductMedia(amazon({ productId: 'child', scope: 'EBAY', listingId: 'alias-2' }))
    expect(read.collection).toEqual(list('img-other'))
    expect(read.context.listingId).toBe('e-alias-child')
    await saveProductMedia(amazon({ productId: 'child', scope: 'EBAY', listingId: 'alias-2' }), { expectedRevision: read.revision, collection: list('img-main') })
    expect(mocks.updates[0].where).toMatchObject({ id: 'e-alias-child', productId: 'child' })
  })

  it('NEGATIVE CONTROL: an id that names neither a listing nor an alias of this product is still refused', async () => {
    await expect(readProductMedia(amazon({ productId: 'child', scope: 'EBAY', listingId: 'e-main' }))).rejects.toMatchObject({ statusCode: 422 })
  })
})
