/**
 * PE P3.4 — studio Publish for an eBay Inventory-model listing, end to end through the service: review (real change plan),
 * field selection (real compiler), submit (journal before the group PUT), result, and a later status read. eBay stubbed.
 */
import { beforeEach, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ facts: vi.fn(), mode: vi.fn(), send: vi.fn(), ebayStatus: vi.fn(), record: vi.fn(), events: [] as string[], rows: new Map<string, any>() }))
vi.mock('./studio-publication-plan.js', async () => {
  const { createHash } = await import('node:crypto')
  return { readPublicationFacts: m.facts, publicationDigest: (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex'), object: (v: any) => v && typeof v === 'object' ? v : {} }
})
vi.mock('@nexus/database/workspace-context', () => ({ workspaceIdForQuery: () => 'business-a' }))
vi.mock('../amazon-publish-gate.service.js', () => ({ getAmazonPublishMode: m.mode }))
vi.mock('../ebay-publish-gate.service.js', () => ({ getEbayPublishMode: m.mode }))
vi.mock('../shopify-publish-gate.service.js', () => ({ getShopifyPublishMode: m.mode }))
vi.mock('./studio-publication-amazon.js', () => ({ prepareAmazonPublication: vi.fn(), sendAmazonPublication: vi.fn(), readAmazonPublication: vi.fn() }))
vi.mock('./studio-publication-overwrite.js', () => ({ readPublicationOverwrite: async () => undefined }))
vi.mock('./studio-publication-baseline.js', () => ({ readPublicationBaseline: async () => ({ values: new Map([[JSON.stringify(['family', 'title']), { state: 'value', value: 'Jacket' }]]), revision: 'baseline-1' }) }))

const liveGroup = { title: 'Jacket', description: '<p>Warm</p>', imageUrls: ['https://img.example/1.jpg'], aspects: { Marca: ['Brand'] }, variantSKUs: ['FAM-M'],
  variesBy: { specifications: [{ name: 'Taglia', values: ['M'] }] } }
const destination = { productId: 'family', channel: 'EBAY', marketplace: 'IT', accountId: 'account', aliasKey: '', expectedSkus: ['FAM-M'], itemId: '9000000004', parentSku: 'FAM' }
vi.mock('./studio-publication-ebay.js', () => ({
  usesEbayInventory: () => true,
  prepareEbayInventoryPublication: async () => ({ kind: 'ebay-inventory', marketplace: 'IT', itemId: '9000000004', destination, owner: { productId: 'family', sku: 'FAM' }, products: [{ productId: 'family', sku: 'FAM' }],
    ours: { title: 'Winter jacket', description: '<p>Warm</p>', pictures: ['https://img.example/1.jpg'], aspects: { Marca: ['Brand'] }, axes: ['Taglia'], order: { Taglia: ['M'] },
      variants: [{ productId: 'm', sku: 'FAM-M', values: { Taglia: 'M' } }] },
    live: { readAt: 'now', source: 'ebay-inventory-group', destination, revision: 'live-rev-1', errors: [],
      content: { title: { state: 'value', value: 'Jacket' }, description: { state: 'value', value: '<p>Warm</p>' }, pictures: { state: 'value', value: ['https://img.example/1.jpg'] }, 'aspect:marca': { state: 'value', value: ['Brand'] } },
      variations: { axes: ['Taglia'], order: { Taglia: ['M'] }, variants: [{ sku: 'FAM-M', values: { Taglia: 'M' }, price: { state: 'absent' }, stock: { state: 'value', value: 1 }, state: 'live' }] },
      raw: { groupKey: 'FAM', group: liveGroup, items: {}, item: null } } }),
  prepareEbayPublication: vi.fn(), sendEbayPublication: vi.fn(), readEbayPublication: m.ebayStatus, ebayPublicationRequest: vi.fn(),
}))
vi.mock('./studio-publication-ebay-inventory.js', () => ({ ebayInventoryReads: () => ({}), sendEbayInventoryGroup: m.send }))
vi.mock('./studio-publication-records.js', () => ({ recordPublicationRequests: m.record, settlePublicationRecords: vi.fn() }))
vi.mock('./workspace-destination.js', () => ({ WorkspaceScopeError: class extends Error { statusCode: number; constructor(message: string, statusCode = 409) { super(message); this.statusCode = statusCode } } }))
vi.mock('../../db.js', () => {
  const matches = (row: any, where: any) => (!where.id || (typeof where.id === 'string' ? row.id === where.id : row.id !== where.id.not))
    && (!Object.hasOwn(where, 'userId') || row.userId === where.userId)
    && (!where.status || (typeof where.status === 'string' ? row.status === where.status : where.status.in.includes(row.status)))
    && (!where.changes || (where.changes.path ? row.changes[where.changes.path[0]] === where.changes.equals : JSON.stringify(row.changes) === JSON.stringify(where.changes.equals)))
  const db: any = { channelDrift: { findMany: async () => [] }, bulkOperation: {
    findFirst: async ({ where }: any) => structuredClone([...m.rows.values()].find(row => matches(row, where)) ?? null),
    create: async ({ data }: any) => { m.rows.set(data.id, structuredClone(data)); return structuredClone(data) },
    updateMany: async ({ where, data }: any) => { const rows = [...m.rows.values()].filter(row => matches(row, where)); for (const row of rows) m.rows.set(row.id, structuredClone({ ...row, ...data })); return { count: rows.length } },
    update: async ({ where, data }: any) => { const row = { ...m.rows.get(where.id), ...data }; m.rows.set(where.id, structuredClone(row)); return structuredClone(row) },
  }, channelListing: { createMany: async () => ({ count: 0 }), updateMany: async () => ({ count: 0 }), count: async () => 1 }, $queryRawUnsafe: async () => [], $transaction: async (fn: any) => fn(db) }
  return { default: db }
})
import { previewStudioPublication, previewStudioPublicationSelection, submitStudioPublication, studioPublicationResult } from './studio-publication.service.js'

const scope = { channel: 'EBAY', marketplace: 'IT', accountId: 'account' }
const facts = () => ({ scope, destination: { familyId: 'family', aliasKey: '', currency: 'EUR' }, account: { displayName: 'eBay IT' }, parent: { id: 'family' },
  products: [{ id: 'family', sku: 'FAM', name: 'Jacket' }, { id: 'm', sku: 'FAM-M', name: 'M' }],
  listings: [{ id: 'l-family', productId: 'family', externalListingId: '9000000004', platformAttributes: {} }, { id: 'l-m', productId: 'm', externalListingId: '9000000004', platformAttributes: { __offerIds: { EBAY_IT: 'o' } } }],
  resolved: [], issues: [], excluded: 0, aliasLabel: 'Main', revision: 'v1' })

beforeEach(() => {
  vi.clearAllMocks(); m.rows.clear(); m.events.length = 0
  m.mode.mockReturnValue('live'); m.facts.mockImplementation(async () => facts())
  m.record.mockImplementation(async () => { m.events.push('journal') })
  m.send.mockImplementation(async (input: any) => { await input.beforeSend({ operation: 'PUT inventory_item_group', groupKey: input.groupKey, body: input.group }); m.events.push('put')
    return { reference: 'FAM', verified: true, warnings: [], readBack: null } })
})

async function reviewAndTick(field: string) {
  const review = await previewStudioPublication('family', scope, 'owner')
  const change = review.changes!.find(c => c.field === field)!
  const selection = await previewStudioPublicationSelection('family', review.id!, { selectedIds: [change.id] }, 'owner')
  return { review, change, selection }
}

it('reviews an Inventory listing field by field; the Nexus title change is SEND by default', async () => {
  const review = await previewStudioPublication('family', scope, 'owner')
  expect(review.issues.filter(i => i.severity === 'error')).toEqual([])
  expect(review.changes!.find(c => c.field === 'title')).toMatchObject({ status: 'SEND', selectedByDefault: true, current: { state: 'value', value: 'Winter jacket' } })
  expect(review.changes!.find(c => c.field === 'description')).toMatchObject({ status: 'SAME', selectable: false })
})

it('the exact payload shown is the whole-group PUT with only the ticked field changed', async () => {
  const { selection } = await reviewAndTick('title')
  expect(JSON.parse(selection.payload.content)).toEqual({ operation: 'PUT inventory_item_group', groupKey: 'FAM', body: { ...liveGroup, title: 'Winter jacket' } })
  expect(selection.payload.format).toBe('json')
})

it('submit: journal first, then the PUT; verified read-back → VERIFIED with the field write recorded', async () => {
  const { review } = await reviewAndTick('title')
  const result = await submitStudioPublication('family', review.id!, { selectionToken: m.rows.get(review.id!)?.changes.selection?.token }, 'owner')
  expect(m.events).toEqual(['journal', 'put'])
  expect(m.send).toHaveBeenCalledWith(expect.objectContaining({ groupKey: 'FAM', expectedRevision: 'live-rev-1', fields: ['title'], destination, group: { ...liveGroup, title: 'Winter jacket' } }))
  expect(m.record.mock.calls[0][1]).toEqual([{ productId: 'family', sku: 'FAM', request: expect.objectContaining({ operation: 'PUT inventory_item_group', intentVersion: 1,
    writes: [{ field: 'title', value: { state: 'value', value: 'Winter jacket' } }] }) }])
  expect(result).toMatchObject({ status: 'VERIFIED', results: [{ sku: 'FAM', status: 'VERIFIED', reference: 'FAM' }] })
})

it('an unconfirmed read-back stays UNVERIFIED and a later status read never re-checks it as a Trading item', async () => {
  m.send.mockImplementation(async (input: any) => { await input.beforeSend({}); return { reference: 'FAM', verified: false, warnings: ['eBay accepted the update, but the read-back differs for: title.'], readBack: null } })
  const { review } = await reviewAndTick('title')
  const result = await submitStudioPublication('family', review.id!, { selectionToken: m.rows.get(review.id!)?.changes.selection?.token }, 'owner')
  expect(result).toMatchObject({ status: 'UNVERIFIED', results: [{ status: 'ACCEPTED' }] })
  await studioPublicationResult('family', review.id!, 'owner')
  expect(m.ebayStatus).not.toHaveBeenCalled()
})

it('a refusal before the PUT reports "nothing was submitted"', async () => {
  m.send.mockRejectedValue(Object.assign(new Error('eBay changed after the review. Refresh the publication review.'), { notSent: true }))
  const { review } = await reviewAndTick('title')
  const result = await submitStudioPublication('family', review.id!, { selectionToken: m.rows.get(review.id!)?.changes.selection?.token }, 'owner')
  expect(result).toMatchObject({ status: 'FAILED', message: expect.stringContaining('Nothing was submitted.') })
})
