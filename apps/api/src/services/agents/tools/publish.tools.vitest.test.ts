/**
 * MCP full control L3 — publish-review and publication-status, run through the one door (call-tool.ts) against a real
 * PostgreSQL with the production schema and business-isolation policies (PGlite), on the studio's own publication service.
 * The channel transports and the studio's fact reader are the studio suites' fakes: no channel is called.
 *
 * Proven here: a review saves nothing — no BulkOperation row, no Shopify content save, no draft listing — whatever the
 * channel; the account is resolved only among this business's own active accounts; another business's product and
 * publication are not found; and a publication's result is read and settled in the business, whoever submitted it.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'

const fixture = vi.hoisted(() => ({
  database: null as any,
  facts: vi.fn(),
  prepareEbay: vi.fn(),
  sendAmazon: vi.fn(),
  readAmazon: vi.fn(),
  shopRead: vi.fn(),
  shopSave: vi.fn(),
  shopPreview: vi.fn(),
}))

vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(fixture.database.client)), property) }) }
})
vi.mock('../../pim/studio-publication-plan.js', async () => {
  const { createHash } = await import('node:crypto')
  return { readPublicationFacts: fixture.facts,
    // Keys sorted, as the real digest does: a review stored as jsonb comes back with its keys reordered.
    publicationDigest: (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, entry) =>
      entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry)).digest('hex'),
    object: (value: unknown) => value && typeof value === 'object' ? value : {} }
})
vi.mock('../../amazon-publish-gate.service.js', () => ({ getAmazonPublishMode: () => 'live' }))
vi.mock('../../ebay-publish-gate.service.js', () => ({ getEbayPublishMode: () => 'live' }))
vi.mock('../../shopify-publish-gate.service.js', () => ({ getShopifyPublishMode: () => 'live' }))
vi.mock('../../shopify/content-workspace.service.js', () => ({ getContentWorkspace: fixture.shopRead, saveContentWorkspace: fixture.shopSave }))
vi.mock('../../shopify/content-sync.service.js', () => ({ previewContentSync: fixture.shopPreview, synchronizeContent: vi.fn() }))
vi.mock('../../pim/studio-publication-amazon.js', () => ({
  prepareAmazonPublication: async (facts: any) => ({ kind: 'amazon', sellerId: 'seller-test', marketplaceId: 'market-it',
    products: facts.products.map((p: any) => ({ productId: p.id, sku: p.sku })),
    feed: { header: { sellerId: 'seller-test', version: '2.0' }, messages: facts.products.map((p: any, i: number) => ({ messageId: i + 1, sku: p.sku, operationType: 'UPDATE', productType: 'COAT', attributes: { item_name: [{ value: `Title ${p.sku}` }] } })) } }),
  sendAmazonPublication: fixture.sendAmazon, readAmazonPublication: fixture.readAmazon,
}))
vi.mock('../../pim/studio-publication-ebay.js', () => ({
  prepareEbayPublication: fixture.prepareEbay, sendEbayPublication: vi.fn(), readEbayPublication: vi.fn(),
  ebayPublicationRequest: () => ({ operation: 'AddFixedPriceItem', xml: '<Item/>' }), usesEbayInventory: () => false, prepareEbayInventoryPublication: vi.fn(),
}))
vi.mock('../../pim/studio-publication-baseline.js', () => ({ readPublicationBaseline: async () => ({ values: new Map(), revision: 'baseline-1' }) }))
const change = (p: any, field: string, status: string) => ({ id: JSON.stringify([p.productId, field]), productId: p.productId, sku: p.sku, field, label: field,
  current: { state: 'value', value: `Nexus ${field}` }, lastAccepted: { state: 'unknown', reason: 'No record' }, channel: { state: 'value', value: `Channel ${field}` },
  status, selectable: true, selectedByDefault: status === 'SEND', localChanged: null, channelChanged: null, reason: 'Differs', operation: 'replace' })
vi.mock('../../pim/studio-publication-amazon-changes.js', () => ({
  prepareAmazonChanges: async (_facts: any, publication: any) => ({ kind: 'amazon-changes', publication, remoteRevision: 'remote-1', products: [], schemas: [],
    changes: publication.products.map((p: any) => change(p, 'item_name', 'SEND')) }),
  compileAmazonChanges: (plan: any, ids: string[]) => ({ ...plan.publication, products: plan.publication.products.filter((p: any) => ids.some(id => id.includes(p.productId))),
    feed: plan.publication.feed, fieldWrites: {} }),
}))
vi.mock('../../pim/studio-publication-ebay-changes.js', () => ({
  prepareEbayChanges: async (_facts: any, publication: any) => ({ kind: 'ebay-changes', publication, remoteRevision: 'remote-1',
    changes: publication.products.flatMap((p: any) => [change(p, 'title', 'DIFFERS'), change(p, 'pictures', 'SAME')]) }),
  compileEbayChanges: (plan: any) => plan.publication,
}))
// The ASIN read after an Amazon promotion calls Amazon; here it reads nothing.
vi.mock('../../amazon/listing-asin-fill.service.js', () => ({ fillAmazonListingAsins: async () => ({ dryRun: false, rows: [], counts: {} }) }))

import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'
import { callTool, type UserPrincipal } from '../call-tool.js'
import { previewStudioPublication, previewStudioPublicationSelection, publicationResultFor, submitStudioPublication } from '../../pim/studio-publication.service.js'

const A = LEGACY_WORKSPACE_ID
const OTHER = 'ws_l3_other_business'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace(business(workspaceId), work)
const claude: UserPrincipal = {
  kind: 'user',
  userId: 'u-l3-claude',
  label: 'L3 test',
  permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
  workspace: business(A),
  via: 'claude',
}

type Json = Record<string, any>
const call = async (tool: string, args: Record<string, unknown>) => (await callTool(claude, tool, args)).visible as Json

const ids = { product: '', child: '', ebay: '', amazon: '', shopify: '', otherProduct: '', otherAccount: '', otherPublication: '' }
const counts = () => inside(A, async () => ({
  operations: await fixture.database.client.bulkOperation.count(),
  listings: await fixture.database.client.channelListing.count(),
}))

const factsFor = (scope: Json) => ({
  scope, destination: { familyId: ids.product, aliasKey: null }, account: { displayName: 'Test account' }, parent: { id: ids.product },
  products: [{ id: ids.product, sku: 'TEST-SKU-L3', name: 'Test jacket' }, { id: ids.child, sku: 'TEST-SKU-L3-M', name: 'Test jacket M' }],
  listings: [], resolved: [], issues: [], excluded: 0, aliasLabel: 'Primary listing', revision: 'stored-revision-1',
})

beforeAll(async () => {
  fixture.database = await formulaDatabase()
  const db = fixture.database.client
  const owner = await db.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active' } })
  await db.workspace.create({ data: { id: OTHER, name: 'L3 other business', createdByUserId: owner.id, creationKey: randomUUID() } })
  await inside(OTHER, async () => {
    ids.otherAccount = (await db.channelConnection.create({ data: { channelType: 'EBAY', isActive: true, accountLabel: 'Other shop', externalAccountId: 'TEST-OTHER-SELLER' } })).id
    ids.otherProduct = (await db.product.create({ data: { sku: 'TEST-SKU-OTHER', name: 'Other jacket', basePrice: 10 } })).id
    ids.otherPublication = (await db.bulkOperation.create({ data: { userId: null, status: 'ACCEPTED', productCount: 1, changeCount: 1,
      changes: { kind: 'studio-publication', productId: ids.otherProduct, scope: { channel: 'EBAY', marketplace: 'IT', accountId: ids.otherAccount },
        result: { id: 'x', status: 'ACCEPTED', message: 'Accepted', results: [{ sku: 'TEST-SKU-OTHER', status: 'ACCEPTED', message: 'ok' }] } } } })).id
  })
  await inside(A, async () => {
    ids.product = (await db.product.create({ data: { sku: 'TEST-SKU-L3', name: 'Test jacket', basePrice: 10, isParent: true } })).id
    ids.child = (await db.product.create({ data: { sku: 'TEST-SKU-L3-M', name: 'Test jacket M', basePrice: 10, parentId: ids.product } })).id
    ids.ebay = (await db.channelConnection.create({ data: { channelType: 'EBAY', isActive: true, accountLabel: 'Test eBay shop', externalAccountId: 'TEST-EBAY-SELLER' } })).id
    ids.amazon = (await db.channelConnection.create({ data: { channelType: 'AMAZON', isActive: true, accountLabel: 'Test Amazon', externalAccountId: 'TEST-AMAZON-SELLER' } })).id
    ids.shopify = (await db.channelConnection.create({ data: { channelType: 'SHOPIFY', isActive: true, accountLabel: 'Test store', externalAccountId: 'TEST-SHOP' } })).id
    for (const [channel, code] of [['EBAY', 'IT'], ['AMAZON', 'IT'], ['SHOPIFY', 'GLOBAL']]) {
      await db.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } as never })
    }
  })
}, 120_000)

beforeEach(() => {
  vi.clearAllMocks()
  fixture.facts.mockImplementation(async (_productId: string, scope: Json) => factsFor(scope))
  fixture.prepareEbay.mockImplementation(async (facts: any) => ({ kind: 'ebay', marketplace: 'IT', itemId: null, liveRevision: null,
    products: facts.products.map((p: any) => ({ productId: p.id, sku: p.sku })), xml: '<Item/>' }))
  fixture.readAmazon.mockResolvedValue(null)
  fixture.sendAmazon.mockImplementation(async (plan: any, _account: string, beforeSend: any) => {
    await beforeSend?.({ feedType: 'JSON_LISTINGS_FEED', marketplaceIds: ['market-it'], feed: plan.feed })
    return 'feed-l3'
  })
  fixture.shopRead.mockResolvedValue({ initialized: false, draft: { axes: [] }, revision: 'uninitialised' })
  fixture.shopPreview.mockResolvedValue({ errors: [], initialized: false, revision: 'uninitialised', remoteRevision: null, draft: {},
    variants: [{ id: ids.child, sku: 'TEST-SKU-L3-M' }], changes: { newProductStatus: 'DRAFT' }, locations: [{ id: 'gid://shopify/Location/1', name: 'Warehouse', isActive: true }] })
})

afterAll(async () => { await fixture.database?.close() }, 30_000)

describe('publish-review', () => {
  it('returns the studio\'s review of one destination, and saves nothing', async () => {
    const before = await counts()
    const answer = await call('publish-review', { productId: ids.child, channel: 'ebay', market: 'it' })
    expect(answer.ok, answer.error).toBe(true)
    expect(answer.data).toMatchObject({
      productId: ids.child, sku: 'TEST-SKU-L3-M',
      destination: { channel: 'EBAY', market: 'IT', accountId: ids.ebay, accountLabel: 'Test eBay shop' },
      mode: 'live', action: 'create', ready: true, issueCounts: { errors: 0 },
      changeCounts: { DIFFERS: 2, SAME: 2 },
      products: [{ productId: ids.product, sku: 'TEST-SKU-L3', live: false }, { productId: ids.child, sku: 'TEST-SKU-L3-M', live: false }],
      note: expect.stringContaining('nothing was saved or sent'),
    })
    // What would change comes first.
    expect(answer.data.changes[0]).toMatchObject({ field: 'title', status: 'DIFFERS', nexus: 'Nexus title', channel: 'Channel title' })
    expect(fixture.facts).toHaveBeenCalledWith(ids.child, { channel: 'EBAY', marketplace: 'IT', accountId: ids.ebay })
    expect(await counts()).toEqual(before)
  })

  it('reviews a Shopify family without saving its content document or starting a listing', async () => {
    const before = await counts()
    const answer = await call('publish-review', { productId: ids.product, channel: 'SHOPIFY', market: 'GLOBAL' })
    expect(answer.ok, answer.error).toBe(true)
    expect(answer.data).toMatchObject({ destination: { channel: 'SHOPIFY', accountId: ids.shopify }, visibility: 'DRAFT', locations: [{ name: 'Warehouse' }] })
    expect(fixture.shopRead).not.toHaveBeenCalled()
    expect(fixture.shopSave).not.toHaveBeenCalled()
    // Wave 2 D4 — facts without Status choices decide no create status: the review reads the Status column, as the send does.
    expect(fixture.shopPreview).toHaveBeenCalledWith(ids.product, { accountId: ids.shopify, listingId: undefined, market: 'GLOBAL' }, true, {})
    expect(await counts()).toEqual(before)
  })

  it('a problem the studio names is in the review, not a failure', async () => {
    fixture.prepareEbay.mockRejectedValueOnce(new Error('eBay category is missing.'))
    const answer = await call('publish-review', { productId: ids.product, channel: 'EBAY', market: 'IT' })
    expect(answer.data).toMatchObject({ ready: false, issueCounts: { errors: 1 }, issues: [{ severity: 'error', message: 'eBay category is missing.' }] })
  })

  it('resolves the account only among this business\'s own active accounts', async () => {
    // Another business's account: never used, never named.
    const foreign = await call('publish-review', { productId: ids.product, channel: 'EBAY', market: 'IT', accountId: ids.otherAccount })
    expect(foreign).toEqual({ ok: false, error: 'TEST-SKU-L3 on eBay IT: This business has no eBay account with this id: listing-coordinates lists its accounts.' })
    // Two active accounts and none named: the caller chooses.
    const second = await inside(A, () => fixture.database.client.channelConnection.create({ data: { channelType: 'EBAY', isActive: true, accountLabel: 'Second shop', externalAccountId: 'TEST-EBAY-SELLER-2' } }))
    try {
      const two = await call('publish-review', { productId: ids.product, channel: 'EBAY', market: 'IT' })
      expect(two.ok).toBe(false)
      expect(two.error).toContain('2 active eBay accounts')
      expect(two.error).toContain(second.id)
      expect((await call('publish-review', { productId: ids.product, channel: 'EBAY', market: 'IT', accountId: second.id })).data.destination.accountLabel).toBe('Second shop')
      await inside(A, () => fixture.database.client.channelConnection.update({ where: { id: second.id }, data: { isActive: false } }))
      expect((await call('publish-review', { productId: ids.product, channel: 'EBAY', market: 'IT', accountId: second.id })).error).toContain('is not active')
    } finally {
      await inside(A, () => fixture.database.client.channelConnection.delete({ where: { id: second.id } }))
    }
    expect((await call('publish-review', { productId: ids.product, channel: 'ETSY', market: 'GLOBAL' })).error).toBe('TEST-SKU-L3 on Etsy GLOBAL: This business has no active Etsy account. Connect one in Nexus first.')
  })

  it('another business\'s product is not found', async () => {
    expect(await call('publish-review', { productId: ids.otherProduct, channel: 'EBAY', market: 'IT' })).toEqual({ ok: false, error: 'Product not found' })
    expect(fixture.facts).not.toHaveBeenCalled()
  })
})

describe('publication-status', () => {
  it('reads a publication in the business, whoever submitted it, and changes nothing — even when the channel has its result', async () => {
    const scope = { channel: 'AMAZON', marketplace: 'IT', accountId: ids.amazon }
    // A colleague publishes from the studio; Claude, for another person, reads its result.
    const submitted = await inside(A, async () => {
      const review = await previewStudioPublication(ids.product, scope, 'u-l3-colleague')
      const selection = await previewStudioPublicationSelection(ids.product, review.id!, { selectedIds: review.changes!.map((c) => c.id) }, 'u-l3-colleague')
      return { review, result: await submitStudioPublication(ids.product, review.id!, { selectionToken: selection.token }, 'u-l3-colleague') }
    })
    expect(submitted.result).toMatchObject({ status: 'SUBMITTED' })
    const id = submitted.review.id!
    // Amazon has processed the feed: a settling read would promote the drafts. A read tool must not.
    fixture.readAmazon.mockResolvedValue({ results: [{ sku: 'TEST-SKU-L3', failed: false, message: 'Processed' }, { sku: 'TEST-SKU-L3-M', failed: false, message: 'Processed' }] })
    const state = () => inside(A, async () => ({
      operation: await fixture.database.client.bulkOperation.findUniqueOrThrow({ where: { id }, select: { status: true, changes: true, completedAt: true } }),
      listings: await fixture.database.client.channelListing.findMany({ where: { productId: { in: [ids.product, ids.child] } }, select: { id: true, listingStatus: true, isPublished: true, syncPaused: true, version: true }, orderBy: { id: 'asc' } }),
      snapshots: await fixture.database.client.channelListingSnapshot.findMany({ where: { publishEventId: id }, select: { id: true, outcome: true, acceptedAt: true }, orderBy: { id: 'asc' } }),
      queued: await fixture.database.client.outboundSyncQueue.count(),
    }))
    const before = await state()
    const pending = await call('publication-status', { publicationId: id })
    expect(pending.data).toMatchObject({ publicationId: id, productId: ids.product, sku: 'TEST-SKU-L3', status: 'SUBMITTED', settled: false,
      destination: { channel: 'AMAZON', market: 'IT', accountId: ids.amazon }, next: expect.stringContaining('Nexus checks it again by itself every 2 minutes') })
    expect(fixture.readAmazon).not.toHaveBeenCalled()
    expect(await state()).toEqual(before)
    expect(before.listings.every((l: Json) => l.listingStatus === 'DRAFT' && !l.isPublished)).toBe(true)
    // Settled elsewhere (the sweep, or the studio's own read): the tool reports the stored result.
    await inside(A, () => publicationResultFor(id))
    const settled = await call('publication-status', { publicationId: id })
    expect(settled.data).toMatchObject({ status: 'ACCEPTED', settled: true, results: [{ sku: 'TEST-SKU-L3', status: 'ACCEPTED' }, { sku: 'TEST-SKU-L3-M', status: 'ACCEPTED' }] })
    expect(settled.data).not.toHaveProperty('next')
  })

  it('another business\'s publication and an unknown id are not found', async () => {
    expect(await call('publication-status', { publicationId: ids.otherPublication })).toEqual({ ok: false, error: 'Publication not found' })
    expect(await call('publication-status', { publicationId: 'no-such-publication' })).toEqual({ ok: false, error: 'Publication not found' })
  })
})
