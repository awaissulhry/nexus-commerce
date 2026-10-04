import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  database: null as any,
  facts: vi.fn(),
  sendEbay: vi.fn(),
  readEbay: vi.fn(),
  sendAmazon: vi.fn(),
  readAmazon: vi.fn(),
  providerWrite: vi.fn(),
  shopPreview: vi.fn(),
  shopSend: vi.fn(),
  fillAsins: vi.fn(),
  seenAtFill: null as unknown,
}))

vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  fixture.database = await formulaDatabase()
  return { default: fixture.database.client }
})
vi.mock('./studio-publication-plan.js', async () => {
  const { createHash } = await import('node:crypto')
  return { readPublicationFacts: fixture.facts,
    publicationDigest: (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, entry) =>
      entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry)).digest('hex'),
    object: (value: unknown) => value && typeof value === 'object' ? value : {} }
})
vi.mock('../amazon-publish-gate.service.js', () => ({ getAmazonPublishMode: () => 'live' }))
// A status change is a refresh hint on the listing bus; here it is only recorded, never sent.
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: vi.fn() }))
vi.mock('../ebay-publish-gate.service.js', () => ({ getEbayPublishMode: () => 'live' }))
vi.mock('../shopify-publish-gate.service.js', () => ({ getShopifyPublishMode: () => 'live' }))
vi.mock('../shopify/content-workspace.service.js', () => ({ getContentWorkspace: async () => ({ initialized: true }), saveContentWorkspace: vi.fn() }))
vi.mock('../shopify/content-sync.service.js', () => ({ previewContentSync: fixture.shopPreview, synchronizeContent: fixture.shopSend }))
vi.mock('./studio-publication-amazon.js', () => ({
  prepareAmazonPublication: async (facts: any) => ({ kind: 'amazon', sellerId: 'seller-a', marketplaceId: 'market-it',
    products: facts.products.map((p: any) => ({ productId: p.id, sku: `REMOTE-${p.sku}` })),
    feed: { header: { sellerId: 'seller-a', version: '2.0' }, messages: facts.products.map((p: any, i: number) => ({ messageId: i + 1, sku: `REMOTE-${p.sku}`, operationType: 'UPDATE', productType: 'COAT', attributes: { item_name: [{ value: `Sent ${p.sku}` }] } })) } }),
  sendAmazonPublication: fixture.sendAmazon, readAmazonPublication: fixture.readAmazon,
}))
vi.mock('./studio-publication-ebay.js', () => ({
  prepareEbayPublication: async (facts: any) => ({ kind: 'ebay', marketplace: 'IT', itemId: null, liveRevision: null,
    products: facts.products.map((p: any) => ({ productId: p.id, sku: p.sku })), xml: '<AddFixedPriceItemRequest><Item><Title>Exact sent title</Title></Item></AddFixedPriceItemRequest>' }),
  sendEbayPublication: fixture.sendEbay,
  readEbayPublication: fixture.readEbay,
  ebayPublicationRequest: (plan: any, reviewId: string) => ({ operation: 'AddFixedPriceItem', xml: plan.xml.replace('<Item>', `<Item><UUID>${reviewId}</UUID>`) }),
  usesEbayInventory: () => false, prepareEbayInventoryPublication: async () => { throw new Error('Inventory is not part of this suite.') },
}))
// The ASIN read after an Amazon promotion calls Amazon. Here it records what it was asked, and what the database
// showed it at that moment — the proof that it runs after the promotion committed.
vi.mock('../amazon/listing-asin-fill.service.js', () => ({ fillAmazonListingAsins: fixture.fillAsins }))
vi.mock('./studio-publication-baseline.js', () => ({ readPublicationBaseline: async () => ({ values: new Map(), revision: 'baseline-1' }) }))
vi.mock('./studio-publication-amazon-changes.js', () => ({
  prepareAmazonChanges: async (_facts: any, publication: any) => ({ kind: 'amazon-changes', publication, remoteRevision: 'remote-1', products: [], schemas: [],
    changes: publication.products.map((p: any) => ({ id: p.productId, ...p, field: 'item_name', label: 'Title',
      current: { state: 'value', value: publication.feed.messages.find((message: any) => message.sku === p.sku).attributes.item_name },
      lastAccepted: { state: 'unknown', reason: 'No record' }, channel: { state: 'unknown', reason: 'New listing' }, status: 'SEND', selectable: true, selectedByDefault: true, localChanged: null, channelChanged: null, reason: 'Create', operation: 'replace' })) }),
  compileAmazonChanges: (plan: any, ids: string[]) => ({ ...plan.publication, products: plan.publication.products.filter((p: any) => ids.includes(p.productId)),
    feed: { ...plan.publication.feed, messages: plan.publication.feed.messages.filter((message: any) => plan.publication.products.some((p: any) => p.sku === message.sku && ids.includes(p.productId))) },
    fieldWrites: Object.fromEntries(plan.changes.filter((c: any) => ids.includes(c.id)).map((c: any) => [c.productId, [{ field: c.field, value: c.current }]])) }),
}))
vi.mock('./studio-publication-ebay-changes.js', () => ({
  prepareEbayChanges: async (_facts: any, publication: any) => ({ kind: 'ebay-changes', publication, remoteRevision: 'remote-1',
    changes: publication.products.map((p: any) => ({ id: p.productId, ...p, field: 'title', label: 'Title', current: { state: 'value', value: 'Exact sent title' },
      lastAccepted: { state: 'unknown', reason: 'No record' }, channel: { state: 'unknown', reason: 'New listing' }, status: 'SEND', selectable: true, selectedByDefault: true, localChanged: null, channelChanged: null, reason: 'Create', operation: 'replace' })) }),
  compileEbayChanges: (plan: any, ids: string[]) => ({ ...plan.publication, products: plan.publication.products.filter((p: any) => ids.includes(p.productId)),
    fieldWrites: Object.fromEntries(plan.changes.filter((c: any) => ids.includes(c.id)).map((c: any) => [c.productId, [{ field: c.field, value: c.current }]])) }),
}))

