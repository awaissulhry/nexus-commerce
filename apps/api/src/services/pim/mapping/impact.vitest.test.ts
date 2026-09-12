const schemaRead = vi.hoisted(() => vi.fn())
vi.mock('../channel-specs/shopify.js', () => ({ readShopifyMappingSchema: schemaRead }))
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { db, resolve, inputToken } = vi.hoisted(() => ({
  db: { product: { findMany: vi.fn(), count: vi.fn() }, mappingRevision: { findUnique: vi.fn() }, channelListing: { findMany: vi.fn() },
    marketplace: { findUnique: vi.fn() }, bulkOperation: { findUnique: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn(), create: vi.fn(), createMany: vi.fn() }, $transaction: vi.fn() },
  resolve: vi.fn(), inputToken: vi.fn(),
}))
vi.mock('./review-inputs.js', () => ({ mappingInputToken: inputToken }))
vi.mock('../../../db.js', () => ({ default: db }))
vi.mock('./resolve-batch.service.js', () => ({ resolveBatch: resolve }))
import { runMappingImpact, activateMappingImpact, createMappingImpact } from './impact.service.js'
import { emptyMapping } from '../schema-mapping.service.js'
import { mappingToken } from './revision-token.js'

let job: any
let chunks: any[]
let catalogueSize: number
const original = emptyMapping()
beforeEach(() => {
  vi.resetAllMocks()
  inputToken.mockResolvedValue('inputs-v1')
  chunks = []
  catalogueSize = 2500
  job = { id: 'review', userId: 'operator', status: 'MAPPING_SCANNING', processed: 0, total: 2500,
    changes: { kind: 'mapping-impact-v1', channel: 'EBAY', market: 'IT', category: 'jackets', before: original,
      after: { ...original, fields: { title: { source: 'name' } } }, token: mappingToken(original), cursor: null,
      cutoff: '2026-09-06T00:00:00Z', inputToken: 'inputs-v1', changes: [{ fieldKey: 'title', rule: { source: 'name' } }],
      counts: { scanned: 0, matchedProducts: 0, affectedListings: 0, changed: 0, preservedOverrides: 0, invalid: 0, introducedInvalid: 0, excluded: 0 } } }
  db.marketplace.findUnique.mockResolvedValue({ schemaMapping: original })
  db.bulkOperation.findUnique.mockImplementation(async () => structuredClone(job))
  db.bulkOperation.findFirst.mockImplementation(async ({ where }) => where.userId === job.userId ? structuredClone(job) : null)
  db.bulkOperation.updateMany.mockImplementation(async ({ where, data }) => {
    if (where.status !== job.status || (where.processed !== undefined && where.processed !== job.processed)) return { count: 0 }
    Object.assign(job, structuredClone(data)); return { count: 1 }
  })
  db.bulkOperation.create.mockImplementation(async ({ data }) => { chunks.push(data); return data })
  db.bulkOperation.createMany.mockImplementation(async ({ data }) => { chunks.push(...data); return { count: data.length } })
  db.$transaction.mockImplementation(async fn => fn(db))
  db.product.findMany.mockImplementation(async ({ where, take }) => {
    const start = where.id ? Number(where.id.gt.slice(1)) + 1 : 0
    return Array.from({ length: Math.max(0, Math.min(take, catalogueSize - start)) }, (_, i) => ({ id: `p${String(start + i).padStart(4, '0')}` }))
  })
  db.channelListing.findMany.mockImplementation(async ({ where }) => where.productId.in.flatMap((id: string) => [
    { id: `${id}-a`, productId: id, channelConnectionId: 'account-a', aliasKey: '' },
    { id: `${id}-b`, productId: id, channelConnectionId: 'account-b', aliasKey: 'alternate' },
  ]))
  resolve.mockImplementation(async input => ({ products: input.productIds.map((id: string) => {
    const n = Number(id.slice(1)); const overridden = input.channelConnectionId === 'account-b' && n % 5 === 0
    return { productId: id, sku: id, category: { channelCategoryId: n % 2 === 0 ? 'jackets' : 'boots' },
      cells: { title: { value: overridden ? 'custom' : input.mappingSnapshot.fields.title ? 'new' : 'old', provenance: overridden ? 'override' : 'mapped', errors: [] } } }
  }) }))
})

