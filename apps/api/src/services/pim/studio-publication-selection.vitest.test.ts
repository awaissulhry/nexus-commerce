import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StudioPublishChange } from '@nexus/shared/studio-publication'

const m = vi.hoisted(() => ({ facts: vi.fn(), baseline: vi.fn(), prepare: vi.fn(), compile: vi.fn(), send: vi.fn(), records: vi.fn(),
  beforeUpdate: vi.fn(), rows: new Map<string, any>(), remoteRevision: 'remote-1', compilerVersion: 'compiler-1', mode: vi.fn(), shopPreview: vi.fn(), shopSend: vi.fn(), inventory: vi.fn(() => false), ebayPrepare: vi.fn() }))
vi.mock('./studio-publication-plan.js', async () => {
  const { createHash } = await import('node:crypto')
  return { readPublicationFacts: m.facts, publicationDigest: (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry)).digest('hex'),
  object: (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value : {} }
})
vi.mock('./workspace-destination.js', () => ({ WorkspaceScopeError: class extends Error { statusCode: number; constructor(message: string, statusCode = 409) { super(message); this.statusCode = statusCode } } }))
vi.mock('@nexus/database/workspace-context', () => ({ workspaceIdForQuery: () => 'selection-business' }))
vi.mock('../amazon-publish-gate.service.js', () => ({ getAmazonPublishMode: m.mode }))
vi.mock('../ebay-publish-gate.service.js', () => ({ getEbayPublishMode: m.mode }))
vi.mock('../shopify-publish-gate.service.js', () => ({ getShopifyPublishMode: m.mode }))
vi.mock('./studio-publication-baseline.js', () => ({ readPublicationBaseline: m.baseline }))
vi.mock('./studio-publication-overwrite.js', () => ({ readPublicationOverwrite: async () => ({ requiresConfirmation: false, products: [] }) }))
vi.mock('./studio-publication-records.js', () => ({ recordPublicationRequests: m.records, settlePublicationRecords: vi.fn() }))
vi.mock('./studio-publication-amazon.js', () => ({
  prepareAmazonPublication: async () => ({ kind: 'amazon', sellerId: 'seller', marketplaceId: 'market',
    products: [{ productId: 'parent', sku: 'SELLER-PARENT' }, { productId: 'child', sku: 'SELLER-CHILD' }], feed: { header: { version: '2.0' }, messages: [] } }),
  sendAmazonPublication: m.send, readAmazonPublication: vi.fn(async () => null),
}))
vi.mock('./studio-publication-amazon-changes.js', () => ({ prepareAmazonChanges: m.prepare, compileAmazonChanges: m.compile }))
vi.mock('./studio-publication-ebay.js', () => ({ prepareEbayPublication: m.ebayPrepare, sendEbayPublication: vi.fn(), readEbayPublication: vi.fn(), usesEbayInventory: (facts: unknown) => m.inventory(facts),
  ebayPublicationRequest: (plan: any) => ({ operation: 'ReviseFixedPriceItem', xml: plan.xml }) }))
vi.mock('./studio-publication-ebay-changes.js', () => ({ prepareEbayChanges: vi.fn(), compileEbayChanges: vi.fn() }))
vi.mock('../shopify/content-workspace.service.js', () => ({ getContentWorkspace: async () => ({ initialized: true }), saveContentWorkspace: vi.fn() }))
vi.mock('../shopify/content-sync.service.js', () => ({ previewContentSync: m.shopPreview, synchronizeContent: m.shopSend }))
// Publish starts missing rows through the one creator (`ensureDraftListings`); its own rules run on PostgreSQL.
vi.mock('./draft-listing.service.js', () => ({ ensureDraftListings: async () => [] }))
vi.mock('../../db.js', () => {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  const matches = (row: any, where: any) => (!where.id || (typeof where.id === 'string' ? row.id === where.id : row.id !== where.id.not))
    && (!Object.hasOwn(where, 'userId') || row.userId === where.userId)
    && (!where.status || (typeof where.status === 'string' ? row.status === where.status : where.status.in.includes(row.status)))
    && (!where.changes || (where.changes.path ? same(where.changes.path.reduce((value: any, key: string) => value?.[key], row.changes), where.changes.equals) : same(row.changes, where.changes.equals)))
  const db = { bulkOperation: {
    findFirst: async ({ where }: any) => structuredClone([...m.rows.values()].find(row => matches(row, where)) ?? null),
    create: async ({ data }: any) => { m.rows.set(data.id, structuredClone(data)); return structuredClone(data) },
    updateMany: async ({ where, data }: any) => {
      await m.beforeUpdate({ where, data })
      const rows = [...m.rows.values()].filter(row => matches(row, where))
      for (const row of rows) m.rows.set(row.id, structuredClone({ ...row, ...data }))
      return { count: rows.length }
    },
    update: async ({ where, data }: any) => { const next = { ...m.rows.get(where.id), ...data }; m.rows.set(where.id, structuredClone(next)); return structuredClone(next) },
  }, channelListing: { createMany: vi.fn(async () => ({ count: 0 })), updateMany: vi.fn(async () => ({ count: 0 })), count: vi.fn(async () => 0) },
  // Draft promotion reads the settled records; they are real only in the database suite.
  channelListingSnapshot: { findMany: async () => [] },
  $queryRawUnsafe: vi.fn(), $transaction: async (fn: any) => fn(db) }
  return { default: db }
})

