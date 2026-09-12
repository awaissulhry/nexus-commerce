import { beforeEach, describe, expect, it, vi } from 'vitest'
const { db, token } = vi.hoisted(() => ({ token: vi.fn(), db: {
  bulkOperation: { findFirst: vi.fn(), updateMany: vi.fn() },
  marketplace: { findUnique: vi.fn(), updateMany: vi.fn() }, mappingRevision: { findFirst: vi.fn(), create: vi.fn() },
  categoryChannelMapping: { upsert: vi.fn(), deleteMany: vi.fn() }, $transaction: vi.fn(), $executeRaw: vi.fn(),
  marketplaceTaxonomy: { findFirst: vi.fn() }, categorySchema: { findUnique: vi.fn() },
} }))
vi.mock('../../../db.js', () => ({ default: db }))
vi.mock('./review-inputs.js', () => ({ mappingInputToken: token }))
vi.mock('./resolve-batch.service.js', () => ({ resolveBatch: vi.fn() }))
import { activateMappingImpact } from './impact.service.js'
import { emptyMapping } from '../schema-mapping.service.js'
import { mappingToken } from './revision-token.js'
let job: any
beforeEach(() => {
  vi.resetAllMocks()
  const before = emptyMapping()
  job = { id: 'review', userId: 'operator', status: 'MAPPING_REVIEW', expiresAt: new Date(Date.now() + 60_000),
    changes: { kind: 'mapping-impact-v1', channel: 'EBAY', market: 'IT', before, after: { ...before, fields: { title: { source: 'name' } } },
      token: mappingToken(before), inputToken: 'v1', counts: { introducedInvalid: 0 } } }
  db.bulkOperation.findFirst.mockImplementation(async ({ where }) => where.userId === 'operator' ? job : null)
  db.bulkOperation.updateMany.mockResolvedValue({ count: 1 })
  db.marketplace.findUnique.mockResolvedValue({ schemaMapping: before })
  db.marketplace.updateMany.mockResolvedValue({ count: 1 })
  db.mappingRevision.findFirst.mockResolvedValue(null)
  db.$transaction.mockImplementation(async fn => fn(db))
  token.mockResolvedValue('v1')
  db.marketplaceTaxonomy.findFirst.mockResolvedValue({ activeSnapshotId: 'tree-v1' })
  db.categorySchema.findUnique.mockResolvedValue({ isActive: true, expiresAt: new Date(Date.now() + 60000) })
})
describe('review activation commits through mapping CAS and a serializable input check', () => {
  it('claims the review, writes mapping and category and records its audit in the same transaction', async () => {
    job.changes.categoryChange = { categoryId: 'shared-category', channelCategoryId: '123' }
    job.changes.taxonomySnapshotId = 'tree-v1'; job.changes.taxonomySchemaId = 'schema-v1'
    expect(await activateMappingImpact('review', 'operator')).toEqual({ applied: true })
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable', timeout: 60_000 })
    expect(token).toHaveBeenCalledWith('EBAY', 'IT', db, expect.any(Function))
    expect(db.categoryChannelMapping.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { categoryId_channel_marketplace: { categoryId: 'shared-category', channel: 'EBAY', marketplace: 'IT' } } }))
    expect(db.mappingRevision.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ reason: expect.stringContaining('review') }) }))
  })
  it('rejects changed inputs before claiming the review or writing anything', async () => {
    token.mockResolvedValue('v2')
    await expect(activateMappingImpact('review', 'operator')).rejects.toThrow(/Resolution inputs changed/)
    expect(db.bulkOperation.updateMany).not.toHaveBeenCalled()
    expect(db.marketplace.updateMany).not.toHaveBeenCalled()
  })
  it('rechecks every input on a bounded serialization retry and does not retry stale inputs', async () => {
    db.$transaction.mockImplementationOnce(async fn => { await fn(db); throw Object.assign(new Error('write conflict'), { code: 'P2034' }) })
    await expect(activateMappingImpact('review', 'operator')).resolves.toEqual({ applied: true })
    expect(token).toHaveBeenCalledTimes(2)
    expect(db.$transaction).toHaveBeenCalledTimes(2)
    db.$transaction.mockClear()
    token.mockResolvedValue('changed')
    await expect(activateMappingImpact('review', 'operator')).rejects.toThrow(/Resolution inputs changed/)
    expect(db.$transaction).toHaveBeenCalledTimes(1)
  })
  it('refuses a modified clone source, incomplete order integration and another actor', async () => {
    job.changes.cloneSource = { channel: 'EBAY', market: 'DE', token: 'old-source' }
    await expect(activateMappingImpact('review', 'operator')).rejects.toThrow(/clone source changed/)
    expect(db.marketplace.updateMany).not.toHaveBeenCalled()
    job.changes.presentationChange = { id: 'order', rule: { order: { axes: ['Size'], values: {} } } }
    await expect(activateMappingImpact('review', 'operator')).rejects.toThrow(/Variation-order activation/)
    await expect(activateMappingImpact('review', 'another')).resolves.toBeNull()
  })
})

it('refuses activation when a taxonomy refresh replaced the reviewed version', async () => {
  job.changes.categoryChange = { categoryId: 'shared-category', channelCategoryId: '123' }; job.changes.taxonomySnapshotId = 'old-tree'
  await expect(activateMappingImpact('review', 'operator')).rejects.toThrow('taxonomy changed')
  expect(db.categoryChannelMapping.upsert).not.toHaveBeenCalled()
  expect(db.bulkOperation.updateMany).not.toHaveBeenCalled()
})
it('refuses requirements that expired while the review was open', async () => {
  job.changes.categoryChange = { categoryId: 'shared-category', channelCategoryId: '123' }; job.changes.taxonomySnapshotId = 'tree-v1'; job.changes.taxonomySchemaId = 'schema-v1'
  db.categorySchema.findUnique.mockResolvedValue({ isActive: true, expiresAt: new Date(0) })
  await expect(activateMappingImpact('review', 'operator')).rejects.toThrow('requirements expired')
  expect(db.categoryChannelMapping.upsert).not.toHaveBeenCalled()
})
