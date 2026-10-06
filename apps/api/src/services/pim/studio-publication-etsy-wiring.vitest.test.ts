import { beforeEach, expect, it, vi } from 'vitest'
import { ETSY_NEW_ACTIVE_NEEDS_PHOTO, NOT_LISTED_MAIN_HELD } from '@nexus/shared/listing-actions'
import { FULL_ETSY_VARIATION } from '@nexus/shared/publish-actions'

/**
 * E2 + E3 — the Etsy publisher wired into studio Publish, with its adapter, its sends and its "creating" marker mocked
 * (their own suites prove the payload, each call and the marker's SQL): a listing Etsy holds is sent (each call journalled
 * just before it goes, then stored through the settle core); a new listing is reviewed, starts as an Etsy draft and is
 * created by the create send (E3) through the studio's hooks: drafts + marker first, each call journalled, the listing id
 * stored on every delivered row once Etsy answers. Fake ids only (public repo).
 */
const m = vi.hoisted(() => ({ facts: vi.fn(), mode: vi.fn(), etsyMode: vi.fn(), etsyPrepare: vi.fn(), etsyNotices: [] as string[], rows: new Map<string, any>(),
  ensure: vi.fn(), record: vi.fn(), ebay: vi.fn(), drift: vi.fn(), locks: vi.fn(), published: [] as any[], changes: vi.fn(), send: vi.fn(), order: [] as string[],
  live: { quantity: 5, readiness: 1 }, create: vi.fn(), createResult: vi.fn(), claimCreate: vi.fn(), markUnknown: vi.fn(), release: vi.fn(), store: vi.fn() }))
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
// The Etsy adapter: prepare records what the service asked for. A new listing is ONE create whose value is the whole
// request; a listing on Etsy is two lines (Tags and the variations), each sent by its own call.
const createId = JSON.stringify(['parent', '__create__'])
const tagsId = JSON.stringify(['parent', 'tags']), inventoryId = JSON.stringify(['parent', 'inventory'])
const createRequest = { operation: 'createDraftListing', listingId: null, calls: [
  { method: 'POST', path: '/shops/{shop_id}/listings', encoding: 'form', body: { title: 'Fake title', quantity: 1 }, fields: ['title'] },
  { method: 'PUT', path: '/listings/{listing_id}/inventory', encoding: 'json', body: { products: [] }, fields: ['inventory'] }] }
const calls = {
  tags: { method: 'PATCH', path: '/shops/{shop_id}/listings/9000000001', encoding: 'form', body: { tags: ['fake-tag'] }, fields: ['tags'] },
  inventory: { method: 'PUT', path: '/listings/9000000001/inventory', encoding: 'json', body: { products: [] }, fields: ['inventory'] },
}
const line = (id: string, field: string, label: string, value: unknown, locked: boolean) => ({ id, field, label, productId: 'parent', sku: 'FAKE-SKU-1',
  current: { state: 'value', value }, lastAccepted: { state: 'unknown', reason: 'No record' }, channel: { state: 'absent' }, status: 'SEND', selectable: true,
  selectedByDefault: true, localChanged: null, channelChanged: null, reason: 'Differs', operation: 'replace', ...(locked ? { locked: true } : {}) })