describe('durable mapping impact at catalog scale', () => {
  it('restores a snapshot through a fresh whole-market review without activating it', async () => {
    const snapshot = { ...original, version: 7, fields: { title: { source: 'sku' } }, byProductType: { jackets: { color: { source: 'color' } } } }
    db.mappingRevision.findUnique.mockResolvedValue({ id: 'revision-7', channel: 'EBAY', code: 'IT', version: 7, snapshot })
    db.product.count.mockResolvedValue(2500)
    db.bulkOperation.create.mockResolvedValue({ id: 'new-review', status: 'MAPPING_SCANNING' })
    db.bulkOperation.findUnique.mockResolvedValue(null)
    await createMappingImpact({ channel: 'EBAY', market: 'IT', userId: 'operator', expectedToken: mappingToken(original), restoreRevisionId: 'revision-7' })
    expect(db.bulkOperation.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'MAPPING_SCANNING', changes: expect.objectContaining({
      allFields: true, restoreRevision: { id: 'revision-7', version: 7 }, token: mappingToken(original), inputToken: 'inputs-v1',
      after: { ...snapshot, version: original.version },
    }) }) })
    expect(db.bulkOperation.updateMany).not.toHaveBeenCalled()
  })
  it('refuses a restore from another market or an invalid saved snapshot', async () => {
    const input = { channel: 'EBAY', market: 'IT', userId: 'operator', expectedToken: mappingToken(original), restoreRevisionId: 'other' }
    db.mappingRevision.findUnique.mockResolvedValue({ channel: 'EBAY', code: 'DE', snapshot: original })
    await expect(createMappingImpact({ ...input })).rejects.toThrow('Invalid mapping')
    db.mappingRevision.findUnique.mockResolvedValue({ channel: 'EBAY', code: 'IT', snapshot: [] })
    await expect(createMappingImpact({ ...input })).rejects.toThrow('Invalid mapping')
    expect(db.bulkOperation.create).not.toHaveBeenCalled()
  })
  it.each([2500, 10000])('scans %i records in bounded batches, counts both accounts, preserves overrides, and pages the complete impact', async size => {
    catalogueSize = size
    job.total = size
    await runMappingImpact(job.id)
    expect(job.status).toBe('MAPPING_REVIEW')
    expect(job.processed).toBe(size)
    expect(job.changes.counts).toEqual({ scanned: size, matchedProducts: size / 2, excluded: size / 2,
      changed: size * 0.9, affectedListings: size * 0.9, matchedListings: size, missing: 0, conflicts: 0, preservedOverrides: size / 10, invalid: 0, introducedInvalid: 0 })
    expect(db.product.findMany).toHaveBeenCalledTimes(size / 100 + 1)
    expect(db.product.findMany.mock.calls.every(([q]) => q.take === 100)).toBe(true)
    expect(resolve.mock.calls.every(([q]) => q.productIds.length <= 100 && q.includeCatalogue === false)).toBe(true)
    expect(chunks.every(c => c.changes.rows.length <= 100)).toBe(true)
    expect(chunks.flatMap(c => c.changes.rows)).toHaveLength(size)
    expect(db.bulkOperation.createMany).toHaveBeenCalledTimes(size / 100)
    expect(chunks.every((chunk, index) => index === 0 || chunk.createdAt > chunks[index - 1].createdAt)).toBe(true)
  })

  it('resumes from a committed checkpoint after a partial failure without duplicate records', async () => {
    resolve.mockRejectedValueOnce(new Error('temporary schema service failure'))
    await runMappingImpact(job.id)
    expect(job.processed).toBe(0)
    expect(job.status).toBe('MAPPING_SCANNING')
    await runMappingImpact(job.id)
    expect(job.status).toBe('MAPPING_REVIEW')
    const rows = chunks.flatMap(c => c.changes.rows)
    expect(new Set(rows.map(r => `${r.productId}:${r.listingId}:${r.field}`)).size).toBe(rows.length)
  })

  it('stops a stale rule preview before resolving or checkpointing records', async () => {
    db.marketplace.findUnique.mockResolvedValue({ schemaMapping: { ...original, version: 2 } })
    await runMappingImpact(job.id)
    expect(job.status).toBe('MAPPING_STALE')
    expect(resolve).not.toHaveBeenCalled()
    expect(chunks).toHaveLength(0)
  })

  it('ends after three failures and cannot activate an incomplete or another operator’s review', async () => {
    resolve.mockRejectedValue(new Error('invalid destination'))
    for (let n = 0; n < 3; n++) await runMappingImpact(job.id)
    expect(job.status).toBe('MAPPING_FAILED')
    await expect(activateMappingImpact(job.id, 'operator')).rejects.toThrow()
    await expect(activateMappingImpact(job.id, 'another-operator')).resolves.toBeNull()
  })

  it('refuses a review when product, listing or schema inputs change during the scan', async () => {
    inputToken.mockResolvedValue('inputs-v2')
    await runMappingImpact(job.id)
    expect(job.status).toBe('MAPPING_STALE')
    await expect(activateMappingImpact(job.id, 'operator')).rejects.toThrow()
  })

  it('refuses conflicting equal-scope changes before creating a job', async () => {
    await expect(createMappingImpact({ channel: 'EBAY', market: 'IT', userId: 'operator', expectedToken: mappingToken(original),
      changes: [{ fieldKey: 'title', rule: { source: 'name' } }, { fieldKey: 'title', rule: { source: 'sku' } }] })).rejects.toThrow(/Invalid mapping/)
    expect(db.bulkOperation.create).not.toHaveBeenCalled()
  })
})

