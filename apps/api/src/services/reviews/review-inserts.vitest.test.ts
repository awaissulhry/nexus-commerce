/**
 * Package inserts carry THIS business's own name (audit B5): one value per deployment put another business's name in
 * the box. A business with no identity for buyers gets no cards, in words.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ identity: { ok: true, identity: { brandName: 'Test Moto' } } as Record<string, unknown>, built: [] as unknown[] }))
vi.mock('../../db.js', () => ({
  default: {
    product: {
      count: vi.fn(async () => 2),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === 'p1' ? { name: 'Test Jacket', amazonAsin: 'B0TEST0001' } : where.id === 'p2' ? { name: 'No ASIN', amazonAsin: null } : null)),
      findMany: vi.fn(async () => [{ name: 'Test Jacket', amazonAsin: 'B0TEST0001' }]),
    },
  },
}))
vi.mock('../business-identity.service.js', () => ({ resolveBusinessIdentity: vi.fn(async () => h.identity) }))
vi.mock('./review-insert-pdf.service.js', () => ({ buildReviewInsertPdf: vi.fn(async (input: unknown) => { h.built.push(input); return Buffer.from('pdf') }) }))

import { bulkInsertsPdf, insertMarket, oneInsertPdf } from './review-inserts.service.js'

beforeEach(() => {
  h.identity = { ok: true, identity: { brandName: 'Test Moto' } }
  h.built = []
})

describe('package inserts', () => {
  it('print the business\'s own name, on the market asked for', async () => {
    await oneInsertPdf('p1', 'de')
    await bulkInsertsPdf({ marketplace: 'FR', productIds: ['p1'] })
    expect(h.built).toEqual([
      { brand: 'Test Moto', marketplace: 'DE', products: [{ name: 'Test Jacket', asin: 'B0TEST0001', marketplace: 'DE' }] },
      { brand: 'Test Moto', marketplace: 'FR', products: [{ name: 'Test Jacket', asin: 'B0TEST0001', marketplace: 'FR' }] },
    ])
  })

  it('a business with no identity for buyers gets no cards (409, in words); a product without an ASIN is refused', async () => {
    h.identity = { ok: false, reason: 'This business has no identity for buyers yet: set its company name in Settings › Company.' }
    await expect(bulkInsertsPdf({ marketplace: 'IT' })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/Settings › Company/) })
    await expect(oneInsertPdf('p2', 'IT')).rejects.toMatchObject({ statusCode: 422 })
    await expect(oneInsertPdf('nope', 'IT')).rejects.toMatchObject({ statusCode: 404 })
    expect(h.built).toEqual([])
  })

  it('a market is two letters, Italy when none or nonsense', () => {
    expect(insertMarket('es')).toBe('ES')
    expect(insertMarket(undefined)).toBe('IT')
    expect(insertMarket('nope')).toBe('IT')
  })
})