vi.mock('./studio-publication-etsy.js', () => ({ prepareEtsyPublication: m.etsyPrepare }))
vi.mock('./studio-publication-etsy-changes.js', async original => ({
  // The digest's view of the plan stays the real one (`etsyRevisionView`): a stock move between review and Publish is no change.
  ...(await original<Record<string, unknown>>()),
  prepareEtsyChanges: (...args: any[]) => {
    m.changes(...args)
    const [, publication, , options] = args
    return { kind: 'etsy-changes', publication, remoteRevision: publication.liveRevision ?? 'new', products: publication.products, ownerProductId: publication.ownerProductId,
      createWrites: { [publication.ownerProductId]: [{ field: 'title', value: { state: 'value', value: 'Fake title' } }, { field: 'inventory', value: { state: 'value', value: { products: [] } } }] },
      ...(options?.full ? { full: true } : {}),
      changes: publication.listingId
        ? [line(tagsId, 'tags', 'Tags', ['fake-tag'], !!options?.full), line(inventoryId, 'inventory', 'Variations, SKUs and processing profile', { products: [] }, !!options?.full)]
        : [{ ...line(createId, '__create__', 'Create Etsy listing (draft)', createRequest, false), lastAccepted: { state: 'unknown', reason: 'No listing exists.' }, reason: 'New listing' }] }
  },
  compileEtsyChanges: (plan: any, ids: string[]) => {
    const publication = plan.publication
    const empty = { removeSkus: [], removeUnnamed: false, addedSkus: [] }
    if (!ids.length) return { ...publication, products: [], fieldWrites: {}, request: null, ...empty }
    if (!publication.listingId) return { ...publication, products: plan.products, fieldWrites: plan.createWrites, request: createRequest, ...empty }
    const fields = plan.changes.filter((change: any) => ids.includes(change.id)).map((change: any) => change.field)
    const products = fields.includes('inventory') ? [publication.products[0], ...publication.inventoryProducts] : [publication.products[0]]
    return { ...publication, live: null, products, ...empty,
      fieldWrites: { parent: fields.map((field: string) => ({ field, value: plan.changes.find((change: any) => change.field === field).current })) },
      request: { operation: 'updateListing', listingId: publication.listingId, calls: fields.map((field: string) => calls[field as keyof typeof calls]) } }
  },
}))
// The send: its own suite proves each call, the read-back and the result's words. Here it journals each call it is handed,
// in order, just before "sending" it.
vi.mock('./studio-publication-etsy-send.js', async original => ({ ...(await original<Record<string, unknown>>()), sendEtsyPublication: m.send }))
// E3 — the create send (its suite proves the POST, the steps and the result's words) and the "creating" marker (its suite
// proves the SQL). Here the send calls the studio's hooks in the order its suite proves.
vi.mock('./studio-publication-etsy-create.js', () => ({ sendEtsyCreate: m.create, etsyCreateResult: m.createResult }))
vi.mock('./studio-publication-etsy-marker.js', async original => ({ ...(await original<Record<string, unknown>>()), claimEtsyCreate: m.claimCreate,
  markEtsyCreateUnknown: m.markUnknown, releaseEtsyCreate: m.release, storeEtsyCreatedListing: m.store }))
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
  },
  // The settle core's draft promotion reads the settled records; they are real only in the database suites.
  channelListing: { findMany: async () => [], findUnique: async () => null, updateMany: async () => ({ count: 0 }), count: async () => 0 },
  channelListingSnapshot: { findMany: async () => [] }, $queryRawUnsafe: m.locks, $transaction: async (fn: any) => fn(db) }
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
/** The same family on Etsy (listing 9000000001), every row live. */
function onEtsyFamily() {
  const listings = products.map(p => ({ id: `listing-${p.id}`, productId: p.id, channel: 'ETSY', marketplace: 'GLOBAL', externalListingId: '9000000001', listingStatus: 'ACTIVE', isPublished: true }))
  return { ...newFamily(), listings, createChoices: newListingChoices({ channel: 'ETSY', aliasKey: '', familyId: 'parent', products, listings }) }
}
/** The same family on Etsy, with one new variation whose own Status is `childTarget` (null: none). */
function listedFamily(childTarget: string | null) {
  const all = [...products, { id: 'child-l', sku: 'FAKE-SKU-4', name: 'Fake L', parentId: 'parent' }]
  const listings = all.map(p => p.id === 'child-l'
    ? { id: 'listing-child-l', productId: p.id, channel: 'ETSY', marketplace: 'GLOBAL', externalListingId: null, listingStatus: 'DRAFT', isPublished: false,
      ...(childTarget ? { sellingTarget: childTarget, sellingTargetAt: new Date('2026-10-05T09:00:00Z') } : {}) }
    : { id: `listing-${p.id}`, productId: p.id, channel: 'ETSY', marketplace: 'GLOBAL', externalListingId: '9000000001', listingStatus: 'ACTIVE', isPublished: true })
  return { ...newFamily(), products: all, listings, createChoices: newListingChoices({ channel: 'ETSY', aliasKey: '', familyId: 'parent', products: all, listings }) }
}
/** Etsy as read for a listing it holds: its stock moves (`m.live.quantity`); the revision leaves the offerings out (B2). */
const liveRead = () => ({ listingId: '9000000001', state: 'active', revision: 'live-1',
  offerings: { 'FAKE-SKU-2': { price: 10, quantity: m.live.quantity, is_enabled: true, readiness_state_id: m.live.readiness } } })
