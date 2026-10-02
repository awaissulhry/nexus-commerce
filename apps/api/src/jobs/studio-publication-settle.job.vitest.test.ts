/**
 * MCP full control L4 — the studio publication settle sweep, on the studio's own publication service and a real
 * PostgreSQL with the production schema and business-isolation policies (PGlite). The channel transports are the studio
 * suites' fakes: no channel is called.
 *
 * Proven here: an Amazon publication left SUBMITTED for more than 2 minutes settles and its accepted drafts go live; an
 * eBay one left UNVERIFIED settles after its read-back; a fresh one is left alone (no channel read); a publication of
 * another business is not touched; and the sweep is scheduled only through the clustered wrapper, OFF unless switched on.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  database: null as any,
  facts: vi.fn(),
  sendAmazon: vi.fn(),
  readAmazon: vi.fn(),
  sendEbay: vi.fn(),
  readEbay: vi.fn(),
  schedule: vi.fn(),
}))

vi.mock('../db.js', async () => {
  const { contextualDatabase } = await import('../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(fixture.database.client)), property) }) }
})
vi.mock('../lib/cron/clustered.js', () => ({ default: { schedule: fixture.schedule } }))
vi.mock('../utils/cron-observability.js', () => ({ recordCronRun: async (_name: string, work: () => Promise<unknown>) => work() }))
vi.mock('../services/pim/studio-publication-plan.js', async () => {
  const { createHash } = await import('node:crypto')
  return { readPublicationFacts: fixture.facts,
    publicationDigest: (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, entry) =>
      entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry)).digest('hex'),
    object: (value: unknown) => value && typeof value === 'object' ? value : {} }
})
vi.mock('../services/amazon-publish-gate.service.js', () => ({ getAmazonPublishMode: () => 'live' }))
vi.mock('../services/ebay-publish-gate.service.js', () => ({ getEbayPublishMode: () => 'live' }))
vi.mock('../services/shopify-publish-gate.service.js', () => ({ getShopifyPublishMode: () => 'live' }))
vi.mock('../services/pim/studio-publication-amazon.js', () => ({
  prepareAmazonPublication: async (facts: any) => ({ kind: 'amazon', sellerId: 'seller-test', marketplaceId: 'market-it',
    products: facts.products.map((p: any) => ({ productId: p.id, sku: p.sku })),
    feed: { header: { sellerId: 'seller-test', version: '2.0' }, messages: facts.products.map((p: any, i: number) => ({ messageId: i + 1, sku: p.sku, operationType: 'UPDATE', productType: 'COAT', attributes: { item_name: [{ value: `Title ${p.sku}` }] } })) } }),
  sendAmazonPublication: fixture.sendAmazon, readAmazonPublication: fixture.readAmazon,
}))
vi.mock('../services/pim/studio-publication-ebay.js', () => ({
  prepareEbayPublication: async (facts: any) => ({ kind: 'ebay', marketplace: 'IT', itemId: null, liveRevision: null,
    products: facts.products.map((p: any) => ({ productId: p.id, sku: p.sku })), xml: '<AddFixedPriceItemRequest><Item><Title>Test</Title></Item></AddFixedPriceItemRequest>' }),
  sendEbayPublication: fixture.sendEbay, readEbayPublication: fixture.readEbay,
  ebayPublicationRequest: (plan: any, reviewId: string) => ({ operation: 'AddFixedPriceItem', xml: plan.xml.replace('<Item>', `<Item><UUID>${reviewId}</UUID>`) }),
  usesEbayInventory: () => false, prepareEbayInventoryPublication: vi.fn(),
}))
vi.mock('../services/pim/studio-publication-baseline.js', () => ({ readPublicationBaseline: async () => ({ values: new Map(), revision: 'baseline-1' }) }))
const sendAll = (publication: any, field: string) => publication.products.map((p: any) => ({ id: p.productId, productId: p.productId, sku: p.sku, field, label: field,
  current: { state: 'value', value: `Title ${p.sku}` }, lastAccepted: { state: 'unknown', reason: 'No record' }, channel: { state: 'unknown', reason: 'New listing' },
  status: 'SEND', selectable: true, selectedByDefault: true, localChanged: null, channelChanged: null, reason: 'Create', operation: 'replace' }))
const compiled = (plan: any, ids: string[]) => ({ ...plan.publication, products: plan.publication.products.filter((p: any) => ids.includes(p.productId)),
  fieldWrites: Object.fromEntries(plan.changes.filter((c: any) => ids.includes(c.id)).map((c: any) => [c.productId, [{ field: c.field, value: c.current }]])) })
vi.mock('../services/pim/studio-publication-amazon-changes.js', () => ({
  prepareAmazonChanges: async (_facts: any, publication: any) => ({ kind: 'amazon-changes', publication, remoteRevision: 'remote-1', products: [], schemas: [], changes: sendAll(publication, 'item_name') }),
  compileAmazonChanges: (plan: any, ids: string[]) => ({ ...compiled(plan, ids),
    feed: { ...plan.publication.feed, messages: plan.publication.feed.messages.filter((m: any) => plan.publication.products.some((p: any) => p.sku === m.sku && ids.includes(p.productId))) } }),
}))
vi.mock('../services/pim/studio-publication-ebay-changes.js', () => ({
  prepareEbayChanges: async (_facts: any, publication: any) => ({ kind: 'ebay-changes', publication, remoteRevision: 'remote-1', changes: sendAll(publication, 'title') }),
  compileEbayChanges: (plan: any, ids: string[]) => compiled(plan, ids),
}))
vi.mock('../services/amazon/listing-asin-fill.service.js', () => ({ fillAmazonListingAsins: async () => ({ dryRun: false, rows: [], counts: {} }) }))

import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { previewStudioPublication, previewStudioPublicationSelection, submitStudioPublication } from '../services/pim/studio-publication.service.js'
import { runStudioPublicationSettleOnce, startStudioPublicationSettleCron, stopStudioPublicationSettleCron } from './studio-publication-settle.job.js'

const A = LEGACY_WORKSPACE_ID
const OTHER = 'ws_l4_other_business'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace(business(workspaceId), work)
const db = () => fixture.database.client

type Json = Record<string, any>
const families: Record<string, { parent: string; child: string }> = {}
const accounts = { amazon: '', ebay: '' }

const factsFor = (family: string) => (_productId: string, scope: Json) => ({
  scope, destination: { familyId: families[family].parent, aliasKey: null }, account: { displayName: 'Test account' }, parent: { id: families[family].parent },
  products: [{ id: families[family].parent, sku: `${family}`, name: family }, { id: families[family].child, sku: `${family}-M`, name: `${family} M` }],
  listings: [], resolved: [], issues: [], excluded: 0, aliasLabel: 'Primary listing', revision: `revision-${family}`,
})

/** A colleague publishes a family from the studio. */
async function publish(family: string, channel: 'AMAZON' | 'EBAY') {
  fixture.facts.mockImplementation(factsFor(family))
  const scope = { channel, marketplace: 'IT', accountId: channel === 'AMAZON' ? accounts.amazon : accounts.ebay }
  return inside(A, async () => {
    const review = await previewStudioPublication(families[family].parent, scope, 'u-l4-colleague')
    const selection = await previewStudioPublicationSelection(families[family].parent, review.id!, { selectedIds: review.changes!.map((c) => c.id) }, 'u-l4-colleague')
    const result = await submitStudioPublication(families[family].parent, review.id!, { selectionToken: selection.token }, 'u-l4-colleague')
    return { id: review.id!, result }
  })
}

