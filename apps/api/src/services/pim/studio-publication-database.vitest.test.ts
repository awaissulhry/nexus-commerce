import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  database: null as any,
  facts: vi.fn(),
  sendEbay: vi.fn(),
  readEbay: vi.fn(),
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
vi.mock('./studio-publication-amazon.js', () => ({
  prepareAmazonPublication: vi.fn(), sendAmazonPublication: vi.fn(), readAmazonPublication: vi.fn(),
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
  await prisma.channelConnection.create({ data: { id: accountId, channelType: 'EBAY', isActive: true } })
}, 120_000)

beforeEach(async () => {
  vi.clearAllMocks()
  fixture.facts.mockImplementation(async () => facts())
  fixture.sendEbay.mockResolvedValue({ reference: '123456789012', warnings: ['eBay normalized a submitted value.'] })
  await prisma.bulkOperation.deleteMany({ where: { changes: { path: ['kind'], equals: 'studio-publication' } } })
  await prisma.channelListing.deleteMany({ where: { productId } })
})

afterAll(async () => { await fixture.database?.close() }, 30_000)

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