import * as publication from './studio-publication.service.js'
import { selectPublicationChanges } from './studio-publication-changes.js'
import { blockRowChanges } from './studio-publication-selection.js'
import { FULL_EBAY_INVENTORY_LATER, FULL_EBAY_VARIATION, SHOPIFY_EXISTING_NOT_YET } from '@nexus/shared/publish-actions'

const scope = { channel: 'AMAZON', marketplace: 'IT', accountId: 'account' }
const facts = () => ({ scope, destination: { familyId: 'parent', aliasKey: '' }, account: { displayName: 'Account' }, parent: { id: 'parent' },
  products: [{ id: 'parent', sku: 'LOCAL-PARENT', name: 'Parent' }, { id: 'child', sku: 'LOCAL-CHILD', name: 'Child' }],
  listings: [], resolved: [], issues: [], excluded: 0, aliasLabel: 'Primary', revision: 'facts-1' })
const change = (productId: string, field: string, selectable = true): StudioPublishChange => ({ id: `field-${productId}-${field}`, productId,
  sku: productId === 'parent' ? 'SELLER-PARENT' : 'SELLER-CHILD', field, label: field,
  current: { state: 'value', value: `New ${field}` }, lastAccepted: { state: 'value', value: `Old ${field}` }, channel: { state: 'value', value: `Old ${field}` },
  localChanged: selectable, channelChanged: false, status: selectable ? 'SEND' : 'SAME', selectable, selectedByDefault: selectable, reason: 'Reviewed field', operation: 'replace' })
const changes = () => [change('parent', 'title'), change('child', 'title'), change('child', 'unchanged', false)]
const preview = () => publication.previewStudioPublication('parent', scope, 'owner')
const select = (id: string, selectedIds = ['field-child-title']) => publication.previewStudioPublicationSelection('parent', id, { selectedIds }, 'owner')

beforeEach(() => {
  vi.clearAllMocks(); m.rows.clear(); m.remoteRevision = 'remote-1'; m.compilerVersion = 'compiler-1'
  m.mode.mockReturnValue('live'); m.facts.mockImplementation(async () => facts()); m.baseline.mockResolvedValue({ values: new Map(), revision: 'baseline-1' })
  m.prepare.mockImplementation(async (_facts, prepared) => ({ kind: 'amazon-changes', changes: changes(), remoteRevision: m.remoteRevision, publication: prepared, products: [], schemas: [] }))
  m.compile.mockImplementation((plan, ids) => {
    const selected = selectPublicationChanges(plan.changes, ids)
    const products = plan.publication.products.filter((product: any) => selected.some(item => item.productId === product.productId))
    return { ...plan.publication, products, fieldWrites: Object.fromEntries(products.map((product: any) => [product.productId, selected.filter(item => item.productId === product.productId).map(item => ({ field: item.field, value: item.current }))])),
      feed: { header: { version: '2.0', compiler: m.compilerVersion }, messages: products.map((product: any, index: number) => ({ messageId: index + 1, sku: product.sku, operationType: 'PATCH', productType: 'COAT',
        patches: selected.filter(item => item.productId === product.productId).map(item => ({ op: 'replace', path: `/attributes/${item.field}`, value: [item.current] })) })) } }
  })
  m.send.mockImplementation(async (plan, _account, beforeSend) => { await beforeSend?.({ feedType: 'JSON_LISTINGS_FEED', marketplaceIds: ['market'], feed: plan.feed }); return 'feed-selection' })
  m.shopPreview.mockResolvedValue({ errors: [], initialized: true, revision: 'shop-local', remoteRevision: 'shop-remote', remote: { id: 'gid://shopify/Product/42' }, draft: {},
    variants: [{ id: 'child', sku: 'SHOP-CHILD' }], changes: { newProductStatus: 'ACTIVE' }, locations: [{ id: 'location', name: 'Stock', isActive: true }] })
})

