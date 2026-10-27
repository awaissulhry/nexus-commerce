/**
 * Reviews Insights › Fit by size against real SQL (PGlite with the production schema and policies): which reviews and
 * returns count (the fit theme gate, fixtures, rejected returns, the period, the scope), the size of each variant, a
 * review on the family placed by its order's line, the minimum, and the words. Nothing leaves this machine.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

const { fitTable, productFit } = await import('./review-fit.service.js')
const { insightsThemes } = await import('./review-themes.service.js')
const { insightsProductDetail } = await import('./review-products.service.js')

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const NOW = new Date()
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000)
const FROM = daysAgo(30)
const ALL = { channel: null, market: null }
const FAMILY = ['test-fit', 'test-fit-s', 'test-fit-m', 'test-fit-m-red', 'test-fit-l']

let seq = 0
async function review(productId: string, body: string, opts: { channel?: string; market?: string | null; themes?: string[] | null; days?: number; source?: string; orderId?: string } = {}) {
  seq += 1
  const themes = opts.themes === undefined ? ['FIT_SIZING'] : opts.themes
  await database.client.review.create({
    data: {
      channel: opts.channel ?? 'EBAY', marketplace: opts.market === undefined ? 'IT' : opts.market, externalReviewId: `test-fit-${seq}`, productId, rating: 3, body,
      postedAt: daysAgo(opts.days ?? 3), ingestSource: opts.source ?? 'MANUAL', orderId: opts.orderId ?? null,
      ...(themes ? { sentiment: { create: { label: 'NEUTRAL', score: 0, categories: themes, model: 'test' } } } : {}),
    } as never,
  })
}

async function returned(productId: string, reason: string, opts: { notes?: string; status?: string; channel?: string } = {}) {
  seq += 1
  await database.client.return.create({
    data: {
      channel: opts.channel ?? 'EBAY', marketplace: 'IT', rmaNumber: `TEST-FIT-RMA-${seq}`, status: opts.status ?? 'RECEIVED', reason, notes: opts.notes ?? null, createdAt: daysAgo(5),
      items: { create: [{ productId, sku: productId.toUpperCase(), quantity: 1 }] },
    } as never,
  })
}

describe('Reviews Insights › Fit by size (real SQL)', () => {
  beforeAll(async () => {
    database = await formulaDatabase()
    await inside(async () => {
      const c = database.client
      await c.product.create({ data: { id: 'test-fit', sku: 'TEST-FIT', name: 'Test touring jacket', basePrice: 10, isParent: true } as never })
      await c.product.create({ data: { id: 'test-fit-s', sku: 'TEST-FIT-S', name: 'Test touring jacket S', basePrice: 10, parentId: 'test-fit', variantAttributes: { Taglia: 'S', Colore: 'Nero' } } as never })
      await c.product.create({ data: { id: 'test-fit-m', sku: 'TEST-FIT-M', name: 'Test touring jacket M', basePrice: 10, parentId: 'test-fit', variantAttributes: { Size: 'M', Colour: 'Black' } } as never })
      await c.product.create({ data: { id: 'test-fit-m-red', sku: 'TEST-FIT-M-RED', name: 'Test touring jacket M red', basePrice: 10, parentId: 'test-fit', variantAttributes: { Size: 'M', Colour: 'Red' } } as never })
      await c.product.create({ data: { id: 'test-fit-l', sku: 'TEST-FIT-L', name: 'Test touring jacket L', basePrice: 10, parentId: 'test-fit', variantAttributes: { Size: 'L', Colour: 'Black' } } as never })
      await c.order.create({
        data: {
          id: 'test-fit-order', channel: 'EBAY', channelOrderId: 'TEST-FIT-ORDER', status: 'DELIVERED', currencyCode: 'EUR', totalPrice: '50.00',
          customerName: 'Test Buyer', customerEmail: 'buyer@example.test', shippingAddress: { city: 'Testville' }, fulfillmentMethod: 'MFN', purchaseDate: daysAgo(10),
          items: { create: [{ productId: 'test-fit-l', sku: 'TEST-FIT-L', quantity: 1, price: '50.00' }] },
        } as never,
      })

      // M (black): three Italian "runs small", one never read by the AI ("too small" decides), and ones that never count.
      for (let i = 0; i < 3; i += 1) await review('test-fit-m', 'Veste piccola, prendete una taglia in più')
      await review('test-fit-m', 'Way too small', { themes: null })
      await review('test-fit-m', 'The box was too small', { themes: ['SHIPPING'] })
      await review('test-fit-m', 'Runs small', { source: 'FIXTURE' })
      await review('test-fit-m', 'Runs small', { days: 40 })
      // M (red): an imported Amazon Germany review.
      await review('test-fit-m-red', 'Gute Jacke, aber fällt klein aus', { channel: 'AMAZON', market: 'DE', source: 'IMPORT_CSV' })
      // L: true to size; a review on the family placed on L by its order; one on the family with no order names no size.
      await review('test-fit-l', 'Fits true to size')
      await review('test-fit', 'Runs small', { orderId: 'test-fit-order' })
      await review('test-fit', 'Runs large')

      // Returns: two small on M (a code, and "does not fit" with the buyer's comment); unclear, other and rejected ones.
      await returned('test-fit-m', 'apparel too small')
      await returned('test-fit-m', 'does not fit', { notes: 'Too tight on the chest' })
      await returned('test-fit-l', 'does not fit')
      await returned('test-fit-l', 'defective')
      await returned('test-fit-m', 'size too small', { status: 'REJECTED' })
    })
  }, 120_000)

  afterAll(async () => {
    await database?.close()
  })

  it('Themes: a family per row, a column per size with a signal, M runs small from reviews and returns, L too few', async () => {
    const t = await inside(() => fitTable({ scope: ALL, from: FROM, now: NOW }))
    expect(t.sizes).toEqual(['M', 'L'])
    expect(t.families).toHaveLength(1)
    const f = t.families[0]
    expect(f).toMatchObject({ familyId: 'test-fit', name: 'Test touring jacket', signals: 9, reviews: 7, returns: 2, noSize: 1 })
    expect(f.cells[0]).toMatchObject({ size: 'M', verdict: 'small', small: 7, true: 0, large: 0, reviews: 5, returns: 2, share: 100 })
    expect(f.cells[1]).toMatchObject({ size: 'L', verdict: 'too_few', small: 1, true: 1, total: 2, shares: null })
    expect(f.advice).toBe('Runs small in M, the one size with enough mentions: suggest one size up.')
    expect(t.summary).toEqual({ reviews: 7, returns: 2, unclearReturns: 1, noSize: 1, minimum: 5 })
    expect(t.words).toMatch(/^From 7 reviews that say how the fit runs and 2 returns/)
  })

  it('the scope narrows reviews and returns: Amazon Germany has one review, too few', async () => {
    const t = await inside(() => fitTable({ scope: { channel: 'AMAZON', market: 'DE' }, from: FROM, now: NOW }))
    expect(t.families.map((f) => f.cells.map((c) => [c.size, c.verdict]))).toEqual([[['M', 'too_few']]])
    expect(t.summary).toMatchObject({ reviews: 1, returns: 0, unclearReturns: 0 })
  })

  it('the pop-up: every size the family sells, and each variant on its own', async () => {
    const p = await inside(() => productFit({ familyId: 'test-fit', familyIds: FAMILY, scope: ALL, from: FROM, now: NOW }))
    expect(p!.sizes.map((c) => [c.size, c.verdict, c.total])).toEqual([['S', 'too_few', 0], ['M', 'small', 7], ['L', 'too_few', 2]])
    expect(p!.variants.map((v) => [v.label, v.total])).toEqual([['Nero · S', 0], ['M · Black', 6], ['M · Red', 1], ['L · Black', 2]])
    expect(p).toMatchObject({ reviews: 7, returns: 2, unclearReturns: 1, noSize: 1 })
  })

  it('in the endpoints: Themes carries the table, the product pop-up its family’s fit (a variant opens its family)', async () => {
    const themes = await inside(() => insightsThemes({ now: NOW }))
    expect(themes.fit.families.map((f) => f.familyId)).toEqual(['test-fit'])
    const detail = await inside(() => insightsProductDetail('test-fit-m', { now: NOW }))
    expect(detail.fit).toMatchObject({ family: { id: 'test-fit' }, reviews: 7, returns: 2 })
    expect(detail.fit!.sizes.find((c) => c.size === 'M')).toMatchObject({ verdict: 'small' })
  })
})
