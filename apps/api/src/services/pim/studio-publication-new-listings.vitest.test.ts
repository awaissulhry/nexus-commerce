import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * New listings (Owner 2026-10-04, ND1 A) — a NEW Amazon listing set Inactive is created WITHOUT this market's offer: no
 * `purchasable_offer`, no merchant quantity (never 0 as a pause), and an FBA row keeps only its channel code (never a
 * quantity). Resume then puts the offer back from Nexus's own data, because no offer was ever saved. Publish leaves out a
 * variation set Not listed, as an excluded one. The real builder and reopen on PGlite; Amazon itself is a recorder (built,
 * never sent). Every id is invented.
 */
const state = vi.hoisted(() => ({ db: null as any, patches: [] as any[] }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../../clients/amazon-sp-api.client.js', async original => ({ ...(await original<Record<string, unknown>>()),
  amazonSpApiClient: { patchPurchasableOffer: async (input: unknown) => { state.patches.push(input); return { success: true } } } }))
vi.stubGlobal('fetch', vi.fn(async (url: unknown) => { throw new Error(`network refused in a gate: ${String(url)}`) }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { merchantQuantityEntries } from '../../lib/amazon-fba-boundary.js'
import { readPublicationFacts } from './studio-publication-plan.js'
import { prepareAmazonPublication } from './studio-publication-amazon.js'
import { nexusPurchasableOffer } from '../amazon/offer-from-nexus.js'
import { reopenMarketOffers } from '../amazon-market-offer.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let account = '', warehouse = ''

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Amazon IT', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'TEST_MARKET_IT' } as never })
  await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: 'IT', productType: 'COAT', schemaVersion: 'v1', expiresAt: new Date(Date.now() + 86_400_000),
    schemaDefinition: { properties: {} } } })
  account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'new-listings', isActive: true, externalAccountId: 'TEST-SELLER',
    authStatus: 'connected', managedBy: 'oauth', region: 'EU' } as never })).id
  warehouse = (await prisma.stockLocation.create({ data: { code: 'NEW-LISTINGS-WH', name: 'New listings warehouse', type: 'WAREHOUSE' } })).id
}), 60_000)
afterAll(async () => { await state.db?.close() })
beforeEach(() => { state.patches.length = 0 })

/** A product with 7 units and its draft Amazon IT row (never sent), holding a Status choice. */
async function draft(sku: string, fulfillment: 'FBA' | 'FBM', sellingTarget: string | null, extra: { parentId?: string; isParent?: boolean } = {}) {
  const product = await prisma.product.create({ data: { sku, name: sku, basePrice: 10, productType: 'COAT', fulfillmentMethod: fulfillment, totalStock: 7, ...extra } as never })
  await prisma.stockLevel.create({ data: { productId: product.id, locationId: warehouse, quantity: 7, available: 7 } })
  await prisma.productImage.create({ data: { productId: product.id, url: `https://img.example/${sku}.jpg`, type: 'MAIN' } as never })
  const listing = await prisma.channelListing.create({ data: { productId: product.id, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU', channelConnectionId: account,
    externalListingId: null, listingStatus: 'DRAFT', isPublished: false, syncPaused: true, fulfillmentMethod: fulfillment, followMasterPrice: true, followMasterQuantity: true, price: 10,
    sellingTarget, sellingTargetAt: sellingTarget ? new Date() : null,
    platformAttributes: fulfillment === 'FBA' ? { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }] } : {} } as never })
  return { productId: product.id, listingId: listing.id }
}

const messageOf = (productId: string, inactive: boolean) => scoped(async () => {
  const facts = await readPublicationFacts(productId, { channel: 'AMAZON', marketplace: 'IT', accountId: account })
  const publication = await prepareAmazonPublication(facts, inactive ? { inactiveProductIds: new Set([productId]) } : {})
  expect(publication.feed.messages).toHaveLength(1)
  return publication.feed.messages[0]
})

describe('🔴 an Amazon listing created Inactive carries no offer in this market', () => {
  it('FBM: no purchasable_offer and no fulfillment_availability (no merchant quantity, never 0); its price is still checked', async () => {
    const { productId } = await scoped(() => draft('new-inactive-fbm', 'FBM', 'INACTIVE'))
    const message = await messageOf(productId, true)
    expect(message.operationType).toBe('UPDATE')
    expect(message.attributes!.purchasable_offer).toBeUndefined()
    expect(message.attributes!.fulfillment_availability).toBeUndefined()
    expect(merchantQuantityEntries(message)).toEqual([])
  })

  it('FBA: only Amazon\'s channel code (AMAZON_EU), never a quantity, and no offer', async () => {
    const { productId } = await scoped(() => draft('new-inactive-fba', 'FBA', 'INACTIVE'))
    const message = await messageOf(productId, true)
    expect(message.attributes!.purchasable_offer).toBeUndefined()
    expect(message.attributes!.fulfillment_availability).toEqual([{ fulfillment_channel_code: 'AMAZON_EU' }])
    expect(merchantQuantityEntries(message)).toEqual([])
  })

  it('control: created Active it carries this market\'s offer and its stock', async () => {
    const { productId } = await scoped(() => draft('new-active-fbm', 'FBM', 'ACTIVE'))
    const message = await messageOf(productId, false)
    expect(message.attributes!.purchasable_offer).toEqual([expect.objectContaining({ marketplace_id: 'TEST_MARKET_IT', currency: 'EUR' })])
    expect(message.attributes!.fulfillment_availability).toEqual([expect.objectContaining({ fulfillment_channel_code: 'DEFAULT', quantity: 7 })])
  })
})