it('stores the private change plan and returns selectable changes in the original review', async () => {
  const review = await preview()
  expect(review.changes).toEqual(changes())
  expect(m.rows.get(review.id!).changes).toMatchObject({ changeVersion: 1, changePlan: { changes: changes() } })
  expect(m.send).not.toHaveBeenCalled(); expect(m.records).not.toHaveBeenCalled()
})
it('warns when an existing Amazon variation theme would change', async () => {
  m.facts.mockImplementation(async () => ({ ...facts(), listings: [{ productId: 'parent', externalListingId: 'ASIN' }] }))
  m.prepare.mockImplementation(async (_facts, prepared) => ({ kind: 'amazon-changes', changes: [change('parent', 'variation_theme')], remoteRevision: 'remote-1', publication: prepared, products: [] }))
  expect((await preview()).issues).toContainEqual(expect.objectContaining({ field: 'variation_theme', severity: 'warning', message: expect.stringMatching(/variation.*relationship|regroup/i) }))
})
it('labels an accepted Amazon creation as existing while its local ASIN is still pending', async () => {
  m.prepare.mockImplementation(async (_facts, prepared) => ({ kind: 'amazon-changes', changes: changes(), remoteRevision: 'remote-1', publication: prepared,
    products: [{ productId: 'parent', sku: 'SELLER-PARENT', newListing: false }, { productId: 'child', sku: 'SELLER-CHILD', newListing: true }] }))
  const review = await preview()
  expect(review.action).toBe('update')
  expect(review.rows.map(row => row.existing)).toEqual([true, false])
})

it('compiles a durable selection without rereading facts, baselines or channels', async () => {
  const review = await preview()
  m.facts.mockClear(); m.baseline.mockClear(); m.prepare.mockClear()
  const selection = await select(review.id!)
  expect(selection).toMatchObject({ reviewId: review.id, token: expect.any(String), selectedIds: ['field-child-title'], products: [{ productId: 'child', sku: 'SELLER-CHILD' }], fieldCount: 1, payload: { format: 'json' } })
  expect(JSON.parse(selection.payload.content).feed.messages).toEqual([expect.objectContaining({ sku: 'SELLER-CHILD', patches: [expect.objectContaining({ path: '/attributes/title' })] })])
  expect(m.rows.get(review.id!).changes.selection).toEqual(selection)
  expect(m.facts).not.toHaveBeenCalled(); expect(m.baseline).not.toHaveBeenCalled(); expect(m.prepare).not.toHaveBeenCalled()
  expect(m.send).not.toHaveBeenCalled(); expect(m.records).not.toHaveBeenCalled()
})

it('keeps selected JSON payload stable when stored plan object keys are reordered', async () => {
  const review = await preview(), row = m.rows.get(review.id!)
  row.changes.changePlan = JSON.parse(JSON.stringify(row.changes.changePlan, (_key, entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.keys(entry).sort().reverse().map(key => [key, entry[key]])) : entry))
  const selection = await select(review.id!)
  const result = await publication.submitStudioPublication('parent', review.id!, { selectionToken: selection.token }, 'owner')
    .catch(error => ({ unexpectedFailure: error instanceof Error ? error.message : String(error) }))
  expect(result).toMatchObject({ status: 'SUBMITTED' })
  expect(m.records.mock.calls[0][1][0].request.message).toEqual(JSON.parse(selection.payload.content).feed.messages[0])
})

it.each([undefined, '', 'forged-token'])('refuses submission without the exact stored selection token (%s)', async selectionToken => {
  const review = await preview(); await select(review.id!)
  await expect(publication.submitStudioPublication('parent', review.id!, { selectionToken, confirmOverwrite: true }, 'owner')).rejects.toThrow(/selection|review|token/i)
  expect(m.send).not.toHaveBeenCalled(); expect(m.records).not.toHaveBeenCalled()
  expect(m.rows.get(review.id!).status).toBe('PREVIEW')
})

