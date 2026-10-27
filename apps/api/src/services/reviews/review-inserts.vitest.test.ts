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

import prisma from '../../db.js'
import { bulkInsertsPdf, familyCards, insertFamilies, insertMarket, oneInsertPdf } from './review-inserts.service.js'

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

  it('a family prints its own card and each variation\'s; its row shows its ASIN and that count (live audit A05)', () => {
    expect(familyCards({ amazonAsin: 'B0PARENT01', children: [{ amazonAsin: 'B0CHILD001' }, { amazonAsin: null }, { amazonAsin: 'B0CHILD003' }] })).toEqual({ asin: 'B0PARENT01', cards: 3 })
    // A family without an ASIN of its own shows its first variation's; no ASIN anywhere: no card.
    expect(familyCards({ amazonAsin: null, children: [{ amazonAsin: null }, { amazonAsin: 'B0CHILD002' }] })).toEqual({ asin: 'B0CHILD002', cards: 1 })
    expect(familyCards({ amazonAsin: '  ', children: [] })).toEqual({ asin: null, cards: 0 })
  })

  it('the picker reads families with their variations\' ASINs; a picked family prints its variations too', async () => {
    const product = prisma.product as unknown as { findMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> }
    product.findMany.mockResolvedValueOnce([
      { id: 'f1', name: 'Test Jacket', sku: 'TEST-JACKET', amazonAsin: null, children: [{ amazonAsin: 'B0TEST0002' }, { amazonAsin: 'B0TEST0003' }] },
    ])
    const page = await insertFamilies({ search: 'jack' })
    expect(page.products).toEqual([{ id: 'f1', name: 'Test Jacket', sku: 'TEST-JACKET', asin: 'B0TEST0002', childCount: 2, cards: 2 }])
    expect(product.findMany.mock.calls.at(-1)![0].where).toMatchObject({ parentId: null, deletedAt: null, OR: [{ name: { contains: 'jack' } }, { sku: { contains: 'jack' } }] })
    await bulkInsertsPdf({ marketplace: 'IT', productIds: ['f1'] })
    expect(product.findMany.mock.calls.at(-1)![0].where).toMatchObject({ amazonAsin: { not: null }, OR: [{ id: { in: ['f1'] } }, { parentId: { in: ['f1'] } }] })
  })
})