describe('Resume of a listing created Inactive: the offer comes from Nexus\'s data', () => {
  it('builds the offer from the listing\'s send price and sends it through SCT.6\'s reopen; the row sells again and follows the stock', async () => {
    const { productId, listingId } = await scoped(() => draft('new-resume-fbm', 'FBM', null))
    // As the settle step leaves it: live, and marked as the engine's Pause marks a closed offer (no offer saved).
    await scoped(() => prisma.channelListing.update({ where: { id: listingId }, data: { externalListingId: 'B0TESTASIN', listingStatus: 'ACTIVE', isPublished: true, syncPaused: false,
      offerClosedAt: new Date(), offerActive: false, offerCloseReason: 'sheet-pause', offerClosedBy: 'publish',
      offerCloseSnapshot: { purchasableOffer: [], productType: 'COAT', snapshotSource: 'created-inactive', createdInactive: true } as never } }))
    const built = await scoped(() => nexusPurchasableOffer(listingId))
    // SCT.6's reopen addresses Amazon's own marketplace id (MARKETPLACE_ID_MAP), as its close did.
    expect(built).toMatchObject({ price: 10, currency: 'EUR', offer: [{ marketplace_id: 'APJ6JRA9NG5V4', currency: 'EUR', our_price: [{ schedule: [{ value_with_tax: 10 }] }] }] })
    const result = await scoped(() => reopenMarketOffers({ targets: [{ productId, marketplace: 'IT', channelConnectionId: account, aliasKey: '' }], actor: 'tester', allowFba: true }))
    expect(result.results).toEqual([expect.objectContaining({ action: 'REOPENED', fromNexus: true })])
    expect(state.patches).toEqual([expect.objectContaining({ op: 'replace', productType: 'COAT', value: (built as { offer: unknown }).offer })])
    expect(await scoped(() => prisma.channelListing.findUniqueOrThrow({ where: { id: listingId } })))
      .toMatchObject({ offerClosedAt: null, offerActive: true, offerCloseReason: null, followMasterQuantity: true })
  })

  it('refuses to resume without a price, and sends nothing', async () => {
    const { productId, listingId } = await scoped(() => draft('new-resume-noprice', 'FBM', null))
    // A pinned price with no number: nothing to offer.
    await scoped(() => prisma.channelListing.update({ where: { id: listingId }, data: { externalListingId: 'B0TESTASI2', listingStatus: 'ACTIVE', isPublished: true, syncPaused: false, price: null,
      followMasterPrice: false, priceOverride: null,
      offerClosedAt: new Date(), offerActive: false, offerCloseReason: 'sheet-pause', offerCloseSnapshot: { purchasableOffer: [], productType: 'COAT', createdInactive: true } as never } }))
    const result = await scoped(() => reopenMarketOffers({ targets: [{ productId, marketplace: 'IT', channelConnectionId: account, aliasKey: '' }], actor: 'tester', allowFba: true }))
    expect(result.results).toEqual([expect.objectContaining({ action: 'FAILED', detail: expect.stringMatching(/^No saved offer to put back, and Nexus could not build one: /) })])
    expect(state.patches).toEqual([])
  })
})

describe('Publish leaves out a variation set Not listed', () => {
  it('a variation whose Status is Not listed is not in the publication, as an excluded one; the others keep their choice', async () => {
    const parent = await scoped(() => draft('new-family', 'FBM', null, { isParent: true }))
    const s = await scoped(() => draft('new-family-s', 'FBM', 'NOT_LISTED', { parentId: parent.productId }))
    const m = await scoped(() => draft('new-family-m', 'FBM', 'INACTIVE', { parentId: parent.productId }))
    const facts = await scoped(() => readPublicationFacts(parent.productId, { channel: 'AMAZON', marketplace: 'IT', accountId: account }))
    expect(facts.products.map(p => p.sku).sort()).toEqual(['new-family', 'new-family-m'])
    expect(facts.excluded).toBe(1)
    expect(facts.createChoices.get(s.productId)).toMatchObject({ target: 'not_listed', source: 'own' })
    expect(facts.createChoices.get(m.productId)).toMatchObject({ target: 'inactive', source: 'own' })
    expect(facts.createChoices.get(parent.productId)).toMatchObject({ target: 'active', source: 'default' })
  })
})