it('sends only the selected product and records explicit field intent separately from the exact request', async () => {
  const review = await preview(), selection = await select(review.id!)
  expect(await publication.submitStudioPublication('parent', review.id!, { selectionToken: selection.token }, 'owner')).toMatchObject({ status: 'SUBMITTED', results: [{ sku: 'SELLER-CHILD' }] })
  expect(m.send.mock.calls[0][0].products).toEqual([{ productId: 'child', sku: 'SELLER-CHILD' }])
  expect(m.records.mock.calls[0][1]).toEqual([expect.objectContaining({ productId: 'child', sku: 'SELLER-CHILD', request: expect.objectContaining({ intentVersion: 1,
    writes: [{ field: 'title', value: { state: 'value', value: 'New title' } }], message: JSON.parse(selection.payload.content).feed.messages[0] }) })])
})

it('ignores client payload and product replacements after a selection is confirmed', async () => {
  const review = await preview(), selection = await select(review.id!)
  expect(await publication.submitStudioPublication('parent', review.id!, { selectionToken: selection.token, selectedIds: ['field-parent-title'],
    products: [{ productId: 'parent', sku: 'FORGED' }], payload: { feed: { messages: [{ sku: 'FORGED' }] } } }, 'owner'))
    .toMatchObject({ status: 'SUBMITTED', results: [{ sku: 'SELLER-CHILD' }] })
  expect(m.send.mock.calls[0][0].products).toEqual([{ productId: 'child', sku: 'SELLER-CHILD' }])
})

it.each([['unknown'], ['field-child-title', 'field-child-title'], ['FIELD-CHILD-TITLE'], ['field-child-unchanged']])('refuses tampered or nonselectable IDs (%j)', async (...ids) => {
  const review = await preview()
  await expect(select(review.id!, ids)).rejects.toThrow()
  expect(m.send).not.toHaveBeenCalled()
})

it('previews an empty selection but refuses a send without selected work', async () => {
  const review = await preview(), selection = await select(review.id!, [])
  expect(selection).toMatchObject({ selectedIds: [], products: [], fieldCount: 0 })
  const refused = await publication.submitStudioPublication('parent', review.id!, { selectionToken: selection.token }, 'owner').catch(error => error)
  expect(refused).toMatchObject({ statusCode: 400, message: expect.stringMatching(/select|nothing|empty/i) })
  expect(m.send).not.toHaveBeenCalled(); expect(m.records).not.toHaveBeenCalled()
})

it('refuses a stale selection token after another field selection replaces it', async () => {
  const review = await preview(), old = await select(review.id!)
  const latest = await select(review.id!, ['field-parent-title'])
  expect(latest.token).not.toBe(old.token)
  await expect(publication.submitStudioPublication('parent', review.id!, { selectionToken: old.token }, 'owner')).rejects.toThrow(/selection|review|token/i)
  expect(m.send).not.toHaveBeenCalled()
})

it('does not overwrite a selection committed by another request during compilation', async () => {
  const review = await preview(); await select(review.id!)
  m.beforeUpdate.mockImplementationOnce(() => { m.rows.get(review.id!).changes.selection.token = 'another-request-token' })
  await expect(select(review.id!, ['field-parent-title'])).rejects.toThrow(/changed|selection/i)
  expect(m.rows.get(review.id!).changes.selection.token).toBe('another-request-token')
  expect(m.send).not.toHaveBeenCalled(); expect(m.records).not.toHaveBeenCalled()
})

it('checks the current selection again when claiming a submission', async () => {
  const review = await preview(), selection = await select(review.id!)
  m.beforeUpdate.mockImplementationOnce(() => { m.rows.get(review.id!).changes.selection.token = 'concurrent-selection-token' })
  await publication.submitStudioPublication('parent', review.id!, { selectionToken: selection.token }, 'owner').catch(() => {})
  expect(m.send).not.toHaveBeenCalled(); expect(m.records).not.toHaveBeenCalled()
  expect(m.rows.get(review.id!).status).toBe('PREVIEW')
})

it.each(['facts', 'baseline', 'remote', 'compiled'] as const)('refuses changed %s before sending a previously selected payload', async dependency => {
  const review = await preview(), selection = await select(review.id!)
  if (dependency === 'facts') m.facts.mockResolvedValue({ ...facts(), revision: 'facts-2' })
  if (dependency === 'baseline') m.baseline.mockResolvedValue({ values: new Map(), revision: 'baseline-2' })
  if (dependency === 'remote') m.remoteRevision = 'remote-2'
  if (dependency === 'compiled') m.compilerVersion = 'compiler-2'
  await expect(publication.submitStudioPublication('parent', review.id!, { selectionToken: selection.token }, 'owner')).rejects.toThrow(/changed|review|selection/i)
  expect(m.send).not.toHaveBeenCalled(); expect(m.records).not.toHaveBeenCalled()
})

