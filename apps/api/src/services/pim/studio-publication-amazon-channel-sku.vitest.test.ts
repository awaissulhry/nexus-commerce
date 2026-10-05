import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * S3 (per-channel SKU) — Amazon Publish takes its seller SKU from THE rule (`wantedChannelSku`): the listing's own SKU
 * when set; else the one active offer or stored identity; else the product SKU — with the same refusals, word for word.
 * The Owner's flow: Delete, change the SKU in the channel view, list again → Amazon gets the NEW SKU (the old one the
 * flat-file mirror still holds is not sent). The EU shared-quantity check of a new listing reads only the rows under its
 * seller SKU. The real builder on PGlite (`readPublicationFacts` → `prepareAmazonPublication`), built and never sent.
 * Every id is invented.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
// The cached category schemas below are fresh, so no provider call is made — any fetch is a failure of the fixture.
vi.stubGlobal('fetch', vi.fn(async (url: unknown) => { throw new Error(`network refused in a gate: ${String(url)}`) }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { readPublicationFacts } from './studio-publication-plan.js'
import { prepareAmazonPublication } from './studio-publication-amazon.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let account = '', warehouse = ''

beforeAll(() => scoped(async () => {
  for (const code of ['IT', 'DE']) {
    await prisma.marketplace.create({ data: { channel: 'AMAZON', code, name: `Amazon ${code}`, currency: 'EUR', region: 'EU', language: code.toLowerCase(), languages: [code.toLowerCase()], marketplaceId: `TEST_MARKET_${code}` } as never })
    await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: code, productType: 'COAT', schemaVersion: 'v1', expiresAt: new Date(Date.now() + 86_400_000), schemaDefinition: { properties: {} } } })
  }
  account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'sku-publish', isActive: true, externalAccountId: 'TEST-SELLER',
    authStatus: 'connected', managedBy: 'oauth', region: 'EU' } as never })).id
  warehouse = (await prisma.stockLocation.create({ data: { code: 'SKU-PUBLISH-WH', name: 'Publish warehouse', type: 'WAREHOUSE' } })).id
}), 60_000)
afterAll(async () => { await state.db?.close() })

/** A merchant product with 7 in stock, and its Amazon row on `market` in the draft shape (a new listing, or one Nexus deleted). */
async function draftRow(sku: string, market: string, listing: Record<string, unknown> = {}, offers: Array<{ sku: string; method: 'FBA' | 'FBM' }> = []) {
  const product = await prisma.product.create({ data: { sku, name: sku, basePrice: 10, productType: 'COAT', fulfillmentMethod: 'FBM', totalStock: 7 } as never })
  await prisma.stockLevel.create({ data: { productId: product.id, locationId: warehouse, quantity: 7, available: 7 } })
  await prisma.productImage.create({ data: { productId: product.id, url: `https://img.example/${sku}.jpg`, type: 'MAIN' } as never })
  const row = await prisma.channelListing.create({ data: { productId: product.id, channel: 'AMAZON', marketplace: market, channelMarket: `AMAZON_${market}`, region: 'EU', channelConnectionId: account,
    externalListingId: null, listingStatus: 'DRAFT', isPublished: false, syncPaused: true, fulfillmentMethod: 'FBM', followMasterPrice: true, followMasterQuantity: true, price: 10,
    platformAttributes: {}, ...listing } as never })
  for (const offer of offers) await prisma.offer.create({ data: { channelListingId: row.id, sku: offer.sku, fulfillmentMethod: offer.method, isActive: true } })
  return product.id
}

const publish = (productId: string, market = 'IT') => scoped(async () =>
  prepareAmazonPublication(await readPublicationFacts(productId, { channel: 'AMAZON', marketplace: market, accountId: account })))

