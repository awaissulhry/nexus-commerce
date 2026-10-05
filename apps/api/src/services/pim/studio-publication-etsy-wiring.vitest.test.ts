import { beforeEach, expect, it, vi } from 'vitest'
import { ETSY_NEW_ACTIVE_NEEDS_PHOTO, ETSY_VARIATION_CANNOT_HIDE, NOT_LISTED_MAIN_HELD } from '@nexus/shared/listing-actions'
import { ETSY_REVIEW_ONLY, ETSY_REVIEW_SENDS_NOTHING } from '@nexus/shared/publish-actions'

/**
 * E1 — the Etsy publisher wired into studio Publish, with its adapter mocked (its own suites prove the payload): every
 * mode builds the review and its one `__create__` change; a new listing starts as an Etsy draft; nothing is ever sent
 * (the submit refuses before any claim, draft, journal or event). Fake ids only (public repo).
 */
const m = vi.hoisted(() => ({ facts: vi.fn(), mode: vi.fn(), etsyMode: vi.fn(), etsyPrepare: vi.fn(), etsyNotices: [] as string[], rows: new Map<string, any>(),
  ensure: vi.fn(), record: vi.fn(), ebay: vi.fn(), drift: vi.fn(), locks: vi.fn(), published: [] as any[] }))
vi.mock('./studio-publication-plan.js', async () => {
  const { createHash } = await import('node:crypto')
  return { readPublicationFacts: m.facts, publicationDigest: (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex'), object: (v: any) => v && typeof v === 'object' ? v : {} }
})
vi.mock('@nexus/database/workspace-context', () => ({ workspaceIdForQuery: () => 'business-a' }))
vi.mock('../amazon-publish-gate.service.js', () => ({ getAmazonPublishMode: m.mode }))
vi.mock('../ebay-publish-gate.service.js', () => ({ getEbayPublishMode: m.mode }))
vi.mock('../shopify-publish-gate.service.js', () => ({ getShopifyPublishMode: m.mode }))
vi.mock('../etsy-publish-gate.service.js', async original => ({ ...(await original<Record<string, unknown>>()), getEtsyPublishMode: m.etsyMode }))
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: (event: any) => m.published.push(event) }))
vi.mock('./studio-publication-amazon.js', () => ({ prepareAmazonPublication: vi.fn(), sendAmazonPublication: vi.fn(), readAmazonPublication: vi.fn(), amazonMovesWithoutPublication: vi.fn() }))
vi.mock('../listing-claim.service.js', () => ({ assertClaimed: vi.fn(), releaseCoordinate: vi.fn() }))
vi.mock('../amazon/listing-asin-fill.service.js', () => ({ fillAmazonListingAsins: vi.fn() }))
vi.mock('./studio-publication-ebay.js', () => ({ prepareEbayPublication: async (facts: any) => ({ kind: 'ebay', marketplace: 'IT', itemId: '123', xml: '<Item/>',
  products: facts.products.map((p: any) => ({ productId: p.id, sku: p.sku })) }), sendEbayPublication: m.ebay, readEbayPublication: vi.fn(),
  ebayPublicationRequest: (plan: any) => ({ operation: 'ReviseFixedPriceItem', xml: plan.xml }), usesEbayInventory: () => false, prepareEbayInventoryPublication: vi.fn() }))
