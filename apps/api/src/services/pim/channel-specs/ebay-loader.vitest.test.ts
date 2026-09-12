import { beforeEach, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ categorySchema: { findFirst: vi.fn() }, channelSchema: { findMany: vi.fn() } }))
vi.mock('../../../db.js', () => ({ default: db }))
import { loadEbaySpec } from './index.js'
beforeEach(() => { vi.clearAllMocks(); db.channelSchema.findMany.mockResolvedValue([{ fieldKey: 'aspect_Foreign', label: 'Foreign', required: true }]) })
it('never borrows marketplace-wide aspects for an uncached category', async () => {
  db.categorySchema.findFirst.mockResolvedValue(null)
  const spec = await loadEbaySpec('IT', ['123'])
  expect(spec.absent).toBe(true)
  expect(spec.fields.some(f => f.attribute === 'aspect_Foreign')).toBe(false)
  expect(spec.fields.some(f => f.key === 'categoryId')).toBe(true)
})
it('selects the latest exact leaf instead of an older English-rich row', async () => {
  db.categorySchema.findFirst.mockResolvedValue({ fetchedAt: new Date(), schemaVersion: 'v2', schemaDefinition: { aspects: [] } })
  await loadEbaySpec('EBAY_IT', ['123'])
  expect(db.categorySchema.findFirst.mock.calls[0][0]).toMatchObject({ where: { productType: '123', marketplace: { in: ['IT', 'EBAY_IT'] } }, orderBy: [{ fetchedAt: 'desc' }, { id: 'asc' }] })
})
it('requires separate contracts for different categories', async () => {
  await expect(loadEbaySpec('IT', ['123', '456'])).rejects.toThrow('separately')
  expect(db.categorySchema.findFirst).not.toHaveBeenCalled()
})
