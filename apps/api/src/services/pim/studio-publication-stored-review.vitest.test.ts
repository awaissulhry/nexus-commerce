import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Sheet publish parity T1 — a saved review read back for a row of the many-product dialog, on the real schema and
 * tenant policies: the review the preview returned, the fields ticked so far and whether they can still change; the
 * creator only; never the exact channel request.
 */
const fixture = vi.hoisted(() => ({ database: null as any, facts: vi.fn() }))

vi.mock('@nexus/database', async () => {
  const { concurrentDatabase, concurrentDatabaseUrl } = await import('../../test-support/concurrent-database.js')
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  fixture.database = concurrentDatabaseUrl() ? await concurrentDatabase() : await formulaDatabase()
  return { default: fixture.database.client }
})
vi.mock('./studio-publication-plan.js', async () => {
  const { createHash } = await import('node:crypto')
  return { readPublicationFacts: fixture.facts,
    publicationDigest: (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    object: (value: unknown) => value && typeof value === 'object' ? value : {} }
})
vi.mock('../amazon-publish-gate.service.js', () => ({ getAmazonPublishMode: () => 'live' }))
vi.mock('../ebay-publish-gate.service.js', () => ({ getEbayPublishMode: () => 'live' }))
vi.mock('../shopify-publish-gate.service.js', () => ({ getShopifyPublishMode: () => 'live' }))
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: () => {} }))
vi.mock('./studio-publication-amazon.js', () => ({
  prepareAmazonPublication: async (facts: any) => ({ kind: 'amazon', sellerId: 'seller-a', marketplaceId: 'market-it',
    products: facts.products.map((p: any) => ({ productId: p.id, sku: p.sku })),
    feed: { header: { version: '2.0' }, messages: facts.products.map((p: any, i: number) => ({ messageId: i + 1, sku: p.sku, operationType: 'PATCH', productType: 'COAT' })) } }),
  sendAmazonPublication: vi.fn(), readAmazonPublication: vi.fn(),
}))
vi.mock('./studio-publication-ebay.js', () => ({ prepareEbayPublication: vi.fn(), sendEbayPublication: vi.fn(), readEbayPublication: vi.fn(),
  usesEbayInventory: () => false, prepareEbayInventoryPublication: vi.fn() }))
