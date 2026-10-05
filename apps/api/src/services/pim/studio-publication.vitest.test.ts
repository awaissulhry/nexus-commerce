import { beforeEach, expect, it, vi } from 'vitest'
import { deletedPublishSkip } from '@nexus/shared/listing-actions'

const m = vi.hoisted(() => ({ ebayNotices: [] as string[], published: [] as any[], facts: vi.fn(), drift: vi.fn(), amazon: vi.fn(), amazonStatus: vi.fn(), ebay: vi.fn(), ebayStatus: vi.fn(), mode: vi.fn(), rows: new Map<string, any>(), persistenceFailure: vi.fn(), persisted: vi.fn(), createListings: vi.fn(), ensure: vi.fn(), updateListings: vi.fn(), locks: vi.fn(), shopPreview: vi.fn(), shopSend: vi.fn(), shopRead: vi.fn(), shopSave: vi.fn(), snapshots: vi.fn(), findListings: vi.fn(), fill: vi.fn(), events: [] as string[], photoFields: { on: false }, moves: null as any[] | null, claim: vi.fn(), amazonSkus: null as Record<string, string> | null }))
vi.mock('./studio-publication-plan.js', async original => {
  const { createHash } = await import('node:crypto')
  return { readPublicationFacts: m.facts, publicationDigest: (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex'), object: (v: any) => v && typeof v === 'object' ? v : {} }
})
vi.mock('@nexus/database/workspace-context', () => ({ workspaceIdForQuery: () => 'business-a' }))
vi.mock('../amazon-publish-gate.service.js', () => ({ getAmazonPublishMode: m.mode }))
// A status change is a refresh hint on the listing bus; here it is only recorded, never sent.
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: (event: any) => m.published.push(event) }))
vi.mock('../ebay-publish-gate.service.js', () => ({ getEbayPublishMode: m.mode }))
vi.mock('../shopify-publish-gate.service.js', () => ({ getShopifyPublishMode: m.mode }))
vi.mock('./studio-publication-amazon.js', () => ({ prepareAmazonPublication: async () => {
  const sku = (productId: string, fallback: string) => m.amazonSkus?.[productId] ?? fallback
  return { kind: 'amazon', sellerId: 'seller', marketplaceId: 'market',
  products: [{ productId: 'parent', sku: sku('parent', 'SELLER-SKU') }, { productId: 'child', sku: sku('child', 'SELLER-CHILD') }],
  feed: { header: { version: '2.0' }, messages: [{ sku: sku('parent', 'SELLER-SKU') }, { sku: sku('child', 'SELLER-CHILD') }] }, ...(m.moves ? { moves: m.moves } : {}) } }, sendAmazonPublication: m.amazon, readAmazonPublication: m.amazonStatus }))
// S10 — the coordinate claim of a moved SKU (shared accounts) is recorded, never written.
vi.mock('../listing-claim.service.js', () => ({ assertClaimed: m.claim, releaseCoordinate: vi.fn() }))
vi.mock('./studio-publication-ebay.js', () => ({ prepareEbayPublication: async (facts: any) => ({ kind: 'ebay', marketplace: 'IT', itemId: '123', xml: '<Item/>', ...(m.ebayNotices.length ? { notices: m.ebayNotices } : {}),
  products: facts.products.map((p: any) => ({ productId: p.id, sku: p.sku })) }), sendEbayPublication: m.ebay, readEbayPublication: m.ebayStatus,
  ebayPublicationRequest: (plan: any) => ({ operation: 'ReviseFixedPriceItem', xml: plan.xml }), usesEbayInventory: () => false, prepareEbayInventoryPublication: vi.fn() }))