import prisma from '../../db.js'
import { ebayPublicationRequest } from './studio-publication-ebay.js'
import { previewStudioPublication as previewRaw, studioPublicationResult, submitStudioPublication as submitRaw, previewStudioPublicationSelection } from './studio-publication.service.js'

async function previewStudioPublication(...args: Parameters<typeof previewRaw>) {
  const review = await previewRaw(...args)
  if (review.id && ['AMAZON', 'EBAY'].includes(args[1].channel)) await previewStudioPublicationSelection(args[0], review.id, { selectedIds: review.changes?.filter(c => c.selectable).map(c => c.id) ?? [] }, args[2])
  return review
}
async function submitStudioPublication(productId: string, id: string, body: Record<string, unknown>, userId: string | null) {
  const stored = await prisma.bulkOperation.findUnique({ where: { id } })
  return submitRaw(productId, id, { ...body, selectionToken: (stored?.changes as any)?.selection?.token }, userId)
}

const productId = 'publication-database-product'
const accountId = 'publication-database-ebay'
// One account per channel: the draft creator (`ensureDraftListings`) starts a listing only under an active account of
// that channel, on an active market.
const amazonAccountId = 'publication-database-amazon'
const shopifyAccountId = 'publication-database-shopify'
const childId = 'publication-database-child'
const scope = { channel: 'EBAY', marketplace: 'IT', accountId }
const facts = () => ({
  scope,
  destination: { familyId: productId, aliasKey: null },
  account: { displayName: 'Disposable eBay account' },
  parent: { id: productId },
  products: [{ id: productId, sku: 'PGLITE-PUBLISH', name: 'Disposable publication fixture' }],
  listings: [], resolved: [], issues: [], excluded: 0, aliasLabel: 'Primary listing', revision: 'stored-revision-1',
})

beforeAll(async () => {
  await prisma.product.create({ data: { id: productId, sku: 'PGLITE-PUBLISH', name: 'Disposable publication fixture', basePrice: 10, status: 'DRAFT' } })
  await prisma.product.create({ data: { id: childId, sku: 'PGLITE-CHILD', name: 'Disposable child', parentId: productId, basePrice: 10, status: 'DRAFT' } })
  await prisma.channelConnection.create({ data: { id: accountId, channelType: 'EBAY', isActive: true } })
  await prisma.channelConnection.create({ data: { id: amazonAccountId, channelType: 'AMAZON', isActive: true } })
  await prisma.channelConnection.create({ data: { id: shopifyAccountId, channelType: 'SHOPIFY', isActive: true } })
  for (const [channel, code] of [['EBAY', 'IT'], ['AMAZON', 'IT'], ['SHOPIFY', 'GLOBAL']]) {
    await prisma.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  }
}, 120_000)

beforeEach(async () => {
  vi.clearAllMocks()
  fixture.facts.mockImplementation(async () => facts())
  fixture.readEbay.mockReset(); fixture.readEbay.mockResolvedValue(null)
  fixture.readAmazon.mockReset(); fixture.readAmazon.mockResolvedValue(null)
  fixture.shopPreview.mockResolvedValue({ errors: [], initialized: true, revision: 'shop-draft', remoteRevision: 'shop-remote', draft: {},
    variants: [{ id: childId, sku: 'EFFECTIVE-SHOP-SKU' }], changes: { newProductStatus: 'DRAFT' }, locations: [{ id: 'shop-location', name: 'Stock', isActive: true }] })
  fixture.shopSend.mockImplementation(async (_product, _scope, _body, beforeMutation) => {
    await beforeMutation?.({ query: 'mutation First { productSet(input:$input) { product { id } } }', variables: { input: { variants: [{ sku: 'EFFECTIVE-SHOP-SKU' }] } } })
    fixture.providerWrite()
    await beforeMutation?.({ query: 'mutation Second { productUpdate(product:$product) { product { id } } }', variables: { product: { id: 'gid://shopify/Product/42' } } })
    fixture.providerWrite()
    return { productId: 'gid://shopify/Product/42' }
  })
  fixture.sendEbay.mockImplementation(async (plan, _account, reviewId, beforeSend) => {
    try { await beforeSend?.(ebayPublicationRequest(plan, reviewId)) }
    catch (error) { throw Object.assign(error, { notSent: true }) }
    fixture.providerWrite()
    return { reference: '123456789012', warnings: ['eBay normalized a submitted value.'] }
  })
  fixture.sendAmazon.mockImplementation(async (plan, _account, beforeSend) => {
    try { await beforeSend?.({ feedType: 'JSON_LISTINGS_FEED', marketplaceIds: ['market-it'], feed: plan.feed }) }
    catch (error) { throw Object.assign(error, { notSent: true }) }
    fixture.providerWrite()
    return 'feed-database'
  })
  fixture.seenAtFill = null
  fixture.fillAsins.mockImplementation(async (ids: string[]) => {
    fixture.seenAtFill = await prisma.channelListing.findMany({ where: { id: { in: ids } }, select: { id: true, isPublished: true, listingStatus: true, syncPaused: true } })
    return { dryRun: false, rows: [], counts: { filled: 0, not_visible_yet: ids.length, already_had_asin: 0, error: 0 } }
  })
  await prisma.bulkOperation.deleteMany({ where: { changes: { path: ['kind'], equals: 'studio-publication' } } })
  await prisma.channelListing.deleteMany({ where: { productId: { in: [productId, childId] } } })
  await prisma.channelPublishAttempt.deleteMany({ where: { productId: { in: [productId, childId] } } })
})

afterAll(async () => { await fixture.database?.close() }, 30_000)

const shopifyFacts = () => ({ ...facts(), scope: { channel: 'SHOPIFY', marketplace: 'GLOBAL', accountId: shopifyAccountId },
  products: [...facts().products, { id: childId, sku: 'PGLITE-CHILD', name: 'Child' }] })