// eBay Inventory reaches the channel gateway (and its queue) at import; nothing here uses it.
vi.mock('./studio-publication-ebay-inventory.js', () => ({ ebayInventoryReads: vi.fn(), sendEbayInventoryGroup: vi.fn() }))
vi.mock('./studio-publication-baseline.js', () => ({ readPublicationBaseline: async () => ({ values: new Map(), revision: 'baseline-1' }) }))
vi.mock('./studio-publication-amazon-changes.js', () => ({ prepareAmazonChanges: vi.fn(), compileAmazonChanges: vi.fn() }))
vi.mock('./studio-publication-ebay-changes.js', () => ({
  prepareEbayChanges: async (_facts: any, publication: any) => ({ kind: 'ebay-changes', publication, remoteRevision: 'remote-1', changes: [] }),
  compileEbayChanges: vi.fn(),
}))
// The Etsy adapter: prepare records what the service asked for; the plan is ONE create whose value is the whole request
// (a listing on Etsy: its variations).
const createId = JSON.stringify(['parent', '__create__'])
const request = { operation: 'createDraftListing', listingId: null, calls: [{ method: 'POST', path: '/shops/{shop_id}/listings', encoding: 'form', body: { title: 'Fake title' } }] }
vi.mock('./studio-publication-etsy.js', () => ({ prepareEtsyPublication: m.etsyPrepare }))
vi.mock('./studio-publication-etsy-changes.js', () => ({
  prepareEtsyChanges: (_facts: any, publication: any) => ({ kind: 'etsy-changes', publication, remoteRevision: 'new', products: publication.products,
    ownerProductId: publication.ownerProductId, createWrites: { [publication.ownerProductId]: [{ field: 'title', value: { state: 'value', value: 'Fake title' } }] },
    changes: [{ ...(publication.listingId ? { id: JSON.stringify(['parent', 'inventory']), field: 'inventory', label: 'Variations, SKUs and processing profile' }
      : { id: createId, field: '__create__', label: 'Create Etsy listing (draft)' }), productId: 'parent', sku: 'FAKE-SKU-1', current: { state: 'value', value: request },
      lastAccepted: { state: 'unknown', reason: 'No listing exists.' }, channel: { state: 'absent' }, status: 'SEND', selectable: true, selectedByDefault: true,
      localChanged: null, channelChanged: null, reason: 'New listing', operation: 'replace' }] }),
  compileEtsyChanges: (plan: any, ids: string[]) => ids.length ? { ...plan.publication, products: plan.products, fieldWrites: plan.createWrites, request }
    : { ...plan.publication, products: [], fieldWrites: {}, request: null },
}))
vi.mock('./studio-publication-records.js', () => ({ recordPublicationRequests: m.record, settlePublicationRecords: vi.fn() }))
vi.mock('./draft-listing.service.js', () => ({ ensureDraftListings: m.ensure }))
vi.mock('./workspace-destination.js', () => ({ WorkspaceScopeError: class extends Error { statusCode: number; constructor(message: string, statusCode = 409) { super(message); this.statusCode = statusCode } } }))
vi.mock('../../db.js', () => {
  const matches = (row: any, where: any) => (!where.id || (typeof where.id === 'string' ? row.id === where.id : row.id !== where.id.not))
    && (!Object.hasOwn(where, 'userId') || row.userId === where.userId)
    && (!where.status || (typeof where.status === 'string' ? row.status === where.status : where.status.in.includes(row.status)))
    && (!where.changes || (where.changes.path ? row.changes[where.changes.path[0]] === where.changes.equals : JSON.stringify(row.changes) === JSON.stringify(where.changes.equals)))
  const db = { channelDrift: { findMany: m.drift }, bulkOperation: {
    findFirst: async ({ where }: any) => structuredClone([...m.rows.values()].find(row => matches(row, where)) ?? null),
    create: async ({ data }: any) => { m.rows.set(data.id, structuredClone(data)); return structuredClone(data) },
    updateMany: async ({ where, data }: any) => { const rows = [...m.rows.values()].filter(row => matches(row, where)); for (const row of rows) m.rows.set(row.id, structuredClone({ ...row, ...data })); return { count: rows.length } },
  }, $queryRawUnsafe: m.locks, $transaction: async (fn: any) => fn(db) }
  return { default: db }
})
import { newListingChoices } from '../listings/new-listing-choices.js'
import { deliverPublication, previewStudioPublication, previewStudioPublicationSelection, reviewStudioPublication, submitStudioPublication,
  type ClaimedPublication } from './studio-publication.service.js'

const etsyScope = { channel: 'ETSY', marketplace: 'GLOBAL', accountId: 'etsy-shop-b' }
// Etsy's displayName is the login name (a 16-character code); the shop's name is what a person knows it by.
const etsyAccount = { displayName: 'a1b2c3d4e5f6g7h8', accountLabel: null, ebayStoreName: null, authStatus: 'connected',
  identity: { username: 'a1b2c3d4e5f6g7h8', storeName: 'Fake Etsy Shop', extra: { shopName: 'Fake Etsy Shop' } } }