vi.mock('./studio-publication-baseline.js', () => ({ readPublicationBaseline: async () => ({ values: new Map(), revision: 'baseline-1' }) }))
vi.mock('./studio-publication-amazon-changes.js', () => ({
  prepareAmazonChanges: async (_facts: any, publication: any) => ({ kind: 'amazon-changes', publication, remoteRevision: 'remote-1', products: [], schemas: [],
    changes: publication.products.map((p: any) => ({ id: p.productId, ...p, field: 'title', label: 'Title', current: { state: 'value', value: 'Saved title' },
      lastAccepted: { state: 'unknown', reason: 'No record' }, channel: { state: 'unknown', reason: 'New listing' }, status: 'SEND', selectable: true, selectedByDefault: true, localChanged: null, channelChanged: null, reason: 'Create', operation: 'replace' })) }),
  compileAmazonChanges: (plan: any, ids: string[]) => ({ ...plan.publication, products: plan.publication.products.filter((p: any) => ids.includes(p.productId)),
    ...(plan.publication.moves ? { moves: plan.publication.moves.filter((move: any) => ids.includes(move.productId)) } : {}),
    feed: { ...plan.publication.feed, messages: plan.publication.feed.messages.filter((message: any) => plan.publication.products.some((p: any) => p.sku === message.sku && ids.includes(p.productId))) },
    fieldWrites: Object.fromEntries(plan.changes.filter((c: any) => ids.includes(c.id)).map((c: any) => [c.productId, [{ field: c.field, value: c.current }]])) }),
}))
vi.mock('./studio-publication-ebay-changes.js', () => ({
  prepareEbayChanges: async (_facts: any, publication: any) => ({ kind: 'ebay-changes', publication, remoteRevision: 'remote-1',
    // P4c: with photoFields on, the owner row offers a title and a gallery change, keyed the real way (["<id>","<field>"]).
    changes: m.photoFields.on ? ['title', 'pictures'].map(field => ({ id: JSON.stringify(['parent', field]), productId: 'parent', sku: 'SKU', field, label: field,
      current: { state: 'value', value: field }, lastAccepted: { state: 'unknown', reason: 'No record' }, channel: { state: 'value', value: 'old' }, status: 'DIFFERS',
      selectable: true, selectedByDefault: false, localChanged: null, channelChanged: null, reason: 'Differs', operation: 'replace' }))
    : publication.products.map((p: any) => ({ id: p.productId, ...p, field: 'title', label: 'Title', current: { state: 'value', value: 'Saved title' },
      lastAccepted: { state: 'unknown', reason: 'No record' }, channel: { state: 'unknown', reason: 'New listing' }, status: 'SEND', selectable: true, selectedByDefault: true, localChanged: null, channelChanged: null, reason: 'Create', operation: 'replace' })) }),
  compileEbayChanges: (plan: any, ids: string[]) => ({ ...plan.publication, products: plan.publication.products.filter((p: any) => ids.some(id => id === p.productId || id.startsWith(`["${p.productId}"`))),
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
import { newListingChoices } from '../listings/new-listing-choices.js'
import { readListingDeletions } from '../listings/listing-deletions.js'
import { previewStudioPublication as previewRaw, submitStudioPublication as submitRaw, previewStudioPublicationSelection, studioPublicationResult, publicationSummary, publicationColumns, reviewStudioPublication, publicationResultFor } from './studio-publication.service.js'

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

beforeEach(() => { vi.resetAllMocks(); m.rows.clear(); m.ebayNotices = []; m.moves = null; m.amazonSkus = null; m.drift.mockResolvedValue([]); m.mode.mockReturnValue('live'); m.facts.mockImplementation(async () => facts()); m.amazon.mockResolvedValue('feed-42'); m.amazonStatus.mockResolvedValue(null); m.ebay.mockResolvedValue({ reference: '123', warnings: ['eBay adjusted the shipping value.'] }); m.ebayStatus.mockResolvedValue({ reference: '123', warnings: [], verified: true }); m.createListings.mockResolvedValue({ count: 2 }); m.ensure.mockResolvedValue([]); m.updateListings.mockResolvedValue({ count: 2 })
  m.snapshots.mockResolvedValue([]); m.findListings.mockResolvedValue([]); m.events.length = 0; m.published.length = 0
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

// Owner 2026-10-01: a new eBay listing at stock 0 is not refused; the eBay prepare step returns a note, and the review shows it
// as a note that blocks nothing.
it('shows an eBay review note as a warning, not a blocker', async () => {
  m.ebayNotices = ['The stock is 0. eBay keeps this listing hidden from search until it has stock.']
  const review = await previewRaw('parent', { ...scope, channel: 'EBAY' }, 'user')
  expect(review.issues).toContainEqual({ severity: 'warning', message: 'The stock is 0. eBay keeps this listing hidden from search until it has stock.' })
  expect(review.issues.filter(issue => issue.severity === 'error')).toEqual([])
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

// P4c — an off-list value on one field (eBay's Season list) blocks that field, not the listing's photos.
it('saves a photos-only review when every error names a field, sends a photos-only selection, and refuses any other field', async () => {
  const ebayScope = { ...scope, channel: 'EBAY' }
  m.photoFields.on = true
  const fieldError = { productId: 'parent', sku: 'SKU', field: 'season', severity: 'error', message: 'Season: Season contains an unaccepted value.' }
  m.facts.mockImplementation(async () => ({ ...existingFacts(), scope: ebayScope, issues: [fieldError] }))
  const review = await previewRaw('parent', ebayScope, 'user')
  expect(review).toMatchObject({ photosOnly: true, issues: [expect.objectContaining({ field: 'season' })] })
  expect(review.id).toBeTruthy()
  const title = JSON.stringify(['parent', 'title']), pictures = JSON.stringify(['parent', 'pictures'])
  await expect(previewStudioPublicationSelection('parent', review.id!, { selectedIds: [title, pictures] }, 'user')).rejects.toMatchObject({ statusCode: 422 })
  await previewStudioPublicationSelection('parent', review.id!, { selectedIds: [pictures] }, 'user')
  const result = await submitStudioPublication('parent', review.id!, {}, 'user')
  expect(m.ebay).toHaveBeenCalledOnce()
  expect(result.status).not.toBe('FAILED')
  m.photoFields.on = false
})
it('an error that names no field still blocks the whole review, photos included', async () => {
  const ebayScope = { ...scope, channel: 'EBAY' }
  m.photoFields.on = true
  m.facts.mockImplementation(async () => ({ ...existingFacts(), scope: ebayScope, issues: [{ severity: 'error', message: 'Reconnect this account before publishing.' }] }))
  expect(await previewRaw('parent', ebayScope, 'user')).toMatchObject({ id: null })
  expect(m.rows.size).toBe(0)
  m.photoFields.on = false
})

// Sheet publish parity, step 1 — the history's columns and counts.
it('counts a result per SKU status, each SKU once', () => {
  expect(publicationSummary({ id: 'p', status: 'PARTIAL', message: 'Two of four', results: [
    { sku: 'A', status: 'ACCEPTED', message: '' }, { sku: 'B', status: 'VERIFIED', message: '' },
    { sku: 'C', status: 'FAILED', message: '' }, { sku: 'D', status: 'SUBMITTED', message: '' }] }))
    .toEqual({ message: 'Two of four', products: 4, accepted: 1, verified: 1, failed: 1, submitted: 1 })
  expect(publicationSummary({ id: 'p', status: 'FAILED', message: 'Nothing was submitted.', results: [] }))
    .toEqual({ message: 'Nothing was submitted.', products: 0, accepted: 0, verified: 0, failed: 0, submitted: 0 })
})

it('stores the family and the exact destination as columns when a review is saved and when it is sent', async () => {
  const review = await previewStudioPublication('child', scope, 'user')
  const destination = { kind: 'studio-publication', productId: 'parent', channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'seller-b', aliasKey: 'alias-b' }
  expect(m.rows.get(review.id!)).toMatchObject(destination)
  expect(m.rows.get(review.id!).submittedAt).toBeUndefined()
  expect(publicationColumns('parent', scope, 'alias-b')).toEqual(destination)
  await submitStudioPublication('child', review.id!, {}, 'user')
  const sent = m.rows.get(review.id!)
  expect(sent).toMatchObject({ ...destination, status: 'SUBMITTED', submittedAt: expect.any(Date), summary: expect.objectContaining({ products: 2, submitted: 2 }) })
  // Step 2 schedules the result sweep on send (pinned in the next test).
  expect(sent.nextCheckAt).toEqual(expect.any(Date))
})

/**
 * Sheet publish parity, step 2 — a send schedules the result sweep and announces each status change once: the claim
 * (PUBLISHING, first look at its 30-minute deadline), then the receipt (SUBMITTED, first look in two minutes). The
 * final store keeps SUBMITTED, so it announces nothing more.
 */
it('schedules the result sweep when it sends and announces each status once', async () => {
  const review = await previewStudioPublication('parent', scope, 'user')
  expect(m.rows.get(review.id!)).not.toHaveProperty('checkCount')
  const before = Date.now()
  expect(await submitStudioPublication('parent', review.id!, {}, 'user')).toMatchObject({ status: 'SUBMITTED' })
  const row = m.rows.get(review.id!)
  expect(row).toMatchObject({ status: 'SUBMITTED', checkCount: 0, nextCheckAt: expect.any(Date) })
  const firstLook = row.nextCheckAt.getTime() - before
  expect(firstLook).toBeGreaterThanOrEqual(2 * 60_000)
  expect(firstLook).toBeLessThan(3 * 60_000)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(m.published.map(event => event.status)).toEqual(['PUBLISHING', 'SUBMITTED'])
  expect(m.published[1]).toMatchObject({ type: 'publication.status_changed', publicationId: review.id, productId: 'parent', channel: 'AMAZON',
    marketplace: 'IT', accountId: 'seller-b', aliasKey: 'alias-b', terminal: false })
})

// MCP full control L3 — Claude's review saves nothing, and a publication's result is the business's, not one person's.
const sameReview = (review: Record<string, unknown>) => ({ ...review, id: null, expiresAt: 'any' })

it('L3: reviews exactly what the studio reviews, and saves nothing — no BulkOperation row', async () => {
  m.facts.mockResolvedValue(existingFacts())
  m.drift.mockResolvedValue([contentObservation()])
  const review = await reviewStudioPublication('parent', scope)
  expect(review.id).toBeNull()
  expect(m.rows.size).toBe(0)
  expect(m.amazon).not.toHaveBeenCalled(); expect(m.ensure).not.toHaveBeenCalled()
  const stored = await previewRaw('parent', scope, 'user')
  expect(stored.id).toEqual(expect.any(String))
  expect(sameReview(review)).toEqual(sameReview(stored))
})

it('L3: reviews a Shopify family without saving its content document or starting its draft listing', async () => {
  const shopScope = { channel: 'SHOPIFY', marketplace: 'GLOBAL', accountId: 'shop-b', listingId: 'shop-alias' }
  m.facts.mockResolvedValue({ ...facts(), scope: shopScope, excluded: 0 })
  m.shopRead.mockResolvedValue({ initialized: false, draft: { options: ['Size'] }, revision: 'uninitialized' })
  m.shopPreview.mockResolvedValue({ errors: [], initialized: false, revision: 'uninitialized', remoteRevision: null, draft: { options: ['Size'] }, variants: [{ id: 'child', sku: 'CHILD' }], changes: { newProductStatus: 'DRAFT' }, locations: [{ id: 'shop-location', name: 'Warehouse', isActive: true }] })
  const review = await reviewStudioPublication('parent', shopScope)
  expect(review).toMatchObject({ id: null, visibility: 'DRAFT', locations: [{ id: 'shop-location', name: 'Warehouse' }] })
  expect(m.shopSave).not.toHaveBeenCalled()
  // Wave 2 D4 — facts without Status choices decide no create status: the review reads the Status column, as the send does.
  expect(m.shopPreview).toHaveBeenCalledWith('parent', { accountId: 'shop-b', listingId: 'shop-alias', market: 'GLOBAL' }, true, {})
  expect(m.rows.size).toBe(0)
})

it('L3: names a publication still waiting for its result at this destination, whoever submitted it', async () => {
  const first = await previewStudioPublication('parent', scope, 'colleague')
  expect(await submitStudioPublication('parent', first.id!, {}, 'colleague')).toMatchObject({ status: 'SUBMITTED' })
  const rows = m.rows.size
  const review = await reviewStudioPublication('parent', scope)
  expect(review).toMatchObject({ id: null, previousPublicationId: first.id,
    issues: expect.arrayContaining([expect.objectContaining({ severity: 'error', message: expect.stringContaining(first.id!) })]) })
  expect(m.rows.size).toBe(rows)
})

it('L3: reads and settles a publication in the business, whoever submitted it; an unknown id is not found', async () => {
  const review = await previewStudioPublication('parent', scope, 'colleague')
  await submitStudioPublication('parent', review.id!, {}, 'colleague')
  // The studio's own read stays the submitter's.
  await expect(studioPublicationResult('parent', review.id!, 'approver')).rejects.toThrow('not found')
  expect(await publicationResultFor(review.id!)).toMatchObject({ id: review.id, status: 'SUBMITTED' })
  m.amazonStatus.mockResolvedValue({ results: [{ sku: 'SELLER-SKU', failed: false }, { sku: 'SELLER-CHILD', failed: false }] })
  expect(await publicationResultFor(review.id!)).toMatchObject({ id: review.id, status: 'ACCEPTED' })
  expect(m.amazonStatus).toHaveBeenCalledWith('feed-42', 'seller-b', ['SELLER-SKU', 'SELLER-CHILD'])
  expect(m.rows.get(review.id!).status).toBe('ACCEPTED')
  // Settled once: a second read returns the stored result without asking Amazon again.
  m.amazonStatus.mockClear()
  expect(await publicationResultFor(review.id!)).toMatchObject({ status: 'ACCEPTED' })
  expect(m.amazonStatus).not.toHaveBeenCalled()
  await expect(publicationResultFor('no-such-publication')).rejects.toThrow('not found')
})

// ── Delete and relist (Owner 2026-10-04, simplified the same day) ────────────────────────────────
// A row Nexus deleted is a row not on the channel, Not listed by default: every review blocks it (no create, never
// ticked), whatever path reviews it (the plan, the many-family batch, the direct studio review). Its Status Active (or an
// older relist choice in the Action column, read as Active) lists it again, ticked by default; Amazon's refusal of that
// relist is explained beside Amazon's own words.
const deletedAt = new Date(Date.now() - 2 * 3_600_000 - 60_000)
const chosenAt = new Date(deletedAt.getTime() + 60_000)
const draftListing = (productId: string, extra: Record<string, unknown> = {}) => ({ id: `listing-${productId}`, productId, channel: 'AMAZON', marketplace: 'IT',
  externalListingId: null, listingStatus: 'DRAFT', isPublished: false, publishAction: null, publishActionAt: null, ...extra })
function deletedChild(childExtra: Record<string, unknown> = {}) {
  const listings = [draftListing('parent', { externalListingId: 'B0PARENT01', listingStatus: 'ACTIVE', isPublished: true }), draftListing('child', childExtra)]
  m.snapshots.mockImplementation(async ({ where }: any) => where.reason === 'delete'
    ? [{ channelListingId: 'listing-child', acceptedAt: deletedAt, payload: { kind: 'listing-action', evidence: { oldExternalListingId: 'B0OLDCHILD' } } }] : [])
  // The facts as `readPublicationFacts` reads them: the delete records, and the choices of every row not on the channel.
  m.facts.mockImplementation(async () => {
    const byListing = await readListingDeletions(listings)
    const deletions = new Map([...byListing].map(([id, deletion]) => [listings.find(listing => listing.id === id)!.productId, deletion]))
    const createChoices = newListingChoices({ channel: 'AMAZON', aliasKey: 'alias-b', familyId: 'parent',
      products: [{ id: 'parent', parentId: null }, { id: 'child', parentId: 'parent' }], listings, deletions: byListing })
    return { ...facts(), listings, deletions, createChoices }
  })
}

it('delete and relist: a deleted row left Not listed sends nothing — no create, never ticked — and the rest of the family still goes', async () => {
  deletedChild()
  const review = await previewRaw('parent', scope, 'user-a')
  const skip = deletedPublishSkip({ where: 'Amazon · IT', at: deletedAt.toISOString() })
  expect(review.rows.find(r => r.productId === 'child')).toMatchObject({ deleted: true, blocked: skip })
  expect(review.rows.find(r => r.productId === 'child')!.relist).toBeUndefined()
  expect(review.changes!.find(c => c.productId === 'child')).toMatchObject({ selectable: false, selectedByDefault: false, reason: skip })
  expect(review.changes!.find(c => c.productId === 'parent')).toMatchObject({ selectable: true, selectedByDefault: true })
  expect(m.rows.get(review.id!).changes.relistProductIds).toBeUndefined()
})

it('delete and relist: Status Active after the delete lists it again, ticked; Amazon\'s refusal is explained beside its words', async () => {
  deletedChild({ sellingTarget: 'ACTIVE', sellingTargetAt: chosenAt, sellingTargetById: 'user-a' })
  const review = await previewStudioPublication('parent', scope, 'user-a')
  expect(review.rows.find(r => r.productId === 'child')).toMatchObject({ relist: { deletedAt: deletedAt.toISOString(), oldReference: 'B0OLDCHILD', asin: null,
    sentence: 'Lists SELLER-CHILD again (it was ASIN B0OLDCHILD; Amazon matches it by its product ID).', warning: null } }) // S10: the relist line names the SKU it sends
  expect(review.rows.find(r => r.productId === 'child')).toMatchObject({ startsAs: 'active' })
  expect(review.rows.find(r => r.productId === 'child')!.blocked).toBeUndefined()
  expect(review.changes!.find(c => c.productId === 'child')).toMatchObject({ selectable: true, selectedByDefault: true })
  expect(m.rows.get(review.id!).changes).toMatchObject({ relistProductIds: ['child'], createChoiceProductIds: ['child'],
    relist: [{ productId: 'child', sku: 'SELLER-CHILD', deletedAt: deletedAt.toISOString(), oldReference: 'B0OLDCHILD', asin: null }] })
  await submitStudioPublication('parent', review.id!, {}, 'user-a')
  m.amazonStatus.mockResolvedValue({ results: [{ sku: 'SELLER-SKU', failed: false, issues: [], message: 'Amazon processed this product.' },
    { sku: 'SELLER-CHILD', failed: true, issues: [{ code: '8005', severity: 'ERROR', message: 'The SKU is associated with ASIN B0ELSEWHR1.' }], message: 'The SKU is associated with ASIN B0ELSEWHR1.' }] })
  const result = await publicationResultFor(review.id!)
  expect(result.results.find(r => r.sku === 'SELLER-CHILD')).toMatchObject({ status: 'FAILED',
    message: 'Amazon still links this SKU to ASIN B0ELSEWHR1 in another market. Delete it there first. Amazon said: The SKU is associated with ASIN B0ELSEWHR1.' })
  expect(result.results.find(r => r.sku === 'SELLER-SKU')!.message).toBe('Amazon processed this product.')
})

it('delete and relist: an OLDER relist choice (Full update after the delete) reads as Status Active; Amazon\'s validation refusal says it in plain words too', async () => {
  deletedChild({ publishAction: 'FULL_UPDATE', publishActionAt: chosenAt })
  const review = await previewStudioPublication('parent', scope, 'user-a')
  expect(review.rows.find(r => r.productId === 'child')).toMatchObject({ startsAs: 'active', relist: { oldReference: 'B0OLDCHILD' } })
  m.amazon.mockRejectedValue(Object.assign(new Error('SELLER-CHILD: 13013: The SKU was recently deleted.'), { notSent: true }))
  const result = await submitStudioPublication('parent', review.id!, {}, 'user-a')
  expect(result).toMatchObject({ status: 'FAILED', message: expect.stringMatching(/^Nothing was submitted\. Amazon is still removing this SKU \(deleted 2 hours ago\)\. Try again later; Amazon can take up to 24 hours\. Amazon said: SELLER-CHILD: 13013: The SKU was recently deleted\.$/) })
})

// ── S10 (per-channel SKU, Owner D2 = A) — a live Amazon listing moved to its own SKU ─────────────────────────────────────
const MOVE = { productId: 'child', listingId: 'listing-child', from: 'CHILD', to: 'SELLER-CHILD', asin: 'B0TESTMOVE', fba: false }
const movingFacts = () => ({ ...existingFacts(), parent: { id: 'parent', sku: 'SKU' },
  listings: [...existingFacts().listings, { id: 'listing-child', productId: 'child', externalListingId: 'B0TESTMOVE' }] })

it('S10: the review says the move and asks for the typed confirmation Delete asks for', async () => {
  m.moves = [MOVE]; m.facts.mockResolvedValue(movingFacts())
  const review = await previewStudioPublication('parent', scope, 'user')
  expect(review.rows.find(row => row.productId === 'child')?.skuMove).toEqual({ from: 'CHILD', to: 'SELLER-CHILD', kind: 'create-delete',
    sentence: 'Creates SELLER-CHILD on Amazon · IT as a new offer, then deletes CHILD there.', warning: null })
  expect(review.rows.find(row => row.productId === 'child')?.sendsSku).toBe('SELLER-CHILD')
  expect(review.confirm).toEqual({ kind: 'type', expected: 'SKU', token: 'DELETE', sentence: expect.stringContaining('This Publish deletes CHILD on Amazon · IT once Amazon accepts its new SKU. If Amazon refuses a new SKU, its old one stays and nothing is deleted.') })
})

it('S10: a move is refused without the typed confirmation, and by a role that cannot delete — nothing is sent, nothing is claimed', async () => {
  m.moves = [MOVE]; m.facts.mockResolvedValue(movingFacts())
  const review = await previewStudioPublication('parent', scope, 'user')
  await expect(submitStudioPublication('parent', review.id!, { confirmOverwrite: true }, 'user'))
    .rejects.toThrow('Moving a listing to a new SKU deletes its old SKU on Amazon: type the SKU, then confirm. It cannot be undone.')
  const token = m.rows.get(review.id!)?.changes.selection?.token
  await expect(submitRaw('parent', review.id!, { confirmOverwrite: true, confirm: 'DELETE', selectionToken: token }, 'user', { canDelete: false }))
    .rejects.toThrow(/Your role cannot delete listings/)
  expect(m.amazon).not.toHaveBeenCalled(); expect(m.claim).not.toHaveBeenCalled()
  expect(m.rows.get(review.id!).status).toBe('PREVIEW')
})

it('S10: confirmed, the NEW coordinate is claimed before the send and the move is kept with the publication', async () => {
  m.moves = [MOVE]; m.facts.mockResolvedValue(movingFacts())
  const review = await previewStudioPublication('parent', scope, 'user')
  await submitStudioPublication('parent', review.id!, { confirmOverwrite: true, confirm: 'DELETE' }, 'user')
  if (process.env.NEXUS_WORKSPACES_ENABLED === '1') expect(m.claim).toHaveBeenCalledWith({ connectionId: 'seller-b', marketplace: 'IT', sellerSku: 'SELLER-CHILD', channelListingId: 'listing-child' })
  expect(m.amazon).toHaveBeenCalledOnce()
  expect(m.rows.get(review.id!).changes.skuMoves).toEqual([{ ...MOVE, marketplaceId: 'market' }])
})

it('S10: another business holding NEW on a shared account refuses the send by name; nothing is sent', async () => {
  if (process.env.NEXUS_WORKSPACES_ENABLED !== '1') return
  m.moves = [MOVE]; m.facts.mockResolvedValue(movingFacts())
  m.claim.mockRejectedValue(new Error('Store A already publishes SELLER-CHILD on this account. One seller SKU can belong to one profile at a time.'))
  const review = await previewStudioPublication('parent', scope, 'user')
  await expect(submitStudioPublication('parent', review.id!, { confirmOverwrite: true, confirm: 'DELETE' }, 'user'))
    .rejects.toThrow('Store A already publishes SELLER-CHILD on this account. One seller SKU can belong to one profile at a time. Nothing was sent.')
  expect(m.amazon).not.toHaveBeenCalled()
})

it('S10 parity: a review with no move asks for no confirmation and stores no move', async () => {
  m.facts.mockResolvedValue(existingFacts())
  const review = await previewStudioPublication('parent', scope, 'user')
  expect(review.confirm).toBeUndefined()
  expect(review.rows.some(row => row.skuMove)).toBe(false)
  await submitStudioPublication('parent', review.id!, { confirmOverwrite: true }, 'user')
  expect(m.rows.get(review.id!).changes.skuMoves).toBeUndefined()
})

it('S10: a seller SKU longer than Amazon takes (40) is refused in the review, by name', async () => {
  m.amazonSkus = { child: 'C'.repeat(41) }; m.facts.mockResolvedValue(existingFacts())
  const review = await reviewStudioPublication('parent', scope)
  expect(review.issues).toContainEqual({ productId: 'child', sku: 'CHILD', severity: 'error',
    message: `${'C'.repeat(41)}: Amazon takes a seller SKU of up to 40 characters; this one has 41. Shorten this listing's SKU, then Publish again.` })
})

it('S10: Etsy — a live row with its own SKU that Etsy holds under another says Nexus cannot send it yet', async () => {
  const etsy = { ...scope, channel: 'ETSY' }
  m.facts.mockResolvedValue({ ...facts(), scope: etsy, listings: [
    { id: 'l-child', productId: 'child', channel: 'ETSY', externalListingId: '777', listingStatus: 'ACTIVE', isPublished: true, channelSku: 'CHILD-ETSY', liveChannelSku: null }] })
  const review = await reviewStudioPublication('parent', etsy)
  const sentence = 'Nexus cannot send Etsy SKU changes yet: Etsy keeps CHILD for this listing (Nexus holds CHILD-ETSY).'
  expect(review.rows.find(row => row.productId === 'child')?.skuMove).toEqual({ from: 'CHILD', to: 'CHILD-ETSY', kind: 'none', sentence, warning: null })
  expect(review.issues).toContainEqual({ productId: 'child', sku: 'CHILD', severity: 'warning', message: `CHILD: ${sentence}` })
})

it('S10: a moved row reads its own mode, "move" — never Partial or Full update, even when Full update was asked for it', async () => {
  m.moves = [MOVE]; m.facts.mockResolvedValue(movingFacts())
  const review = await previewStudioPublication('parent', scope, 'user', { fullProductIds: ['child', 'parent'] })
  expect(review.rows.find(row => row.productId === 'child')?.mode).toBe('move')
  expect(review.rows.find(row => row.productId === 'parent')?.mode).toBe('full')
  const plain = await previewStudioPublication('parent', scope, 'user-2')
  expect(plain.rows.find(row => row.productId === 'child')?.mode).toBe('move')
  expect(plain.rows.find(row => row.productId === 'parent')?.mode).toBe('partial')
})
