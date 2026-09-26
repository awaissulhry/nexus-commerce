/**
 * NCF N6 — Shopify's product CSV through the SAME transfer path as every channel file: the reader's rows are planned,
 * staged, reviewed and applied. The price and the compare-at price are recorded through the one price door (nothing is
 * queued for Shopify), and Shopify's identity of the product is recorded on its listing. Isolated in-memory store.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { importTestStore } from './catalog-transfer-test/store.js'
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshInTransaction: vi.fn() } }))
vi.mock('./readiness-index.service.js', () => ({ produceReadiness: vi.fn() }))
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
const state = vi.hoisted(() => ({ store: null as unknown as ReturnType<typeof importTestStore>, fields: [] as unknown[] }))
vi.mock('./content-write.js', () => ({ writeContent: async (input: any) => {
  const db = state.store.db
  const c = input.address.coordinate
  const listing = await db.channelListing.findFirst({ where: { productId: input.productId, channel: c.channel, marketplace: c.market, channelConnectionId: c.accountId, aliasKey: c.aliasId ?? '' } })
  return db.channelListing.update({ where: { id: listing.id }, data: { translations: [{ language: input.address.language, ...input.values }], version: { increment: 1 } } })
} }))
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => state.store.db[key as string] }) }))
vi.mock('./sheet-columns.service.js', () => ({ getSheetColumns: async () => ({ columns: [] }), clearSheetColumnCache: vi.fn() }))
vi.mock('./mapping/field-catalogue.service.js', () => ({ getFieldCatalogue: async () => ({ fields: state.fields, schema: { present: true, fetchedAt: '2026-01-01' } }), clearFieldCatalogueCache: vi.fn() }))
vi.mock('./mapping/category-mapping.service.js', () => ({ resolveCategoriesForProducts: async () => ({}) }))
import { buildTransferPlan, transferContracts } from './catalog-transfer-plan.js'
import { loadTransferContext, resetPresenceColumnCache } from './catalog-transfer.service.js'
import { applyTransferJob, readTransferJob, stageTransferJob, transferJobStatus } from './catalog-transfer-jobs.js'
import { resetSaleWindowColumnCache } from './sale-window.js'
import { mapShopifyCsv, readShopifyCsv, SHOPIFY_CSV_IDENTITY, type ShopifyCsvTarget } from './catalog-shopify-csv.js'
import { shopifyProductSpec } from './channel-specs/store.js'
import { csvOf, SHOPIFY_CLASSIC_HEADERS, SHOPIFY_SAMPLE_ROWS } from './catalog-transfer-test/shopify-csv-fixtures.js'
import type { TransferRow } from '@nexus/shared/catalog-transfer'

const STORE = 'store-1'
const spec = shopifyProductSpec(null, STORE)
// The catalogue the planner reads for SHOPIFY: the Shopify spec's own fields, as `getFieldCatalogue` shapes them.
state.fields = spec.fields.map(f => ({ fieldKey: f.key, sheetKey: f.masterKey ?? f.key, label: f.label, kind: f.kind, shape: f.shape, cardinality: f.cardinality, unitOptions: f.unitOptions,
  channelStore: f.channelStore, validation: f.validation, shopifyField: f.shopifyField, readOnlyReason: f.readOnlyReason, editable: f.editable, maxLength: f.maxLength ?? null, maxBytes: null,
  options: f.options ?? null, optionLabels: null, selectionOnly: f.mode === 'strict' && !!f.options?.length, deprecatedOptions: null, priority: 'optional', helpText: null, group: 'General', groupOrder: 0, prioritySource: 'channelSchema' }))

function seed() {
  const s = importTestStore(); s.seed(0)
  s.data.channelConnection.set(STORE, { id: STORE, channelType: 'SHOPIFY', marketplace: null, displayName: 'ACME store', isActive: true })
  s.data.marketplace.set('SHOPIFY-GLOBAL', { id: 'SHOPIFY-GLOBAL', channel: 'SHOPIFY', code: 'GLOBAL', name: 'Shopify', language: 'it', languages: ['it'], isActive: true })
  const product = (id: string, sku: string, parentId: string | null) => s.data.product.set(id, { id, sku, name: sku, description: null, familyId: 'f1', parentId, isParent: !parentId && sku === 'ACME-JACKET', version: 1, basePrice: 150,
    totalStock: 5, categories: [], categoryAttributes: {}, localizedContent: {}, deletedAt: null, updatedAt: new Date('2026-01-01') })
  product('p-jacket', 'ACME-JACKET', null); product('p-s', 'ACME-JACKET-S', 'p-jacket'); product('p-m', 'ACME-JACKET-M', 'p-jacket'); product('p-l', 'ACME-JACKET-L', 'p-jacket')
  for (const [id, productId, pa] of [['l-jacket', 'p-jacket', { [SHOPIFY_CSV_IDENTITY]: { handle: 'acme-jacket', status: 'active', options: ['Size'], variants: [{ sku: 'ACME-JACKET-S', values: ['S'] }] } }],
    ['l-s', 'p-s', { shopifyCompareAtPrice: 199 }], ['l-m', 'p-m', {}], ['l-l', 'p-l', {}]] as const)
    s.data.channelListing.set(id, { id, productId, channel: 'SHOPIFY', marketplace: 'GLOBAL', channelConnectionId: STORE, aliasKey: '', version: 4, updatedAt: new Date('2026-01-01'),
      platformAttributes: pa, followMasterTitle: true, title: null, titleOverride: null, overrideData: {}, followMasterPrice: true, price: null, priceOverride: null, salePrice: null })
  return s
}
const targets = (): ShopifyCsvTarget[] => [...state.store.data.channelListing.values()].filter(l => l.channel === 'SHOPIFY').map(l => {
  const p = state.store.data.product.get(l.productId)!
  return { id: l.id, sku: p.sku, parentSku: p.parentId ? state.store.data.product.get(p.parentId)!.sku : null, accountId: STORE, aliasKey: '', version: l.version, handles: l.platformAttributes[SHOPIFY_CSV_IDENTITY] ? [l.platformAttributes[SHOPIFY_CSV_IDENTITY].handle] : [] }
})
const readJacket = () => {
  const table = readShopifyCsv(csvOf(SHOPIFY_CLASSIC_HEADERS, SHOPIFY_SAMPLE_ROWS.filter(r => r.Handle === 'acme-jacket')))
  return mapShopifyCsv(table, targets(), { accountId: STORE, spec, storeFields: false })
}
const waitFor = async (id: string, states: string[]) => {
  let loaded: NonNullable<Awaited<ReturnType<typeof readTransferJob>>>
  await vi.waitFor(async () => { loaded = (await readTransferJob(id, 'owner'))!; expect(states).toContain(loaded.job.status) }, { timeout: 30_000, interval: 10 })
  return transferJobStatus(loaded!)
}

beforeEach(() => { state.store = seed(); resetSaleWindowColumnCache(); resetPresenceColumnCache() })

describe('NCF N6 — Shopify product CSV through the transfer path', () => {
  it('plans the price and compare-at price as record-only price writes, and the identity as a listing fact', async () => {
    const read = readJacket()
    const rows = read.rows as TransferRow[]
    const plan = await buildTransferPlan(rows, 'update', await loadTransferContext(rows), transferContracts('GLOBAL'))
    // The only refusal is the category path (read.issues); the planner refuses nothing of what the reader emitted.
    expect(plan.issues).toEqual([])
    const bySku = new Map(plan.targets.map(t => [t.identity.sku, t]))
    expect(bySku.get('ACME-JACKET-S')!.priceWrite).toMatchObject({ price: 199, compareAt: 249 })
    expect(bySku.get('ACME-JACKET-S')!.cells.find(c => c.field === 'compareAt')).toMatchObject({ before: 199, beforeState: 'stored', after: 249, verdict: 'changed' })
    expect(bySku.get('ACME-JACKET-L')!.priceWrite).toMatchObject({ price: 209 })
    expect(bySku.get('ACME-JACKET-L')!.priceWrite?.compareAt).toBeUndefined()
    expect(bySku.get('ACME-JACKET-S')!.patch.platformAttributes).toMatchObject({ taxable: true, inventoryPolicy: 'DENY', requiresShipping: true })
    const root = bySku.get('ACME-JACKET')!
    expect((root.patch.platformAttributes as Record<string, unknown>)[SHOPIFY_CSV_IDENTITY]).toMatchObject({ handle: 'acme-jacket', variants: [{ sku: 'ACME-JACKET-S' }, { sku: 'ACME-JACKET-M' }, { sku: 'ACME-JACKET-L' }] })
    expect(root.patch.platformAttributes).toMatchObject({ vendor: 'ACME', productType: 'Jacket', tags: ['Jackets', 'Winter', 'Acme'] })
    expect(root.contentWrites?.length).toBeGreaterThan(0)
  })

  it('refuses a compare-at price on another channel', async () => {
    const row: TransferRow = { row: 2, entity: 'Overrides', sku: 'ACME-JACKET-S', channel: 'SHOPIFY', accountId: STORE, marketplace: 'GLOBAL', aliasKey: '', locale: '', field: 'compareAt', action: 'SET', value: -1, origin: 'channel-file' }
    const plan = await buildTransferPlan([row], 'update', await loadTransferContext([row]), transferContracts('GLOBAL'))
    expect(plan.issues[0].message).toBe('A compare-at price is a number of zero or more')
  })

  it('applies: records the price and compare-at price without queuing a push, and the identity; a second import changes nothing', async () => {
    const rows = readJacket().rows as TransferRow[]
    const job = await stageTransferJob({ rows, issues: [], mode: 'update', market: 'GLOBAL', filename: 'products_export_1.csv', userId: 'owner' })
    const reviewed = await waitFor(job.jobId, ['QUEUED', 'INVALID'])
    expect(reviewed.state).toBe('QUEUED')
    await applyTransferJob(job.jobId, 'owner', reviewed.reviewToken!)
    const done = await waitFor(job.jobId, ['COMPLETED', 'PARTIAL'])
    expect(done.state).toBe('COMPLETED')
    const small = state.store.data.channelListing.get('l-s')!
    expect(small).toMatchObject({ price: 199, priceOverride: 199, followMasterPrice: false })
    expect(small.platformAttributes).toMatchObject({ compareAtPrice: 249, taxable: true })
    expect(small.platformAttributes).not.toHaveProperty('shopifyCompareAtPrice')
    expect([...state.store.data.outboundSyncQueue.values()]).toEqual([])
    expect([...state.store.data.channelListingOverride.values()].map(o => `${o.channelListingId}:${o.fieldName}`).sort()).toEqual(['l-l:price', 'l-m:compareAtPrice', 'l-m:price', 'l-s:compareAtPrice', 'l-s:price'])
    expect(state.store.data.channelListing.get('l-jacket')!.platformAttributes[SHOPIFY_CSV_IDENTITY]).toMatchObject({ handle: 'acme-jacket', status: 'active' })
    // The same file again: every cell restates what Nexus now holds.
    const again = readJacket().rows as TransferRow[]
    const plan = await buildTransferPlan(again, 'update', await loadTransferContext(again), transferContracts('GLOBAL'))
    expect(plan.issues).toEqual([])
    // Title and description go through the content writer, which this isolated store stubs (its stand-in does not store
    // translations where a re-read finds them); every other cell must read back unchanged.
    expect(plan.targets.flatMap(t => t.cells).filter(c => c.verdict === 'changed' && !['title', 'descriptionHtml'].includes(c.field)).map(c => `${c.sku}:${c.field}`)).toEqual([])
    expect(plan.targets.flatMap(t => t.cells).filter(c => c.verdict === 'unchanged').length).toBeGreaterThan(10)
  })
})
