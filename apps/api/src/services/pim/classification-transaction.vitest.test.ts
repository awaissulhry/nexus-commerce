import { beforeEach, expect, it, vi } from 'vitest'
const { tx, event } = vi.hoisted(() => ({
  tx: { $executeRaw: vi.fn(), product: { findFirst: vi.fn(), updateMany: vi.fn() }, productFamily: { findUnique: vi.fn() }, category: { count: vi.fn() }, productCategory: { deleteMany: vi.fn(), createMany: vi.fn() } }, event: vi.fn(),
}))
vi.mock('../../db.js', () => ({ default: { $transaction: (fn: (client: typeof tx) => unknown) => fn(tx) } }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emitTx: event } }))
import { updateProductClassification } from './product-classification.js'
const change = { version: 4, familyId: 'jackets', categoryIds: ['clothing'], primaryId: 'clothing' }
beforeEach(() => {
  vi.clearAllMocks()
  tx.product.findFirst.mockResolvedValue({ parentId: null, familyId: null })
  tx.productFamily.findUnique.mockResolvedValue({ id: 'jackets' })
  tx.category.count.mockResolvedValue(1)
  tx.product.updateMany.mockResolvedValue({ count: 1 })
})
it('changes classification with a version guard and audit event, without writing product values', async () => {
  expect(await updateProductClassification('p', change)).toEqual({ status: 200, version: 5 })
  expect(tx.product.updateMany).toHaveBeenCalledWith({ where: { id: 'p', version: 4, deletedAt: null }, data: { familyId: 'jackets', version: { increment: 1 } } })
  expect(tx.productCategory.createMany).toHaveBeenCalledWith({ data: [{ productId: 'p', categoryId: 'clothing', isPrimary: true }] })
  expect(event).toHaveBeenCalledOnce()
})
it('refuses stale edits before replacing memberships', async () => {
  tx.product.updateMany.mockResolvedValue({ count: 0 })
  expect((await updateProductClassification('p', change)).status).toBe(409)
  expect(tx.productCategory.deleteMany).not.toHaveBeenCalled()
  expect(event).not.toHaveBeenCalled()
})
it('refuses nonexistent families and variation-root confusion', async () => {
  tx.productFamily.findUnique.mockResolvedValue(null)
  expect((await updateProductClassification('p', change)).status).toBe(400)
  tx.product.findFirst.mockResolvedValue({ parentId: 'root' })
  expect((await updateProductClassification('p', change)).status).toBe(400)
  expect(tx.product.updateMany).not.toHaveBeenCalled()
})
