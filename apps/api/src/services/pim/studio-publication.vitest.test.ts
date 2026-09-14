import { beforeEach, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ facts: vi.fn(), amazon: vi.fn(), amazonStatus: vi.fn(), ebay: vi.fn(), mode: vi.fn(), rows: new Map<string, any>(), createListings: vi.fn(), updateListings: vi.fn(), locks: vi.fn(), shopPreview: vi.fn(), shopSend: vi.fn(), shopRead: vi.fn(), shopSave: vi.fn() }))
vi.mock('./studio-publication-plan.js', async original => {
  const { createHash } = await import('node:crypto')
  return { readPublicationFacts: m.facts, publicationDigest: (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex'), object: (v: any) => v && typeof v === 'object' ? v : {} }
})
vi.mock('@nexus/database/workspace-context', () => ({ workspaceIdForQuery: () => 'business-a' }))
vi.mock('../amazon-publish-gate.service.js', () => ({ getAmazonPublishMode: m.mode }))
vi.mock('../ebay-publish-gate.service.js', () => ({ getEbayPublishMode: m.mode }))
vi.mock('../shopify-publish-gate.service.js', () => ({ getShopifyPublishMode: m.mode }))
vi.mock('./studio-publication-amazon.js', () => ({ prepareAmazonPublication: async () => ({ kind: 'amazon', feed: { messages: [{ sku: 'SELLER-SKU' }, { sku: 'SELLER-CHILD' }] } }), sendAmazonPublication: m.amazon, readAmazonPublication: m.amazonStatus }))
vi.mock('./studio-publication-ebay.js', () => ({ prepareEbayPublication: async () => ({ kind: 'ebay', xml: '<Item/>' }), sendEbayPublication: m.ebay }))
vi.mock('../shopify/content-workspace.service.js', () => ({ getContentWorkspace: m.shopRead, saveContentWorkspace: m.shopSave }))
vi.mock('../shopify/content-sync.service.js', () => ({ previewContentSync: m.shopPreview, synchronizeContent: m.shopSend }))
vi.mock('./workspace-destination.js', () => ({ WorkspaceScopeError: class extends Error { statusCode: number; constructor(message: string, statusCode = 409) { super(message); this.statusCode = statusCode } } }))
vi.mock('../../db.js', () => {
  const matches = (row: any, where: any) => (!where.id || (typeof where.id === 'string' ? row.id === where.id : row.id !== where.id.not))
    && (!Object.hasOwn(where, 'userId') || row.userId === where.userId)
    && (!where.status || (typeof where.status === 'string' ? row.status === where.status : where.status.in.includes(row.status)))
    && (!where.changes || row.changes[where.changes.path[0]] === where.changes.equals)
  const db = { bulkOperation: {
    findFirst: async ({ where }: any) => [...m.rows.values()].find(row => matches(row, where)) ?? null,
    create: async ({ data }: any) => { m.rows.set(data.id, data); return data },
    updateMany: async ({ where, data }: any) => { const rows = [...m.rows.values()].filter(row => matches(row, where)); for (const row of rows) m.rows.set(row.id, { ...row, ...data }); return { count: rows.length } },
    update: async ({ where, data }: any) => { const row = { ...m.rows.get(where.id), ...data }; m.rows.set(where.id, row); return row },
  }, channelListing: { createMany: m.createListings, updateMany: m.updateListings }, $queryRawUnsafe: m.locks, $transaction: async (fn: any) => fn(db) }
  return { default: db }
})
import { previewStudioPublication, submitStudioPublication, studioPublicationResult } from './studio-publication.service.js'

const scope = { channel: 'AMAZON', marketplace: 'IT', accountId: 'seller-b', listingId: 'alias-listing' }
const facts = () => ({ scope, destination: { familyId: 'parent', aliasKey: 'alias-b' }, account: { displayName: 'Store B' }, parent: { id: 'parent' },
  products: [{ id: 'parent', sku: 'SKU', name: 'Saved title' }, { id: 'child', sku: 'CHILD', name: 'Child' }], listings: [], resolved: [], issues: [], excluded: 1, aliasLabel: 'Second listing', revision: 'v1' })

beforeEach(() => { vi.clearAllMocks(); m.rows.clear(); m.mode.mockReturnValue('live'); m.facts.mockImplementation(async () => facts()); m.amazon.mockResolvedValue('feed-42'); m.amazonStatus.mockResolvedValue(null); m.ebay.mockResolvedValue('123'); m.createListings.mockResolvedValue({ count: 2 }); m.updateListings.mockResolvedValue({ count: 2 }) })

it('reviews saved family values and publishes directly to the exact account and alias, without marking an Amazon acknowledgement live', async () => {
  const review = await previewStudioPublication('parent', scope, 'user')
  expect(review).toMatchObject({ scope, aliasLabel: 'Second listing', accountLabel: 'Store B', excluded: 1, action: 'create' })
  const result = await submitStudioPublication('parent', review.id!, {}, 'user')
  expect(result.status).toBe('SUBMITTED')
  expect(result.results).toHaveLength(2)
  expect(m.amazon).toHaveBeenCalledWith(expect.objectContaining({ kind: 'amazon' }), 'seller-b')
  expect(m.updateListings).not.toHaveBeenCalled()
  expect(m.createListings.mock.calls[0][0].data).toEqual(expect.arrayContaining([expect.objectContaining({ productId: 'child', channelConnectionId: 'seller-b', aliasKey: 'alias-b', isPublished: false })]))
})

it('deduplicates overlapping sends and later retries using the durable review', async () => {
  const review = await previewStudioPublication('parent', scope, 'user')
  const results = await Promise.all([submitStudioPublication('parent', review.id!, {}, 'user'), submitStudioPublication('parent', review.id!, {}, 'user')])
  expect(m.amazon).toHaveBeenCalledTimes(1)
  expect(results.some(r => r.status === 'SUBMITTED')).toBe(true)
  expect(await submitStudioPublication('parent', review.id!, {}, 'user')).toMatchObject({ status: 'SUBMITTED' })
  expect(m.amazon).toHaveBeenCalledTimes(1)
  expect(m.locks).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), expect.stringContaining('studio-publication:'))
})

