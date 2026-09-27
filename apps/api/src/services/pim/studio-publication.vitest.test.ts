import { beforeEach, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ facts: vi.fn(), drift: vi.fn(), amazon: vi.fn(), amazonStatus: vi.fn(), ebay: vi.fn(), ebayStatus: vi.fn(), mode: vi.fn(), rows: new Map<string, any>(), persistenceFailure: vi.fn(), persisted: vi.fn(), createListings: vi.fn(), ensure: vi.fn(), updateListings: vi.fn(), locks: vi.fn(), shopPreview: vi.fn(), shopSend: vi.fn(), shopRead: vi.fn(), shopSave: vi.fn(), snapshots: vi.fn(), findListings: vi.fn(), fill: vi.fn(), events: [] as string[] }))
vi.mock('./studio-publication-plan.js', async original => {
  const { createHash } = await import('node:crypto')
  return { readPublicationFacts: m.facts, publicationDigest: (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex'), object: (v: any) => v && typeof v === 'object' ? v : {} }
})
vi.mock('@nexus/database/workspace-context', () => ({ workspaceIdForQuery: () => 'business-a' }))
vi.mock('../amazon-publish-gate.service.js', () => ({ getAmazonPublishMode: m.mode }))
vi.mock('../ebay-publish-gate.service.js', () => ({ getEbayPublishMode: m.mode }))
vi.mock('../shopify-publish-gate.service.js', () => ({ getShopifyPublishMode: m.mode }))
vi.mock('./studio-publication-amazon.js', () => ({ prepareAmazonPublication: async () => ({ kind: 'amazon', sellerId: 'seller', marketplaceId: 'market',
  products: [{ productId: 'parent', sku: 'SELLER-SKU' }, { productId: 'child', sku: 'SELLER-CHILD' }],
  feed: { header: { version: '2.0' }, messages: [{ sku: 'SELLER-SKU' }, { sku: 'SELLER-CHILD' }] } }), sendAmazonPublication: m.amazon, readAmazonPublication: m.amazonStatus }))
vi.mock('./studio-publication-ebay.js', () => ({ prepareEbayPublication: async (facts: any) => ({ kind: 'ebay', marketplace: 'IT', itemId: '123', xml: '<Item/>',
  products: facts.products.map((p: any) => ({ productId: p.id, sku: p.sku })) }), sendEbayPublication: m.ebay, readEbayPublication: m.ebayStatus,
  ebayPublicationRequest: (plan: any) => ({ operation: 'ReviseFixedPriceItem', xml: plan.xml }), usesEbayInventory: () => false, prepareEbayInventoryPublication: vi.fn() }))
vi.mock('./studio-publication-baseline.js', () => ({ readPublicationBaseline: async () => ({ values: new Map(), revision: 'baseline-1' }) }))
vi.mock('./studio-publication-amazon-changes.js', () => ({
  prepareAmazonChanges: async (_facts: any, publication: any) => ({ kind: 'amazon-changes', publication, remoteRevision: 'remote-1', products: [], schemas: [],
    changes: publication.products.map((p: any) => ({ id: p.productId, ...p, field: 'title', label: 'Title', current: { state: 'value', value: 'Saved title' },
      lastAccepted: { state: 'unknown', reason: 'No record' }, channel: { state: 'unknown', reason: 'New listing' }, status: 'SEND', selectable: true, selectedByDefault: true, localChanged: null, channelChanged: null, reason: 'Create', operation: 'replace' })) }),
  compileAmazonChanges: (plan: any, ids: string[]) => ({ ...plan.publication, products: plan.publication.products.filter((p: any) => ids.includes(p.productId)),
    feed: { ...plan.publication.feed, messages: plan.publication.feed.messages.filter((message: any) => plan.publication.products.some((p: any) => p.sku === message.sku && ids.includes(p.productId))) },
    fieldWrites: Object.fromEntries(plan.changes.filter((c: any) => ids.includes(c.id)).map((c: any) => [c.productId, [{ field: c.field, value: c.current }]])) }),
}))
vi.mock('./studio-publication-ebay-changes.js', () => ({
  prepareEbayChanges: async (_facts: any, publication: any) => ({ kind: 'ebay-changes', publication, remoteRevision: 'remote-1',
    changes: publication.products.map((p: any) => ({ id: p.productId, ...p, field: 'title', label: 'Title', current: { state: 'value', value: 'Saved title' },
      lastAccepted: { state: 'unknown', reason: 'No record' }, channel: { state: 'unknown', reason: 'New listing' }, status: 'SEND', selectable: true, selectedByDefault: true, localChanged: null, channelChanged: null, reason: 'Create', operation: 'replace' })) }),
  compileEbayChanges: (plan: any, ids: string[]) => ({ ...plan.publication, products: plan.publication.products.filter((p: any) => ids.includes(p.productId)),
    fieldWrites: Object.fromEntries(plan.changes.filter((c: any) => ids.includes(c.id)).map((c: any) => [c.productId, [{ field: c.field, value: c.current }]])) }),
}))
// Durable exact-payload writes are exercised against formulaDatabase in the database suite.
vi.mock('./studio-publication-records.js', () => ({ recordPublicationRequests: vi.fn(), settlePublicationRecords: vi.fn() }))
vi.mock('../shopify/content-workspace.service.js', () => ({ getContentWorkspace: m.shopRead, saveContentWorkspace: m.shopSave }))
vi.mock('../shopify/content-sync.service.js', () => ({ previewContentSync: m.shopPreview, synchronizeContent: m.shopSend }))
// Product-sheet create path, step 5 — Publish starts missing rows through the one creator; its own rules run on PostgreSQL.
vi.mock('./draft-listing.service.js', () => ({ ensureDraftListings: m.ensure }))
// The ASIN read after an Amazon promotion calls Amazon; here it only records when it ran.
vi.mock('../amazon/listing-asin-fill.service.js', () => ({ fillAmazonListingAsins: m.fill }))
vi.mock('./workspace-destination.js', () => ({ WorkspaceScopeError: class extends Error { statusCode: number; constructor(message: string, statusCode = 409) { super(message); this.statusCode = statusCode } } }))
vi.mock('../../db.js', () => {
  const matches = (row: any, where: any) => (!where.id || (typeof where.id === 'string' ? row.id === where.id : row.id !== where.id.not))
    && (!Object.hasOwn(where, 'userId') || row.userId === where.userId)
    && (!where.status || (typeof where.status === 'string' ? row.status === where.status : where.status.in.includes(row.status)))
    && (!where.changes || (where.changes.path ? row.changes[where.changes.path[0]] === where.changes.equals : JSON.stringify(row.changes) === JSON.stringify(where.changes.equals)))
  const db = { channelDrift: { findMany: m.drift }, bulkOperation: {
    findFirst: async ({ where }: any) => structuredClone([...m.rows.values()].find(row => matches(row, where)) ?? null),
    create: async ({ data }: any) => { m.rows.set(data.id, structuredClone(data)); return structuredClone(data) },
    updateMany: async ({ where, data }: any) => { m.persistenceFailure(data); const rows = [...m.rows.values()].filter(row => matches(row, where)); for (const row of rows) m.rows.set(row.id, structuredClone({ ...row, ...data })); return { count: rows.length } },
    update: async ({ where, data }: any) => { m.persistenceFailure(data); const row = { ...m.rows.get(where.id), ...data }; m.rows.set(where.id, structuredClone(row)); await m.persisted(row); return structuredClone(row) },
  }, channelListing: { createMany: m.createListings, updateMany: m.updateListings, findMany: m.findListings, count: async () => 2 },
  // Draft promotion reads the settled records; they are real only in the database suite. `commit` marks a transaction's end.
  channelListingSnapshot: { findMany: m.snapshots }, $queryRawUnsafe: m.locks, $transaction: async (fn: any) => { const out = await fn(db); m.events.push('commit'); return out } }
  return { default: db }
})
import { previewStudioPublication as previewRaw, submitStudioPublication as submitRaw, previewStudioPublicationSelection, studioPublicationResult } from './studio-publication.service.js'

// Existing recovery tests explicitly review a selection before their send/result scenario.
async function previewStudioPublication(...args: Parameters<typeof previewRaw>) {
  const review = await previewRaw(...args)
  if (review.id && ['AMAZON', 'EBAY'].includes(args[1].channel)) await previewStudioPublicationSelection(args[0], review.id, { selectedIds: review.changes?.filter(c => c.selectable).map(c => c.id) ?? [] }, args[2])
  return review
}
const submitStudioPublication = (productId: string, id: string, body: Record<string, unknown>, userId: string | null) =>
  submitRaw(productId, id, { ...body, selectionToken: m.rows.get(id)?.changes.selection?.token }, userId)

const scope = { channel: 'AMAZON', marketplace: 'IT', accountId: 'seller-b', listingId: 'alias-listing' }
const facts = () => ({ scope, destination: { familyId: 'parent', aliasKey: 'alias-b' }, account: { displayName: 'Store B' }, parent: { id: 'parent' },
  products: [{ id: 'parent', sku: 'SKU', name: 'Saved title' }, { id: 'child', sku: 'CHILD', name: 'Child' }], listings: [], resolved: [], issues: [], excluded: 1, aliasLabel: 'Second listing', revision: 'v1' })

beforeEach(() => { vi.resetAllMocks(); m.rows.clear(); m.drift.mockResolvedValue([]); m.mode.mockReturnValue('live'); m.facts.mockImplementation(async () => facts()); m.amazon.mockResolvedValue('feed-42'); m.amazonStatus.mockResolvedValue(null); m.ebay.mockResolvedValue({ reference: '123', warnings: ['eBay adjusted the shipping value.'] }); m.ebayStatus.mockResolvedValue({ reference: '123', warnings: [], verified: true }); m.createListings.mockResolvedValue({ count: 2 }); m.ensure.mockResolvedValue([]); m.updateListings.mockResolvedValue({ count: 2 })
  m.snapshots.mockResolvedValue([]); m.findListings.mockResolvedValue([]); m.events.length = 0
  m.fill.mockImplementation(async () => { m.events.push('fill'); return { dryRun: false, rows: [], counts: {} } }) })

const existingFacts = () => ({ ...facts(), listings: [{ id: 'listing-parent', productId: 'parent', externalListingId: 'existing-item' }] })
const contentObservation = (theirs = 'Channel title') => ({ channelListingId: 'listing-parent',
  checkedBySource: { 'amazon-content': { at: '2026-09-24T18:40:00.000Z', outcome: 'compared', differing: 1, notCompared: 12 } },
  driftedFields: [{ source: 'amazon-content', field: 'item_name', ours: 'Earlier Nexus title', theirs, checkedAt: '2026-09-24T18:40:00.000Z' }] })

it('reviews historical content differences and unread children before an existing listing overwrite', async () => {
  m.facts.mockResolvedValue({ ...existingFacts(), listings: [...existingFacts().listings, { id: 'listing-child', productId: 'child', externalListingId: 'existing-child' }] })
  m.drift.mockResolvedValue([contentObservation()])
  const review = await previewStudioPublication('parent', scope, 'user')
  expect(review.overwrite).toMatchObject({ requiresConfirmation: true, products: [
    { productId: 'parent', sku: 'SKU', status: 'compared', notCompared: 12,
      fields: [{ field: 'item_name', nexusAtRead: 'Earlier Nexus title', channelAtRead: 'Channel title' }] },
    { productId: 'child', sku: 'CHILD', status: 'not_read', fields: [] },
  ] })
  expect(m.amazon).not.toHaveBeenCalled()
})

it.each([undefined, false, 'forged', 1])('refuses an existing listing send without the exact selection token (%s)', async selectionToken => {
  m.facts.mockResolvedValue(existingFacts())
  const review = await previewStudioPublication('parent', scope, 'user')
  await expect(submitRaw('parent', review.id!, { selectionToken, confirmOverwrite: true }, 'user')).rejects.toThrow(/selection|token|review/i)
  expect(m.amazon).not.toHaveBeenCalled(); expect(m.ensure).not.toHaveBeenCalled()
  expect(m.rows.get(review.id!).status).toBe('PREVIEW')
})

it('records the explicitly reviewed sparse selection with the submitted review', async () => {
  m.facts.mockResolvedValue(existingFacts())
  const review = await previewStudioPublication('parent', scope, 'user')
  expect(await submitStudioPublication('parent', review.id!, { confirmOverwrite: true }, 'user')).toMatchObject({ status: 'SUBMITTED' })
  expect(m.rows.get(review.id!).changes.selection.token).toEqual(expect.any(String))
  expect(m.amazon).toHaveBeenCalledOnce()
})

it('invalidates the selected review when the observed channel differences change', async () => {
  m.facts.mockResolvedValue(existingFacts()); m.drift.mockResolvedValue([contentObservation()])
  const review = await previewStudioPublication('parent', scope, 'user')
  m.drift.mockResolvedValue([contentObservation('A more recent channel title')])
  await expect(submitStudioPublication('parent', review.id!, { confirmOverwrite: true }, 'user')).rejects.toThrow(/changed/i)
  expect(m.amazon).not.toHaveBeenCalled(); expect(m.ensure).not.toHaveBeenCalled()
})

it('checkpoints eBay acknowledgement before read-back and recovers local persistence without resending', async () => {
  const ebayScope = { ...scope, channel: 'EBAY' }
  m.facts.mockImplementation(async () => ({ ...facts(), scope: ebayScope }))
  const review = await previewStudioPublication('parent', ebayScope, 'user')
  m.ebayStatus.mockImplementation(async () => {
    expect(m.rows.get(review.id!).changes.result.results[0].reference).toBe('123')
    return { reference: '123', warnings: [], verified: true }
  })
  m.updateListings.mockRejectedValueOnce(new Error('Local connection lost'))
  const pending = await submitStudioPublication('parent', review.id!, {}, 'user')
  expect(pending).toMatchObject({ status: 'UNVERIFIED', warnings: ['eBay adjusted the shipping value.'], results: [expect.objectContaining({ reference: '123' }), expect.anything()] })
  expect(await studioPublicationResult('parent', review.id!, 'user')).toMatchObject({ status: 'ACCEPTED', warnings: ['eBay adjusted the shipping value.'] })
  expect(m.ebay).toHaveBeenCalledOnce()
  expect(m.ebayStatus).toHaveBeenCalledWith('123', 'seller-b', 'IT')
  expect(m.updateListings.mock.calls.at(-1)![0].where).toMatchObject({ channelConnectionId: 'seller-b', aliasKey: 'alias-b', marketplace: 'IT' })
})

it('keeps an acknowledged eBay item unresolved until the reviewed account confirms it', async () => {
  const ebayScope = { ...scope, channel: 'EBAY' }
  m.facts.mockImplementation(async () => ({ ...facts(), scope: ebayScope }))
  m.ebayStatus.mockResolvedValue(null)
  const review = await previewStudioPublication('parent', ebayScope, 'user')
  expect(await submitStudioPublication('parent', review.id!, {}, 'user')).toMatchObject({ status: 'UNVERIFIED', results: [expect.objectContaining({ reference: '123', status: 'ACCEPTED' }), expect.anything()] })
  expect(m.updateListings).not.toHaveBeenCalled()
  expect(await previewStudioPublication('parent', ebayScope, 'user')).toMatchObject({ id: null, previousPublicationId: review.id })
})

it('reports an interrupted send honestly after its deadline without blindly resubmitting', async () => {
  const review = await previewStudioPublication('parent', scope, 'user')
  const row = m.rows.get(review.id!)
  row.status = 'PUBLISHING'; row.changes.startedAt = new Date(Date.now() - 31 * 60_000).toISOString()
  expect(await studioPublicationResult('parent', review.id!, 'user')).toMatchObject({ status: 'UNVERIFIED', message: expect.stringContaining('receipt') })
  expect(await submitStudioPublication('parent', review.id!, {}, 'user')).toMatchObject({ status: 'UNVERIFIED' })
  expect(m.amazon).not.toHaveBeenCalled()
})

it('refuses edits that land while waiting to claim the publication', async () => {
  const review = await previewStudioPublication('parent', scope, 'user')
  m.locks.mockImplementation(async () => { m.facts.mockResolvedValue({ ...facts(), revision: 'v2' }) })
  expect(await submitStudioPublication('parent', review.id!, {}, 'user')).toMatchObject({ status: 'FAILED', message: expect.stringContaining('changed') })
  expect(m.amazon).not.toHaveBeenCalled()
})

it('does not overwrite a processing report that arrives before the submit response finishes', async () => {
  const review = await previewStudioPublication('parent', scope, 'user')
  m.amazonStatus.mockResolvedValue({ results: [{ sku: 'SELLER-SKU', failed: false }, { sku: 'SELLER-CHILD', failed: false }] })
  m.persisted.mockImplementationOnce(async () => { await studioPublicationResult('parent', review.id!, 'user') })
  expect(await submitStudioPublication('parent', review.id!, {}, 'user')).toMatchObject({ status: 'ACCEPTED' })
  expect(m.rows.get(review.id!).status).toBe('ACCEPTED')
})

it.each(['AMAZON', 'EBAY'])('returns the known %s receipt if the database goes down immediately after acknowledgement', async channel => {
  const selectedScope = { ...scope, channel }
  m.facts.mockImplementation(async () => ({ ...facts(), scope: selectedScope }))
  const review = await previewStudioPublication('parent', selectedScope, 'user')
  m.persistenceFailure.mockImplementation(data => { if (data.status !== 'PUBLISHING') throw new Error('Database is unavailable') })
  const result = await submitStudioPublication('parent', review.id!, {}, 'user')
  expect(result).toMatchObject({ id: review.id, status: 'UNVERIFIED', message: expect.stringContaining('could not record'),
    results: [expect.objectContaining({ reference: channel === 'AMAZON' ? 'feed-42' : '123' }), expect.anything()] })
  expect(m.rows.get(review.id!).status).toBe('PUBLISHING')
  expect(channel === 'AMAZON' ? m.amazon : m.ebay).toHaveBeenCalledOnce()
})

it('reviews saved family values and publishes directly to the exact account and alias, without marking an Amazon acknowledgement live', async () => {
  const review = await previewStudioPublication('parent', scope, 'user')
  expect(review).toMatchObject({ scope, aliasLabel: 'Second listing', accountLabel: 'Store B', excluded: 1, action: 'create' })
  const result = await submitStudioPublication('parent', review.id!, {}, 'user')
  expect(result.status).toBe('SUBMITTED')
  expect(result.results).toHaveLength(2)
  expect(m.amazon).toHaveBeenCalledWith(expect.objectContaining({ kind: 'amazon' }), 'seller-b', expect.any(Function))
  expect(m.updateListings).not.toHaveBeenCalled()
  // The delivered products, exactly (`family: false`), on the reviewed account and alias; the creator decides the draft's fields.
  expect(m.ensure).toHaveBeenCalledWith(expect.anything(), { channel: 'AMAZON', market: 'IT', accountId: 'seller-b', aliasKey: 'alias-b', productIds: expect.arrayContaining(['child']), family: false })
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
  expect(m.amazon).not.toHaveBeenCalled(); expect(m.ensure).not.toHaveBeenCalled()
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
  m.ensure.mockRejectedValue(new Error('Database unavailable'))
  expect(await submitStudioPublication('parent', review.id!, {}, 'user')).toMatchObject({ status: 'FAILED', message: 'Nothing was submitted. Database unavailable' })
  expect(m.amazon).not.toHaveBeenCalled()
})

it.each([false, true])('uses Shopify’s native family publisher and retains its reference if final recording fails (%s)', async persistenceFails => {
  const shopScope = { channel: 'SHOPIFY', marketplace: 'GLOBAL', accountId: 'shop-b', listingId: 'shop-alias' }
  m.facts.mockResolvedValue({ ...facts(), scope: shopScope, excluded: 0 })
  m.shopRead.mockResolvedValue({ initialized: false, draft: { options: ['Size'] }, revision: 'uninitialized' })
  m.shopSave.mockResolvedValue({ revision: 'draft-v1' })
  m.shopPreview.mockResolvedValue({ errors: [], initialized: true, revision: 'draft-v1', remoteRevision: 'remote-v2', draft: { options: ['Size'] }, variants: [{ id: 'child', sku: 'CHILD' }], changes: { newProductStatus: 'DRAFT' }, locations: [{ id: 'shop-location', name: 'Warehouse', isActive: true }] })
  m.shopSend.mockResolvedValue({ productId: 'gid://shopify/Product/42' })
  const review = await previewStudioPublication('parent', shopScope, 'user')
  expect(review.visibility).toBe('DRAFT')
  expect(m.shopSave).toHaveBeenCalledWith('parent', { accountId: 'shop-b', listingId: 'shop-alias', market: 'GLOBAL' }, { draft: { options: ['Size'] }, expectedRevision: 'uninitialized' })
  await expect(submitStudioPublication('parent', review.id!, { locationId: 'other-store' }, 'user')).rejects.toThrow('inventory location')
  expect(m.shopSend).not.toHaveBeenCalled()
  if (persistenceFails) m.persistenceFailure.mockImplementation(data => { if (data.status !== 'PUBLISHING') throw new Error('Database is unavailable') })
  const result = await submitStudioPublication('parent', review.id!, { locationId: 'shop-location' }, 'user')
  expect(result).toMatchObject({ status: persistenceFails ? 'UNVERIFIED' : 'VERIFIED',
    message: expect.stringContaining(persistenceFails ? 'could not record' : 'DRAFT'),
    results: [expect.objectContaining({ reference: 'gid://shopify/Product/42' }), expect.anything()] })
  expect(m.shopSend).toHaveBeenCalledOnce()
  expect(m.shopSend).toHaveBeenCalledWith('parent', { accountId: 'shop-b', listingId: 'shop-alias', market: 'GLOBAL' }, { expectedRevision: 'draft-v1', expectedRemoteRevision: 'remote-v2', locationId: 'shop-location', confirmActive: true }, expect.any(Function))
})

it('reads the ASINs of the rows an Amazon acceptance promoted, after the promotion commits', async () => {
  const review = await previewStudioPublication('parent', scope, 'user')
  await submitStudioPublication('parent', review.id!, {}, 'user')
  expect(m.fill).not.toHaveBeenCalled()
  m.snapshots.mockResolvedValue([{ channelListingId: 'listing-parent' }, { channelListingId: 'listing-child' }])
  // Both SKUs were accepted; only the parent's row is still a draft, so only it is promoted — and read.
  m.findListings.mockResolvedValue([{ id: 'listing-parent' }])
  m.updateListings.mockImplementation(async () => { m.events.push('promote'); return { count: 1 } })
  m.amazonStatus.mockResolvedValue({ results: [{ sku: 'SELLER-SKU', failed: false }, { sku: 'SELLER-CHILD', failed: false }] })
  m.events.length = 0
  expect(await studioPublicationResult('parent', review.id!, 'user')).toMatchObject({ status: 'ACCEPTED' })
  await vi.waitFor(() => expect(m.fill).toHaveBeenCalledOnce())
  expect(m.fill).toHaveBeenCalledWith(['listing-parent'])
  expect(m.events).toEqual(['promote', 'commit', 'fill'])
  expect(m.findListings.mock.calls[0][0].where).toMatchObject({ id: { in: ['listing-parent', 'listing-child'] }, channel: 'AMAZON', marketplace: 'IT',
    channelConnectionId: 'seller-b', aliasKey: 'alias-b', listingStatus: 'DRAFT', isPublished: false, externalListingId: null })
  expect(m.updateListings.mock.calls[0][0].where).toMatchObject({ id: { in: ['listing-parent'] }, listingStatus: 'DRAFT', isPublished: false, externalListingId: null })
})

it('reads nothing when an Amazon acceptance promoted no row', async () => {
  const review = await previewStudioPublication('parent', scope, 'user')
  await submitStudioPublication('parent', review.id!, {}, 'user')
  m.snapshots.mockResolvedValue([{ channelListingId: 'listing-live' }])
  m.amazonStatus.mockResolvedValue({ results: [{ sku: 'SELLER-SKU', failed: false }, { sku: 'SELLER-CHILD', failed: false }] })
  expect(await studioPublicationResult('parent', review.id!, 'user')).toMatchObject({ status: 'ACCEPTED' })
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(m.updateListings).not.toHaveBeenCalled()
  expect(m.fill).not.toHaveBeenCalled()
})
