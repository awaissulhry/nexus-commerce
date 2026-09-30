/**
 * Step 7, part 2 — the group-A sites that make a Nexus draft take its fields from the one draft rule
 * (`ensureDraftListings`, or `draftListingFields` for an alias row): the add-child copy, the Shopify first save, the
 * listings cascade and the eBay flat-file save's outbound queue. (`createAlias` and catalog-transfer are pinned in
 * listing-alias-account and catalog-transfer-transaction.)
 *
 * On an in-process PostgreSQL (PGlite) with the generated schema and the production row policies. No channel is
 * called and no queue runs (ENABLE_QUEUE_WORKERS is off). Every id is invented.
 *
 * Run: DATABASE_URL=postgresql://nexus@127.0.0.1:1/nexus_unit_test npx vitest run src/services/pim/draft-listing-sites.vitest.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async importOriginal => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { ...await importOriginal<any>(), default: state.db.client, prisma: state.db.client }
})

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { draftListingFields, ensureDraftListings } from './draft-listing.service.js'
import { copySiblingListings } from './variant-listing-copy.service.js'
import { startShopifyFamilyDraft } from '../shopify/content-workspace.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const rowsOf = (productId: string, where: Record<string, unknown> = {}) => scoped(() => prisma.channelListing.findMany({ where: { productId, ...where }, orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }, { aliasKey: 'asc' }] }))
const queued = (channelListingId: string) => scoped(() => prisma.outboundSyncQueue.count({ where: { channelListingId } }))
const listing = (data: Record<string, unknown>) => scoped(() => prisma.channelListing.create({ data: { channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT',
  region: 'IT', channelConnectionId: accounts.amazon, ...data } as never }))
/** The fields every Nexus draft has, whichever site made it. */
const DRAFT = { listingStatus: 'DRAFT', isPublished: false, syncPaused: true, externalListingId: null }

const ids: Record<string, string> = {}
const accounts: Record<string, string> = {}

afterAll(async () => { await state.db?.close() })

beforeAll(async () => {
  await scoped(async () => {
    const market = (channel: string, code: string, isActive = true) => prisma.marketplace.create({ data: { channel, code, name: `${channel} ${code}`,
      currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], isActive } })
    await market('AMAZON', 'IT')
    await market('AMAZON', 'FR', false)
    await market('EBAY', 'UK')
    await market('EBAY', 'IT')
    await market('SHOPIFY', 'GLOBAL')
    const account = async (key: string, channelType: string) => {
      accounts[key] = (await prisma.channelConnection.create({ data: { channelType, accountLabel: key, isActive: true, isPrimary: true,
        externalAccountId: `SELLER-${key}`, authStatus: 'connected', managedBy: 'oauth' } as never })).id
    }
    await account('amazon', 'AMAZON')
    await account('ebay', 'EBAY')
    await account('shopify', 'SHOPIFY')
    const product = async (key: string, parent?: string) => {
      ids[key] = (await prisma.product.create({ data: { sku: `DS-${key}`, name: key, basePrice: 10, ...(parent ? { parentId: ids[parent] } : { isParent: true }) } as never })).id
    }
    for (const family of ['copy', 'shop', 'cascade', 'save']) {
      await product(family)
      for (const variant of ['A', 'B', 'C', 'D']) await product(`${family}${variant}`, family)
    }
  })
}, 60_000)

describe('draftListingFields — the draft rule for an alias row', () => {
  it('an alias draft has exactly the draft fields, with its alias id; eBay UK is region GB', () => {
    expect(draftListingFields({ productId: 'p', channel: 'EBAY', market: 'UK', accountId: 'a', aliasKey: 'alias-1' })).toEqual({ productId: 'p', channel: 'EBAY', marketplace: 'UK',
      channelMarket: 'EBAY_UK', region: 'GB', channelConnectionId: 'a', aliasKey: 'alias-1', aliasId: 'alias-1', ...DRAFT, quantity: null, price: null })
    expect(draftListingFields({ productId: 'p', channel: 'AMAZON', market: 'IT', accountId: 'a' })).toMatchObject({ region: 'IT', aliasKey: '', aliasId: null })
    expect(() => draftListingFields({ productId: 'p', channel: 'EBAY', market: 'UK', accountId: '' })).toThrow('Connect an eBay account')
  })
})