it('reviews both former and new matches when an account-scoped rule moves', async () => {
  const rule = { id: 'theme-rule', name: 'Theme', version: 1, priority: 10, scope: { accountId: 'account-a' }, themeId: 'theme' }
  const before = { ...original, presentationRules: [rule] }
  job.changes = { ...job.changes, category: null, before, token: mappingToken(before),
    after: { ...original, presentationRules: [{ ...rule, scope: { accountId: 'account-b' }, version: 2 }] },
    presentationChange: { id: rule.id, rule: { ...rule, scope: { accountId: 'account-b' } } }, changes: [{ fieldKey: 'descriptionThemeId', rule: null }] }
  db.marketplace.findUnique.mockResolvedValue({ schemaMapping: before })
  db.product.findMany.mockResolvedValueOnce([{ id: 'p0000' }]).mockResolvedValue([])
  resolve.mockImplementation(async input => ({ products: input.productIds.map((id: string) => ({ productId: id, sku: id, category: { channelCategoryId: 'jackets' },
    presentationContext: { accountId: input.channelConnectionId, familyId: 'clothing', sharedCategoryIds: [], marketplaceCategoryId: 'jackets' },
    cells: { descriptionThemeId: { value: input.mappingSnapshot.presentationRules[0].scope.accountId === input.channelConnectionId ? 'theme' : null, errors: [], provenance: 'catalogRule' } },
  })) }))
  await runMappingImpact(job.id)
  expect(job.status).toBe('MAPPING_REVIEW')
  const rows = chunks.flatMap(c => c.changes.rows)
  expect(rows).toHaveLength(2)
  expect(rows.find(r => r.accountId === 'account-a')).toMatchObject({ before: 'theme', after: null, changed: true, matchesDraft: false })
  expect(rows.find(r => r.accountId === 'account-b')).toMatchObject({ before: null, after: 'theme', changed: true, matchesDraft: true })
  expect(resolve.mock.calls.every(([input]) => input.includePresentation === true)).toBe(true)
})

it('refuses activation when the connected store changed its metafield definitions after review', async () => {
  job.status = 'MAPPING_REVIEW'; job.expiresAt = new Date(Date.now() + 60_000)
  job.changes.channel = 'SHOPIFY'; job.changes.market = 'GLOBAL'; job.changes.shopifySchemaRevisions = { 'store-a': 'reviewed' }
  schemaRead.mockResolvedValue({ revision: 'changed' })
  await expect(activateMappingImpact(job.id, 'operator')).rejects.toThrow('Shopify store schema changed')
  expect(schemaRead).toHaveBeenCalledWith('store-a', true)
  expect(db.$transaction).not.toHaveBeenCalled()
})