it('refuses foreign users, products, expired and in-flight selection requests', async () => {
  const review = await preview()
  // Ordinary assertions preserve their AssertionError in Vitest's JSON mutation report.
  const outcome = (request: Promise<unknown>) => request.catch(error => error)
  expect(await outcome(publication.previewStudioPublicationSelection('parent', review.id!, { selectedIds: [] }, 'other')))
    .toMatchObject({ statusCode: 404, message: expect.stringMatching(/not found/i) })
  expect(await outcome(publication.previewStudioPublicationSelection('other-product', review.id!, { selectedIds: [] }, 'owner')))
    .toMatchObject({ statusCode: 404, message: expect.stringMatching(/not found/i) })
  m.rows.get(review.id!).expiresAt = new Date(0)
  expect(await outcome(select(review.id!))).toMatchObject({ statusCode: 409, message: expect.stringMatching(/expired/i) })
  m.rows.get(review.id!).expiresAt = new Date(Date.now() + 60_000); m.rows.get(review.id!).status = 'PUBLISHING'
  expect(await outcome(select(review.id!))).toMatchObject({ statusCode: 409, message: expect.stringMatching(/progress|submitted|review|selection|started/i) })
})

it('refuses a legacy PREVIEW instead of falling back to full-family publication', async () => {
  const review = await preview(); delete m.rows.get(review.id!).changes.changeVersion
  await expect(select(review.id!)).rejects.toThrow(/review|refresh|version/i)
  await expect(publication.submitStudioPublication('parent', review.id!, {}, 'owner')).rejects.toThrow(/review|refresh|version/i)
  expect(m.send).not.toHaveBeenCalled()
})

it('blocks existing remote Shopify products even if Nexus has no external listing ID', async () => {
  const shopScope = { channel: 'SHOPIFY', marketplace: 'GLOBAL', accountId: 'shop' }
  m.facts.mockResolvedValue({ ...facts(), scope: shopScope })
  const review = await publication.previewStudioPublication('parent', shopScope, 'owner')
  expect(review.id).toBeNull()
  expect(review.issues.some(issue => issue.severity === 'error' && /change.only|field|existing/i.test(issue.message))).toBe(true)
  expect(m.shopSend).not.toHaveBeenCalled()
})