const products = [{ id: 'parent', sku: 'FAKE-SKU-1', name: 'Fake family', parentId: null }, { id: 'child-s', sku: 'FAKE-SKU-2', name: 'Fake S', parentId: 'parent' },
  { id: 'child-m', sku: 'FAKE-SKU-3', name: 'Fake M', parentId: 'parent' }]
/** A family not on Etsy yet: an Etsy draft row per product; the main row's Status (`sellingTarget`) is the only choice made. */
function newFamily(mainTarget: string | null = null) {
  const listings = products.map(p => ({ id: `listing-${p.id}`, productId: p.id, channel: 'ETSY', marketplace: 'GLOBAL', externalListingId: null,
    listingStatus: 'DRAFT', isPublished: false, ...(p.id === 'parent' && mainTarget ? { sellingTarget: mainTarget, sellingTargetAt: new Date('2026-10-05T09:00:00Z') } : {}) }))
  const createChoices = newListingChoices({ channel: 'ETSY', aliasKey: '', familyId: 'parent', products, listings })
  return { scope: etsyScope, destination: { familyId: 'parent', aliasKey: '' }, account: etsyAccount, parent: { id: 'parent', isParent: true }, products, listings,
    resolved: [], issues: [], excluded: 0, aliasLabel: 'Primary listing', revision: 'v1', createChoices, deletions: new Map() }
}
/** The same family already on Etsy (listing 9000000001), with one new variation whose own Status is `childTarget` (null: none). */
function listedFamily(childTarget: string | null) {
  const all = [...products, { id: 'child-l', sku: 'FAKE-SKU-4', name: 'Fake L', parentId: 'parent' }]
  const listings = all.map(p => p.id === 'child-l'
    ? { id: 'listing-child-l', productId: p.id, channel: 'ETSY', marketplace: 'GLOBAL', externalListingId: null, listingStatus: 'DRAFT', isPublished: false,
      ...(childTarget ? { sellingTarget: childTarget, sellingTargetAt: new Date('2026-10-05T09:00:00Z') } : {}) }
    : { id: `listing-${p.id}`, productId: p.id, channel: 'ETSY', marketplace: 'GLOBAL', externalListingId: '9000000001', listingStatus: 'ACTIVE', isPublished: true })
  return { ...newFamily(), products: all, listings, createChoices: newListingChoices({ channel: 'ETSY', aliasKey: '', familyId: 'parent', products: all, listings }) }
}
const publication = (facts: any, options: any) => ({ kind: 'etsy', marketplace: 'GLOBAL', listingId: facts.listings.find((l: any) => l.externalListingId)?.externalListingId ?? null, products: facts.products.map((p: any) => ({ productId: p.id, sku: p.sku })),
  inventoryProducts: facts.products.filter((p: any) => p.id !== 'parent').map((p: any) => ({ productId: p.id, sku: p.sku })), ownerProductId: 'parent',
  values: {}, form: {}, inventory: {}, structure: { properties: [], products: [] }, properties: [], translations: [],
  create: facts.listings.some((l: any) => l.externalListingId) ? null : { state: options.createState ?? 'draft', price: 19.99, quantity: 1 }, live: null, liveRevision: null, ...(m.etsyNotices.length ? { notices: m.etsyNotices } : {}) })

beforeEach(() => {
  vi.resetAllMocks(); m.rows.clear(); m.etsyNotices = []; m.published.length = 0
  m.mode.mockReturnValue('live'); m.etsyMode.mockReturnValue('live'); m.drift.mockResolvedValue([]); m.ensure.mockResolvedValue([])
  m.facts.mockImplementation(async () => newFamily())
  m.etsyPrepare.mockImplementation(async (facts: any, options: any) => publication(facts, options))
})