it('records Shopify mutations against the effective variant SKU and verifies all ordered request captures', async () => {
  fixture.facts.mockResolvedValue(shopifyFacts())
  const review = await previewStudioPublication(productId, shopifyFacts().scope, null)
  const result = await submitStudioPublication(productId, review.id!, { locationId: 'shop-location' }, null)
  expect(result).toMatchObject({ status: 'VERIFIED', results: expect.arrayContaining([expect.objectContaining({ sku: 'EFFECTIVE-SHOP-SKU' })]) })
  const snapshots = await prisma.channelListingSnapshot.findMany({ where: { publishEventId: review.id } })
  expect(snapshots).toHaveLength(2)
  const child = snapshots.find(row => (row.payload as any).productId === childId)!
  expect(child).toMatchObject({ outcome: 'ACCEPTED', acceptedAt: expect.any(Date), payload: { sku: 'EFFECTIVE-SHOP-SKU',
    requests: [{ variables: { input: { variants: [{ sku: 'EFFECTIVE-SHOP-SKU' }] } } }, { variables: { product: { id: 'gid://shopify/Product/42' } } }] } })
  expect(await prisma.channelPublishAttempt.findFirst({ where: { productId: childId } })).toMatchObject({ sku: 'EFFECTIVE-SHOP-SKU', outcome: 'success' })
  expect(fixture.providerWrite).toHaveBeenCalledTimes(2)
}, 30_000)

it('keeps a Shopify first-journal failure retryable without claiming a remote send', async () => {
  fixture.facts.mockResolvedValue(shopifyFacts())
  const review = await previewStudioPublication(productId, shopifyFacts().scope, null)
  await fixture.database.db.exec('ALTER TABLE "ChannelPublishAttempt" ADD CONSTRAINT "pco_reject_shop_pending" CHECK (outcome <> \'pending\')')
  try {
    expect(await submitStudioPublication(productId, review.id!, { locationId: 'shop-location' }, null)).toMatchObject({ status: 'FAILED' })
    expect(fixture.providerWrite).not.toHaveBeenCalled()
    expect(await prisma.channelListingSnapshot.count({ where: { publishEventId: review.id } })).toBe(0)
    expect((await previewStudioPublication(productId, shopifyFacts().scope, null)).id).not.toBeNull()
  } finally { await fixture.database.db.exec('ALTER TABLE "ChannelPublishAttempt" DROP CONSTRAINT "pco_reject_shop_pending"') }
}, 30_000)

it('keeps a Shopify later-journal failure unverified after one mutation attempt', async () => {
  fixture.facts.mockResolvedValue(shopifyFacts())
  const review = await previewStudioPublication(productId, shopifyFacts().scope, null)
  await fixture.database.db.exec('ALTER TABLE "ChannelListingSnapshot" ADD CONSTRAINT "pco_one_shop_request" CHECK (jsonb_array_length(payload->\'requests\') <= 1)')
  try {
    expect(await submitStudioPublication(productId, review.id!, { locationId: 'shop-location' }, null)).toMatchObject({ status: 'UNVERIFIED' })
    expect(fixture.providerWrite).toHaveBeenCalledOnce()
    const rows = await prisma.channelListingSnapshot.findMany({ where: { publishEventId: review.id } })
    expect(rows).toHaveLength(2)
    expect(rows.every(row => row.outcome === 'UNKNOWN' && row.acceptedAt === null && (row.payload as any).requests.length === 1)).toBe(true)
    expect((await previewStudioPublication(productId, shopifyFacts().scope, null)).id).toBeNull()
  } finally { await fixture.database.db.exec('ALTER TABLE "ChannelListingSnapshot" DROP CONSTRAINT "pco_one_shop_request"') }
}, 30_000)

it('journals the exact eBay request before dispatch and accepts it only after active read-back', async () => {
  fixture.providerWrite.mockImplementationOnce(async () => {})
  const review = await previewStudioPublication(productId, scope, null)
  fixture.readEbay.mockImplementationOnce(async () => {
    const snapshot = await prisma.channelListingSnapshot.findFirstOrThrow({ where: { publishEventId: review.id } })
    expect(snapshot).toMatchObject({ outcome: 'SUBMITTED', acceptedAt: null, payload: { kind: 'studio-publication', productId, channelConnectionId: accountId,
      requests: [{ operation: 'AddFixedPriceItem', xml: expect.stringContaining(`<UUID>${review.id}</UUID>`) }] } })
    expect(await prisma.channelPublishAttempt.findFirst({ where: { productId } })).toMatchObject({ outcome: 'submitted', submissionId: '123456789012' })
    return null
  })
  expect(await submitStudioPublication(productId, review.id!, {}, null)).toMatchObject({ status: 'UNVERIFIED' })
  expect(await prisma.channelListingSnapshot.findFirst({ where: { publishEventId: review.id } })).toMatchObject({ outcome: 'SUBMITTED', acceptedAt: null,
    payload: { requests: [{ operation: 'AddFixedPriceItem', xml: expect.stringContaining(`<UUID>${review.id}</UUID>`) }] } })
  fixture.readEbay.mockResolvedValue({ reference: '123456789012', warnings: [], verified: true })
  expect(await studioPublicationResult(productId, review.id!, null)).toMatchObject({ status: 'ACCEPTED' })
  const accepted = await prisma.channelListingSnapshot.findFirstOrThrow({ where: { publishEventId: review.id } })
  expect(accepted).toMatchObject({ outcome: 'ACCEPTED', acceptedAt: expect.any(Date) })
  await studioPublicationResult(productId, review.id!, null)
  expect(await prisma.channelListingSnapshot.findUnique({ where: { id: accepted.id } })).toMatchObject({ acceptedAt: accepted.acceptedAt })
  expect(fixture.providerWrite).toHaveBeenCalledOnce()
}, 30_000)