describe('the seller SKU Publish sends', () => {
  it('parity: no SKU of its own anywhere → the product SKU', async () => {
    const id = await scoped(() => draftRow('pub-plain', 'IT'))
    const publication = await publish(id)
    expect(publication.products).toEqual([{ productId: id, sku: 'pub-plain' }])
    expect(publication.feed.messages.map(m => m.sku)).toEqual(['pub-plain'])
  })

  it('parity: the one stored identity (the flat-file mirror) is sent, as before', async () => {
    const id = await scoped(() => draftRow('pub-legacy', 'IT', { flatFileSnapshot: { item_sku: 'pub-legacy-OLD' } }))
    expect((await publish(id)).feed.messages.map(m => m.sku)).toEqual(['pub-legacy-OLD'])
  })

  it('🔴 the Owner\'s flow: deleted, then given its own SKU in the channel view → listed again under the NEW SKU, not the old mirror', async () => {
    const id = await scoped(() => draftRow('pub-renamed', 'IT', { channelSku: 'pub-renamed-IT', flatFileSnapshot: { item_sku: 'pub-renamed' }, platformAttributes: { sellerSku: 'pub-renamed' } }))
    const publication = await publish(id)
    expect(publication.products).toEqual([{ productId: id, sku: 'pub-renamed-IT' }])
    expect(publication.feed.messages.map(m => m.sku)).toEqual(['pub-renamed-IT'])
  })

  it.each([
    ['two active offers (FBM and FBA)', 'pub-two-1', { listing: {}, offers: [{ sku: 'pub-two-a', method: 'FBM' as const }, { sku: 'pub-two-b', method: 'FBA' as const }] },
      'pub-two-1 has multiple seller SKUs. Select its offer before publishing.'],
    ['two stored identities', 'pub-two-2', { listing: { platformAttributes: { sellerSku: 'pub-two-x' }, flatFileSnapshot: { item_sku: 'pub-two-y' } }, offers: [] },
      'pub-two-2: conflicting Amazon seller SKUs. Reconcile this listing\'s identity before publishing.'],
  ])('the same refusal as before, word for word: %s', async (_name, sku, seed, sentence) => {
    const id = await scoped(() => draftRow(sku, 'IT', seed.listing, seed.offers))
    await expect(publish(id)).rejects.toThrow(sentence)
  })
})

describe('the EU shared-quantity check of a new listing is per seller SKU', () => {
  /** Two live siblings under the PRODUCT SKU that disagree on its one EU quantity: IT pinned at 0, FR following the pool. */
  const livePair = async (productId: string) => {
    for (const [market, pinned] of [['IT', true], ['FR', false]] as const) await prisma.channelListing.create({ data: { productId, channel: 'AMAZON', marketplace: market,
      channelMarket: `AMAZON_${market}`, region: 'EU', channelConnectionId: account, externalListingId: `B0TEST${market}`, listingStatus: 'ACTIVE', isPublished: true,
      syncPaused: false, fulfillmentMethod: 'FBM', followMasterPrice: true, followMasterQuantity: !pinned, quantityOverride: pinned ? 0 : null, quantity: pinned ? 0 : 7, price: 10 } as never })
  }

  it('control (as before): a DE row under the product SKU is held by the disagreeing IT and FR rows → refused', async () => {
    const id = await scoped(async () => { const pid = await draftRow('pub-eu-same', 'DE'); await livePair(pid); return pid })
    await expect(publish(id, 'DE')).rejects.toThrow(/EU shared-quantity conflict for pub-eu-same/)
  })

  it('a DE row under its own seller SKU is another quantity: created with its stock', async () => {
    const id = await scoped(async () => { const pid = await draftRow('pub-eu-own', 'DE', { channelSku: 'pub-eu-own-DE' }); await livePair(pid); return pid })
    const message = (await publish(id, 'DE')).feed.messages[0]
    expect(message.sku).toBe('pub-eu-own-DE')
    expect(message.attributes!.fulfillment_availability).toEqual([expect.objectContaining({ fulfillment_channel_code: 'DEFAULT', quantity: 7 })])
  })
})
