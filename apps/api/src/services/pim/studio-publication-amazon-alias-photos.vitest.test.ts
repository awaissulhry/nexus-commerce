import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Owner 2026-10-05 — Amazon keeps ONE photo set per product: images belong to the ASIN in every market, whatever seller SKU
 * sends them (Listings API FAQ). An Amazon listing alias (another SKU of the same product page) therefore never sends photos
 * different from the main listing's: a NEW alias row is created with the main listing's photos; an alias offer Amazon
 * already holds sends no image attribute. An older per-alias Product media list is kept on its row and never sent. The real
 * builder on PGlite (`readPublicationFacts` → `prepareAmazonPublication`), built and never sent. Every id is invented.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.stubGlobal('fetch', vi.fn(async (url: unknown) => { throw new Error(`network refused in a gate: ${String(url)}`) }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { readPublicationFacts } from './studio-publication-plan.js'
import { prepareAmazonPublication } from './studio-publication-amazon.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let account = '', warehouse = ''
const photo = (name: string) => `https://img.example/${name}.jpg`
const productMedia = (...ids: string[]) => ({ und: { _productMedia: { version: 1, items: ids.map(assetId => ({ assetId })) } } })

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Amazon IT', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'TEST_MARKET_IT' } as never })
  await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: 'IT', productType: 'COAT', schemaVersion: 'v1', expiresAt: new Date(Date.now() + 86_400_000), schemaDefinition: { properties: {} } } })
  account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'alias-photos', isActive: true, externalAccountId: 'TEST-SELLER',
    authStatus: 'connected', managedBy: 'oauth', region: 'EU' } as never })).id
  warehouse = (await prisma.stockLocation.create({ data: { code: 'ALIAS-PHOTOS-WH', name: 'Alias photos warehouse', type: 'WAREHOUSE' } })).id
}), 60_000)
afterAll(async () => { await state.db?.close() })

/**
 * A merchant product with two photos; its main Amazon listing saved "main" in Product media and its alias ALT1 an older
 * per-alias list "alias". `alias.live`: the alias offer is on Amazon already (else a new row).
 */
async function family(sku: string, alias: { live: boolean }, main: { live?: boolean; none?: boolean } = {}) {
  const product = await prisma.product.create({ data: { sku, name: sku, basePrice: 10, productType: 'COAT', fulfillmentMethod: 'FBM', totalStock: 7 } as never })
  await prisma.stockLevel.create({ data: { productId: product.id, locationId: warehouse, quantity: 7, available: 7 } })
  const mainPhoto = await prisma.productImage.create({ data: { productId: product.id, url: photo(`${sku}-main`), type: 'MAIN', sortOrder: 0 } as never })
  const aliasPhoto = await prisma.productImage.create({ data: { productId: product.id, url: photo(`${sku}-alias`), type: 'ALT', sortOrder: 1 } as never })
  const row = (extra: Record<string, unknown>, live: boolean) => prisma.channelListing.create({ data: { productId: product.id, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT',
    region: 'EU', channelConnectionId: account, fulfillmentMethod: 'FBM', followMasterPrice: true, followMasterQuantity: true, price: 10,
    ...(live ? { externalListingId: `B0${sku.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)}`, listingStatus: 'ACTIVE', isPublished: true, syncPaused: false }
      : { externalListingId: null, listingStatus: 'DRAFT', isPublished: false, syncPaused: true }), ...extra } as never })
  const mainRow = main.none ? null : await row({ platformAttributes: { _productMediaLocales: productMedia(mainPhoto.id) } }, !!main.live)
  const aliasId = (await prisma.productListingAlias.create({ data: { productId: product.id, channel: 'AMAZON', marketplace: 'IT', channelConnectionId: account, label: 'ALT1', position: 1 } as never })).id
  const aliasRow = await row({ aliasId, aliasKey: aliasId, platformAttributes: { sellerSku: `${sku}-ALT1`, _productMediaLocales: productMedia(aliasPhoto.id) } }, alias.live)
  return { productId: product.id, main: mainRow?.id ?? '', alias: aliasRow.id }
}
const publish = (productId: string, listingId: string) => scoped(async () =>
  prepareAmazonPublication(await readPublicationFacts(productId, { channel: 'AMAZON', marketplace: 'IT', accountId: account, listingId })))
const photosOf = (message: unknown) => [...JSON.stringify(message).matchAll(/https:\/\/img\.example\/[^"]+\.jpg/g)].map(m => m[0])

describe('an Amazon alias never sends photos different from the main listing\'s (Owner 2026-10-05)', () => {
  it('a NEW alias row is created with the main listing\'s photos, never its own older list', async () => {
    const ids = await scoped(() => family('alias-new', { live: false }))
    const message = (await publish(ids.productId, ids.alias)).feed.messages[0]
    expect(message.sku).toBe('alias-new-ALT1')
    expect(photosOf(message)).toEqual([photo('alias-new-main')])
  })

  it('a NEW alias row with no main listing here: the Shared photos (the product\'s), still never its own older list', async () => {
    const ids = await scoped(() => family('alias-alone', { live: false }, { none: true }))
    expect(photosOf((await publish(ids.productId, ids.alias)).feed.messages[0])).toEqual([photo('alias-alone-main'), photo('alias-alone-alias')])
  })

  it('an alias offer Amazon already holds sends no image attribute (the product page shows the main listing\'s photos)', async () => {
    const ids = await scoped(() => family('alias-live', { live: true }, { live: true }))
    const message = (await publish(ids.productId, ids.alias)).feed.messages[0]
    expect(message.sku).toBe('alias-live-ALT1')
    expect(photosOf(message)).toEqual([])
    expect(JSON.stringify(message)).not.toContain('image_locator')
  })

  it('a NEW alias row of a family with an Images draft on the main listing: the main listing\'s draft, not the alias\'s own', async () => {
    const ids = await scoped(async () => {
      const made = await family('alias-draft', { live: false })
      const [main, extra] = await prisma.productImage.findMany({ where: { productId: made.productId }, orderBy: { sortOrder: 'asc' } })
      const draft = (assetId: string) => ({ version: 1, draft: { common: { MAIN: { assetId: `product:${assetId}`, language: 'zxx' } }, items: {} }, assets: [] })
      await prisma.channelListing.update({ where: { id: made.main }, data: { platformAttributes: { _amazonMediaWorkspace: draft(main.id) } } })
      await prisma.channelListing.update({ where: { id: made.alias }, data: { platformAttributes: { sellerSku: 'alias-draft-ALT1', _amazonMediaWorkspace: draft(extra.id) } } })
      return made
    })
    expect(photosOf((await publish(ids.productId, ids.alias)).feed.messages[0])).toEqual([photo('alias-draft-main')])
  })

  it('NEGATIVE CONTROL: the main listing sends its own Product media, new or live', async () => {
    const fresh = await scoped(() => family('main-new', { live: false }))
    expect(photosOf((await publish(fresh.productId, fresh.main)).feed.messages[0])).toEqual([photo('main-new-main')])
    const live = await scoped(() => family('main-live', { live: true }, { live: true }))
    expect(photosOf((await publish(live.productId, live.main)).feed.messages[0])).toEqual([photo('main-live-main')])
  })
})