it('does not send if exact request and audit cannot both be durably recorded', async () => {
  const review = await previewStudioPublication(productId, scope, null)
  await fixture.database.db.exec('ALTER TABLE "ChannelPublishAttempt" ADD CONSTRAINT "pco_reject_pending_test" CHECK (outcome <> \'pending\')')
  try {
    expect(await submitStudioPublication(productId, review.id!, {}, null)).toMatchObject({ status: 'FAILED' })
    expect(fixture.providerWrite).not.toHaveBeenCalled()
    expect(await prisma.channelListingSnapshot.count({ where: { publishEventId: review.id } })).toBe(0)
  } finally { await fixture.database.db.exec('ALTER TABLE "ChannelPublishAttempt" DROP CONSTRAINT "pco_reject_pending_test"') }
}, 30_000)

it('attributes Amazon messages by seller SKU and advances only the accepted SKU after its processing report', async () => {
  const amazon = { ...scope, channel: 'AMAZON', accountId: amazonAccountId }
  fixture.facts.mockResolvedValue({ ...facts(), scope: amazon, products: [...facts().products, { id: childId, sku: 'PGLITE-CHILD', name: 'Child' }] })
  const review = await previewStudioPublication(productId, amazon, null)
  expect(await submitStudioPublication(productId, review.id!, {}, null)).toMatchObject({ status: 'SUBMITTED' })
  const captured = await prisma.channelListingSnapshot.findMany({ where: { publishEventId: review.id }, include: { channelListing: true } })
  expect(captured).toHaveLength(2)
  for (const row of captured) {
    const sku = row.channelListing.productId === productId ? 'REMOTE-PGLITE-PUBLISH' : 'REMOTE-PGLITE-CHILD'
    expect(row).toMatchObject({ outcome: 'SUBMITTED', acceptedAt: null, payload: { productId: row.channelListing.productId, sku,
      requests: [{ feedType: 'JSON_LISTINGS_FEED', marketplaceIds: ['market-it'], header: { sellerId: 'seller-a' }, message: { sku } }] } })
  }
  fixture.readAmazon.mockResolvedValue({ results: [{ sku: 'REMOTE-PGLITE-PUBLISH', failed: false, message: 'Accepted' }, { sku: 'REMOTE-PGLITE-CHILD', failed: true, message: 'Invalid content' }] })
  expect(await studioPublicationResult(productId, review.id!, null)).toMatchObject({ status: 'PARTIAL' })
  const settled = await prisma.channelListingSnapshot.findMany({ where: { publishEventId: review.id } })
  expect(settled.find(row => (row.payload as any).productId === productId)).toMatchObject({ outcome: 'ACCEPTED', acceptedAt: expect.any(Date) })
  expect(settled.find(row => (row.payload as any).productId === childId)).toMatchObject({ outcome: 'FAILED', acceptedAt: null })
  expect(fixture.providerWrite).toHaveBeenCalledOnce()
}, 30_000)

/**
 * Sheet publish parity, step 1 — a publication keeps its destination as indexed columns (the FAMILY, whichever member
 * opened the studio) and its result in counts, so a history lists it without reading `changes`. Step 2 — a send
 * schedules the result sweep (`checkCount` 0, the first look in two minutes); a final result clears `nextCheckAt`.
 */
it('keeps the destination of a publication as columns and its result in counts', async () => {
  const amazon = { ...scope, channel: 'AMAZON', accountId: amazonAccountId }
  fixture.facts.mockResolvedValue({ ...facts(), scope: amazon, products: [...facts().products, { id: childId, sku: 'PGLITE-CHILD', name: 'Child' }] })
  const review = await previewStudioPublication(childId, amazon, null)
  const destination = { kind: 'studio-publication', productId, channel: 'AMAZON', marketplace: 'IT', channelConnectionId: amazonAccountId, aliasKey: '' }
  expect(await prisma.bulkOperation.findUnique({ where: { id: review.id! } })).toMatchObject({ ...destination, status: 'PREVIEW',
    submittedAt: null, summary: null, batchId: null, nextCheckAt: null, checkCount: null })
  expect(await submitStudioPublication(childId, review.id!, {}, null)).toMatchObject({ status: 'SUBMITTED' })
  const submitted = await prisma.bulkOperation.findUniqueOrThrow({ where: { id: review.id! } })
  expect(submitted).toMatchObject({ ...destination, status: 'SUBMITTED', submittedAt: expect.any(Date), nextCheckAt: expect.any(Date), checkCount: 0,
    summary: { products: 2, submitted: 2, accepted: 0, verified: 0, failed: 0, message: expect.stringContaining('feed-database') } })
  expect(submitted.submittedAt!.toISOString()).toBe((submitted.changes as any).startedAt)
  // The Amazon feed's first look: two minutes after its receipt (within this test's own run time).
  const firstLook = submitted.nextCheckAt!.getTime() - Date.now()
  expect(firstLook).toBeGreaterThan(60_000)
  expect(firstLook).toBeLessThanOrEqual(120_000)
  fixture.readAmazon.mockResolvedValue({ results: [{ sku: 'REMOTE-PGLITE-PUBLISH', failed: false, message: 'Accepted' }, { sku: 'REMOTE-PGLITE-CHILD', failed: true, message: 'Invalid content' }] })
  expect(await studioPublicationResult(childId, review.id!, null)).toMatchObject({ status: 'PARTIAL' })
  expect(await prisma.bulkOperation.findUnique({ where: { id: review.id! } })).toMatchObject({ ...destination, status: 'PARTIAL', nextCheckAt: null,
    summary: { products: 2, submitted: 0, accepted: 1, verified: 0, failed: 1, message: expect.stringContaining('rejected by Amazon') } })
}, 30_000)

/**
 * Draft listing safety, step 1 — an accepted SKU turns its still-draft row live (published, ACTIVE, unpaused), per SKU.
 * A rejected SKU's draft stays a draft, and a live listing an operator paused stays paused.
 */
