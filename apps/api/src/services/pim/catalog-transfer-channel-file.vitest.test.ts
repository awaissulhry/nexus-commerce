/**
 * CFI (R-CFI-1) — the planner, apply and job halves of a CHANNEL-FILE import (an Amazon template / our eBay workbook read by
 * the L2/L3 readers into rows with `origin: 'channel-file'`). BUILD.md §1 + D1–D3, D6, D7. Isolated in-memory store; no
 * network, no working catalogue. Each arm names the rule it protects; each rule was reverted once to watch its arm fail.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { importTestStore } from './catalog-transfer-test/store.js'
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshInTransaction: vi.fn() } }))
vi.mock('./readiness-index.service.js', () => ({ produceReadiness: vi.fn() }))
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
const state = vi.hoisted(() => ({ store: null as unknown as ReturnType<typeof importTestStore>, effective: new Map<string, unknown>(), resolveCalls: [] as Record<string, any>[], resolveFails: false }))
// The same stand-in for the Step 4 content writer the other orchestration suites use.
vi.mock('./content-write.js', () => ({ writeContent: async (input: any) => {
  const db = state.store.db
  const c = input.address.coordinate
  const listing = await db.channelListing.findFirst({ where: { productId: input.productId, channel: c.channel, marketplace: c.market, channelConnectionId: c.accountId, aliasKey: c.aliasId ?? '' } })
  return db.channelListing.update({ where: { id: listing.id }, data: { translations: [{ language: input.address.language, ...input.values }], version: { increment: 1 } } })
} }))
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => state.store.db[key as string] }) }))
vi.mock('./sheet-columns.service.js', () => ({ getSheetColumns: async () => ({ columns: [{ key: 'name', writeField: 'name', label: 'Name', group: 'Shared', kind: 'text', storage: 'column', scope: 'global', shape: 'scalar', requiredBy: [], editable: true, defaultVisible: true }] }), clearSheetColumnCache: vi.fn() }))
const fields = [
  { fieldKey: 'item_name', sheetKey: 'name', label: 'Title', kind: 'text', shape: 'scalar', editable: true, maxLength: 200, channelStore: { kind: 'listingColumn', column: 'title', followFlag: 'followMasterTitle' } },
  { fieldKey: 'material', sheetKey: 'material', label: 'Material', kind: 'text', shape: 'scalar', editable: true },
  { fieldKey: 'color', sheetKey: 'color', label: 'Colour', kind: 'text', shape: 'scalar', editable: true, channelStore: { kind: 'platformAttributes', path: ['color'] } },
  { fieldKey: 'brand', sheetKey: 'brand', label: 'Brand', kind: 'text', shape: 'scalar', editable: false, channelStore: { kind: 'platformAttributes', path: ['brand'] } },
  { fieldKey: 'list_price', sheetKey: 'list_price', label: 'List price', kind: 'number', shape: 'scalar', editable: true, channelStore: { kind: 'platformAttributes', path: ['list_price'] } },
]
vi.mock('./mapping/field-catalogue.service.js', () => ({ getFieldCatalogue: async () => ({ fields, schema: { present: true, fetchedAt: '2026-01-01' } }), clearFieldCatalogueCache: vi.fn() }))
vi.mock('./mapping/category-mapping.service.js', () => ({ resolveCategoriesForProducts: async ({ productIds }: { productIds: string[] }) => Object.fromEntries(productIds.map(id => [id, { channelCategoryId: 'COAT' }])) }))
// D3 — the effective value Nexus would publish, per product + field. Recorded so the batching is asserted, not assumed.
vi.mock('./mapping/resolve-batch.service.js', () => ({ resolveBatch: async (input: Record<string, any>) => {
  state.resolveCalls.push(input)
  if (state.resolveFails) throw new Error('mapping unavailable')
  return { channel: input.channel, marketplace: input.marketplace, locale: input.locale ?? 'it', catalogue: null, missingProductIds: [],
    products: input.productIds.map((productId: string) => ({ productId, sku: productId, name: null, category: {}, counts: {},
      cells: Object.fromEntries(input.fieldKeys.map((fieldKey: string) => [fieldKey, { fieldKey, value: state.effective.get(`${productId}:${fieldKey}`) ?? null, provenance: 'fallback' }])) })) }
} }))
import { buildTransferPlan, transferContracts } from './catalog-transfer-plan.js'
import { loadTransferContext, resetPresenceColumnCache } from './catalog-transfer.service.js'
import { applyTransferJob, readTransferJob, stageTransferJob, transferJobOutcomes, transferJobStatus } from './catalog-transfer-jobs.js'
import { resetSaleWindowColumnCache } from './sale-window.js'
import { withWorkspace, workspaceContext } from '../../lib/workspace-context.js'
import type { TransferIssue, TransferRow } from '@nexus/shared/catalog-transfer'

const cf = (patch: Partial<TransferRow> = {}): TransferRow => ({ row: 7, entity: 'Overrides', sku: '000000', channel: 'AMAZON', accountId: 'account-a', marketplace: 'IT', aliasKey: '', locale: '', field: 'material', action: 'SET', value: 'Mesh', origin: 'channel-file', ...patch })
const plan = async (rows: TransferRow[]) => buildTransferPlan(rows, 'upsert', await loadTransferContext(rows), transferContracts('IT'))
const waitFor = async (id: string, states = ['QUEUED', 'INVALID', 'COMPLETED', 'PARTIAL']) => {
  let loaded: NonNullable<Awaited<ReturnType<typeof readTransferJob>>>
  await vi.waitFor(async () => { loaded = (await readTransferJob(id, 'owner'))!; expect(states).toContain(loaded.job.status) }, { timeout: 30_000, interval: 10 })
  return transferJobStatus(loaded!)
}
const stage = async (rows: TransferRow[], extra: { issues?: TransferIssue[]; links?: { fileSku: string; proposedSku: string; reason: string }[] } = {}) => {
  const job = await stageTransferJob({ rows, issues: extra.issues ?? [], mode: 'upsert', market: 'IT', filename: 'GALE IT.xlsm', userId: 'owner', ...(extra.links ? { links: extra.links } : {}) })
  return waitFor(job.jobId)
}

beforeEach(() => {
  state.store = importTestStore(); state.store.seed(3)
  state.effective = new Map(); state.resolveCalls = []; state.resolveFails = false
  resetSaleWindowColumnCache(); resetPresenceColumnCache()
})

describe('channel-file planning (origin: channel-file)', () => {
  it('stores a field read-only on a live listing and the RRP only from a channel file; an operator file keeps both refusals', async () => {
    const rows = [cf({ field: 'brand', value: 'XAVIA RACING' }), cf({ field: 'list_price', value: 129.9 })]
    const fromChannel = await plan(rows)
    expect(fromChannel.issues).toEqual([])
    expect(fromChannel.targets[0].patch.platformAttributes).toMatchObject({ brand: 'XAVIA RACING', list_price: 129.9 })
    const fromOperator = await plan(rows.map(({ origin: _origin, ...row }) => row))
    expect(fromOperator.issues.map(i => i.message)).toEqual(['The channel marks this field read-only on an existing listing', 'Use the pricing or inventory workspace for this listing'])
  })

  it('records the channel seller SKU where the studio publisher reads it, and refuses a second identity', async () => {
    const recorded = await plan([cf({ entity: 'Listings', field: 'sellerSku', value: 'MOSS-JACKET' })])
    expect(recorded.issues).toEqual([])
    expect(recorded.targets[0].patch.platformAttributes).toMatchObject({ productType: 'COAT', sellerSku: 'MOSS-JACKET' })
    expect(recorded.targets[0].cells[0]).toMatchObject({ field: 'sellerSku', before: null, after: 'MOSS-JACKET', verdict: 'changed' })
    state.store.data.offer.set('o1', { id: 'o1', channelListingId: 'p0-account-a', sku: 'IT-MOSS-JACKET', isActive: true })
    const conflict = await plan([cf({ entity: 'Listings', field: 'sellerSku', value: 'MOSS-JACKET' })])
    expect(conflict.targets).toEqual([])
    expect(conflict.issues[0].message).toContain('already carries the seller SKU IT-MOSS-JACKET')
  })

  it('ends a listing the channel deleted, never creates one, and refuses a delete mixed with an update', async () => {
    const ended = await plan([cf({ entity: 'Listings', field: 'presence', value: 'ENDED' })])
    expect(ended.issues).toEqual([])
    expect(ended.targets[0]).toMatchObject({ presence: 'ENDED', patch: {}, create: false })
    const nothing = await plan([cf({ entity: 'Listings', field: 'presence', value: 'ENDED', accountId: 'account-b', marketplace: 'IT' })])
    expect(nothing.targets).toEqual([])
    expect(nothing.issues).toEqual([])
    expect(nothing.exclusions?.[0].message).toContain('nothing to end')
    const mixed = await plan([cf({ entity: 'Listings', field: 'presence', value: 'ENDED' }), cf({ field: 'material', value: 'Mesh' })])
    expect(mixed.issues[0].message).toContain('both deletes this listing and updates it')
  })

  it('ends only the listing that holds the file seller SKU (review 2)', async () => {
    const ends = async (fileSku: string) => plan([cf({ entity: 'Listings', field: 'presence', value: 'ENDED', fileSku })])
    expect((await ends('000000')).targets[0]).toMatchObject({ presence: 'ENDED' })
    const other = await ends('SOMEONE-ELSE')
    expect(other.targets).toEqual([])
    expect(other.issues[0].message).toBe('The file deletes seller SKU SOMEONE-ELSE, which this listing does not hold')
    state.store.data.offer.set('o1', { id: 'o1', channelListingId: 'p0-account-a', sku: 'SOMEONE-ELSE', isActive: true })
    expect((await ends('SOMEONE-ELSE')).targets[0]).toMatchObject({ presence: 'ENDED' })
    // The listing sells as its held identity: a file deleting the bare Nexus SKU does not reach it (with or without fileSku).
    expect((await ends('000000')).issues[0].message).toBe('The file deletes seller SKU 000000, which this listing does not hold (it sells as SOMEONE-ELSE)')
    expect((await plan([cf({ entity: 'Listings', field: 'presence', value: 'ENDED' })])).issues[0].message).toContain('(it sells as SOMEONE-ELSE)')
  })

  it('plans the channel price and sale as a record-only write, never as a patch', async () => {
    const priced = await plan([cf({ field: 'price', value: 99.9 })])
    expect(priced.issues).toEqual([])
    expect(priced.targets[0].priceWrite).toEqual({ price: 99.9, expectedPrice: null, expectedSale: { value: null, start: null, end: null } })
    expect(priced.targets[0].patch).toEqual({})
    expect(priced.targets[0].cells[0]).toMatchObject({ field: 'price', before: null, after: 99.9, beforeState: 'inherited', verdict: 'changed' })
    expect((await plan([cf({ field: 'price', value: -1 })])).issues[0].message).toBe('A price is a number of zero or more')
    expect((await plan([cf({ field: 'sale', value: { value: 79.9, start: null, end: null } })])).issues[0].message).toContain('start and an end date')
    state.store.data.outboundSyncQueue.set('q1', { id: 'q1', channelListingId: 'p0-account-a', syncType: 'PRICE_UPDATE', syncStatus: 'PENDING' })
    expect((await plan([cf({ field: 'price', value: 99.9 })])).issues[0].message).toContain('A price change is waiting to be sent to AMAZON')
  })

  it('clears a full-update blank only when Nexus would publish a value, with ONE effective read per coordinate', async () => {
    state.effective.set('p0:color', 'Nero')
    state.store.data.channelListing.set('p0-account-a', { ...state.store.data.channelListing.get('p0-account-a')!, overrideData: {} })
    const cleared = await plan([cf({ field: 'color', action: 'CLEAR', value: undefined, clearIfPresent: true }), cf({ field: 'material', action: 'CLEAR', value: undefined, clearIfPresent: true })])
    expect(cleared.issues).toEqual([])
    expect(cleared.targets[0].cells).toEqual([expect.objectContaining({ field: 'color', before: 'Nero', after: null, verdict: 'changed' })])
    expect(cleared.stats).toEqual({ alreadyEmpty: 1, clearUnchecked: 0 })
    expect(state.resolveCalls).toHaveLength(1)
    expect(state.resolveCalls[0]).toMatchObject({ channel: 'AMAZON', channelConnectionId: 'account-a', marketplace: 'IT', productType: 'COAT', productIds: ['p0'], fieldKeys: ['color', 'material'] })
    state.resolveFails = true
    const unchecked = await plan([cf({ field: 'color', action: 'CLEAR', value: undefined, clearIfPresent: true })])
    expect(unchecked.targets[0].cells).toEqual([])
    expect(unchecked.stats).toEqual({ alreadyEmpty: 0, clearUnchecked: 1 })
    expect(unchecked.warnings.join(' ')).toContain('could not be read, so none of them was cleared')
    const operator = await plan([{ ...cf({ field: 'color', action: 'CLEAR', value: undefined, clearIfPresent: true }), origin: undefined }])
    expect(operator.issues[0].message).toContain('Only a channel file')
  })

  it('plans text for a NEW market listing of a product that belongs to a business', async () => {
    // Measured refusal 2026-09-24: "Content listing does not belong to this product/workspace" (REGAL IT, AIREON DE…).
    for (const id of ['p0', 'p1']) state.store.data.product.set(id, { ...state.store.data.product.get(id)!, workspaceId: 'nexus_legacy_workspace' })
    state.store.data.channelListing.delete('p1-account-a')
    const created = await plan([cf({ sku: '000001', entity: 'Listings', field: 'productType', value: 'COAT' }), cf({ sku: '000001', field: 'item_name', value: 'Giacca Gale' })])
    expect(created.issues).toEqual([])
    expect(created.targets[0]).toMatchObject({ create: true, contentWrites: [{ address: { tier: 'pin', language: 'it' }, values: { title: 'Giacca Gale' } }] })
  })
})

describe('channel-file jobs', () => {
  it('previews and applies a whole channel file — ends, clears, records the price and identity — and sends nothing', async () => {
    state.effective.set('p0:color', 'Nero')
    state.store.data.channelListing.set('p0-account-a', { ...state.store.data.channelListing.get('p0-account-a')!, platformAttributes: { productType: 'COAT', color: 'Nero' }, overrideData: {} })
    state.store.data.outboundSyncQueue.set('stock', { id: 'stock', channelListingId: 'p0-account-b', syncType: 'QUANTITY_UPDATE', syncStatus: 'PENDING' })
    const rows = [
      cf({ field: 'brand', value: 'XAVIA RACING' }), cf({ field: 'list_price', value: 129.9 }),
      cf({ field: 'color', action: 'CLEAR', value: undefined, clearIfPresent: true }), cf({ field: 'material', action: 'CLEAR', value: undefined, clearIfPresent: true }),
      cf({ field: 'price', value: 99.9 }), cf({ field: 'sale', value: { value: 79.9, start: '2026-10-01', end: '2026-10-31' } }),
      cf({ entity: 'Listings', field: 'sellerSku', value: 'SELLER-000000' }),
      cf({ entity: 'Listings', field: 'presence', value: 'ENDED', accountId: 'account-b', marketplace: 'FR' }),
    ]
    const queueBefore = state.store.data.outboundSyncQueue.size
    const review = await stage(rows)
    expect(review.state).toBe('QUEUED')
    // material: nothing stored, nothing mapped → already empty, nothing to clear.
    expect(review.counts).toMatchObject({ refused: 0, cleared: 1, alreadyEmpty: 1, ended: 1, pricesRecorded: 2 })
    expect(review.deletes).toEqual([{ sku: '000000', fileSku: '000000', channel: 'AMAZON', marketplace: 'FR', accountId: 'account-b', confirmed: true }])
    await applyTransferJob(review.jobId, 'owner', review.reviewToken!)
    const done = await waitFor(review.jobId, ['COMPLETED', 'PARTIAL'])
    expect(done.state).toBe('COMPLETED')
    const it = state.store.data.channelListing.get('p0-account-a')!
    expect(it).toMatchObject({ price: 99.9, priceOverride: 99.9, followMasterPrice: false, salePrice: 79.9 })
    expect(state.store.raw.saleWindows.get('p0-account-a')).toEqual({ start: '2026-10-01', end: '2026-10-31' })
    expect(it.platformAttributes).toMatchObject({ productType: 'COAT', brand: 'XAVIA RACING', list_price: 129.9, color: null, sellerSku: 'SELLER-000000' })
    expect(it.syncStatus).toBeUndefined() // record-only: nothing is waiting to be sent
    expect(state.store.data.channelListing.get('p0-account-b')).toMatchObject({ listingStatus: 'ENDED', isPublished: false, offerActive: false, presenceIntent: 'ENDED', channelFact: 'ABSENT', endedReason: 'channel-file-delete' })
    // 🔴 Import never publishes: no queue row created; the one pending row of the deleted listing is cancelled, not sent.
    expect(state.store.data.outboundSyncQueue.size).toBe(queueBefore)
    expect(state.store.data.outboundSyncQueue.get('stock')).toMatchObject({ syncStatus: 'CANCELLED' })
    expect([...state.store.data.priceChangeEvent.values()].map(e => e.source)).toEqual(['CHANNEL_FILE_IMPORT'])
    const audit = [...state.store.data.auditLog.values()].find(a => a.entityId === 'p0-account-b')!
    expect(audit.metadata).toMatchObject({ channelFact: 'ABSENT', presence: 'ENDED', cancelledOutbound: [{ id: 'stock', syncType: 'QUANTITY_UPDATE' }] })
  })

  it('applies only the ready records of an INVALID review when asked, and keeps the refused ones', async () => {
    state.store.data.outboundSyncQueue.set('q1', { id: 'q1', channelListingId: 'p0-account-a', syncType: 'PRICE_UPDATE', syncStatus: 'PENDING' })
    const review = await stage([cf({ field: 'price', value: 99.9 }), cf({ sku: '000001', field: 'material', value: 'Mesh' })])
    expect(review.state).toBe('INVALID')
    await expect(applyTransferJob(review.jobId, 'owner', review.reviewToken!)).rejects.toThrow('invalid or expired')
    await applyTransferJob(review.jobId, 'owner', review.reviewToken!, { readyOnly: true })
    const done = await waitFor(review.jobId, ['COMPLETED', 'PARTIAL'])
    expect(done.state).toBe('PARTIAL')
    expect(done.receipt).toMatchObject({ saved: 1, skipped: 1, failed: 0 })
    expect(state.store.data.channelListing.get('p1-account-a')?.overrideData).toMatchObject({ material: 'Mesh' })
    expect(state.store.data.channelListing.get('p0-account-a')?.price).toBeUndefined()
    expect((await transferJobOutcomes(review.jobId, 'owner', 1, 'INVALID'))!.rows[0].issues[0].message).toContain('waiting to be sent')
  })

  it('refuses a channel sale when the sale window changed after the review, and keeps the operator window (review 1)', async () => {
    const review = await stage([cf({ field: 'sale', value: { value: 79.9, start: '2026-10-01', end: '2026-10-31' } })])
    expect(review.state).toBe('QUEUED')
    // ONLY the raw window columns move: no version bump, nothing the listing snapshot compares — the fingerprint must see it.
    state.store.raw.saleWindows.set('p0-account-a', { start: '2026-11-01', end: '2026-11-30' })
    await applyTransferJob(review.jobId, 'owner', review.reviewToken!)
    expect((await waitFor(review.jobId, ['COMPLETED', 'PARTIAL'])).state).toBe('PARTIAL')
    expect(state.store.raw.saleWindows.get('p0-account-a')).toEqual({ start: '2026-11-01', end: '2026-11-30' })
    expect(state.store.data.channelListing.get('p0-account-a')?.salePrice).toBeUndefined()
  })

  it('writes the channel sale on the REVIEWED listing version, never a fresher one (review 1)', async () => {
    const review = await stage([cf({ field: 'sale', value: { value: 79.9, start: '2026-10-01', end: '2026-10-31' } })])
    const row = state.store.data.channelListing.get('p0-account-a')!
    // A write the listing snapshot does not compare (version + stamps only) still moved the listing after the review.
    state.store.data.channelListing.set(row.id, { ...row, version: row.version + 1, updatedAt: new Date() })
    await applyTransferJob(review.jobId, 'owner', review.reviewToken!)
    expect((await waitFor(review.jobId, ['COMPLETED', 'PARTIAL'])).state).toBe('PARTIAL')
    expect(state.store.data.channelListing.get('p0-account-a')?.salePrice).toBeUndefined()
  })

  it('records FAILED under the business when the signed-in user loses access mid-job', async () => {
    // The row policy, as the store has none: once the user's access is gone, every statement run AS that user fails (P2025).
    const db = state.store.db, revoked = { on: false }
    const asUser = () => workspaceContext()?.actorUserId === 'owner'
    const denied = () => Object.assign(new Error('Record to update not found.'), { code: 'P2025' })
    for (const [model, methods] of [['importJobRow', ['update', 'findMany', 'count']], ['bulkOperation', ['updateMany', 'findUnique', 'findFirst']], ['importJob', ['update', 'updateMany']]] as const) {
      for (const method of methods) {
        const real = db[model][method]
        db[model][method] = async (args: unknown) => {
          if (model === 'importJobRow' && method === 'update' && asUser()) revoked.on = true
          if (revoked.on && asUser()) throw denied()
          return real(args)
        }
      }
    }
    const staged = await withWorkspace({ workspaceId: 'nexus_legacy_workspace', actorUserId: 'owner', membershipId: 'm1', roleKeys: ['OWNER'] },
      () => stageTransferJob({ rows: [cf({ field: 'material', value: 'Mesh' })], issues: [], mode: 'upsert', market: 'IT', filename: 'GALE IT.xlsm', userId: 'owner' }))
    const done = await waitFor(staged.jobId, ['FAILED'])
    expect(revoked.on).toBe(true)
    expect(done).toMatchObject({ state: 'FAILED', error: 'Record to update not found.' })
  })

  it('shows what the channel last reported beside each listing cell', async () => {
    const at = '2026-09-24T03:37:00.000Z'
    state.store.data.channelDrift.set('d1', { id: 'd1', channelListingId: 'p0-account-a', driftedFields: [{ field: 'color', ours: { '[0].value': 'Nero' }, theirs: { '[0].value': 'Schwarz' }, source: 'amazon-content', checkedAt: at }],
      checkedBySource: { 'amazon-content': { at, outcome: 'compared', differing: 1 } } })
    const review = await stage([cf({ field: 'color', value: 'Nero' }), cf({ field: 'material', value: 'Mesh' })])
    const cells = (await transferJobOutcomes(review.jobId, 'owner'))!.rows.flatMap(r => r.cells) as any[]
    expect(cells.find(c => c.field === 'color').channelRead).toEqual({ differs: true, value: { '[0].value': 'Schwarz' }, ours: { '[0].value': 'Nero' }, readAt: at, source: 'amazon-content' })
    expect(cells.find(c => c.field === 'material').channelRead).toEqual({ differs: false, readAt: at, source: 'amazon-content' })
  })

  it('keeps the identity proposals and the unconfirmed deletes on the review', async () => {
    const links = [{ fileSku: 'MOSS-JACKET', proposedSku: 'IT-MOSS-JACKET', reason: 'All 20 children of MOSS-JACKET belong to IT-MOSS-JACKET' }]
    const unconfirmed = { row: 9, sku: '000002', fileSku: 'AMZ-000002', field: 'presence', message: 'Confirm this delete: Amazon last reported the listing on 2026-09-24', channel: 'AMAZON', marketplace: 'DE', accountId: 'account-a' } as TransferIssue
    const review = await stage([cf({ field: 'material', value: 'Mesh' }), cf({ sku: '000001', entity: 'Listings', field: 'presence', value: 'ENDED', fileSku: 'AMZ-000001', accountId: 'account-b', marketplace: 'FR' })], { issues: [unconfirmed], links })
    expect(review.links).toEqual(links)
    expect(review.deletes).toEqual([{ sku: '000001', fileSku: 'AMZ-000001', channel: 'AMAZON', marketplace: 'FR', accountId: 'account-b', confirmed: true },
      { sku: '000002', fileSku: 'AMZ-000002', channel: 'AMAZON', marketplace: 'DE', accountId: 'account-a', evidence: unconfirmed.message, confirmed: false }])
  })
})

describe('eBay channel-file requests (L3-1, L3-2)', () => {
  const ebay = (patch: Partial<TransferRow>) => cf({ channel: 'EBAY', accountId: 'ebay-account', marketplace: 'IT', ...patch })
  beforeEach(() => {
    state.store.data.channelConnection.set('ebay-account', { id: 'ebay-account', channelType: 'EBAY', marketplace: 'IT', isActive: true })
    state.store.data.marketplace.set('ebay-it', { id: 'ebay-it', channel: 'EBAY', code: 'IT', languages: ['it'], isActive: true })
    const base = state.store.data.channelListing.get('p0-account-a')!
    state.store.data.channelListing.set('p0-ebay', { ...base, id: 'p0-ebay', channel: 'EBAY', channelConnectionId: 'ebay-account', platformAttributes: { categoryId: '177104', itemSpecifics: { Genere: 'Uomo' } } })
  })
  it('stores a custom item specific at the eBay listing path, only from the channel file', async () => {
    const planned = await plan([ebay({ field: 'itemSpecifics.Tipo di giacca', value: 'Giacca da moto' })])
    expect(planned.issues).toEqual([])
    expect(planned.targets[0].patch.platformAttributes).toEqual({ categoryId: '177104', itemSpecifics: { Genere: 'Uomo', 'Tipo di giacca': 'Giacca da moto' } })
    const operator = await plan([{ ...ebay({ field: 'itemSpecifics.Tipo di giacca', value: 'Giacca da moto' }), origin: undefined }])
    expect(operator.issues[0].message).toBe('This attribute is not declared by the listing category')
  })
  it('keeps an eBay value outside the listed choices as a named warning; Amazon stays strict', async () => {
    const choice = { ...fields[2], selectionOnly: true, options: ['Nero', 'Blu'] }
    fields.push({ ...choice, fieldKey: 'season', sheetKey: 'season', label: 'Stagione', options: ['Tutte le stagione', 'Estate'], channelStore: { kind: 'platformAttributes', path: ['itemSpecifics', 'Stagione'] } } as never)
    try {
      const kept = await plan([ebay({ field: 'season', value: 'Tutte le stagioni' })])
      expect(kept.issues).toEqual([])
      expect(kept.warnings.join(' ')).toContain('Stagione "Tutte le stagioni" is not one of eBay\'s listed choices')
      expect(kept.targets[0].patch.platformAttributes).toMatchObject({ itemSpecifics: { Stagione: 'Tutte le stagioni' } })
      const amazon = await plan([cf({ field: 'season', value: 'Tutte le stagioni' })])
      expect(amazon.issues[0].message).toContain('contains an unaccepted value')
    } finally { fields.pop() }
  })
})