const publication = (facts: any, options: any) => {
  const listingId = facts.listings.find((l: any) => l.externalListingId)?.externalListingId ?? null
  return { kind: 'etsy', marketplace: 'GLOBAL', listingId, products: facts.products.map((p: any) => ({ productId: p.id, sku: p.sku })),
    inventoryProducts: facts.products.filter((p: any) => p.id !== 'parent').map((p: any) => ({ productId: p.id, sku: p.sku })), ownerProductId: 'parent',
    values: {}, form: {}, inventory: {}, structure: { properties: [], products: [] }, properties: [], translations: [], currency: 'EUR',
    create: listingId ? null : { state: options.createState ?? 'draft', price: 19.99, quantity: 1 },
    live: listingId ? liveRead() : null, liveRevision: listingId ? 'live-1' : null, ...(m.etsyNotices.length ? { notices: m.etsyNotices } : {}) }
}
/** The send as its suite proves it: each call journalled (`beforeSend`) just before it goes, in the request's order. */
const sendingEvery = (receipt: Record<string, unknown>) => async (plan: any, _accountId: string, _reviewId: string, beforeSend: (request: any) => Promise<void>) => {
  for (const call of plan.request.calls) {
    await beforeSend({ operation: 'updateListing', method: call.method, path: call.path, encoding: call.encoding, body: call.body, fields: call.fields })
    m.order.push(`${call.method} sent`)
  }
  return { reference: plan.listingId, steps: plan.request.calls.map((call: any) => ({ label: call.fields[0], fields: call.fields, outcome: 'applied' })), mismatches: [], verified: true, ...receipt }
}
/** Review a listing on Etsy, tick both lines and submit. */
async function publishOnEtsy(between: () => void = () => {}) {
  const review = await previewStudioPublication('parent', etsyScope, 'user')
  const selection = await previewStudioPublicationSelection('parent', review.id!, { selectedIds: [tagsId, inventoryId] }, 'user')
  between()
  return { review, result: await submitStudioPublication('parent', review.id!, { selectionToken: selection.token }, 'user') }
}

/** The create send as its suite proves it: claim → journal + POST → landed → journal + each later call → the receipt. */
const creating = (receipt: Record<string, unknown> = {}) => async (plan: any, _accountId: string, reviewId: string, hooks: any) => {
  await hooks.claim({ reviewId, title: 'Fake title', skus: ['FAKE-SKU-2', 'FAKE-SKU-3'] })
  const [post, ...later] = plan.request.calls
  await hooks.beforeSend({ operation: 'createDraftListing', method: 'POST', path: post.path, encoding: post.encoding, body: post.body, fields: post.fields })
  m.order.push('POST sent')
  await hooks.landed('9000000001')
  for (const call of later) {
    await hooks.beforeSend({ operation: 'createDraftListing', method: call.method, path: call.path.replace('{listing_id}', '9000000001'), encoding: call.encoding, body: call.body, fields: call.fields })
    m.order.push(`${call.method} sent`)
  }
  return { reference: '9000000001', verified: true, steps: [], mismatches: [], created: { listingId: '9000000001', state: 'draft' }, ...receipt }
}
/** A stand-in for the create result (its words are the create suite's): VERIFIED or UNVERIFIED from the receipt. */
const createResultOf = (id: string, plan: any, receipt: any) => ({ id, status: receipt.verified && !receipt.createUnknown ? 'VERIFIED' : 'UNVERIFIED',
  message: receipt.createUnknown ?? 'Etsy created draft listing 9000000001.', results: plan.products.map((p: any) => ({ sku: p.sku, status: receipt.verified ? 'VERIFIED' : 'SUBMITTED',
    message: 'stand-in', ...(receipt.reference ? { reference: receipt.reference } : {}) })) })