/** Each channel's own account: Publish starts a missing row only under an active account of that channel (`ensureDraftListings`). */
const accountFor = (channel: string) => channel === 'AMAZON' ? amazonAccountId : channel === 'SHOPIFY' ? shopifyAccountId : accountId
const draftRow = (id: string, channel: string, marketplace: string, paused: boolean) => prisma.channelListing.create({ data: { productId: id, channel,
  marketplace, region: marketplace, channelMarket: `${channel}_${marketplace}`, channelConnectionId: accountFor(channel), aliasKey: '', listingStatus: 'DRAFT', isPublished: false, syncPaused: paused } })
const pausedLiveRow = (id: string, channel: string, marketplace: string) => prisma.channelListing.create({ data: { productId: id, channel,
  marketplace, region: marketplace, channelMarket: `${channel}_${marketplace}`, channelConnectionId: accountFor(channel), aliasKey: '', listingStatus: 'ACTIVE', isPublished: true,
  externalListingId: `FIXTURE-LIVE-${id}`, syncPaused: true } })

it('Amazon ACCEPTED promotes and unpauses the accepted still-draft row, and leaves an operator-paused live row paused', async () => {
  const amazon = { ...scope, channel: 'AMAZON', accountId: amazonAccountId }
  const draft = await draftRow(productId, 'AMAZON', 'IT', true)
  const live = await pausedLiveRow(childId, 'AMAZON', 'IT')
  fixture.facts.mockResolvedValue({ ...facts(), scope: amazon, products: [...facts().products, { id: childId, sku: 'PGLITE-CHILD', name: 'Child' }], listings: [draft, live] })
  const review = await previewStudioPublication(productId, amazon, null)
  expect(await submitStudioPublication(productId, review.id!, {}, null)).toMatchObject({ status: 'SUBMITTED' })
  // The paused draft was SENT (Publish's lock lets a still-draft through), and journaled against its own row.
  expect(fixture.providerWrite).toHaveBeenCalledOnce()
  expect(await prisma.channelListingSnapshot.findFirst({ where: { publishEventId: review.id, channelListingId: draft.id } })).toMatchObject({ outcome: 'SUBMITTED' })
  // Submitted is not accepted: nothing is promoted yet.
  expect(await prisma.channelListing.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ listingStatus: 'DRAFT', isPublished: false, syncPaused: true })
  expect(fixture.fillAsins).not.toHaveBeenCalled()
  fixture.readAmazon.mockResolvedValue({ results: [{ sku: 'REMOTE-PGLITE-PUBLISH', failed: false, message: 'Accepted' }, { sku: 'REMOTE-PGLITE-CHILD', failed: false, message: 'Accepted' }] })
  expect(await studioPublicationResult(productId, review.id!, null)).toMatchObject({ status: 'ACCEPTED' })
  expect(await prisma.channelListing.findUniqueOrThrow({ where: { id: draft.id } }))
    .toMatchObject({ listingStatus: 'ACTIVE', isPublished: true, syncPaused: false, externalListingId: null, version: draft.version + 1 })
  expect(await prisma.channelListing.findUniqueOrThrow({ where: { id: live.id } }))
    .toMatchObject({ listingStatus: 'ACTIVE', isPublished: true, syncPaused: true, version: live.version })
  // The ASIN read: the promoted row only (the paused live row was accepted too, and is not a promotion), and it
  // already sees the promotion — it ran after the transaction committed.
  await vi.waitFor(() => expect(fixture.fillAsins).toHaveBeenCalledOnce())
  expect(fixture.fillAsins).toHaveBeenCalledWith([draft.id])
  expect(fixture.seenAtFill).toEqual([{ id: draft.id, isPublished: true, listingStatus: 'ACTIVE', syncPaused: false }])
  // A repeated status read changes nothing, and reads nothing again.
  await studioPublicationResult(productId, review.id!, null)
  expect((await prisma.channelListing.findUniqueOrThrow({ where: { id: draft.id } })).version).toBe(draft.version + 1)
  expect(fixture.fillAsins).toHaveBeenCalledOnce()
}, 30_000)

it('Amazon PARTIAL promotes only the accepted SKU; the rejected SKU stays an unpublished draft', async () => {
  const amazon = { ...scope, channel: 'AMAZON', accountId: amazonAccountId }
  fixture.facts.mockResolvedValue({ ...facts(), scope: amazon, products: [...facts().products, { id: childId, sku: 'PGLITE-CHILD', name: 'Child' }] })
  const review = await previewStudioPublication(productId, amazon, null)
  await submitStudioPublication(productId, review.id!, {}, null)
  fixture.readAmazon.mockResolvedValue({ results: [{ sku: 'REMOTE-PGLITE-PUBLISH', failed: false, message: 'Accepted' }, { sku: 'REMOTE-PGLITE-CHILD', failed: true, message: 'Invalid content' }] })
  expect(await studioPublicationResult(productId, review.id!, null)).toMatchObject({ status: 'PARTIAL' })
  const where = (id: string) => ({ productId: id, channel: 'AMAZON', marketplace: 'IT', channelConnectionId: amazonAccountId, aliasKey: '' })
  const accepted = await prisma.channelListing.findFirstOrThrow({ where: where(productId) })
  expect(accepted).toMatchObject({ listingStatus: 'ACTIVE', isPublished: true, syncPaused: false })
  expect(await prisma.channelListing.findFirstOrThrow({ where: where(childId) })).toMatchObject({ listingStatus: 'DRAFT', isPublished: false })
  // Only the promoted SKU reads its ASIN; the rejected draft is not read.
  await vi.waitFor(() => expect(fixture.fillAsins).toHaveBeenCalledOnce())
  expect(fixture.fillAsins).toHaveBeenCalledWith([accepted.id])
}, 30_000)

