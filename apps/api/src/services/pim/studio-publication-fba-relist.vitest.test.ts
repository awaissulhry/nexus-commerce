import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Delete and relist, S1 (Owner 2026-10-04) — an FBA row Nexus deleted is listed again with its own Amazon fulfilment
 * channel (`AMAZON_EU`) and NEVER a quantity: FBA quantity is Amazon's (Owner rule: untouchable). A merchant row listed
 * again sends DEFAULT with its stock, as any create. The real builder on PGlite (`readPublicationFacts` →
 * `prepareAmazonPublication`), built and never sent; the FBA boundary's own reading of each message must find no
 * merchant quantity. Every id is invented.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
// The cached category schema below is fresh, so no provider call is made — any fetch is a failure of the fixture.
vi.stubGlobal('fetch', vi.fn(async (url: unknown) => { throw new Error(`network refused in a gate: ${String(url)}`) }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { merchantQuantityEntries } from '../../lib/amazon-fba-boundary.js'
import { readPublicationFacts } from './studio-publication-plan.js'
import { prepareAmazonPublication } from './studio-publication-amazon.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let account = '', warehouse = ''

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Amazon IT', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'TEST_MARKET_IT' } as never })
  await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: 'IT', productType: 'COAT', schemaVersion: 'v1', expiresAt: new Date(Date.now() + 86_400_000),
    schemaDefinition: { properties: {} } } })
  account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'fba-relist', isActive: true, externalAccountId: 'TEST-SELLER',
    authStatus: 'connected', managedBy: 'oauth', region: 'EU' } as never })).id
  // A merchant warehouse routed everywhere (no routing rows): a create's quantity comes from the routed ledger (sheet gaps).
  warehouse = (await prisma.stockLocation.create({ data: { code: 'FBA-RELIST-WH', name: 'Relist warehouse', type: 'WAREHOUSE' } })).id
}), 60_000)
afterAll(async () => { await state.db?.close() })

/**
 * A product and the draft shape an accepted Delete leaves on its Amazon IT row (no ASIN, DRAFT, unpublished). Both rows
 * hold 7 in the merchant warehouse: the FBA row has a merchant number it could wrongly send, and must not.
 */
async function deletedRow(sku: string, fulfillment: 'FBA' | 'FBM') {
  const product = await prisma.product.create({ data: { sku, name: sku, basePrice: 10, productType: 'COAT', fulfillmentMethod: fulfillment, totalStock: 7 } as never })
  await prisma.stockLevel.create({ data: { productId: product.id, locationId: warehouse, quantity: 7, available: 7 } })
  await prisma.productImage.create({ data: { productId: product.id, url: `https://img.example/${sku}.jpg`, type: 'MAIN' } as never })
  await prisma.channelListing.create({ data: { productId: product.id, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU', channelConnectionId: account,
    externalListingId: null, listingStatus: 'DRAFT', isPublished: false, syncPaused: true, fulfillmentMethod: fulfillment, followMasterPrice: true, followMasterQuantity: true, price: 10,
    platformAttributes: fulfillment === 'FBA' ? { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }] } : {} } as never })
  return product.id
}

async function relistMessage(productId: string) {
  return scoped(async () => {
    const facts = await readPublicationFacts(productId, { channel: 'AMAZON', marketplace: 'IT', accountId: account })
    const publication = await prepareAmazonPublication(facts)
    expect(publication.feed.messages).toHaveLength(1)
    return publication.feed.messages[0]
  })
}

describe('🔴 an FBA row listed again after a delete sends its own channel and no quantity', () => {
  it('FBA: the create carries fulfillment_availability AMAZON_EU and no quantity; the FBA boundary finds no merchant quantity', async () => {
    const id = await scoped(() => deletedRow('relist-fba', 'FBA'))
    const message = await relistMessage(id)
    expect(message.operationType).toBe('UPDATE')
    // Entries are channel-scoped since the sheet gaps (`amazonFulfillmentAvailability`): no marketplace_id, and no quantity.
    expect(message.attributes!.fulfillment_availability).toEqual([{ fulfillment_channel_code: 'AMAZON_EU' }])
    expect(JSON.stringify(message.attributes!.fulfillment_availability)).not.toMatch(/quantity/)
    expect(merchantQuantityEntries(message)).toEqual([])
  })

  it('control: a merchant (FBM) row listed again sends DEFAULT with its stock', async () => {
    const id = await scoped(() => deletedRow('relist-fbm', 'FBM'))
    const message = await relistMessage(id)
    expect(message.attributes!.fulfillment_availability).toEqual([expect.objectContaining({ fulfillment_channel_code: 'DEFAULT', quantity: 7 })])
  })
})