describe('add child → copy from a sibling', () => {
  it('every copy is an inert draft on the sibling\'s coordinate with the copied content; a refused coordinate is skipped; the sibling is untouched', async () => {
    const alias = await scoped(() => prisma.productListingAlias.create({ data: { productId: ids.copy, channel: 'AMAZON', marketplace: 'IT', channelConnectionId: accounts.amazon, label: 'Listing 2' } }))
    const live = await listing({ productId: ids.copyA, listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'ASIN-A', title: 'Jacket', price: 50,
      platformAttributes: { attributes: { item_name: [{ value: 'Jacket' }], color: [{ value: 'Red' }] } } })
    await listing({ productId: ids.copyA, aliasKey: alias.id, aliasId: alias.id, listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'ASIN-A2', title: 'Jacket 2' })
    await listing({ productId: ids.copyA, channel: 'EBAY', marketplace: 'UK', channelMarket: 'EBAY_GB', region: 'GB', channelConnectionId: null, listingStatus: 'ACTIVE', externalListingId: '110000000001' })
    await listing({ productId: ids.copyA, marketplace: 'FR', channelMarket: 'AMAZON_FR', region: 'FR', listingStatus: 'ACTIVE' })

    const skipped = await scoped(() => prisma.$transaction(tx => copySiblingListings(tx, { sourceProductId: ids.copyA, productId: ids.copyD, groups: new Set(['content', 'attributes', 'pricing']) })))
    expect(skipped).toEqual([expect.objectContaining({ channel: 'AMAZON', marketplace: 'FR', reason: expect.stringContaining('not an active market') })])
    const copies = await rowsOf(ids.copyD)
    expect(copies).toHaveLength(3)
    for (const row of copies) expect(row).toMatchObject(DRAFT)
    expect(copies.find(r => r.channel === 'AMAZON' && r.aliasKey === '')).toMatchObject({ channelConnectionId: accounts.amazon, title: 'Jacket', platformAttributes: { attributes: { item_name: [{ value: 'Jacket' }] } } })
    expect(copies.find(r => r.channel === 'AMAZON' && r.aliasKey === '')?.price?.toNumber()).toBe(50)
    expect(copies.find(r => r.aliasKey === alias.id)).toMatchObject({ aliasId: alias.id, channelConnectionId: accounts.amazon, title: 'Jacket 2' })
    // A sibling saved without an account resolves to the channel's primary; eBay UK keeps its GB region.
    expect(copies.find(r => r.channel === 'EBAY')).toMatchObject({ marketplace: 'UK', region: 'GB', channelConnectionId: accounts.ebay })
    // The sibling's live listing is exactly as it was.
    expect((await rowsOf(ids.copyA, { id: live.id }))[0]).toMatchObject({ listingStatus: 'ACTIVE', isPublished: true, syncPaused: false, externalListingId: 'ASIN-A', version: 1 })
  })

  it('never copies the sibling\'s own channel ids or checkpoints: the new variant cannot claim its Shopify variant or eBay offers', async () => {
    const identity = { shopifyProductId: '9001', variantId: '9002', inventoryItemId: '9003', inventoryLocationId: 'gid://shopify/Location/9004', nexusFamilyId: ids.copy,
      shopifyColourProductId: 'colour-black', shopifyColourStockPending: true, shopifyColourRetired: true,
      __offerIds: { EBAY_IT: 'offer-1' }, __lastPublishedAxes: { EBAY_IT: ['Colour'] }, _nexusContentPublish: { productId: 'gid://shopify/Product/9001' }, _nexusSheetMediaSync: { version: 1 } }
    const content = { descriptionThemeId: 'theme-1', _productMediaLocales: { it: ['photo-1'] } }
    const shopify = await listing({ productId: ids.copyB, channel: 'SHOPIFY', marketplace: 'GLOBAL', channelMarket: 'SHOPIFY_GLOBAL', region: 'GLOBAL', channelConnectionId: accounts.shopify,
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: '9001', title: 'Jacket', platformAttributes: { ...identity, ...content, attributes: { material: 'Mesh', color: 'Nero' } } })

    await scoped(() => prisma.$transaction(tx => copySiblingListings(tx, { sourceProductId: ids.copyB, productId: ids.copyC, groups: new Set(['content', 'attributes', 'pricing']) })))
    const [copy] = await rowsOf(ids.copyC, { channel: 'SHOPIFY' })
    expect(copy).toMatchObject({ ...DRAFT, channelConnectionId: accounts.shopify, title: 'Jacket' })
    // Content keys come across; the sibling's axis value does not; none of its ids or checkpoints do.
    expect(copy.platformAttributes).toEqual({ ...content, attributes: { material: 'Mesh' } })
    // The sibling keeps all of them.
    expect((await rowsOf(ids.copyB, { id: shopify.id }))[0].platformAttributes).toMatchObject(identity)
  })
})