it('eBay read-back promotes a paused still-draft row and lifts its pause; a paused row that is not a draft keeps its pause', async () => {
  const draft = await draftRow(productId, 'EBAY', 'IT', true)
  // Not a still-draft (it carries a channel id), so the promotion writes it live but never touches its pause.
  const other = await prisma.channelListing.create({ data: { productId: childId, channel: 'EBAY', marketplace: 'IT', region: 'IT', channelMarket: 'EBAY_IT',
    channelConnectionId: accountId, aliasKey: '', listingStatus: 'INACTIVE', isPublished: false, externalListingId: '123456789012', syncPaused: true } })
  fixture.facts.mockResolvedValue({ ...facts(), products: [...facts().products, { id: childId, sku: 'PGLITE-CHILD', name: 'Child' }], listings: [draft, other] })
  const review = await previewStudioPublication(productId, scope, null)
  expect(await submitStudioPublication(productId, review.id!, {}, null)).toMatchObject({ status: 'UNVERIFIED' })
  expect(fixture.providerWrite).toHaveBeenCalledOnce()
  fixture.readEbay.mockResolvedValue({ reference: '123456789012', warnings: [], verified: true })
  expect(await studioPublicationResult(productId, review.id!, null)).toMatchObject({ status: 'ACCEPTED' })
  expect(await prisma.channelListing.findUniqueOrThrow({ where: { id: draft.id } }))
    .toMatchObject({ externalListingId: '123456789012', isPublished: true, listingStatus: 'ACTIVE', syncPaused: false, version: draft.version + 1 })
  expect(await prisma.channelListing.findUniqueOrThrow({ where: { id: other.id } }))
    .toMatchObject({ externalListingId: '123456789012', isPublished: true, listingStatus: 'ACTIVE', syncPaused: true, version: other.version + 1 })
  // eBay's receipt carries the ItemID: no ASIN read.
  expect(fixture.fillAsins).not.toHaveBeenCalled()
}, 30_000)

it('Shopify VERIFIED keeps the rows exactly as the Shopify synchronisation wrote them — a Shopify draft stays INACTIVE', async () => {
  // The real synchronisation (shopify/content-sync.service.ts) maps every delivered row with the Shopify ids and the
  // status Shopify verified. Here the Shopify product is a draft, so the rows are INACTIVE and unpublished: honest.
  fixture.facts.mockResolvedValue(shopifyFacts())
  fixture.shopSend.mockImplementationOnce(async (_product, _scope, _body, beforeMutation) => {
    await beforeMutation?.({ query: 'mutation First { productSet(input:$input) { product { id } } }', variables: { input: { variants: [{ sku: 'EFFECTIVE-SHOP-SKU' }] } } })
    await prisma.channelListing.updateMany({ where: { productId: { in: [productId, childId] }, channel: 'SHOPIFY' },
      data: { externalListingId: 'FIXTURE-SHOPIFY-PRODUCT', listingStatus: 'INACTIVE', isPublished: false, version: { increment: 1 } } })
    return { productId: 'gid://shopify/Product/42' }
  })
  const review = await previewStudioPublication(productId, shopifyFacts().scope, null)
  expect(await submitStudioPublication(productId, review.id!, { locationId: 'shop-location' }, null)).toMatchObject({ status: 'VERIFIED' })
  const rows = await prisma.channelListing.findMany({ where: { productId: { in: [productId, childId] }, channel: 'SHOPIFY' } })
  expect(rows).toHaveLength(2)
  for (const row of rows) expect(row).toMatchObject({ externalListingId: 'FIXTURE-SHOPIFY-PRODUCT', listingStatus: 'INACTIVE', isPublished: false })
}, 30_000)

it('binds a real stored content read to the selected listing and persists its explicit field selection', async () => {
  const own = await prisma.channelListing.create({ data: { productId, channel: 'EBAY', marketplace: 'IT', region: 'IT', channelMarket: 'EBAY_IT', channelConnectionId: accountId, externalListingId: '123456789012' } })
  const other = await prisma.channelListing.create({ data: { productId, channel: 'EBAY', marketplace: 'IT', region: 'IT', channelMarket: 'EBAY_IT', channelConnectionId: accountId, aliasKey: 'different-alias', externalListingId: 'another-item' } })
  const at = '2026-09-24T18:40:00.000Z'
  const content = { driftCount: 1, driftedFields: [{ field: 'Title', ours: 'Earlier Nexus', theirs: 'eBay title', source: 'ebay-content', checkedAt: at }],
    checkedBySource: { 'ebay-content': { at, outcome: 'compared', differing: 1 } } }
  await prisma.channelDrift.create({ data: { channelListingId: other.id, channel: 'EBAY', marketplace: 'IT', lastCheckedAt: new Date(at), ...content } })
  const stock = await prisma.channelDrift.create({ data: { channelListingId: own.id, channel: 'EBAY', marketplace: 'IT', lastCheckedAt: new Date(at),
    checkedBySource: { 'ebay-trading-getitem': { at, outcome: 'compared', differing: 0 } } } })
  fixture.facts.mockResolvedValue({ ...facts(), listings: [own] })
  const unreadReview = await previewStudioPublication(productId, scope, null)
  expect(unreadReview.overwrite).toMatchObject({ requiresConfirmation: true, products: [{ status: 'not_read', fields: [] }] })
  await expect(submitRaw(productId, unreadReview.id!, { confirmOverwrite: true }, null)).rejects.toThrow(/selection|token|review/i)
  await prisma.channelDrift.update({ where: { id: stock.id }, data: content })
  await expect(submitStudioPublication(productId, unreadReview.id!, { confirmOverwrite: true }, null)).rejects.toThrow('changed')
  expect(fixture.sendEbay).not.toHaveBeenCalled()
  const reviewed = await previewStudioPublication(productId, scope, null)
  expect(reviewed.overwrite?.products[0]).toMatchObject({ status: 'compared', fields: [{ field: 'Title', nexusAtRead: 'Earlier Nexus', channelAtRead: 'eBay title' }] })
  fixture.readEbay.mockResolvedValue({ reference: '123456789012', warnings: [], verified: true })
  await submitStudioPublication(productId, reviewed.id!, { confirmOverwrite: true }, null)
  expect((await prisma.bulkOperation.findUniqueOrThrow({ where: { id: reviewed.id! } })).changes).toMatchObject({ selection: { token: expect.any(String), selectedIds: [productId] } })
  expect(fixture.sendEbay).toHaveBeenCalledOnce()
}, 30_000)

