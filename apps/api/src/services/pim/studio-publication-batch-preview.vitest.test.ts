import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Sheet publish parity, step 5 — `previewStudioPublication(…, { batchId, expiresInMs })` on the real schema.
 *
 * Without options nothing changes: a review that cannot be sent is returned unsaved. Inside a batch, a review that can
 * be sent is saved with its `batchId` and the batch's lifetime, and one that cannot is kept as a BLOCKED row (never
 * sent, never in flight, never blocking its destination) so the batch can say why.
 */
const fixture = vi.hoisted(() => ({ database: null as any, mode: 'live' as string }))

vi.mock('@nexus/database', async () => {
  const { concurrentDatabase, concurrentDatabaseUrl } = await import('../../test-support/concurrent-database.js')
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  fixture.database = concurrentDatabaseUrl() ? await concurrentDatabase() : await formulaDatabase()
  return { default: fixture.database.client }
})
vi.mock('./studio-publication-plan.js', async () => {
  const { createHash } = await import('node:crypto')
  return { readPublicationFacts: async () => ({ scope: { channel: 'AMAZON', marketplace: 'IT', accountId: 'acc' }, destination: { familyId: 'family', aliasKey: null },
      account: { displayName: 'Amazon account' }, parent: { id: 'family' }, products: [{ id: 'family', sku: 'COAT', name: 'Coat' }],
      listings: [], resolved: [], issues: [], excluded: 0, aliasLabel: 'Primary listing', revision: 'facts-1' }),
    publicationDigest: (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    object: (value: unknown) => value && typeof value === 'object' ? value : {} }
})
vi.mock('../amazon-publish-gate.service.js', () => ({ getAmazonPublishMode: () => fixture.mode }))
vi.mock('../ebay-publish-gate.service.js', () => ({ getEbayPublishMode: () => 'live' }))
vi.mock('../shopify-publish-gate.service.js', () => ({ getShopifyPublishMode: () => 'live' }))
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: () => {} }))
vi.mock('../assortment/shared-listing-warning.js', () => ({ sharedListingWarnings: async () => [] }))
vi.mock('./studio-publication-overwrite.js', () => ({ readPublicationOverwrite: async () => ({ requiresConfirmation: false, products: [] }) }))
vi.mock('./studio-publication-amazon.js', () => ({
  prepareAmazonPublication: async (facts: any) => ({ kind: 'amazon', sellerId: 's', marketplaceId: 'm', products: facts.products.map((p: any) => ({ productId: p.id, sku: p.sku })),
    feed: { header: {}, messages: [{ messageId: 1, sku: 'COAT', operationType: 'PATCH', productType: 'COAT' }] } }),
  sendAmazonPublication: vi.fn(), readAmazonPublication: vi.fn(),
}))
vi.mock('./studio-publication-ebay.js', () => ({ prepareEbayPublication: vi.fn(), sendEbayPublication: vi.fn(), readEbayPublication: vi.fn(), usesEbayInventory: () => false, prepareEbayInventoryPublication: vi.fn() }))
vi.mock('./studio-publication-baseline.js', () => ({ readPublicationBaseline: async () => ({ values: new Map(), revision: 'b' }) }))
vi.mock('./studio-publication-amazon-changes.js', () => ({
  prepareAmazonChanges: async (_facts: any, publication: any) => ({ kind: 'amazon-changes', publication, remoteRevision: 'r', products: [],
    changes: [{ id: JSON.stringify(['family', 'item_name']), productId: 'family', sku: 'COAT', field: 'item_name', label: 'Title', current: { state: 'value', value: 'A' },
      lastAccepted: { state: 'unknown', reason: '' }, channel: { state: 'value', value: 'B' }, status: 'SEND', selectable: true, selectedByDefault: true,
      localChanged: true, channelChanged: false, reason: '', operation: 'replace' }] }),
  compileAmazonChanges: vi.fn(),
}))
vi.mock('./studio-publication-ebay-changes.js', () => ({ prepareEbayChanges: vi.fn(), compileEbayChanges: vi.fn() }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { previewStudioPublication } from './studio-publication.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const scope = { channel: 'AMAZON', marketplace: 'IT', accountId: 'acc' } as const

describe('a review made for a publication batch', () => {
  beforeAll(async () => { await scoped(() => prisma.bulkOperation.count()) }, 120_000)
  afterAll(async () => { await fixture.database?.close?.() })

  it('without a batch, a blocked review is returned unsaved, as before', () => scoped(async () => {
    fixture.mode = 'gated'
    const before = await prisma.bulkOperation.count()
    const review = await previewStudioPublication('family', scope as never, 'user')
    expect(review.id).toBeNull()
    expect(review.issues.some(i => /Sending is off: publishing to Amazon is turned off/.test(i.message))).toBe(true)
    expect(await prisma.bulkOperation.count()).toBe(before)
  }))

  it('inside a batch, a blocked review is kept as BLOCKED with the reason, and never blocks the destination', () => scoped(async () => {
    fixture.mode = 'gated'
    const review = await previewStudioPublication('family', scope as never, 'user', { batchId: 'batch-1' })
    expect(review.id).toEqual(expect.any(String))
    const row = await prisma.bulkOperation.findUnique({ where: { id: review.id! } })
    expect(row).toMatchObject({ status: 'BLOCKED', batchId: 'batch-1', kind: 'studio-publication', productId: 'family', channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'acc', aliasKey: '' })
    expect(row!.completedAt).toBeInstanceOf(Date)
    expect((row!.summary as any)).toMatchObject({ blocked: true, message: expect.stringMatching(/Sending is off: publishing to Amazon is turned off/) })
    // A BLOCKED review is not in flight: a normal review of the same destination is not refused because of it.
    fixture.mode = 'live'
    const next = await previewStudioPublication('family', scope as never, 'user')
    expect(next.id).toEqual(expect.any(String))
    expect(next.previousPublicationId).toBeUndefined()
  }))

  it('inside a batch, a review that can be sent carries the batch and the batch\'s lifetime', () => scoped(async () => {
    fixture.mode = 'live'
    const before = Date.now()
    const review = await previewStudioPublication('family', scope as never, 'user', { batchId: 'batch-2', expiresInMs: 2 * 60 * 60_000 })
    const row = await prisma.bulkOperation.findUnique({ where: { id: review.id! } })
    expect(row).toMatchObject({ status: 'PREVIEW', batchId: 'batch-2' })
    expect(row!.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 2 * 60 * 60_000 - 1_000)
    expect(new Date(review.expiresAt).getTime()).toBe(row!.expiresAt!.getTime())
  }))
})