/** Moves a publication's send time (and its review) into the past. */
async function age(id: string, minutes: number) {
  await inside(A, async () => {
    const row = await db().bulkOperation.findUniqueOrThrow({ where: { id } })
    const at = new Date(Date.now() - minutes * 60_000)
    await db().bulkOperation.update({ where: { id }, data: { createdAt: at, changes: { ...(row.changes as Json), startedAt: at.toISOString() } } })
  })
}
const statusOf = (id: string) => inside(A, async () => (await db().bulkOperation.findUniqueOrThrow({ where: { id } })).status)
const listingsOf = (family: string, channel: string) => inside(A, () => db().channelListing.findMany({
  where: { channel, productId: { in: [families[family].parent, families[family].child] } }, select: { listingStatus: true, isPublished: true, syncPaused: true, externalListingId: true } }))

beforeAll(async () => {
  fixture.database = await formulaDatabase()
  const owner = await db().userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active' } })
  await db().workspace.create({ data: { id: OTHER, name: 'L4 other business', createdByUserId: owner.id, creationKey: randomUUID() } })
  await inside(A, async () => {
    accounts.amazon = (await db().channelConnection.create({ data: { channelType: 'AMAZON', isActive: true, accountLabel: 'Test Amazon', externalAccountId: 'TEST-L4-AMAZON' } })).id
    accounts.ebay = (await db().channelConnection.create({ data: { channelType: 'EBAY', isActive: true, accountLabel: 'Test eBay', externalAccountId: 'TEST-L4-EBAY' } })).id
    for (const channel of ['AMAZON', 'EBAY']) {
      await db().marketplace.create({ data: { channel, code: 'IT', name: `${channel} IT`, currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } as never })
    }
    for (const family of ['TEST-SKU-OLD', 'TEST-SKU-FRESH', 'TEST-SKU-EBAY']) {
      const parent = (await db().product.create({ data: { sku: family, name: family, basePrice: 10, isParent: true } })).id
      const child = (await db().product.create({ data: { sku: `${family}-M`, name: `${family} M`, basePrice: 10, parentId: parent } })).id
      families[family] = { parent, child }
    }
  })
}, 120_000)

