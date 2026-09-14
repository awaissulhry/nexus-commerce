import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshInTransaction: vi.fn() } }))
vi.mock('./readiness-index.service.js', () => ({ produceReadiness: vi.fn() }))
const mocks = vi.hoisted(() => ({ findFirst: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() }))
vi.mock('../../db.js', () => ({ default: { bulkOperation: mocks } }))
vi.mock('./catalog-transfer-plan.js', async original => {
  const real = await original<typeof import('./catalog-transfer-plan.js')>()
  return { ...real, transferContracts: vi.fn() }
})
vi.mock('./sheet-columns.service.js', () => ({ clearSheetColumnCache: vi.fn(), getSheetColumns: vi.fn() }))
vi.mock('./mapping/field-catalogue.service.js', () => ({ clearFieldCatalogueCache: vi.fn(), getFieldCatalogue: vi.fn() }))
import { applyTransferTarget, readCatalogTransfer, startCatalogTransfer } from './catalog-transfer.service.js'
import type { TransferTarget } from './catalog-transfer-plan.js'
import { produceReadiness } from './readiness-index.service.js'

const before = { id: 'p1', sku: 'SKU', name: 'Old', version: 5, updatedAt: new Date('2026-01-01'), deletedAt: null, categories: [] }
const target = (): TransferTarget => ({ key: 'p1', identity: { row: 2, entity: 'Products', sku: 'SKU', channel: '', accountId: '', marketplace: '', aliasKey: '', locale: '', field: 'name', action: 'SET', value: 'New' }, before: JSON.parse(JSON.stringify(before)), patch: { name: 'New' }, cells: [], rows: [], contractHash: 'x', create: false })
const txOf = () => ({ product: { findUnique: vi.fn().mockResolvedValue(before), updateMany: vi.fn().mockResolvedValue({ count: 1 }), create: vi.fn().mockResolvedValue({ id: 'new' }) },
  channelConnection: { findUnique: vi.fn().mockResolvedValue({ channelType: 'AMAZON', marketplace: null }) },
  channelListing: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({ id: 'new-listing' }), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit' }) }, productCategory: { deleteMany: vi.fn(), createMany: vi.fn() }, category: { count: vi.fn() } })

describe('catalog transaction boundaries', () => {
  it('rechecks alias ownership at apply if an alias appeared after preview', async () => {
    const existing = { ...before, parentId: 'old-parent' }
    const tx = { ...txOf(), productListingAlias: { findMany: vi.fn().mockResolvedValue([]) } }
    tx.product.findUnique.mockResolvedValue(existing)
    tx.channelListing.findMany.mockResolvedValue([{ productId: 'p1' }] as never)
    const t = { ...target(), before: JSON.parse(JSON.stringify(existing)), parentSku: null }
    await expect(applyTransferTarget(tx as never, t, 'job', null)).rejects.toThrow('listing aliases')
    expect(tx.product.updateMany).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })
  it('refuses becoming a child when a new child appeared after preview without changing the product snapshot', async () => {
    const tx = txOf()
    tx.product.findUnique.mockResolvedValueOnce(before).mockResolvedValueOnce({ id: 'parent', parentId: null, isParent: true, deletedAt: null, _count: { children: 0 } } as never)
    const count = vi.fn().mockResolvedValue(1)
    const transaction = { ...tx, product: { ...tx.product, count } }
    await expect(applyTransferTarget(transaction as never, { ...target(), parentSku: 'PARENT' }, 'job', null)).rejects.toThrow('now a parent')
    expect(count).toHaveBeenCalledWith({ where: { parentId: 'p1' } })
    expect(tx.product.updateMany).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })
  beforeEach(() => vi.clearAllMocks())
  it('checks snapshot, version and updatedAt and audits the change in the supplied transaction', async () => {
    const tx = txOf()
    await applyTransferTarget(tx as never, target(), 'job1', 'user1')
    expect(tx.product.updateMany).toHaveBeenCalledWith({ where: { id: 'p1', version: 5, updatedAt: before.updatedAt, deletedAt: null }, data: { name: 'New', version: { increment: 1 } } })
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: 'user1', metadata: expect.objectContaining({ jobId: 'job1' }) }) }))
  })
  it('refuses an intervening sync write even if it did not bump the version', async () => {
    const tx = txOf(); tx.product.findUnique.mockResolvedValue({ ...before, name: 'Synced value' })
    await expect(applyTransferTarget(tx as never, target(), 'job', null)).rejects.toThrow('changed since preview')
    expect(tx.product.updateMany).not.toHaveBeenCalled()
  })
  it('refuses an edit that wins between the read and write', async () => {
    const tx = txOf(); tx.product.updateMany.mockResolvedValue({ count: 0 })
    await expect(applyTransferTarget(tx as never, target(), 'job', null)).rejects.toThrow('changed during apply')
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })
  it('creates products as drafts and never asks a sync service to publish them', async () => {
    const tx = txOf(); tx.product.findUnique.mockResolvedValue(null as never)
    await applyTransferTarget(tx as never, { ...target(), before: null, create: true, patch: { name: 'New', familyId: 'f1' } }, 'job', null)
    expect(tx.product.create).toHaveBeenCalledWith({ data: { sku: 'SKU', name: 'New', familyId: 'f1', basePrice: 0, status: 'DRAFT' } })
  })
  it('creates an exact account listing with publication disabled', async () => {
    const tx = txOf(), t = target()
    t.identity = { ...t.identity, entity: 'Listings', channel: 'AMAZON', accountId: 'account-a', marketplace: 'IT' }; t.before = null; t.create = true; t.patch = { platformAttributes: { productType: 'COAT' } }
    await applyTransferTarget(tx as never, t, 'job', null)
    expect(tx.channelListing.create).toHaveBeenCalledWith({ data: expect.objectContaining({ channelConnectionId: 'account-a', aliasKey: '', marketplace: 'IT', listingStatus: 'DRAFT', isPublished: false }) })
    expect(produceReadiness).toHaveBeenCalledWith('p1', { channel: 'AMAZON', market: 'IT', accountId: 'account-a' })
  })
  it('does not expose or apply another user’s job', async () => {
    mocks.findFirst.mockResolvedValue(null)
    expect(await readCatalogTransfer('job1', 'user2')).toBeNull()
    expect(mocks.findFirst).toHaveBeenCalledWith({ where: { id: 'job1', userId: 'user2' } })
  })
  it('refuses an expired preview before claiming it', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'job', status: 'QUEUED', changes: { kind: 'catalog-transfer-v1', previewExpiresAt: '2020-01-01' } })
    await expect(startCatalogTransfer('job', 'user')).rejects.toThrow('expired')
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })
  it('uses a compare-and-set claim when Apply is clicked twice', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'job', status: 'QUEUED', changes: { kind: 'catalog-transfer-v1', mode: 'update', previewExpiresAt: '2099-01-01', plan: { targets: [], issues: [], warnings: [] } } })
    mocks.updateMany.mockResolvedValue({ count: 0 })
    await startCatalogTransfer('job', 'user')
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'job', status: 'QUEUED' }) }))
  })
})