it('refuses a concurrently replaced persisted selection at the database claim', async () => {
  const review = await previewStudioPublication(productId, scope, null)
  const initial = await prisma.bulkOperation.findUniqueOrThrow({ where: { id: review.id! } })
  const selection = (initial.changes as any).selection
  fixture.facts.mockImplementationOnce(async () => {
    await prisma.bulkOperation.update({ where: { id: review.id! }, data: { changes: { ...(initial.changes as object), selection: { ...selection, token: 'replaced-while-submit-waited' } } } })
    return facts()
  })
  await expect(submitRaw(productId, review.id!, { selectionToken: selection.token }, null)).rejects.toThrow(/changed|selection/i)
  expect(fixture.providerWrite).not.toHaveBeenCalled()
  expect(await prisma.channelListingSnapshot.count({ where: { publishEventId: review.id } })).toBe(0)
  expect(await prisma.bulkOperation.findUnique({ where: { id: review.id! } })).toMatchObject({ status: 'PREVIEW', changes: { selection: { token: 'replaced-while-submit-waited' } } })
}, 30_000)

it('persists the eBay receipt before read-back and recovers the local projection without resending', async () => {
  const review = await previewStudioPublication(productId, scope, null)
  expect(review.id).toBeTruthy()

  fixture.readEbay.mockImplementationOnce(async (reference: string, receivedAccount: string, marketplace: string) => {
    const checkpoint = await prisma.bulkOperation.findUniqueOrThrow({ where: { id: review.id! } })
    expect(checkpoint.status).toBe('UNVERIFIED')
    expect(checkpoint.completedAt).toBeNull()
    expect(checkpoint.changes).toMatchObject({ result: {
      status: 'UNVERIFIED', warnings: ['eBay normalized a submitted value.'],
      results: [expect.objectContaining({ reference: '123456789012', status: 'ACCEPTED' })],
    } })
    expect([reference, receivedAccount, marketplace]).toEqual(['123456789012', accountId, 'IT'])
    return null
  })

  const submitted = await submitStudioPublication(productId, review.id!, {}, null)
  expect(submitted).toMatchObject({ status: 'UNVERIFIED', warnings: ['eBay normalized a submitted value.'] })
  expect(fixture.sendEbay).toHaveBeenCalledOnce()
  const draft = await prisma.channelListing.findFirstOrThrow({ where: { productId, channel: 'EBAY', marketplace: 'IT', channelConnectionId: accountId } })
  expect(draft).toMatchObject({ externalListingId: null, isPublished: false, listingStatus: 'DRAFT' })

  fixture.readEbay.mockResolvedValueOnce({ reference: '123456789012', warnings: ['Read-back warning'], verified: true })
  const recovered = await studioPublicationResult(productId, review.id!, null)
  expect(recovered).toMatchObject({ status: 'ACCEPTED', warnings: ['eBay normalized a submitted value.', 'Read-back warning'] })
  expect(fixture.sendEbay).toHaveBeenCalledOnce()
  expect(await prisma.channelListing.findFirstOrThrow({ where: { productId, channel: 'EBAY', marketplace: 'IT', channelConnectionId: accountId } }))
    .toMatchObject({ externalListingId: '123456789012', isPublished: true, listingStatus: 'ACTIVE', version: draft.version + 1 })
  expect(await prisma.bulkOperation.findUniqueOrThrow({ where: { id: review.id! } }))
    .toMatchObject({ status: 'ACCEPTED', completedAt: expect.any(Date) })
}, 30_000)

it('retains an unresolved receipt when the exact local destination disappeared', async () => {
  fixture.readEbay.mockResolvedValue(null)
  const review = await previewStudioPublication(productId, scope, null)
  await submitStudioPublication(productId, review.id!, {}, null)
  await prisma.channelListing.deleteMany({ where: { productId } })
  fixture.readEbay.mockResolvedValue({ reference: '123456789012', warnings: [], verified: true })
  await expect(studioPublicationResult(productId, review.id!, null)).rejects.toThrow('local listing')
  expect((await prisma.bulkOperation.findUniqueOrThrow({ where: { id: review.id! } })).status).toBe('UNVERIFIED')
  expect(fixture.sendEbay).toHaveBeenCalledOnce()
}, 30_000)

/**
 * New listings (Owner 2026-10-04) — the rows a publication creates Inactive are marked when the channel accepts them, in
 * the same step that makes them live: Amazon as the engine's Pause marks a closed offer (no offer was sent), eBay held
 * as an eBay Pause holds it. A row's own stored choice clears once accepted. Shopify gets the main row's choice as the
 * new product's status. A main row set Not listed holds its family: nothing of it can be ticked.
 */
const choice = (target: 'active' | 'inactive' | 'not_listed', own: boolean) =>
  ({ target, source: own ? 'own' : 'default', own: own ? target : null, defaultTarget: 'active', includedByDefault: true, noRecord: false, isVariation: false })
const withChoices = (base: any, entries: Array<[string, ReturnType<typeof choice>]>) =>
  ({ ...base, createChoices: new Map(entries.map(([id, value]) => [id, { productId: id, listingId: null, ...value }])) })
const childFacts = (over: Record<string, unknown> = {}) => ({ ...facts(), products: [...facts().products, { id: childId, sku: 'PGLITE-CHILD', name: 'Child' }], ...over })