/** Review a new Etsy listing, tick its create and submit. */
async function createOnEtsy() {
  const review = await previewStudioPublication('parent', etsyScope, 'user')
  const selection = await previewStudioPublicationSelection('parent', review.id!, { selectedIds: [createId] }, 'user')
  return { review, result: await submitStudioPublication('parent', review.id!, { selectionToken: selection.token }, 'user') }
}
const where = { marketplace: 'GLOBAL', accountId: 'etsy-shop-b', aliasKey: '', ownerProductId: 'parent' }

beforeEach(() => {
  vi.resetAllMocks(); m.rows.clear(); m.etsyNotices = []; m.published.length = 0; m.order.length = 0; m.live = { quantity: 5, readiness: 1 }
  m.mode.mockReturnValue('live'); m.etsyMode.mockReturnValue('live'); m.drift.mockResolvedValue([])
  m.ensure.mockImplementation(async () => { m.order.push('drafts'); return [] })
  m.record.mockImplementation(async (_context: unknown, _items: unknown, at: number) => { m.order.push(`journal ${at}`) })
  m.facts.mockImplementation(async () => newFamily())
  m.etsyPrepare.mockImplementation(async (facts: any, options: any) => publication(facts, options))
  m.send.mockImplementation(sendingEvery({}))
  m.create.mockImplementation(creating())
  m.createResult.mockImplementation(createResultOf)
  m.claimCreate.mockImplementation(async () => { m.order.push('marker') })
  m.store.mockImplementation(async () => { m.order.push('stored'); return 3 })
})

it('a listing on Etsy: each call is journalled just before it goes (its own field writes), drafts are started once, and the verified result is stored', async () => {
  m.facts.mockImplementation(async () => onEtsyFamily())
  const { review, result } = await publishOnEtsy()
  expect(review.issues.filter(issue => issue.severity === 'error')).toEqual([])
  expect(m.send).toHaveBeenCalledTimes(1)
  expect(m.send).toHaveBeenCalledWith(expect.objectContaining({ listingId: '9000000001', live: null }), 'etsy-shop-b', review.id, expect.any(Function))
  expect(m.order).toEqual(['drafts', 'journal 0', 'PATCH sent', 'journal 1', 'PUT sent'])
  expect(m.ensure).toHaveBeenCalledTimes(1)
  // Each journal names every delivered product (the main row, and its variations: the variations line is ticked) with the
  // exact call; only the main row writes, and only the fields that call carries.
  const journal = (at: number) => m.record.mock.calls[at][1].map((item: any) => [item.productId, item.request.method, item.request.intentVersion, item.request.writes.map((w: any) => w.field)])
  expect(journal(0)).toEqual([['parent', 'PATCH', 1, ['tags']], ['child-s', 'PATCH', 1, []], ['child-m', 'PATCH', 1, []]])
  expect(journal(1)).toEqual([['parent', 'PUT', 1, ['inventory']], ['child-s', 'PUT', 1, []], ['child-m', 'PUT', 1, []]])
  expect(m.record.mock.calls[0][1][0].request).toMatchObject({ operation: 'updateListing', path: '/shops/{shop_id}/listings/9000000001', encoding: 'form', body: { tags: ['fake-tag'] } })
  expect(result.status).toBe('VERIFIED')
  expect(result.results.map(row => row.sku)).toEqual(['FAKE-SKU-1', 'FAKE-SKU-2', 'FAKE-SKU-3'])
  expect(m.rows.get(review.id!)).toMatchObject({ status: 'VERIFIED', changes: { result: { status: 'VERIFIED' }, etsyCreate: false } })
  expect(m.published.map(event => event.status)).toEqual(['PUBLISHING', 'VERIFIED'])
  // An update never reaches the create send or the marker.
  expect(m.create).not.toHaveBeenCalled(); expect(m.claimCreate).not.toHaveBeenCalled(); expect(m.store).not.toHaveBeenCalled()
})