it('refuses changed saved values before any provider mutation', async () => {
  const review = await previewStudioPublication('parent', scope, 'user')
  m.facts.mockResolvedValue({ ...facts(), revision: 'v2' })
  await expect(submitStudioPublication('parent', review.id!, {}, 'user')).rejects.toThrow('changed')
  expect(m.amazon).not.toHaveBeenCalled(); expect(m.createListings).not.toHaveBeenCalled()
})

it('refuses cross-user and cross-product review IDs', async () => {
  const review = await previewStudioPublication('parent', scope, 'user')
  await expect(submitStudioPublication('parent', review.id!, {}, 'other')).rejects.toThrow('not found')
  await expect(studioPublicationResult('different', review.id!, 'user')).rejects.toThrow('not found')
  expect(m.amazon).not.toHaveBeenCalled()
})

it('never offers a live send for a blocked or simulated destination', async () => {
  m.mode.mockReturnValue('dry-run')
  expect(await previewStudioPublication('parent', scope, 'user')).toMatchObject({ id: null, issues: expect.arrayContaining([expect.objectContaining({ severity: 'error' })]) })
  expect(m.rows.size).toBe(0); expect(m.amazon).not.toHaveBeenCalled()
})

it('refuses an expired review and a gate changed after review', async () => {
  const review = await previewStudioPublication('parent', scope, 'user')
  const row = m.rows.get(review.id!)
  row.expiresAt = new Date(0)
  await expect(submitStudioPublication('parent', review.id!, {}, 'user')).rejects.toThrow('expired')
  row.expiresAt = new Date(Date.now() + 60_000); m.mode.mockReturnValue('gated')
  await expect(submitStudioPublication('parent', review.id!, {}, 'user')).rejects.toThrow('changed')
  expect(m.amazon).not.toHaveBeenCalled()
})

it('keeps an ambiguous provider failure durable and blocks blind republishing', async () => {
  const review = await previewStudioPublication('parent', scope, 'user')
  m.amazon.mockRejectedValue(new Error('Connection closed after sending'))
  expect(await submitStudioPublication('parent', review.id!, {}, 'user')).toMatchObject({ status: 'UNVERIFIED' })
  expect(await studioPublicationResult('parent', review.id!, 'user')).toMatchObject({ status: 'UNVERIFIED' })
  expect(await previewStudioPublication('parent', scope, 'user')).toMatchObject({ id: null, issues: expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('previous publication') })]) })
})