vi.mock('./studio-publication-baseline.js', () => ({ readPublicationBaseline: async () => ({ values: new Map(), revision: 'baseline-1' }) }))
vi.mock('./studio-publication-amazon-changes.js', () => ({
  prepareAmazonChanges: async (_facts: any, publication: any) => ({ kind: 'amazon-changes', publication, remoteRevision: 'remote-1', products: [],
    changes: publication.products.map((p: any) => ({ id: JSON.stringify([p.productId, 'item_name']), ...p, field: 'item_name', label: 'Title',
      current: { state: 'value', value: 'Saved' }, lastAccepted: { state: 'unknown', reason: 'No record' }, channel: { state: 'value', value: 'Live' },
      status: 'SEND', selectable: true, selectedByDefault: true, localChanged: true, channelChanged: false, reason: 'Changed', operation: 'replace' })) }),
  compileAmazonChanges: vi.fn(),
}))
vi.mock('./studio-publication-ebay-changes.js', () => ({ prepareEbayChanges: vi.fn(), compileEbayChanges: vi.fn() }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { permissionForRoute } from '../../lib/auth/permissions-manifest.js'
import { previewStudioPublication, studioPublicationStoredReview } from './studio-publication.service.js'

const WORKSPACE_B = 'stored_review_workspace_b'
const inside = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const scoped = <T>(work: () => Promise<T>) => inside(LEGACY_WORKSPACE_ID, work)
const ids: Record<string, string> = {}
const ACCOUNT = 'stored-review-amazon'
const SCOPE = { channel: 'AMAZON', marketplace: 'IT', accountId: ACCOUNT }
const NOW = new Date(Date.UTC(2026, 9, 2, 12, 0))
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000)
const changeId = (productId: string) => JSON.stringify([productId, 'item_name'])

const facts = () => ({ scope: SCOPE, destination: { familyId: ids.root, aliasKey: null },
  account: { displayName: 'Amazon account' }, parent: { id: ids.root },
  products: [{ id: ids.root, sku: 'JACKET', name: 'Jacket' }, { id: ids.s, sku: 'JACKET-S', name: 'Jacket S' }],
  listings: [], resolved: [], issues: [], excluded: 0, aliasLabel: 'Primary listing', revision: 'facts-1' })

/** A batch child the way the batch review stage leaves it: a saved review, its plan and its default ticks. */
async function child(id: string, input: { status?: string; userId: string; expiresAt?: Date | null; ticks?: string[] | null; changePlan?: boolean }) {
  const review = { id, productId: ids.root, scope: SCOPE, accountLabel: 'Amazon account', aliasLabel: 'Primary listing', mode: 'live', action: 'update',
    excluded: 0, skipped: [], rows: [{ productId: ids.root, sku: 'JACKET', title: 'Jacket', existing: true }, { productId: ids.s, sku: 'JACKET-S', title: 'Jacket S', existing: true }],
    changes: [{ id: changeId(ids.root), productId: ids.root, sku: 'JACKET', field: 'item_name', label: 'Title', status: 'SEND', selectable: true, selectedByDefault: true },
      { id: changeId(ids.s), productId: ids.s, sku: 'JACKET-S', field: 'item_name', label: 'Title', status: 'DIFFERS', selectable: true, selectedByDefault: false }],
    issues: [], expiresAt: later(120).toISOString() }
  const ticks = input.ticks === undefined ? [changeId(ids.root)] : input.ticks
  await prisma.bulkOperation.create({ data: {
    id, userId: input.userId, status: input.status ?? 'PREVIEW', productCount: 2, changeCount: ticks?.length ?? 0, batchId: 'batch-1',
    kind: 'studio-publication', productId: ids.root, channel: 'AMAZON', marketplace: 'IT', channelConnectionId: ACCOUNT, aliasKey: '',
    expiresAt: input.expiresAt === undefined ? later(120) : input.expiresAt,
    changes: { kind: 'studio-publication', publicationKey: 'key-1', productId: ids.root, scope: SCOPE, revision: 'rev-1', review,
      ...(input.changePlan === false ? {} : { changeVersion: 1, changePlan: { kind: 'amazon-changes', changes: review.changes } }),
      ...(ticks ? { selection: { reviewId: id, token: 'token-1', selectedIds: ticks, fieldCount: ticks.length,
        products: [{ productId: ids.root, sku: 'JACKET' }], payload: { format: 'json', content: '{"secret-request":"PATCH item_name"}' } } } : {}) },
  } as never })
}

beforeAll(async () => {
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  fixture.facts.mockImplementation(async () => facts())
  await scoped(async () => {
    ids.owner = (await prisma.userProfile.create({ data: { displayName: 'Batch Owner', email: 'stored-review-owner@example.test' } as never })).id
    ids.other = (await prisma.userProfile.create({ data: { displayName: 'Colleague', email: 'stored-review-colleague@example.test' } as never })).id
    ids.root = (await prisma.product.create({ data: { sku: 'JACKET', name: 'Jacket', basePrice: 10, isParent: true } as never })).id
    ids.s = (await prisma.product.create({ data: { sku: 'JACKET-S', name: 'Jacket S', basePrice: 10, parentId: ids.root } as never })).id
  })
  await fixture.database.client.workspace.create({ data: { id: WORKSPACE_B, name: 'Other business', createdByUserId: ids.owner, creationKey: 'stored-review-b' } as never })
}, 120_000)

afterAll(async () => { vi.unstubAllEnvs(); await fixture.database?.close?.() })

describe('a saved review read back (T1, many-product dialog row)', () => {
  it('returns the saved review with its ticks, editable, and never the exact channel request', async () => {
    await scoped(() => child('ticked', { userId: ids.owner }))
    const read = await scoped(() => studioPublicationStoredReview(ids.root, 'ticked', ids.owner, NOW))
    expect(read).toMatchObject({ status: 'PREVIEW', selectedIds: [changeId(ids.root)], fieldCount: 1, editable: true })
    expect(read.review).toMatchObject({ id: 'ticked', productId: ids.root, scope: SCOPE, expiresAt: later(120).toISOString() })
    expect(read.review.changes?.map(c => c.id)).toEqual([changeId(ids.root), changeId(ids.s)])
    expect(JSON.stringify(read)).not.toContain('secret-request')
    expect(read).not.toHaveProperty('selection')
  })

  it('reads a review the preview saved exactly as the preview returned it, with no ticks yet', async () => {
    const preview = await scoped(() => previewStudioPublication(ids.root, SCOPE, ids.owner, { batchId: 'batch-2', expiresInMs: 2 * 60 * 60_000 }))
    expect(preview.id).toEqual(expect.any(String))
    const read = await scoped(() => studioPublicationStoredReview(ids.root, preview.id!, ids.owner))
    expect(read.review).toEqual(preview)
    expect(read).toMatchObject({ status: 'PREVIEW', selectedIds: null, fieldCount: null, editable: true })
  })

  it('cannot be edited when blocked, expired, already sent or without a field list', async () => {
    await scoped(async () => {
      await child('blocked', { userId: ids.owner, status: 'BLOCKED', ticks: null, changePlan: false })
      await child('expired', { userId: ids.owner, expiresAt: later(-1) })
      await child('sent', { userId: ids.owner, status: 'SUBMITTED' })
      await child('no-plan', { userId: ids.owner, changePlan: false })
    })
    for (const id of ['blocked', 'expired', 'sent', 'no-plan']) {
      const read = await scoped(() => studioPublicationStoredReview(ids.root, id, ids.owner, NOW))
      expect(read.editable, id).toBe(false)
      expect(read.review.id, id).toBe(id)
    }
    expect((await scoped(() => studioPublicationStoredReview(ids.root, 'blocked', ids.owner, NOW))).selectedIds).toBeNull()
  })

  it('is the creator’s only: another person, another product or another business gets not found', async () => {
    await scoped(() => child('private', { userId: ids.owner }))
    await expect(scoped(() => studioPublicationStoredReview(ids.root, 'private', ids.other, NOW))).rejects.toMatchObject({ statusCode: 404 })
    await expect(scoped(() => studioPublicationStoredReview(ids.s, 'private', ids.owner, NOW))).rejects.toMatchObject({ statusCode: 404 })
    await expect(inside(WORKSPACE_B, () => studioPublicationStoredReview(ids.root, 'private', ids.owner, NOW))).rejects.toMatchObject({ statusCode: 404 })
  })

  it('needs products.publish, like every studio publication route', () => {
    expect(permissionForRoute('GET', '/api/products/:id/studio-publication/:reviewId/review')).toBe('products.publish')
  })
})