it('a send that sends nothing (Etsy changed after the review) is FAILED, "Nothing was submitted.", and stored', async () => {
  m.facts.mockImplementation(async () => onEtsyFamily())
  m.send.mockRejectedValue(Object.assign(new Error('Etsy changed this listing after the review (its fields, attributes, variations, translations or state). Review again.'), { notSent: true }))
  const { review, result } = await publishOnEtsy()
  expect(result).toEqual({ id: review.id, status: 'FAILED', results: [],
    message: 'Nothing was submitted. Etsy changed this listing after the review (its fields, attributes, variations, translations or state). Review again.' })
  expect(m.record).not.toHaveBeenCalled()
  expect(m.rows.get(review.id!)).toMatchObject({ status: 'FAILED' })
})

it('a receipt the read-back did not confirm is stored UNVERIFIED (the destination waits for a person to check it)', async () => {
  m.facts.mockImplementation(async () => onEtsyFamily())
  m.send.mockImplementation(sendingEvery({ verified: false, mismatches: ['Tags: Etsy holds something other than what Nexus sent.'] }))
  const { review, result } = await publishOnEtsy()
  expect(result.status).toBe('UNVERIFIED')
  expect(m.rows.get(review.id!)).toMatchObject({ status: 'UNVERIFIED' })
})

it('a stock move on Etsy between the review and Publish is no change: the claim succeeds; a processing profile changed on Etsy is one', async () => {
  m.facts.mockImplementation(async () => onEtsyFamily())
  const { result } = await publishOnEtsy(() => { m.live.quantity = 2 })
  expect(result.status).toBe('VERIFIED')
  // The control: what a send depends on (here a variation's processing profile) still asks for a new review.
  m.rows.clear(); m.send.mockClear()
  await expect(publishOnEtsy(() => { m.live.readiness = 2 })).rejects.toMatchObject({ message: expect.stringContaining('Review the current values before publishing.') })
  expect(m.send).not.toHaveBeenCalled()
})

it('sending off, a listing on Etsy: the gate sentence, as for every channel; nothing is stored', async () => {
  m.facts.mockImplementation(async () => onEtsyFamily())
  m.etsyMode.mockReturnValue('gated')
  const review = await previewStudioPublication('parent', etsyScope, 'user')
  expect(review.id).toBeNull()
  expect(m.rows.size).toBe(0)
  expect(review.issues.filter(issue => issue.severity === 'error')).toEqual([{ severity: 'error',
    message: 'Sending is off: publishing to Etsy is turned off on this server. Nexus ran every check it can without reading Etsy (it reads the live listing only when sending is live); nothing will be sent until live publishing is turned on.' }])
  // Dry-run reads no Etsy either: the same words, in its own mode.
  m.etsyMode.mockReturnValue('dry-run')
  expect((await previewStudioPublication('parent', etsyScope, 'user')).issues.filter(issue => issue.severity === 'error').map(issue => issue.message))
    .toEqual(['Sending is off: publishing to Etsy is in dry-run mode on this server. Nexus ran every check it can without reading Etsy (it reads the live listing only when sending is live); nothing will be sent until live publishing is turned on.'])
})

it('Full update on the main row reviews every row as Full update, and the change plan is asked for the whole listing', async () => {
  m.facts.mockImplementation(async () => onEtsyFamily())
  const review = await previewStudioPublication('parent', etsyScope, 'user', { fullProductIds: ['parent'] })
  expect(review.rows.map(row => [row.sku, row.mode, row.blocked])).toEqual([['FAKE-SKU-1', 'full', undefined], ['FAKE-SKU-2', 'full', undefined], ['FAKE-SKU-3', 'full', undefined]])
  expect(m.changes.mock.calls[0][3]).toEqual({ full: true })
})

it('Full update on a variation alone is held with why (Etsy changes a whole listing); the plan stays Partial', async () => {
  m.facts.mockImplementation(async () => onEtsyFamily())
  const review = await previewStudioPublication('parent', etsyScope, 'user', { fullProductIds: ['child-s'] })
  expect(review.rows.find(row => row.sku === 'FAKE-SKU-2')).toMatchObject({ mode: 'full', blocked: FULL_ETSY_VARIATION })
  expect(review.issues).toContainEqual({ productId: 'child-s', sku: 'FAKE-SKU-2', severity: 'warning', message: `FAKE-SKU-2: ${FULL_ETSY_VARIATION}` })
  expect(m.changes.mock.calls[0][3]).toEqual({})
})