// Build shape v2 P4 — the rows reviewed as Full update are the caller's list (P6 passes the stored Action values), kept
// with the review so its submit rebuilds the same plan. Everything else stays Partial, exactly as before.
describe('Full update rows', () => {
  const live = () => ({ ...facts(), listings: [{ productId: 'parent', externalListingId: 'ASIN-P' }, { productId: 'child', externalListingId: 'ASIN-C' }] })
  const removal = { productId: 'child', sku: 'SELLER-CHILD', field: 'fabric_type', label: 'Fabric', value: [{ value: 'Old' }] }
  beforeEach(() => {
    m.inventory.mockReturnValue(false)
    m.facts.mockImplementation(async () => live())
    m.prepare.mockImplementation(async (_facts, prepared, _baseline, options) => ({ kind: 'amazon-changes', changes: changes(), remoteRevision: m.remoteRevision, publication: prepared,
      products: [], ...(options?.fullProductIds?.size ? { removals: [removal] } : {}) }))
  })

  it('reviews only the asked rows on the channel as Full, says each row\'s mode, lists the removals and keeps the list with the review', async () => {
    const review = await publication.previewStudioPublication('parent', scope, 'owner', { fullProductIds: ['child', 'ghost', 'child'] })
    expect(m.prepare.mock.calls[0][3]).toEqual({ fullProductIds: new Set(['child']) })
    expect(review.rows.map(row => [row.productId, row.mode, row.blocked])).toEqual([['parent', 'partial', undefined], ['child', 'full', undefined]])
    expect(review.removals).toEqual([removal])
    expect(m.rows.get(review.id!).changes.fullProductIds).toEqual(['child', 'ghost'])
    // The submit rebuilds the review with the same Full rows: the same plan, so the same revision.
    const selection = await select(review.id!)
    m.prepare.mockClear()
    expect(await publication.submitStudioPublication('parent', review.id!, { selectionToken: selection.token }, 'owner')).toMatchObject({ status: 'SUBMITTED' })
    expect(m.prepare.mock.calls[0][3]).toEqual({ fullProductIds: new Set(['child']) })
  })

  it('with no Full rows the review is today\'s: Partial rows, no stored list, no removals', async () => {
    const review = await preview()
    expect(m.prepare.mock.calls[0][3]).toEqual({})
    expect(review.rows.map(row => row.mode)).toEqual(['partial', 'partial'])
    expect(review.removals).toBeUndefined()
    expect(m.rows.get(review.id!).changes).not.toHaveProperty('fullProductIds')
  })

  it('a row not on the channel yet is created whole: asked as Full, it is reviewed as Partial (the create)', async () => {
    m.facts.mockImplementation(async () => ({ ...facts(), listings: [{ productId: 'parent', externalListingId: 'ASIN-P' }, { productId: 'child', externalListingId: null }] }))
    const review = await publication.previewStudioPublication('parent', scope, 'owner', { fullProductIds: ['child'] })
    expect(m.prepare.mock.calls[0][3]).toEqual({})
    expect(review.rows.find(row => row.productId === 'child')?.mode).toBe('partial')
  })

  it('a Full row Amazon refuses (another product type) blocks the review by name', async () => {
    m.prepare.mockImplementation(async (_facts, prepared) => ({ kind: 'amazon-changes', changes: changes(), remoteRevision: 'remote-1', publication: prepared, products: [],
      fullIssues: [{ productId: 'child', sku: 'SELLER-CHILD', severity: 'error', message: 'SELLER-CHILD: Product type differs on Amazon — use Delete, then Publish.' }] }))
    const review = await publication.previewStudioPublication('parent', scope, 'owner', { fullProductIds: ['child'] })
    expect(review.id).toBeNull()
    expect(review.issues).toContainEqual(expect.objectContaining({ severity: 'error', message: 'SELLER-CHILD: Product type differs on Amazon — use Delete, then Publish.' }))
  })

  it.each([
    ['an existing Shopify product', { channel: 'SHOPIFY', marketplace: 'GLOBAL', accountId: 'shop' }, false, ['child'], { child: SHOPIFY_EXISTING_NOT_YET }],
    ['an eBay Inventory listing', { channel: 'EBAY', marketplace: 'IT', accountId: 'ebay' }, true, ['parent', 'child'], { parent: FULL_EBAY_INVENTORY_LATER, child: FULL_EBAY_INVENTORY_LATER }],
    ['an eBay variation row alone', { channel: 'EBAY', marketplace: 'IT', accountId: 'ebay' }, false, ['child'], { child: FULL_EBAY_VARIATION }],
  ])('Full on %s is refused with the shared sentence: the row is blocked, nothing of it is sent', async (_, destination, inventory, asked, blocked: Record<string, string>) => {
    m.facts.mockImplementation(async () => ({ ...live(), scope: destination }))
    m.inventory.mockReturnValue(inventory)
    const review = await publication.previewStudioPublication('parent', destination, 'owner', { fullProductIds: asked })
    for (const row of review.rows) expect([row.productId, row.blocked]).toEqual([row.productId, blocked[row.productId]])
    for (const [productId, reason] of Object.entries(blocked)) expect(review.issues).toContainEqual(expect.objectContaining({ productId, severity: 'warning', message: expect.stringContaining(reason) }))
    expect(m.ebayPrepare.mock.calls.every(call => call[1]?.full !== true)).toBe(true)
  })

  it('eBay Trading: Full on the main row reviews the whole item as Full update', async () => {
    const destination = { channel: 'EBAY', marketplace: 'IT', accountId: 'ebay' }
    m.facts.mockImplementation(async () => ({ ...live(), scope: destination }))
    const review = await publication.previewStudioPublication('parent', destination, 'owner', { fullProductIds: ['parent'] })
    expect(m.ebayPrepare.mock.calls[0][1]).toEqual({ full: true })
    expect(review.rows.map(row => row.mode)).toEqual(['full', 'full'])
  })

  it('a blocked row\'s fields cannot be ticked; the other rows keep their ticks', () => {
    const blockedChanges = blockRowChanges(changes(), new Map([['child', FULL_EBAY_INVENTORY_LATER]]))
    expect(blockedChanges.map(c => [c.productId, c.selectable, c.selectedByDefault])).toEqual([['parent', true, true], ['child', false, false], ['child', false, false]])
    expect(blockedChanges[1].reason).toBe(FULL_EBAY_INVENTORY_LATER)
  })
})