it('distinguishes a refused preflight from an uncertain send so corrected data can be reviewed', async () => {
  const review = await previewStudioPublication('parent', scope, 'user')
  m.amazon.mockRejectedValue(Object.assign(new Error('Missing identifier'), { notSent: true }))
  expect(await submitStudioPublication('parent', review.id!, {}, 'user')).toMatchObject({ status: 'FAILED', message: 'Nothing was submitted. Missing identifier' })
  expect((await previewStudioPublication('parent', scope, 'user')).id).not.toBeNull()
})

it('resumes a pending feed from a reopened review and releases it only after a real processing report', async () => {
  const review = await previewStudioPublication('parent', scope, 'user')
  await submitStudioPublication('parent', review.id!, {}, 'user')
  expect(await previewStudioPublication('parent', scope, 'user')).toMatchObject({ id: null, previousPublicationId: review.id })
  m.amazonStatus.mockResolvedValue({ results: [{ sku: 'SELLER-SKU', failed: false, message: 'Processed' }, { sku: 'SELLER-CHILD', failed: true, message: 'Invalid size' }] })
  expect(await studioPublicationResult('parent', review.id!, 'user')).toMatchObject({ status: 'PARTIAL', results: [expect.objectContaining({ status: 'ACCEPTED' }), expect.objectContaining({ status: 'FAILED', message: 'Invalid size' })] })
  expect(m.amazonStatus).toHaveBeenCalledWith('feed-42', 'seller-b', ['SELLER-SKU', 'SELLER-CHILD'])
  expect((await previewStudioPublication('parent', scope, 'user')).id).not.toBeNull()
  expect(m.updateListings).not.toHaveBeenCalled()
})

it('does not call a local draft write failure an uncertain channel send', async () => {
  const review = await previewStudioPublication('parent', scope, 'user')
  m.createListings.mockRejectedValue(new Error('Database unavailable'))
  expect(await submitStudioPublication('parent', review.id!, {}, 'user')).toMatchObject({ status: 'FAILED', message: 'Nothing was submitted. Database unavailable' })
  expect(m.amazon).not.toHaveBeenCalled()
})

it('uses Shopify’s native family publisher with the saved visibility, both revisions and the selected store location', async () => {
  const shopScope = { channel: 'SHOPIFY', marketplace: 'GLOBAL', accountId: 'shop-b', listingId: 'shop-alias' }
  m.facts.mockResolvedValue({ ...facts(), scope: shopScope, excluded: 0 })
  m.shopRead.mockResolvedValue({ initialized: false, draft: { options: ['Size'] }, revision: 'uninitialized' })
  m.shopSave.mockResolvedValue({ revision: 'draft-v1' })
  m.shopPreview.mockResolvedValue({ errors: [], initialized: true, revision: 'draft-v1', remoteRevision: 'remote-v2', draft: { options: ['Size'] }, changes: { newProductStatus: 'DRAFT' }, locations: [{ id: 'shop-location', name: 'Warehouse', isActive: true }] })
  m.shopSend.mockResolvedValue({ productId: 'gid://shopify/Product/42' })
  const review = await previewStudioPublication('parent', shopScope, 'user')
  expect(review.visibility).toBe('DRAFT')
  expect(m.shopSave).toHaveBeenCalledWith('parent', { accountId: 'shop-b', listingId: 'shop-alias', market: 'GLOBAL' }, { draft: { options: ['Size'] }, expectedRevision: 'uninitialized' })
  await expect(submitStudioPublication('parent', review.id!, { locationId: 'other-store' }, 'user')).rejects.toThrow('inventory location')
  expect(m.shopSend).not.toHaveBeenCalled()
  expect(await submitStudioPublication('parent', review.id!, { locationId: 'shop-location' }, 'user')).toMatchObject({ status: 'VERIFIED', message: expect.stringContaining('DRAFT') })
  expect(m.shopSend).toHaveBeenCalledWith('parent', { accountId: 'shop-b', listingId: 'shop-alias', market: 'GLOBAL' }, { expectedRevision: 'draft-v1', expectedRemoteRevision: 'remote-v2', locationId: 'shop-location', confirmActive: true })
})