it('sending off, a new listing: the review still holds the one create change, and the gate sentence is its one error (as an update\'s); nothing is stored', async () => {
  m.etsyMode.mockReturnValue('gated')
  const review = await previewStudioPublication('parent', etsyScope, 'user')
  expect(review.id).toBeNull()
  expect(m.rows.size).toBe(0)
  expect(review.issues.filter(issue => issue.severity === 'error')).toEqual([{ severity: 'error',
    message: 'Sending is off: publishing to Etsy is turned off on this server. Nexus ran every check it can without reading Etsy (it reads the live listing only when sending is live); nothing will be sent until live publishing is turned on.' }])
  expect(review.issues.map(issue => issue.message).join('\n')).not.toMatch(/next Nexus update/)
  expect(review.changes?.map(change => change.field)).toEqual(['__create__'])
  // A new listing nobody chose for starts as an Etsy draft (Owner D1 = A); the live and shop readers are handed over, never called here.
  expect(m.etsyPrepare).toHaveBeenCalledWith(expect.objectContaining({ scope: etsyScope }), { createState: 'draft', readLive: expect.any(Function), readShop: expect.any(Function) })
  expect(m.create).not.toHaveBeenCalled()
})

it('sending live, a new listing: stored as a review with no "comes later" warning; every row starts Inactive (a draft); the selection is the exact JSON request', async () => {
  const review = await previewStudioPublication('parent', etsyScope, 'user')
  expect(review.id).toEqual(expect.any(String))
  expect(m.rows.get(review.id!)).toMatchObject({ status: 'PREVIEW', changes: { changeVersion: 1, changePlan: { kind: 'etsy-changes' } } })
  expect(review.issues.filter(issue => issue.severity === 'error')).toEqual([])
  expect(review.issues.map(issue => issue.message).join('\n')).not.toMatch(/next Nexus update/)
  expect(review.changes).toEqual([expect.objectContaining({ id: createId, field: '__create__', selectable: true, selectedByDefault: true })])
  expect(review.rows.map(row => [row.sku, row.startsAs])).toEqual([['FAKE-SKU-1', 'inactive'], ['FAKE-SKU-2', 'inactive'], ['FAKE-SKU-3', 'inactive']])
  const selection = await previewStudioPublicationSelection('parent', review.id!, { selectedIds: [createId] }, 'user')
  expect(selection).toMatchObject({ fieldCount: 1, payload: { format: 'json' }, products: products.map(p => ({ productId: p.id, sku: p.sku })) })
  expect(JSON.parse(selection.payload.content)).toEqual(createRequest)
})

