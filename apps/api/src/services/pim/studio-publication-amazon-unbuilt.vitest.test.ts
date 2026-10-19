/**
 * Option A (Owner 2026-10-19) — an Amazon family row the builder cannot build is left out by its own problem, and the
 * other rows still go. The baseline was judged against every included row, so the one unbuilt row failed its identity rule
 * ("Every included publication product needs its exact provider identity"): an error with no field and no product, which
 * left the whole family with no change list. The baseline here is the real one (its accepted records read empty).
 */
import { beforeEach, expect, it, vi } from 'vitest'
import { blockedChangeIds, type StudioPublishChange } from '@nexus/shared/studio-publication'

const m = vi.hoisted(() => ({ facts: vi.fn(), mode: vi.fn(), rows: new Map<string, any>() }))
vi.mock('./studio-publication-plan.js', async () => {
  const { createHash } = await import('node:crypto')
  return { readPublicationFacts: m.facts, publicationDigest: (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex'), object: (v: any) => v && typeof v === 'object' && !Array.isArray(v) ? v : {} }
})
vi.mock('./workspace-destination.js', () => ({ WorkspaceScopeError: class extends Error { statusCode: number; constructor(message: string, statusCode = 409) { super(message); this.statusCode = statusCode } } }))
vi.mock('@nexus/database/workspace-context', () => ({ workspaceIdForQuery: () => 'business-a' }))
vi.mock('../amazon-publish-gate.service.js', () => ({ getAmazonPublishMode: m.mode }))
vi.mock('../ebay-publish-gate.service.js', () => ({ getEbayPublishMode: m.mode }))
vi.mock('../shopify-publish-gate.service.js', () => ({ getShopifyPublishMode: m.mode }))
vi.mock('./studio-publication-overwrite.js', () => ({ readPublicationOverwrite: async () => ({ requiresConfirmation: false, products: [] }) }))
vi.mock('./studio-publication-records.js', () => ({ recordPublicationRequests: vi.fn(), settlePublicationRecords: vi.fn() }))
// FAM-3 cannot be built: the builder leaves it out with its own problem and builds the others (`prepareAmazonPublication`).
const built = [{ productId: 'family', sku: 'FAM' }, { productId: 'c1', sku: 'FAM-1' }, { productId: 'c2', sku: 'FAM-2' }]
const unbuiltIssue = { productId: 'c3', sku: 'FAM-3', severity: 'error' as const, message: 'FAM-3 could not be resolved.' }
vi.mock('./studio-publication-amazon.js', () => ({
  prepareAmazonPublication: async () => ({ kind: 'amazon', sellerId: 'seller', marketplaceId: 'market', products: built,
    feed: { header: { version: '2.0' }, messages: built.map((p, i) => ({ messageId: i + 1, sku: p.sku, operationType: 'PATCH', productType: 'COAT', patches: [] })) }, issues: [unbuiltIssue] }),
  sendAmazonPublication: vi.fn(), readAmazonPublication: vi.fn(async () => null), amazonMovesWithoutPublication: vi.fn(),
}))
vi.mock('./studio-publication-amazon-changes.js', async () => {
  const { publicationChangeId } = await import('./studio-publication-changes.js')
  const change = (productId: string, sku: string): StudioPublishChange => ({ id: publicationChangeId(productId, 'item_name'), productId, sku, field: 'item_name', label: 'Title',
    current: { state: 'value', value: `New ${sku}` }, lastAccepted: { state: 'unknown', reason: 'No accepted publish record' }, channel: { state: 'value', value: `Old ${sku}` },
    localChanged: true, channelChanged: false, status: 'SEND', selectable: true, selectedByDefault: true, reason: 'Reviewed field', operation: 'replace' })
  return {
    prepareAmazonChanges: async (_facts: unknown, prepared: any) => ({ kind: 'amazon-changes', changes: prepared.products.map((p: any) => change(p.productId, p.sku)), remoteRevision: 'remote-1',
      publication: prepared, products: prepared.products.map((p: any) => ({ ...p, newListing: false })), schemas: [] }),
    compileAmazonChanges: (plan: any, ids: string[]) => {
      const products = plan.publication.products.filter((p: any) => plan.changes.some((c: any) => ids.includes(c.id) && c.productId === p.productId))
      return { ...plan.publication, products, feed: { header: { version: '2.0' }, messages: products.map((p: any, i: number) => ({ messageId: i + 1, sku: p.sku, operationType: 'PATCH', productType: 'COAT',
        patches: [{ op: 'replace', path: '/attributes/item_name', value: [{ value: `New ${p.sku}` }] }] })) } }
    },
  }
})
// Publish starts missing rows through the one creator (`ensureDraftListings`); its own rules run on PostgreSQL.
vi.mock('./draft-listing.service.js', () => ({ ensureDraftListings: async () => [] }))
vi.mock('../../db.js', () => {
  const matches = (row: any, where: any) => (!where.id || (typeof where.id === 'string' ? row.id === where.id : row.id !== where.id.not))
    && (!Object.hasOwn(where, 'userId') || row.userId === where.userId)
    && (!where.status || (typeof where.status === 'string' ? row.status === where.status : where.status.in.includes(row.status)))
    && (!where.changes || JSON.stringify(row.changes) === JSON.stringify(where.changes.equals))
  const db: any = { bulkOperation: {
    findFirst: async ({ where }: any) => structuredClone([...m.rows.values()].find(row => matches(row, where)) ?? null),
    create: async ({ data }: any) => { m.rows.set(data.id, structuredClone(data)); return structuredClone(data) },
    updateMany: async ({ where, data }: any) => { const rows = [...m.rows.values()].filter(row => matches(row, where)); for (const row of rows) m.rows.set(row.id, structuredClone({ ...row, ...data })); return { count: rows.length } },
    update: async ({ where, data }: any) => { const row = { ...m.rows.get(where.id), ...data }; m.rows.set(where.id, structuredClone(row)); return structuredClone(row) },
  }, channelListing: { createMany: async () => ({ count: 0 }), updateMany: async () => ({ count: 0 }), count: async () => 0 },
  // The baseline's accepted records: none yet.
  channelListingSnapshot: { findMany: async () => [] }, $queryRawUnsafe: async () => [], $transaction: async (fn: any) => fn(db) }
  return { default: db }
})
import { previewStudioPublication, previewStudioPublicationSelection } from './studio-publication.service.js'

const scope = { channel: 'AMAZON', marketplace: 'IT', accountId: 'account' }
const ids = ['family', 'c1', 'c2', 'c3']
const facts = () => ({ scope, destination: { familyId: 'family', aliasKey: '', currency: 'EUR' }, account: { displayName: 'Amazon IT' }, parent: { id: 'family', sku: 'FAM' },
  products: ids.map((id, i) => ({ id, sku: i ? `FAM-${i}` : 'FAM', name: id })),
  listings: ids.map((id, i) => ({ id: `l-${id}`, productId: id, channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'account', aliasKey: '', externalListingId: `B0FX00000${i}`, platformAttributes: {} })),
  resolved: [], issues: [], excluded: 0, aliasLabel: 'Primary listing', revision: 'facts-1' })

beforeEach(() => {
  vi.clearAllMocks(); m.rows.clear()
  m.mode.mockReturnValue('live'); m.facts.mockImplementation(async () => facts())
})

it('an unbuilt row blocks only itself: the built rows keep their change list, with no identity error', async () => {
  const review = await previewStudioPublication('family', scope, 'owner')
  expect(review.issues).not.toContainEqual(expect.objectContaining({ message: expect.stringMatching(/exact provider identity/) }))
  expect(review.issues.filter(issue => issue.severity === 'error')).toEqual([unbuiltIssue])
  expect(review.rows.map(row => row.sku)).toEqual(['FAM', 'FAM-1', 'FAM-2', 'FAM-3'])
  expect(review.changes!.map(change => change.sku)).toEqual(['FAM', 'FAM-1', 'FAM-2'])
  expect(blockedChangeIds(review).size).toBe(0)
})

it('a built row of that family can be selected', async () => {
  const review = await previewStudioPublication('family', scope, 'owner')
  const change = review.changes!.find(c => c.productId === 'c1')!
  const selection = await previewStudioPublicationSelection('family', review.id!, { selectedIds: [change.id] }, 'owner')
  expect(selection).toMatchObject({ selectedIds: [change.id], products: [{ productId: 'c1', sku: 'FAM-1' }], fieldCount: 1 })
})