describe('Shopify first save', () => {
  it('starts an inert draft of the whole family and returns the parent row', async () => {
    const destination = { productId: ids.shop, familyId: ids.shop, accountId: accounts.shopify, marketplace: 'GLOBAL', aliasKey: '' } as never
    const parent = await scoped(() => prisma.$transaction(tx => startShopifyFamilyDraft(tx, destination, { id: ids.shop, children: [] })))
    expect(parent).toMatchObject({ productId: ids.shop, created: true })
    const rows = await scoped(() => prisma.channelListing.findMany({ where: { channel: 'SHOPIFY', product: { OR: [{ id: ids.shop }, { parentId: ids.shop }] } } }))
    expect(rows).toHaveLength(5)
    for (const row of rows) expect(row).toMatchObject({ ...DRAFT, channelConnectionId: accounts.shopify, marketplace: 'GLOBAL', channelMarket: 'SHOPIFY_GLOBAL', region: 'GLOBAL', aliasKey: '' })
  })
})

describe('listings cascade', () => {
  async function cascade(body: Record<string, unknown>) {
    const { listingsSyndicationRoutes: routes } = await import('../../routes/listings-syndication.routes.js')
    const app = Fastify()
    await app.register(routes, { prefix: '/api' })
    try {
      return await scoped(async () => (await app.inject({ method: 'POST', url: '/api/listings/cascade', payload: body })).json())
    } finally { await app.close() }
  }

  it('a sibling with no listing gets an inert draft and nothing is queued for it or for a still-draft; a live sibling is queued as before', async () => {
    await listing({ productId: ids.cascadeA, listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'ASIN-CA', price: 20, quantity: 5 })
    await scoped(() => prisma.$transaction(tx => ensureDraftListings(tx, { channel: 'AMAZON', market: 'IT', productIds: [ids.cascadeC] })))
    const liveD = await listing({ productId: ids.cascadeD, listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'ASIN-CD', price: 9, quantity: 1 })

    const result = await cascade({ sourceProductId: ids.cascadeA, channel: 'AMAZON', marketplace: 'IT', fields: ['price', 'quantity'] })
    expect(result).toMatchObject({ affected: 3 })

    const [b] = await rowsOf(ids.cascadeB)
    expect(b).toMatchObject({ ...DRAFT, channelConnectionId: accounts.amazon, quantity: 5, followMasterPrice: false })
    expect(b.price?.toNumber()).toBe(20)
    expect(await queued(b.id)).toBe(0)
    const [c] = await rowsOf(ids.cascadeC)
    expect(c).toMatchObject({ ...DRAFT, quantity: 5 })
    expect(await queued(c.id)).toBe(0)
    // The live sibling takes the values and is queued, exactly as before.
    const [d] = await rowsOf(ids.cascadeD)
    expect(d).toMatchObject({ id: liveD.id, listingStatus: 'ACTIVE', isPublished: true, syncPaused: false, quantity: 5 })
    expect(await queued(liveD.id)).toBe(2)
  }, 60_000)
})

describe('eBay flat-file save', () => {
  it('queues no price or quantity update for a still-draft; a live listing is queued as before', async () => {
    const [draft] = await scoped(() => prisma.$transaction(tx => ensureDraftListings(tx, { channel: 'EBAY', market: 'IT', productIds: [ids.saveA] })))
    const live = await listing({ productId: ids.saveB, channel: 'EBAY', marketplace: 'IT', channelMarket: 'EBAY_IT', region: 'IT', channelConnectionId: accounts.ebay,
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: '110000000009', price: 10, quantity: 1 })
    const { default: routes } = await import('../../routes/ebay-flat-file.routes.js')
    const app = Fastify()
    await app.register(routes, { prefix: '/api' })
    try {
      const response = await scoped(async () => app.inject({ method: 'PATCH', url: '/api/ebay/flat-file/rows', payload: { marketplace: 'IT', rows: [
        { sku: 'DS-saveA', _productId: ids.saveA, it_price: 30, it_qty: 3 },
        { sku: 'DS-saveB', _productId: ids.saveB, it_price: 31, it_qty: 4, it_item_id: '110000000009' },
      ] } }))
      expect(response.statusCode).toBe(200)
    } finally { await app.close() }
    const [a] = await rowsOf(ids.saveA, { channel: 'EBAY' })
    expect(a).toMatchObject({ id: draft.id, ...DRAFT, quantity: 3 })
    expect(a.price?.toNumber()).toBe(30)
    expect(await queued(draft.id)).toBe(0)
    const [b] = await rowsOf(ids.saveB, { channel: 'EBAY' })
    expect(b).toMatchObject({ id: live.id, listingStatus: 'ACTIVE', isPublished: true, syncPaused: false, quantity: 4 })
    expect(await queued(live.id)).toBe(2)
  }, 60_000)
})