it('E3 — a new listing\'s submit is claimed (no refusal) and sent by the create send: drafts, then the marker, each call journalled in order, the id stored on every delivered row; VERIFIED stored', async () => {
  const { review, result } = await createOnEtsy()
  // The claim records that this publication creates the listing (the marker, the settle and Mark as checked read it).
  expect(m.rows.get(review.id!).changes).toMatchObject({ etsyCreate: true, delivery: { productIds: ['parent', 'child-s', 'child-m'], aliasKey: '' } })
  expect(m.send).not.toHaveBeenCalled()
  expect(m.create).toHaveBeenCalledTimes(1)
  expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ listingId: null, request: createRequest }), 'etsy-shop-b', review.id, expect.objectContaining({
    claim: expect.any(Function), beforeSend: expect.any(Function), landed: expect.any(Function), unknown: expect.any(Function), release: expect.any(Function) }))
  expect(m.order).toEqual(['drafts', 'marker', 'journal 0', 'POST sent', 'stored', 'journal 1', 'PUT sent'])
  expect(m.ensure).toHaveBeenCalledTimes(1)
  // The marker: this destination's main row, the create send's facts and the person who published.
  expect(m.claimCreate).toHaveBeenCalledWith(where, { reviewId: review.id, title: 'Fake title', skus: ['FAKE-SKU-2', 'FAKE-SKU-3'], userId: 'user' })
  // Each journal names every delivered product with the exact call; only the main row writes, and only the fields that call carries.
  const journal = (at: number) => m.record.mock.calls[at][1].map((item: any) => [item.productId, item.request.method, item.request.intentVersion, item.request.writes.map((w: any) => w.field)])
  expect(m.record.mock.calls.map(call => call[2])).toEqual([0, 1])
  expect(journal(0)).toEqual([['parent', 'POST', 1, ['title']], ['child-s', 'POST', 1, []], ['child-m', 'POST', 1, []]])
  expect(journal(1)).toEqual([['parent', 'PUT', 1, ['inventory']], ['child-s', 'PUT', 1, []], ['child-m', 'PUT', 1, []]])
  expect(m.record.mock.calls[0][1][0].request).toMatchObject({ operation: 'createDraftListing', path: '/shops/{shop_id}/listings', encoding: 'form', body: { title: 'Fake title', quantity: 1 } })
  expect(m.record.mock.calls[1][1][0].request).toMatchObject({ operation: 'createDraftListing', path: '/listings/9000000001/inventory' })
  // Etsy's listing id goes on every delivered row of this destination, once Etsy answered.
  expect(m.store).toHaveBeenCalledWith(where, { reviewId: review.id, productIds: ['parent', 'child-s', 'child-m'], listingId: '9000000001' })
  expect(m.markUnknown).not.toHaveBeenCalled(); expect(m.release).not.toHaveBeenCalled()
  expect(m.createResult).toHaveBeenCalledWith(review.id, expect.objectContaining({ listingId: null }), expect.objectContaining({ reference: '9000000001', verified: true }))
  expect(result.status).toBe('VERIFIED')
  expect(m.rows.get(review.id!)).toMatchObject({ status: 'VERIFIED', changes: { result: { status: 'VERIFIED' } } })
  expect(m.published.map(event => event.status)).toEqual(['PUBLISHING', 'VERIFIED'])
})

it('E3 — a create that sends nothing (Etsy refused the POST, or the marker was refused) is FAILED, "Nothing was submitted.", and stored', async () => {
  m.create.mockRejectedValue(Object.assign(new Error('Etsy refused the listing: fake reason.'), { notSent: true }))
  const { review, result } = await createOnEtsy()
  expect(result).toEqual({ id: review.id, status: 'FAILED', results: [], message: 'Nothing was submitted. Etsy refused the listing: fake reason.' })
  expect(m.rows.get(review.id!)).toMatchObject({ status: 'FAILED' })
  expect(m.createResult).not.toHaveBeenCalled()
})

it('E3 — a create whose outcome is unknown is stored UNVERIFIED (the destination waits for Mark as checked)', async () => {
  m.create.mockImplementation(async (plan: any, _accountId: string, reviewId: string, hooks: any) => {
    await hooks.claim({ reviewId, title: 'Fake title', skus: [] })
    await hooks.beforeSend({ operation: 'createDraftListing', method: 'POST', path: '/shops/{shop_id}/listings', encoding: 'form', body: plan.request.calls[0].body, fields: ['title'] })
    await hooks.unknown('No answer from Etsy.')
    return { reference: '', verified: false, steps: [], mismatches: [], created: { listingId: null, state: null }, createUnknown: 'No answer from Etsy.' }
  })
  const { review, result } = await createOnEtsy()
  expect(m.markUnknown).toHaveBeenCalledWith(where, review.id, 'No answer from Etsy.', undefined)
  expect(m.store).not.toHaveBeenCalled(); expect(m.release).not.toHaveBeenCalled()
  expect(result.status).toBe('UNVERIFIED')
  expect(m.rows.get(review.id!)).toMatchObject({ status: 'UNVERIFIED', changes: { result: { status: 'UNVERIFIED', message: 'No answer from Etsy.' } } })
})