it('Amazon: a row created Inactive is promoted AND paused when accepted (no offer, sheet-pause), and its own choice clears', async () => {
  const amazon = { ...scope, channel: 'AMAZON', accountId: amazonAccountId }
  const main = await draftRow(productId, 'AMAZON', 'IT', true)
  const child = await draftRow(childId, 'AMAZON', 'IT', true)
  await prisma.channelListing.update({ where: { id: child.id }, data: { sellingTarget: 'INACTIVE', sellingTargetAt: new Date(Date.now() - 60_000) } })
  fixture.facts.mockResolvedValue(withChoices(childFacts({ scope: amazon, listings: [main, child] }), [[productId, choice('active', false)], [childId, choice('inactive', true)]]))
  const review = await previewStudioPublication(productId, amazon, null)
  expect(review.rows.map(row => [row.sku, row.startsAs])).toEqual([['PGLITE-PUBLISH', 'active'], ['PGLITE-CHILD', 'inactive']])
  const stored = (await prisma.bulkOperation.findUniqueOrThrow({ where: { id: review.id! } })).changes as any
  expect(stored).toMatchObject({ inactiveProductIds: [childId], createInactive: { [childId]: { productType: 'COAT', fba: false } }, createChoiceProductIds: [childId],
    creates: [{ productId, sku: 'PGLITE-PUBLISH', startsAs: 'active' }, { productId: childId, sku: 'PGLITE-CHILD', startsAs: 'inactive' }] })
  await submitStudioPublication(productId, review.id!, {}, null)
  fixture.readAmazon.mockResolvedValue({ results: [{ sku: 'REMOTE-PGLITE-PUBLISH', failed: false, message: 'Accepted' }, { sku: 'REMOTE-PGLITE-CHILD', failed: false, message: 'Accepted' }] })
  expect(await studioPublicationResult(productId, review.id!, null)).toMatchObject({ status: 'ACCEPTED' })
  const paused = await prisma.channelListing.findUniqueOrThrow({ where: { id: child.id } })
  expect(paused).toMatchObject({ listingStatus: 'ACTIVE', isPublished: true, syncPaused: false, offerActive: false, offerCloseReason: 'sheet-pause',
    offerCloseSnapshot: { purchasableOffer: [], productType: 'COAT', createdInactive: true, snapshotSource: 'created-inactive' }, sellingTarget: null, sellingTargetAt: null })
  expect(paused.offerClosedAt).toBeInstanceOf(Date)
  // The main row (a family's main product has no offer of its own) is promoted as before.
  expect(await prisma.channelListing.findUniqueOrThrow({ where: { id: main.id } })).toMatchObject({ listingStatus: 'ACTIVE', isPublished: true, offerClosedAt: null })
}, 30_000)

it('eBay: a row created Inactive becomes live AND held (sheet-pause) when eBay confirms the item', async () => {
  const main = await draftRow(productId, 'EBAY', 'IT', true)
  const child = await draftRow(childId, 'EBAY', 'IT', true)
  fixture.facts.mockResolvedValue(withChoices(childFacts({ listings: [main, child] }), [[productId, choice('active', false)], [childId, choice('inactive', true)]]))
  const review = await previewStudioPublication(productId, scope, null)
  await submitStudioPublication(productId, review.id!, {}, null)
  fixture.readEbay.mockResolvedValue({ reference: '123456789012', warnings: [], verified: true })
  expect(await studioPublicationResult(productId, review.id!, null)).toMatchObject({ status: 'ACCEPTED' })
  expect(await prisma.channelListing.findUniqueOrThrow({ where: { id: child.id } })).toMatchObject({ externalListingId: '123456789012', isPublished: true,
    listingStatus: 'ACTIVE', syncPaused: false, offerActive: false, offerCloseReason: 'sheet-pause', offerCloseSnapshot: { channel: 'EBAY', createdInactive: true, previewId: review.id } })
  expect(await prisma.channelListing.findUniqueOrThrow({ where: { id: main.id } })).toMatchObject({ isPublished: true, offerClosedAt: null, syncPaused: false })
}, 30_000)

it('Shopify: the main row\'s choice is the new product\'s status (Active → ACTIVE, Inactive → DRAFT)', async () => {
  for (const [target, status] of [['active', 'ACTIVE'], ['inactive', 'DRAFT']] as const) {
    fixture.shopSend.mockClear()
    fixture.facts.mockResolvedValue(withChoices(shopifyFacts(), [[productId, choice(target, true)]]))
    const review = await previewStudioPublication(productId, shopifyFacts().scope, null)
    expect(review.visibility).toBe(status)
    await submitStudioPublication(productId, review.id!, { locationId: 'shop-location' }, null)
    expect(fixture.shopSend).toHaveBeenCalledWith(productId, expect.anything(), expect.objectContaining({ createStatus: status }), expect.any(Function))
    await prisma.bulkOperation.deleteMany({ where: { changes: { path: ['kind'], equals: 'studio-publication' } } })
  }
}, 30_000)

it('a main row set Not listed holds its family: every create is blocked with the reason, and nothing is created Inactive', async () => {
  const amazon = { ...scope, channel: 'AMAZON', accountId: amazonAccountId }
  fixture.facts.mockResolvedValue(withChoices(childFacts({ scope: amazon }), [[productId, choice('not_listed', true)], [childId, choice('inactive', true)]]))
  const review = await previewRaw(productId, amazon, null)
  expect(review.rows.map(row => [row.sku, row.notListed, row.blocked, row.startsAs])).toEqual([
    ['PGLITE-PUBLISH', true, expect.stringContaining('Not listed'), undefined], ['PGLITE-CHILD', true, expect.stringContaining('Not listed'), undefined]])
  expect(review.changes!.every(change => !change.selectable)).toBe(true)
  const stored = (await prisma.bulkOperation.findFirst({ where: { id: review.id ?? '' } }))?.changes as any
  expect(stored?.inactiveProductIds).toBeUndefined()
}, 30_000)
