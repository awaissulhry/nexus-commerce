import { beforeEach, describe, expect, it, vi } from 'vitest'
import { importTestStore, fixtureColumns, fixtureFields } from './catalog-transfer-test/store.js'
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshInTransaction: vi.fn() } }))
vi.mock('./readiness-index.service.js', () => ({ produceReadiness: vi.fn() }))
const state = vi.hoisted(() => ({ fetch: vi.fn(), store: null as unknown as ReturnType<typeof importTestStore>, fields: null as Array<Record<string, unknown>> | null }))
// Orchestration tests mock the Step 4 writer; its real transaction is exercised by the LX7 local fixture.
vi.mock('./content-write.js', () => ({ writeContent: async (input: any) => {
  const db = state.store.db
  if (input.address.tier === 'source') return db.product.update({ where: { id: input.productId }, data: { ...Object.fromEntries(Object.entries(input.values).map(([key, value]) => [key === 'title' ? 'name' : key, value])), version: { increment: 1 } } })
  const c = input.address.coordinate
  const listing = await db.channelListing.findFirst({ where: { productId: input.productId, channel: c.channel, marketplace: c.market, channelConnectionId: c.accountId, aliasKey: c.aliasId ?? '' } })
  const translation = { language: input.address.language, ...Object.fromEntries(Object.entries(input.values).map(([key, value]) => [key === 'title' ? 'name' : key, value])), source: 'manual', reviewedAt: new Date() }
  return db.channelListing.update({ where: { id: listing.id }, data: { translations: [translation], version: { increment: 1 } } })
} }))
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => state.store.db[key as string] }) }))
vi.mock('./sheet-columns.service.js', () => ({ getSheetColumns: async () => ({ columns: fixtureColumns }), clearSheetColumnCache: vi.fn() }))
vi.mock('./mapping/field-catalogue.service.js', () => ({ getFieldCatalogue: async () => ({ fields: state.fields ?? fixtureFields, schema: { present: true, fetchedAt: '2026-01-01' } }), clearFieldCatalogueCache: vi.fn() }))
vi.mock('./mapping/category-mapping.service.js', () => ({ resolveCategoriesForProducts: async ({ productIds }: { productIds: string[] }) => Object.fromEntries(productIds.map(id => [id, { channelCategoryId: 'COAT' }])) }))
vi.mock('./catalog-source-fetch.js', () => ({ fetchCatalogSource: (...args: unknown[]) => state.fetch(...args) }))
import { ScheduledImportService } from '../scheduled-import.service.js'
import { writeFile } from 'node:fs/promises'
import ExcelJS from 'exceljs'
import { readSourceFile } from './catalog-source-file.js'
import { mapSourceTable } from './catalog-source-mapping.js'
import { stageTransferJob, readTransferJob, transferJobStatus, applyTransferJob, transferJobOutcomes, retryTransferJob, recoverTransferJobs } from './catalog-transfer-jobs.js'
import { inspectCatalogSource, previewCatalogSource, saveSourcePreset } from './catalog-source.service.js'
import { ImportWizardService } from '../import-wizard.service.js'
import type { TransferRow } from '@nexus/shared/catalog-transfer'
import type { SourceMapping } from './catalog-source-mapping.js'
import { resolveAttributes } from './attribute-resolver.js'
import { resolveChannelField } from './resolve-channel-field.js'
const row = (patch: Partial<TransferRow> = {}): TransferRow => ({ row: 2, entity: 'Products', sku: '000000', channel: '', accountId: '', marketplace: '', aliasKey: '', locale: '', field: 'name', action: 'SET', value: 'New shared', ...patch })
const waitFor = async (id: string, states = ['QUEUED', 'INVALID', 'COMPLETED', 'PARTIAL']) => {
  let result: NonNullable<Awaited<ReturnType<typeof readTransferJob>>>
  await vi.waitFor(async () => { result = (await readTransferJob(id, 'owner'))!; expect(states).toContain(result.job.status) }, { timeout: 30_000, interval: 10 })
  return transferJobStatus(result!)
}
const stage = async (rows: TransferRow[]) => { const job = await stageTransferJob({ rows, issues: [], mode: 'update', market: 'IT', filename: 'fixture.csv', userId: 'owner' }); return waitFor(job.jobId) }
const apply = async (id: string, token: string) => { await applyTransferJob(id, 'owner', token); return waitFor(id, ['COMPLETED', 'PARTIAL']) }
const mapping: SourceMapping = { kind: 'catalog-source-v1', market: 'IT', mode: 'update', skuColumn: 'SKU', policy: { shared: 'replace', overrides: 'replace' }, bindings: [{ source: 'Name', entity: 'Products', field: 'name', format: 'text' }, { source: 'Amazon A', entity: 'Overrides', field: 'item_name', format: 'text', channel: { value: 'AMAZON' }, accountId: { value: 'account-a' }, marketplace: { value: 'IT' } }] }