it('E3 — the hooks address only this destination\'s marker: unknown keeps Etsy\'s id, release removes it (each with this publication\'s id)', async () => {
  m.create.mockImplementation(async (_plan: any, _accountId: string, _reviewId: string, hooks: any) => {
    await hooks.unknown('Etsy created listing 9000000001, but Nexus could not record it: fake.', '9000000001')
    await hooks.release()
    throw Object.assign(new Error('Stand-in.'), { notSent: true })
  })
  const { review } = await createOnEtsy()
  expect(m.markUnknown).toHaveBeenCalledWith(where, review.id, 'Etsy created listing 9000000001, but Nexus could not record it: fake.', '9000000001')
  expect(m.release).toHaveBeenCalledWith(where, review.id)
})

it('a stored Etsy review without its change plan asks for a refreshed review (not the create refusal); nothing is claimed', async () => {
  const review = await previewStudioPublication('parent', etsyScope, 'user')
  const row = m.rows.get(review.id!)
  m.rows.set(review.id!, { ...row, changes: { ...row.changes, changeVersion: null, changePlan: null } })
  const before = structuredClone(m.rows.get(review.id!))
  await expect(submitStudioPublication('parent', review.id!, { selectionToken: 'any' }, 'user'))
    .rejects.toMatchObject({ message: 'Refresh this review to choose the fields to publish.' })
  expect(m.rows.get(review.id!)).toEqual(before)
  expect(m.facts).toHaveBeenCalledTimes(1)
  expect(m.ensure).not.toHaveBeenCalled(); expect(m.record).not.toHaveBeenCalled(); expect(m.locks).not.toHaveBeenCalled(); expect(m.send).not.toHaveBeenCalled()
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
  expect(m.rows.get(review.id!).changes.inactiveProductIds).toBeUndefined()
})

it.each([['its own Status', 'INACTIVE', undefined], ['"New listings start as"', null, 'inactive' as const]])('a new variation of a listing on Etsy set Inactive (%s) joins it hidden (D6): no error, the adapter and the stored review name it', async (_, stored, startAs) => {
  m.facts.mockImplementation(async () => listedFamily(stored))
  const review = await previewStudioPublication('parent', etsyScope, 'user', startAs ? { startAs } : {})
  expect(review.id).toEqual(expect.any(String))
  expect(review.issues.filter(issue => issue.severity === 'error')).toEqual([])
  expect(review.rows.find(row => row.sku === 'FAKE-SKU-4')!.startsAs).toBe('inactive')
  expect(m.etsyPrepare.mock.calls[0][1].inactiveProductIds).toEqual(new Set(['child-l']))
  expect(m.rows.get(review.id!).changes.inactiveProductIds).toEqual(['child-l'])
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

it('E3 — a delivery routes by the plan: no listing id → the create send (never the update send); sending turned off since the claim → nothing started', async () => {
  const facts = newFamily()
  const claim = { productId: 'parent', id: 'review-1', userId: 'user', data: { scope: etsyScope, startedAt: new Date().toISOString(), delivery: { productIds: ['parent'], aliasKey: '' } }, input: {},
    plan: { facts, prepared: { ...publication(facts, {}), fieldWrites: {}, request: createRequest } } as never,
    destinationRow: { kind: 'studio-publication', productId: 'parent', channel: 'ETSY', marketplace: 'GLOBAL', channelConnectionId: 'etsy-shop-b', aliasKey: '', batchId: null } } as ClaimedPublication
  m.etsyMode.mockReturnValue('gated')
  expect(await deliverPublication(claim)).toEqual({ result: { id: 'review-1', status: 'FAILED', message: 'Nothing was submitted. Live publication was disabled before submission.', results: [] }, receipt: undefined })
  expect(m.create).not.toHaveBeenCalled(); expect(m.ensure).not.toHaveBeenCalled(); expect(m.record).not.toHaveBeenCalled()
  m.etsyMode.mockReturnValue('live')
  const delivered = await deliverPublication(claim)
  expect(delivered.result.status).toBe('VERIFIED')
  expect(m.create).toHaveBeenCalledTimes(1); expect(m.send).not.toHaveBeenCalled()
  expect(m.store).toHaveBeenCalledWith(where, { reviewId: 'review-1', productIds: ['parent'], listingId: '9000000001' })
})
