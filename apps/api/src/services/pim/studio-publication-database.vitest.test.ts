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
}))

vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  fixture.database = await formulaDatabase()
  return { default: fixture.database.client }
})
vi.mock('./studio-publication-plan.js', () => ({
  readPublicationFacts: fixture.facts,
  publicationDigest: (value: unknown) => JSON.stringify(value),
  object: (value: unknown) => value && typeof value === 'object' ? value : {},
}))
vi.mock('../amazon-publish-gate.service.js', () => ({ getAmazonPublishMode: () => 'live' }))
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
  prepareEbayPublication: async () => ({ kind: 'ebay', marketplace: 'IT', itemId: null, liveRevision: null, xml: '<AddFixedPriceItemRequest/>' }),
  sendEbayPublication: fixture.sendEbay,
  readEbayPublication: fixture.readEbay,
}))

import prisma from '../../db.js'
import { previewStudioPublication, studioPublicationResult, submitStudioPublication } from './studio-publication.service.js'

const productId = 'publication-database-product'
const accountId = 'publication-database-ebay'
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
  fixture.sendEbay.mockImplementation(async (_plan, _account, reviewId, beforeSend) => {
    try { await beforeSend?.({ operation: 'AddFixedPriceItem', xml: `<AddFixedPriceItemRequest><Item><UUID>${reviewId}</UUID><Title>Exact sent title</Title></Item></AddFixedPriceItemRequest>` }) }
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
  await prisma.bulkOperation.deleteMany({ where: { changes: { path: ['kind'], equals: 'studio-publication' } } })
  await prisma.channelListing.deleteMany({ where: { productId: { in: [productId, childId] } } })
  await prisma.channelPublishAttempt.deleteMany({ where: { productId: { in: [productId, childId] } } })
})

afterAll(async () => { await fixture.database?.close() }, 30_000)

const shopifyFacts = () => ({ ...facts(), scope: { channel: 'SHOPIFY', marketplace: 'GLOBAL', accountId },
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
  const amazon = { ...scope, channel: 'AMAZON' }
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

it('binds a real stored content read to the selected listing and persists its explicit overwrite acknowledgement', async () => {
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
  await expect(submitStudioPublication(productId, unreadReview.id!, {}, null)).rejects.toThrow(/confirm.*overwrite/i)
  await prisma.channelDrift.update({ where: { id: stock.id }, data: content })
  await expect(submitStudioPublication(productId, unreadReview.id!, { confirmOverwrite: true }, null)).rejects.toThrow('changed')
  expect(fixture.sendEbay).not.toHaveBeenCalled()
  const reviewed = await previewStudioPublication(productId, scope, null)
  expect(reviewed.overwrite?.products[0]).toMatchObject({ status: 'compared', fields: [{ field: 'Title', nexusAtRead: 'Earlier Nexus', channelAtRead: 'eBay title' }] })
  fixture.readEbay.mockResolvedValue({ reference: '123456789012', warnings: [], verified: true })
  await submitStudioPublication(productId, reviewed.id!, { confirmOverwrite: true }, null)
  expect((await prisma.bulkOperation.findUniqueOrThrow({ where: { id: reviewed.id! } })).changes).toMatchObject({ confirmOverwrite: true })
  expect(fixture.sendEbay).toHaveBeenCalledOnce()
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