describe('reference names across durable preview and apply', () => {
  const themeRow = () => row({ entity: 'Overrides', channel: 'EBAY', accountId: 'ebay-account', marketplace: 'IT', field: 'descriptionThemeId', value: 'Modern' })
  beforeEach(() => {
    state.store = importTestStore(); state.store.seed(1)
    state.fields = [{ fieldKey: 'descriptionThemeId', sheetKey: 'descriptionThemeId', label: 'Description theme', kind: 'text', shape: 'scalar', editable: true, selectionOnly: false, channelStore: { kind: 'platformAttributes', path: ['descriptionThemeId'] } }]
    state.store.data.channelConnection.set('ebay-account', { id: 'ebay-account', channelType: 'EBAY', marketplace: 'IT', isActive: true })
    state.store.data.marketplace.set('ebay-it', { id: 'ebay-it', channel: 'EBAY', code: 'IT', isActive: true })
    state.store.data.ebayDescriptionTheme.set('theme-id', { id: 'theme-id', name: 'Modern', active: true })
    const base = state.store.data.channelListing.get('p0-account-a')!
    state.store.data.channelListing.set('ebay-listing', { ...base, id: 'ebay-listing', channel: 'EBAY', channelConnectionId: 'ebay-account', platformAttributes: { categoryId: '177104', descriptionThemeId: 'old-id' } })
  })
  it('previews the resolved ID, saves that exact ID and preserves other accounts', async () => {
    const untouched = structuredClone(state.store.data.channelListing.get('p0-account-a'))
    const preview = await stage([themeRow()])
    expect(preview.state).toBe('QUEUED')
    expect((await transferJobOutcomes(preview.jobId, 'owner'))!.rows[0].cells[0]).toMatchObject({ value: 'Modern', before: 'old-id', after: 'theme-id', verdict: 'changed' })
    expect((await apply(preview.jobId, preview.reviewToken!)).state).toBe('COMPLETED')
    expect(state.store.data.channelListing.get('ebay-listing')).toMatchObject({ version: 9, platformAttributes: { categoryId: '177104', descriptionThemeId: 'theme-id' } })
    expect(state.store.data.channelListing.get('p0-account-a')).toEqual(untouched)
  })
  it.each(['inactive', 'deleted', 'reassigned-name'])('refuses a %s choice after preview without writing the reviewed target', async change => {
    const preview = await stage([themeRow()])
    const before = structuredClone(state.store.data.channelListing.get('ebay-listing'))
    if (change === 'inactive') state.store.data.ebayDescriptionTheme.get('theme-id')!.active = false
    if (change === 'deleted') state.store.data.ebayDescriptionTheme.delete('theme-id')
    if (change === 'reassigned-name') {
      state.store.data.ebayDescriptionTheme.get('theme-id')!.name = 'Renamed'
      state.store.data.ebayDescriptionTheme.set('new-id', { id: 'new-id', name: 'Modern', active: true })
    }
    expect((await apply(preview.jobId, preview.reviewToken!)).state).toBe('PARTIAL')
    expect(state.store.data.channelListing.get('ebay-listing')).toEqual(before)
    expect(state.store.data.auditLog.size).toBe(0)
    expect((await transferJobOutcomes(preview.jobId, 'owner'))!.rows[0].status).toBe('FAILED')
  })
  it('rejects duplicate names at preview and keeps a legacy unchanged ID without validating it as a new choice', async () => {
    state.store.data.ebayDescriptionTheme.set('duplicate', { id: 'duplicate', name: 'MODERN', active: true })
    const ambiguous = await stage([themeRow()])
    expect(ambiguous.state).toBe('INVALID')
    expect((await transferJobOutcomes(ambiguous.jobId, 'owner'))!.rows[0].issues[0].message).toContain('more than one choice')
    const preserved = await stage([{ ...themeRow(), value: 'old-id' }])
    expect(preserved.state).toBe('QUEUED')
    expect(preserved.counts.unchanged).toBe(1)
    expect((await apply(preserved.jobId, preserved.reviewToken!)).state).toBe('COMPLETED')
    expect(state.store.data.channelListing.get('ebay-listing')!.version).toBe(8)
  })
})