it('sending off: the review still holds the one create change, and one Etsy error (true in E1) replaces the gate sentence; nothing is stored', async () => {
  m.etsyMode.mockReturnValue('gated')
  const review = await previewStudioPublication('parent', etsyScope, 'user')
  expect(review.id).toBeNull()
  expect(m.rows.size).toBe(0)
  expect(review.issues.filter(issue => issue.severity === 'error')).toEqual([{ severity: 'error', message: ETSY_REVIEW_SENDS_NOTHING }])
  expect(ETSY_REVIEW_SENDS_NOTHING).toBe('Sending to Etsy comes in the next Nexus update. This review shows what Nexus would send; nothing is sent.')
  expect(review.issues.map(issue => issue.message)).not.toContain(ETSY_REVIEW_ONLY)
  expect(review.changes?.map(change => change.field)).toEqual(['__create__'])
  // A new listing nobody chose for starts as an Etsy draft (Owner D1 = A); the live reader is handed over, never called here.
  expect(m.etsyPrepare).toHaveBeenCalledWith(expect.objectContaining({ scope: etsyScope }), { createState: 'draft', readLive: expect.any(Function) })
})

it('sending live: a new family is stored as a review, every row starts Inactive (a draft), and the selection is the exact JSON request', async () => {
  const review = await previewStudioPublication('parent', etsyScope, 'user')
  expect(review.id).toEqual(expect.any(String))
  expect(m.rows.get(review.id!)).toMatchObject({ status: 'PREVIEW', changes: { changeVersion: 1, changePlan: { kind: 'etsy-changes' } } })
  expect(review.issues.filter(issue => issue.severity === 'error')).toEqual([])
  expect(review.issues).toContainEqual({ severity: 'warning', message: ETSY_REVIEW_ONLY })
  expect(review.changes).toEqual([expect.objectContaining({ id: createId, field: '__create__', selectable: true, selectedByDefault: true })])
  expect(review.rows.map(row => [row.sku, row.startsAs])).toEqual([['FAKE-SKU-1', 'inactive'], ['FAKE-SKU-2', 'inactive'], ['FAKE-SKU-3', 'inactive']])
  const selection = await previewStudioPublicationSelection('parent', review.id!, { selectedIds: [createId] }, 'user')
  expect(selection).toMatchObject({ fieldCount: 1, payload: { format: 'json' }, products: products.map(p => ({ productId: p.id, sku: p.sku })) })
  expect(JSON.parse(selection.payload.content)).toEqual(request)
})

it('submit: refused before any claim, draft, journal or event — the review stays PREVIEW', async () => {
  const review = await previewStudioPublication('parent', etsyScope, 'user')
  const selection = await previewStudioPublicationSelection('parent', review.id!, { selectedIds: [createId] }, 'user')
  const before = structuredClone(m.rows.get(review.id!))
  await expect(submitStudioPublication('parent', review.id!, { selectionToken: selection.token }, 'user'))
    .rejects.toMatchObject({ message: 'Sending to Etsy comes in the next Nexus update. Nothing was sent.', statusCode: 422 })
  expect(m.rows.get(review.id!)).toEqual(before)
  expect(m.facts).toHaveBeenCalledTimes(1)
  expect(m.ensure).not.toHaveBeenCalled(); expect(m.record).not.toHaveBeenCalled(); expect(m.locks).not.toHaveBeenCalled()
  expect(m.published).toEqual([])
})

it('a new listing set to start Active is refused: Etsy needs a photo to go live; nothing is stored', async () => {
  const review = await previewStudioPublication('parent', etsyScope, 'user', { startAs: 'active' })
  expect(review.id).toBeNull()
  expect(m.rows.size).toBe(0)
  expect(review.issues).toContainEqual({ severity: 'error', message: ETSY_NEW_ACTIVE_NEEDS_PHOTO })
  expect(review.rows.every(row => row.startsAs === 'active')).toBe(true)
  expect(m.etsyPrepare).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ createState: 'active' }))
})

it('the main row Not listed holds the whole Etsy listing: every row says so and the create cannot be ticked', async () => {
  m.facts.mockImplementation(async () => newFamily('NOT_LISTED'))
  const review = await previewStudioPublication('parent', etsyScope, 'user')
  expect(review.rows.map(row => [row.sku, row.notListed, row.blocked, row.startsAs])).toEqual(products.map(p => [p.sku, true, NOT_LISTED_MAIN_HELD, undefined]))
  expect(review.changes).toEqual([expect.objectContaining({ id: createId, selectable: false, selectedByDefault: false, reason: NOT_LISTED_MAIN_HELD })])
  expect(m.etsyPrepare).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ createState: null }))
  await expect(previewStudioPublicationSelection('parent', review.id!, { selectedIds: [createId] }, 'user')).rejects.toMatchObject({ statusCode: 400,
    message: expect.stringContaining(NOT_LISTED_MAIN_HELD) })
})