beforeEach(() => {
  vi.clearAllMocks()
  fixture.readAmazon.mockResolvedValue(null)
  fixture.readEbay.mockResolvedValue(null)
  fixture.schedule.mockReturnValue({ stop: vi.fn() })
  fixture.sendAmazon.mockImplementation(async (plan: any, _account: string, beforeSend: any) => {
    await beforeSend?.({ feedType: 'JSON_LISTINGS_FEED', marketplaceIds: ['market-it'], feed: plan.feed })
    return `feed-${plan.products[0].sku}`
  })
  fixture.sendEbay.mockImplementation(async (plan: any, _account: string, reviewId: string, beforeSend: any) => {
    await beforeSend?.({ operation: 'AddFixedPriceItem', xml: plan.xml.replace('<Item>', `<Item><UUID>${reviewId}</UUID>`) })
    return { reference: 'TEST-ITEM-L4', warnings: [] }
  })
})

afterEach(() => {
  stopStudioPublicationSettleCron()
  vi.unstubAllEnvs()
})

afterAll(async () => { await fixture.database?.close() }, 30_000)

describe('runStudioPublicationSettleOnce', () => {
  it('settles an Amazon publication left SUBMITTED for more than 2 minutes, and leaves a fresh one alone', async () => {
    const old = await publish('TEST-SKU-OLD', 'AMAZON')
    const fresh = await publish('TEST-SKU-FRESH', 'AMAZON')
    expect([old.result.status, fresh.result.status]).toEqual(['SUBMITTED', 'SUBMITTED'])
    await age(old.id, 3)
    // Amazon has processed both feeds; only the old publication may be asked about.
    fixture.readAmazon.mockImplementation(async (_feed: string, _account: string, skus: string[]) => ({ results: skus.map((sku) => ({ sku, failed: false, message: 'Processed' })) }))
    expect((await listingsOf('TEST-SKU-OLD', 'AMAZON')).every((l: Json) => l.listingStatus === 'DRAFT' && !l.isPublished)).toBe(true)

    const run = await inside(A, () => runStudioPublicationSettleOnce())

    expect(run.summary).toBe('read 1 · settled 1 · still pending 0 · errors 0')
    expect(fixture.readAmazon).toHaveBeenCalledOnce()
    expect(fixture.readAmazon).toHaveBeenCalledWith('feed-TEST-SKU-OLD', accounts.amazon, ['TEST-SKU-OLD', 'TEST-SKU-OLD-M'])
    expect(await statusOf(old.id)).toBe('ACCEPTED')
    // Its accepted drafts are live now; the fresh publication's are still drafts.
    expect(await listingsOf('TEST-SKU-OLD', 'AMAZON')).toEqual([
      { listingStatus: 'ACTIVE', isPublished: true, syncPaused: false, externalListingId: null },
      { listingStatus: 'ACTIVE', isPublished: true, syncPaused: false, externalListingId: null },
    ])
    expect(await statusOf(fresh.id)).toBe('SUBMITTED')
    expect((await listingsOf('TEST-SKU-FRESH', 'AMAZON')).every((l: Json) => l.listingStatus === 'DRAFT' && !l.isPublished)).toBe(true)

    // Settled once: the next run asks Amazon nothing more about it.
    fixture.readAmazon.mockClear()
    expect((await inside(A, () => runStudioPublicationSettleOnce())).summary).toBe('read 0 · settled 0 · still pending 0 · errors 0')
    expect(fixture.readAmazon).not.toHaveBeenCalled()
    // The fresh one is settled once it is old enough.
    await age(fresh.id, 3)
    expect((await inside(A, () => runStudioPublicationSettleOnce())).summary).toBe('read 1 · settled 1 · still pending 0 · errors 0')
    expect(await statusOf(fresh.id)).toBe('ACCEPTED')
  })

  it('keeps an eBay item pending until its read-back confirms it, then settles it', async () => {
    const ebay = await publish('TEST-SKU-EBAY', 'EBAY')
    expect(ebay.result.status).toBe('UNVERIFIED')
    await age(ebay.id, 3)
    // Not confirmed yet: still pending, asked again next time.
    expect((await inside(A, () => runStudioPublicationSettleOnce())).summary).toBe('read 1 · settled 0 · still pending 1 · errors 0')
    expect(fixture.readEbay).toHaveBeenCalledWith('TEST-ITEM-L4', accounts.ebay, 'IT')
    fixture.readEbay.mockResolvedValue({ reference: 'TEST-ITEM-L4', warnings: [], verified: true })
    expect((await inside(A, () => runStudioPublicationSettleOnce())).summary).toBe('read 1 · settled 1 · still pending 0 · errors 0')
    expect(await statusOf(ebay.id)).toBe('ACCEPTED')
    expect((await listingsOf('TEST-SKU-EBAY', 'EBAY')).map((l: Json) => [l.listingStatus, l.isPublished, l.externalListingId])).toEqual([
      ['ACTIVE', true, 'TEST-ITEM-L4'], ['ACTIVE', true, 'TEST-ITEM-L4'],
    ])
  })

  it('never touches another business\'s publication', async () => {
    const other = await inside(OTHER, () => db().bulkOperation.create({ data: { userId: null, status: 'SUBMITTED', productCount: 1, changeCount: 1,
      createdAt: new Date(Date.now() - 10 * 60_000),
      changes: { kind: 'studio-publication', productId: 'none', scope: { channel: 'AMAZON', marketplace: 'IT', accountId: 'none' }, startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        result: { id: 'x', status: 'SUBMITTED', message: 'Submitted', results: [{ sku: 'TEST-SKU-OTHER', status: 'SUBMITTED', reference: 'feed-other', message: 'Awaiting' }] } } } }))
    fixture.readAmazon.mockResolvedValue({ results: [{ sku: 'TEST-SKU-OTHER', failed: false, message: 'Processed' }] })
    expect((await inside(A, () => runStudioPublicationSettleOnce())).summary).toBe('read 0 · settled 0 · still pending 0 · errors 0')
    expect(fixture.readAmazon).not.toHaveBeenCalled()
    expect(await inside(OTHER, async () => (await db().bulkOperation.findUniqueOrThrow({ where: { id: other.id } })).status)).toBe('SUBMITTED')
  })
})

describe('startStudioPublicationSettleCron', () => {
  it('is OFF by default: settling reads Amazon and eBay', () => {
    startStudioPublicationSettleCron()
    expect(fixture.schedule).not.toHaveBeenCalled()
  })

  it('switched on, runs every 5 minutes through the clustered wrapper', () => {
    vi.stubEnv('NEXUS_STUDIO_PUBLICATION_SETTLE', '1')
    startStudioPublicationSettleCron()
    expect(fixture.schedule).toHaveBeenCalledOnce()
    expect(fixture.schedule.mock.calls[0][0]).toBe('*/5 * * * *')
  })

  it('takes a schedule override', () => {
    vi.stubEnv('NEXUS_STUDIO_PUBLICATION_SETTLE', '1')
    vi.stubEnv('NEXUS_STUDIO_PUBLICATION_SETTLE_SCHEDULE', '*/10 * * * *')
    startStudioPublicationSettleCron()
    expect(fixture.schedule.mock.calls[0][0]).toBe('*/10 * * * *')
  })
})