describe('durable unified catalog workflow', () => {
  it('creates a new parent and 101 variants from a reversed file across preview pages', async () => {
    const rows = Array.from({ length: 101 }, (_, i) => [
      row({ sku: `NEW-${i}`, field: 'parentSku', value: 'NEW-PARENT', row: i * 2 + 2 }),
      row({ sku: `NEW-${i}`, field: 'name', value: `New variant ${i}`, row: i * 2 + 3 }),
    ]).flat().reverse()
    rows.push(row({ sku: 'NEW-PARENT', field: 'family', value: 'coats' }), row({ sku: 'NEW-PARENT', field: 'name', value: 'New parent' }))
    const staged = await stageTransferJob({ rows, issues: [], mode: 'create', market: 'IT', filename: 'new-family.csv', userId: 'owner' })
    const preview = await waitFor(staged.jobId)
    expect(preview.state).toBe('QUEUED')
    expect(preview.counts.productsCreated).toBe(102)
    const result = await apply(staged.jobId, preview.reviewToken!)
    expect(result.state).toBe('COMPLETED')
    const products = [...state.store.data.product.values()]
    const parent = products.find(p => p.sku === 'NEW-PARENT')!
    expect(parent).toMatchObject({ isParent: true, parentId: null, familyId: 'f1', status: 'DRAFT' })
    const variants = products.filter(p => p.parentId === parent.id)
    expect(variants).toHaveLength(101)
    expect(variants.every(p => p.isParent === false && p.familyId === 'f1' && p.status === 'DRAFT')).toBe(true)
    const count = state.store.data.product.size
    await applyTransferJob(staged.jobId, 'owner', preview.reviewToken!)
    expect(state.store.data.product.size).toBe(count)
  })

  it('rejects unlinking an aliased variant and preserves its product and listing records', async () => {
    state.store.data.channelListing.set('alias-child', { id: 'alias-child', productId: 'p1', aliasKey: 'outlet', aliasId: 'outlet' })
    const beforeProduct = structuredClone(state.store.data.product.get('p1'))
    const preview = await stage([row({ sku: '000001', field: 'parentSku', action: 'CLEAR', value: undefined })])
    expect(preview.state).toBe('INVALID')
    expect((await transferJobOutcomes(preview.jobId, 'owner'))!.rows[0].issues[0].message).toContain('listing aliases')
    expect(state.store.data.product.get('p1')).toEqual(beforeProduct)
    expect(state.store.data.channelListing.get('alias-child')?.aliasKey).toBe('outlet')
  })

  beforeEach(() => { state.fields = null; state.store = importTestStore(); state.store.seed(3); state.fetch.mockReset(); state.fetch.mockResolvedValue({ buffer: Buffer.from('SKU,Name,Amazon A\n000000,Supplier name,Supplier title'), filename: 'supplier.csv' }) })
  it('runs upload → mapping → complete preview → apply with exact accounts and untouched stock/prices/overrides', async () => {
    const source = await inspectCatalogSource(Buffer.from('SKU,Name,Amazon A\n000000,New shared,Italy title'), 'source.csv', 'owner')
    const staged = await previewCatalogSource({ sourceId: source.sourceId, inputHash: source.hash, mapping, userId: 'owner' })
    const preview = await waitFor(staged.jobId)
    expect(preview.counts).toMatchObject({ productsAffected: 1, listingsAffected: 1, changed: 2, newOverrides: 1, preservedOverrides: 2, refused: 0 })
    const result = await apply(staged.jobId, preview.reviewToken!)
    expect(result.state).toBe('COMPLETED')
    expect(state.store.data.product.get('p0')).toMatchObject({ name: 'New shared', basePrice: 25, totalStock: 17, version: 4 })
    expect(state.store.data.channelListing.get('p0-account-a')).toMatchObject({ title: 'Sync snapshot', followMasterTitle: true, translations: [expect.objectContaining({ language: 'it', name: 'Italy title' })], overrideData: { material: 'Protected cotton' }, version: 9 })
    expect(state.store.data.channelListing.get('p0-account-b')).toMatchObject({ title: 'Sync snapshot', followMasterTitle: true, version: 8 })
    const product = state.store.data.product.get('p0')!
    const resolved = resolveAttributes({ product: product as never, parent: null, channelListing: { ...state.store.data.channelListing.get('p0-account-b'), languages: ['fr'] } as never, locale: 'en' })
    expect(resolveChannelField({ fieldKey: 'item_name', rule: { source: 'title', transforms: [] } as never, resolvedAttrs: resolved, product: { ...product, variantAttributes: {} } as never, locale: 'en' }).value).toBe('New shared')
    const audits = [...state.store.data.auditLog.values()]
    expect(audits).toHaveLength(2)
    expect((await transferJobOutcomes(staged.jobId, 'owner'))!.rows.map(r => r.status)).toEqual(['SUCCESS', 'SUCCESS'])
  })
  it('refuses changed source tokens, another actor, stale reviews and a changed preset', async () => {
    const source = await inspectCatalogSource(Buffer.from('SKU,Name\n000000,Updated'), 'source.csv', 'owner')
    await expect(previewCatalogSource({ sourceId: source.sourceId, inputHash: 'bad', mapping: { ...mapping, bindings: [mapping.bindings[0]] }, userId: 'owner' })).rejects.toThrow('changed or expired')
    await expect(previewCatalogSource({ sourceId: source.sourceId, inputHash: source.hash, mapping, userId: 'other' })).rejects.toThrow('unavailable')
    const preset = await saveSourcePreset({ name: 'Supplier', mapping: { ...mapping, bindings: [mapping.bindings[0]] }, userId: 'owner' })
    const staged = await previewCatalogSource({ sourceId: source.sourceId, inputHash: source.hash, mapping: preset!.columnMapping, presetId: preset!.id, presetVersion: preset!.updatedAt.toISOString(), userId: 'owner' })
    const preview = await waitFor(staged.jobId)
    expect(await applyTransferJob(staged.jobId, 'other', preview.reviewToken!)).toBeNull()
    await expect(applyTransferJob(staged.jobId, 'owner', 'bad')).rejects.toThrow('token')
    state.store.data.scheduledImport.get(preset!.id)!.columnMapping = { ...mapping, policy: { shared: 'exclude', overrides: 'exclude' } }
    await expect(applyTransferJob(staged.jobId, 'owner', preview.reviewToken!)).rejects.toThrow('policy changed')
  })
  it('checks shared dependency versions before a listing override can apply', async () => {
    const preview = await stage([row({ entity: 'Overrides', channel: 'AMAZON', accountId: 'account-a', marketplace: 'IT', field: 'item_name', value: 'Custom' })])
    state.store.data.product.get('p0')!.name = 'Edited after review'
    const result = await apply(preview.jobId, preview.reviewToken!)
    expect(result.state).toBe('PARTIAL')
    expect((await transferJobOutcomes(preview.jobId, 'owner'))!.rows[0].error).toContain('Shared or parent data changed')
    expect(state.store.data.channelListing.get('p0-account-a')!.followMasterTitle).toBe(true)
  })
  it('retries only refused records with a fresh preview and cannot replay successful writes', async () => {
    const preview = await stage([row(), row({ sku: '000001', row: 3 })])
    state.store.failures.set('product:p1', new Error('Isolated record refusal'))
    const result = await apply(preview.jobId, preview.reviewToken!)
    expect(result.state).toBe('PARTIAL'); expect(state.store.data.auditLog.size).toBe(1)
    await applyTransferJob(preview.jobId, 'owner', preview.reviewToken!)
    expect(state.store.data.auditLog.size).toBe(1)
    const retried = (await retryTransferJob(preview.jobId, 'owner'))!
    const review = await waitFor(retried.jobId)
    expect(review.total).toBe(1)
    expect((await apply(review.jobId, review.reviewToken!)).state).toBe('COMPLETED')
    expect(state.store.data.auditLog.size).toBe(2)
  })
  it('blocks all apply on conflicting duplicated shared input', async () => {
    const preview = await stage([row(), row({ value: 'Conflicting name', row: 3 })])
    expect(preview.state).toBe('INVALID'); expect(preview.counts.refused).toBe(1)
    await expect(applyTransferJob(preview.jobId, 'owner', preview.reviewToken!)).rejects.toThrow('invalid or expired')
    expect(state.store.data.auditLog.size).toBe(0)
  })
  it('recovers a rolled-back infrastructure failure from the durable checkpoint without repeating a committed record', async () => {
    const preview = await stage([row(), row({ sku: '000001', row: 3 })])
    state.store.failures.set('product:p1', Object.assign(new Error('Database unavailable'), { code: 'P1001' }))
    await applyTransferJob(preview.jobId, 'owner', preview.reviewToken!)
    await vi.waitFor(() => { expect(state.store.data.auditLog.size).toBe(1); expect(state.store.failures.size).toBe(0) })
    const running = state.store.data.bulkOperation.get(preview.jobId)!
    expect(running.processed).toBe(1); expect(state.store.data.product.get('p1')!.version).toBe(3)
    running.expiresAt = new Date('2020-01-01')
    await recoverTransferJobs()
    expect((await waitFor(preview.jobId, ['COMPLETED', 'PARTIAL'])).state).toBe('COMPLETED')
    expect(state.store.data.auditLog.size).toBe(2)
  })
  it('does not permit legacy unversioned apply or rollback through the old writer', async () => {
    state.store.data.importJob.set('old', { id: 'old', createdBy: 'owner', targetEntity: 'product', status: 'PENDING_PREVIEW' })
    const service = new ImportWizardService(state.store.db as never)
    await expect(service.apply('old', undefined, 'owner')).rejects.toThrow('no record versions')
    await expect(service.rollback('old')).rejects.toThrow('Unversioned rollback')
    expect(state.store.data.auditLog.size).toBe(0)
  })
  it('accounts for saved and unprocessed records when infrastructure recovery is exhausted', async () => {
    const preview = await stage([row(), row({ sku: '000001', row: 3 })])
    state.store.failures.set('product:p1', Object.assign(new Error('Database unavailable'), { code: 'P1001' }))
    await applyTransferJob(preview.jobId, 'owner', preview.reviewToken!)
    await vi.waitFor(() => { expect(state.store.data.auditLog.size).toBe(1); expect(state.store.failures.size).toBe(0) })
    const running = state.store.data.bulkOperation.get(preview.jobId)!
    running.expiresAt = new Date('2020-01-01')
    running.changes = { ...running.changes, recoveryAttempts: 5 }
    await recoverTransferJobs()
    const result = await waitFor(preview.jobId, ['FAILED'])
    expect(result.receipt).toEqual({ saved: 1, unchanged: 0, failed: 0, excluded: 0, unprocessed: 1 })
    expect(state.store.data.product.get('p1')!.version).toBe(3)
    expect(state.store.data.auditLog.size).toBe(1)
    const retry = (await retryTransferJob(preview.jobId, 'owner'))!
    const review = await waitFor(retry.jobId)
    expect(review.total).toBe(1)
    expect((await apply(review.jobId, review.reviewToken!)).receipt?.saved).toBe(1)
    expect(state.store.data.auditLog.size).toBe(2)
  })
  it('keeps legacy job results available without inventing a detailed receipt', async () => {
    const preview = await stage([row()])
    const job = state.store.data.bulkOperation.get(preview.jobId)!
    delete job.changes.outcomeVersion
    for (const record of state.store.data.importJobRow.values()) delete record.parsedValues.changed
    const result = await apply(preview.jobId, preview.reviewToken!)
    expect(result.state).toBe('COMPLETED')
    expect(result.hasChangeFilter).toBe(false)
    expect(result.receipt).toBeUndefined()
    expect((await transferJobOutcomes(preview.jobId, 'owner', 1, 'SUCCESS'))!.total).toBe(1)
  })
  it('previews thousands of variants in bounded pages and exposes all outcomes beyond the first page', async () => {
    state.store.seed(2500)
    const start = performance.now(), heapBefore = process.memoryUsage().heapUsed
    const preview = await stage(Array.from({ length: 2500 }, (_, i) => row({ sku: String(i).padStart(6, '0'), row: i + 2, value: `Updated ${i}` })))
    const heapAfter = process.memoryUsage().heapUsed
    expect(preview.counts).toMatchObject({ productsAffected: 2500, changed: 2500, preservedOverrides: 5000 })
    const last = (await transferJobOutcomes(preview.jobId, 'owner', 50))!
    expect(last.total).toBe(2500); expect(last.rows).toHaveLength(50); expect(last.rows[49].identity!.sku).toBe('002499')
    const productQueries = state.store.queries.filter(q => q.model === 'product' && q.method === 'findMany')
    expect(productQueries).toHaveLength(50)
    expect(Math.max(...productQueries.map(q => q.returned))).toBeLessThanOrEqual(120)
    expect(state.store.queries.filter(q => q.model === 'importJobRow' && q.method === 'findMany' && q.args.where?.rowIndex).every(q => q.args.take <= 100)).toBe(true)
    await writeFile('/tmp/nexus-session-two-preview-metrics.json', JSON.stringify({ fixture: '2500 variants / 5000 listings, in-memory query instrumentation', previewMs: Math.round(performance.now() - start), heapDeltaMiB: Math.round((heapAfter - heapBefore) / 1024 / 1024), productReadQueries: productQueries.length, maxProductsPerRead: Math.max(...productQueries.map(q => q.returned)) }, null, 2))
  }, 60_000)
  it('orders existing parents before variants across preview pages even when the source is reversed', async () => {
    state.store.seed(130)
    const rows = Array.from({ length: 130 }, (_, i) => row({ sku: String(129 - i).padStart(6, '0'), row: i + 2 }))
    const review = await stage(rows)
    const result = await apply(review.jobId, review.reviewToken!)
    expect(result.state).toBe('COMPLETED')
    expect(state.store.data.auditLog.size).toBe(130)
  })
  it('deletes only an owned paused schedule at its reviewed version and rejects a concurrent change', async () => {
    const service = new ScheduledImportService(state.store.db as never)
    const schedule = await service.create({ name: 'Supplier', source: 'url', sourceUrl: 'https://supplier.example/catalog.csv', targetEntity: 'catalog-source-v1', columnMapping: mapping, cronExpression: '0 6 * * *', createdBy: 'owner' })
    const version = schedule.updatedAt.toISOString()
    await expect(service.deleteOwned(schedule.id, 'another-user', version)).rejects.toThrow('Schedule not found')
    await expect(service.deleteOwned(schedule.id, 'owner', version)).rejects.toThrow('Pause the schedule')
    const paused = await service.setEnabled(schedule.id, false, version)
    await expect(service.deleteOwned(schedule.id, 'owner', version)).rejects.toThrow('Pause the schedule')
    const deletion = vi.spyOn(state.store.db.scheduledImport, 'deleteMany').mockResolvedValueOnce({ count: 0 })
    try {
      await expect(service.deleteOwned(schedule.id, 'owner', paused.updatedAt.toISOString())).rejects.toThrow('Schedule changed')
      expect(await service.get(schedule.id)).not.toBeNull()
    } finally { deletion.mockRestore() }
    await service.deleteOwned(schedule.id, 'owner', paused.updatedAt.toISOString())
    expect(await service.get(schedule.id)).toBeNull()
  })
  it('claims a scheduled URL occurrence once, reuses its durable receipt and requires review by default', async () => {
    const service = new ScheduledImportService(state.store.db as never)
    const schedule = await service.create({ name: 'Supplier', source: 'url', sourceUrl: 'https://supplier.example/catalog.csv', targetEntity: 'catalog-source-v1', columnMapping: mapping, cronExpression: '0 6 * * *', createdBy: 'owner' })
    const results = await Promise.allSettled([service.fireOnce(schedule), service.fireOnce(schedule)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(state.fetch).toHaveBeenCalledTimes(1)
    const success = results.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof service.fireOnce>>>
    const preview = await waitFor(success.value.jobId)
    expect(preview.state).toBe('QUEUED'); expect(state.store.data.auditLog.size).toBe(0)
    const receipt = await service.get(schedule.id)
    expect(receipt!.lastJobId).toBe(preview.jobId)
    expect((await service.fireOnce(receipt!)).jobId).toBe(preview.jobId)
    expect(state.fetch).toHaveBeenCalledTimes(1)
    await service.markFired(schedule.id, { jobId: preview.jobId, status: preview.state })
    expect((await apply(preview.jobId, preview.reviewToken!)).state).toBe('COMPLETED')
  })
  it('automatically applies only a schedule with an explicit automatic policy and freezes policy while fetching', async () => {
    const service = new ScheduledImportService(state.store.db as never)
    const schedule = await service.create({ name: 'Automatic supplier', source: 'url', sourceUrl: 'https://supplier.example/catalog.csv', targetEntity: 'catalog-source-v1', columnMapping: { ...mapping, execution: 'automatic' }, cronExpression: '0 6 * * *', createdBy: 'owner' })
    const result = await service.fireOnce(schedule)
    expect((await waitFor(result.jobId, ['COMPLETED', 'PARTIAL'])).state).toBe('COMPLETED')
    expect(state.store.data.auditLog.size).toBe(2)
    const fresh = await service.create({ name: 'Changed supplier', source: 'url', sourceUrl: 'https://supplier.example/catalog.csv', targetEntity: 'catalog-source-v1', columnMapping: mapping, cronExpression: '0 6 * * *', createdBy: 'owner' })
    state.fetch.mockImplementationOnce(async () => { state.store.data.scheduledImport.get(fresh.id)!.enabled = false; return { buffer: Buffer.from('SKU,Name\n000000,Unsafe'), filename: 'supplier.csv' } })
    await expect(service.fireOnce(fresh)).rejects.toThrow('policy changed')
    expect(state.store.data.auditLog.size).toBe(2)
  })
  it('measures representative CSV and XLSX parsing with thousands of mixed account destinations', async () => {
    const headers = ['SKU', 'Name', 'Amazon A']
    const records = Array.from({ length: 2500 }, (_, i) => [String(i).padStart(6, '0'), `Supplier ${i}`, i % 5 ? `Scoped ${i}` : ''])
    const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('Mixed source'); sheet.addRow(headers); sheet.addRows(records)
    const inputs = [{ name: 'scale.csv', buffer: Buffer.from([headers, ...records].map(r => r.join(',')).join('\n')) }, { name: 'scale.xlsx', buffer: Buffer.from(await workbook.xlsx.writeBuffer()) }]
    const metrics = []
    for (const input of inputs) {
      const before = process.memoryUsage(), start = performance.now()
      const table = await readSourceFile(input.buffer, input.name)
      const mapped = mapSourceTable(table, mapping)
      expect(table.records).toHaveLength(2500); expect(mapped.rows).toHaveLength(4500); expect(mapped.exclusions).toHaveLength(500)
      metrics.push({ filename: input.name, bytes: input.buffer.length, rows: table.records.length, mappedActions: mapped.rows.length, parseAndMapMs: Math.round(performance.now() - start), heapDeltaMiB: Math.round((process.memoryUsage().heapUsed - before.heapUsed) / 1024 / 1024), rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024) })
    }
    await writeFile('/tmp/nexus-session-two-file-metrics.json', JSON.stringify(metrics, null, 2))
  }, 30_000)

  it('recovers complete staging but refuses a partial source as a retry', async () => {
    const preview = await stage([row(), row({ sku: '000001', row: 3 })])
    const job = state.store.data.bulkOperation.get(preview.jobId)!
    job.status = 'STAGING'; job.processed = 0; job.expiresAt = new Date('2020-01-01')
    job.changes.counts = Object.fromEntries(Object.keys(job.changes.counts).map(k => [k, 0]))
    for (const r of state.store.data.importJobRow.values()) { r.status = 'PENDING'; r.parsedValues = { rows: r.parsedValues.rows } }
    await recoverTransferJobs()
    expect((await waitFor(job.id)).counts.changed).toBe(2)
    Object.assign(state.store.data.bulkOperation.get(job.id)!, { status: 'STAGING', total: 3, expiresAt: new Date('2020-01-01') })
    await recoverTransferJobs()
    expect(state.store.data.importJob.get(job.id)!.status).toBe('FAILED')
    await expect(retryTransferJob(job.id, 'owner')).rejects.toThrow('partial file cannot be retried')
  })
  it('allows a scoped update after an excluded shared classification without bypassing its preview version', async () => {
    const staged = await stageTransferJob({ rows: [row({ field: 'family', value: 'coats' }), row({ entity: 'Overrides', channel: 'AMAZON', accountId: 'account-a', marketplace: 'IT', field: 'item_name', value: 'Kept scope' })], issues: [], mode: 'update', market: 'IT', filename: 'policy.csv', userId: 'owner', mapping: { ...mapping, policy: { shared: 'fill-empty', overrides: 'replace' } } })
    const review = await waitFor(staged.jobId)
    expect(review.counts.excluded).toBe(1)
    expect((await apply(review.jobId, review.reviewToken!)).state).toBe('COMPLETED')
    expect(state.store.data.auditLog.size).toBe(1)
  })

})