it.each([[null], ['ACTIVE']])('a new variation of a listing on Etsy joins it for sale (own Status %s): no create state, no photo refusal, nothing hidden', async stored => {
  m.facts.mockImplementation(async () => listedFamily(stored))
  const review = await previewStudioPublication('parent', etsyScope, 'user')
  expect(review.id).toEqual(expect.any(String))
  expect(review.issues.filter(issue => issue.severity === 'error')).toEqual([])
  expect(review.rows.map(row => [row.sku, row.startsAs])).toEqual([['FAKE-SKU-1', undefined], ['FAKE-SKU-2', undefined], ['FAKE-SKU-3', undefined], ['FAKE-SKU-4', 'active']])
  // A listing on Etsy is never a create, and no Etsy row reaches the adapter as hidden.
  const options = m.etsyPrepare.mock.calls[0][1]
  expect(options.createState).toBeNull()
  expect(options.inactiveProductIds).toBeUndefined()
})

it.each([['its own Status', 'INACTIVE', undefined], ['"New listings start as"', null, 'inactive' as const]])('a new variation of a listing on Etsy set Inactive (%s) is refused by name: one variation cannot be hidden; nothing is stored', async (_, stored, startAs) => {
  m.facts.mockImplementation(async () => listedFamily(stored))
  const review = await previewStudioPublication('parent', etsyScope, 'user', startAs ? { startAs } : {})
  expect(review.id).toBeNull()
  expect(m.rows.size).toBe(0)
  expect(review.issues.filter(issue => issue.severity === 'error')).toEqual([{ productId: 'child-l', sku: 'FAKE-SKU-4', severity: 'error', message: `FAKE-SKU-4: ${ETSY_VARIATION_CANNOT_HIDE}` }])
  expect(m.etsyPrepare.mock.calls[0][1].inactiveProductIds).toBeUndefined()
})

it('names the Etsy shop by its shop name, never the login code; eBay keeps its display name', async () => {
  expect((await reviewStudioPublication('parent', etsyScope)).accountLabel).toBe('Fake Etsy Shop')
  const ebayScope = { channel: 'EBAY', marketplace: 'IT', accountId: 'ebay-store-b' }
  m.facts.mockImplementation(async () => ({ ...newFamily(), scope: ebayScope, account: { ...etsyAccount, displayName: 'Store B' }, createChoices: new Map() }))
  expect((await reviewStudioPublication('parent', ebayScope)).accountLabel).toBe('Store B')
})

it('the adapter\'s notes are the review\'s warnings', async () => {
  m.etsyNotices = ['Photos are not sent to Etsy yet; they come in a later Nexus update.']
  const review = await reviewStudioPublication('parent', etsyScope)
  expect(review.issues).toContainEqual({ severity: 'warning', message: 'Photos are not sent to Etsy yet; they come in a later Nexus update.' })
})

it('a claimed Etsy publication that reaches the send is FAILED, "Nothing was submitted": no draft, no journal', async () => {
  const facts = newFamily()
  const claim = { productId: 'parent', id: 'review-1', userId: 'user', data: { scope: etsyScope, startedAt: new Date().toISOString() }, input: {},
    plan: { facts, prepared: publication(facts, {}) } as never,
    destinationRow: { kind: 'studio-publication', productId: 'parent', channel: 'ETSY', marketplace: 'GLOBAL', channelConnectionId: 'etsy-shop-b', aliasKey: '', batchId: null } } as ClaimedPublication
  // Said once: "Nothing was submitted." is the result's own; the Etsy sentence adds why.
  expect(await deliverPublication(claim)).toEqual({ result: { id: 'review-1', status: 'FAILED', message: 'Nothing was submitted. Sending to Etsy comes in the next Nexus update.', results: [] }, receipt: undefined })
  expect(m.ensure).not.toHaveBeenCalled(); expect(m.record).not.toHaveBeenCalled()
})
