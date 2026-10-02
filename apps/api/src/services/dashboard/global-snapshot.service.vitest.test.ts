/**
 * MCP full control P3 — the dashboard's Global Snapshot and market-health reads moved from dashboard.routes.ts into
 * global-snapshot.service.ts. GET /api/dashboard/global-snapshot (every period, a marketplace filter, the EUR-equivalent
 * basis) and GET /api/dashboard/market-health answer byte for byte what they answered before (goldens recorded on the
 * route as it was), with business profiles off and on.
 *
 * The clock is frozen at 2026-09-15T10:00Z, which is 12:00 in Rome (summer time): "today" starts at 2026-09-14T22:00Z.
 */
import { afterAll, beforeAll, describe, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, bulkJobQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))

import { expectGolden, freezeGoldenClock, goldenApp, GOLDEN_NOW, inGoldenBusiness } from '../../test-support/route-golden.js'
import dashboardRoutes from '../../routes/dashboard.routes.js'

const GOLDEN = './__golden__'
const HOUR = 3_600_000
const hoursAgo = (hours: number) => new Date(GOLDEN_NOW.getTime() - hours * HOUR)

let app: FastifyInstance
beforeAll(async () => {
  freezeGoldenClock()
  const db = state.db.client
  await inGoldenBusiness(async () => {
    // Amazon EU markets for market health: active (an order in the last hour), quiet (in the last day), silent
    // (older), never (no order), one switched off; an eBay market and one without a marketplace id stay out.
    const markets: Array<[string, string, string, boolean, string | null]> = [
      ['golden-mkt-de', 'DE', 'EUR', true, 'TEST-MKT-DE'],
      ['golden-mkt-it', 'IT', 'EUR', true, 'TEST-MKT-IT'],
      ['golden-mkt-uk', 'UK', 'GBP', true, 'TEST-MKT-UK'],
      ['golden-mkt-pl', 'PL', 'PLN', true, 'TEST-MKT-PL'],
      ['golden-mkt-es', 'ES', 'EUR', true, 'TEST-MKT-ES'],
      ['golden-mkt-se', 'SE', 'SEK', false, 'TEST-MKT-SE'],
      ['golden-mkt-nl', 'NL', 'EUR', true, null],
    ]
    for (const [id, code, currency, isActive, marketplaceId] of markets) {
      await db.marketplace.create({ data: { id, channel: 'AMAZON', code, name: `Amazon ${code}`, region: 'EU', currency, language: 'en', marketplaceId, isActive, isParticipating: code !== 'ES' } })
    }
    await db.marketplace.create({ data: { id: 'golden-mkt-ebay-it', channel: 'EBAY', code: 'IT', name: 'eBay IT', region: 'EU', currency: 'EUR', language: 'it', marketplaceId: 'TEST-EBAY-IT' } })

    await db.product.create({ data: { id: 'golden-product-1', sku: 'TEST-SKU-1', name: 'Golden one', basePrice: '25.00', totalStock: 5 } })
    await db.product.create({ data: { id: 'golden-product-2', sku: 'TEST-SKU-2', name: 'Golden two', basePrice: '19.90', totalStock: 2 } })
    await db.product.create({ data: { id: 'golden-product-3', sku: 'TEST-SKU-3', name: 'Golden three', basePrice: '12.00', totalStock: 1 } })
    // Estimates for €0 orders: a listing price per market (sale price first), else the product's base price.
    await db.channelListing.create({ data: { id: 'golden-listing-1', productId: 'golden-product-1', channelMarket: 'AMAZON_IT', channel: 'AMAZON', region: 'IT', marketplace: 'IT', price: '30.00', salePrice: '27.50', quantity: 5 } })
    await db.channelListing.create({ data: { id: 'golden-listing-2', productId: 'golden-product-2', channelMarket: 'AMAZON_FR', channel: 'AMAZON', region: 'FR', marketplace: 'FR', price: '24.00', quantity: 2 } })

    await db.fxRate.create({ data: { id: 'golden-fx-gbp', fromCurrency: 'EUR', toCurrency: 'GBP', rate: '0.85', asOf: new Date('2026-09-14T00:00:00.000Z'), source: 'manual' } })

    let n = 0
    const order = (data: {
      channel?: string; marketplace: string | null; currency: string; total: string; at: Date; status?: string
      fulfillment?: string | null; items: Array<[string | null, string, number, string]>; deleted?: boolean
    }) => {
      n += 1
      return db.order.create({
        data: {
          id: `golden-order-${n}`,
          channel: data.channel ?? 'AMAZON',
          channelOrderId: `TEST-ORDER-${n}`,
          marketplace: data.marketplace,
          currencyCode: data.currency,
          totalPrice: data.total,
          status: data.status ?? 'SHIPPED',
          fulfillmentMethod: data.fulfillment === undefined ? 'FBM' : data.fulfillment,
          customerName: `Golden Buyer ${n}`,
          customerEmail: `buyer-${n}@example.test`,
          shippingAddress: { city: 'Testville' },
          purchaseDate: data.at,
          ...(data.deleted ? { deletedAt: hoursAgo(1) } : {}),
          items: { create: data.items.map(([productId, sku, quantity, price]) => ({ productId, sku, quantity, price })) },
        },
      })
    }
    // Today (Rome): IT shipped, DE unshipped in the last hour, SE (no stored rate) pending FBA, FR €0 pending.
    await order({ marketplace: 'IT', currency: 'EUR', total: '50.00', at: hoursAgo(2), items: [['golden-product-1', 'TEST-SKU-1', 2, '25.00']] })
    await order({ marketplace: 'DE', currency: 'EUR', total: '30.00', at: hoursAgo(0.5), status: 'PROCESSING', items: [['golden-product-3', 'TEST-SKU-3', 1, '30.00']] })
    await order({ marketplace: 'SE', currency: 'SEK', total: '300.00', at: hoursAgo(3), status: 'PENDING', fulfillment: 'FBA', items: [['golden-product-3', 'TEST-SKU-3', 1, '300.00']] })
    await order({ marketplace: 'FR', currency: 'EUR', total: '0.00', at: hoursAgo(4), status: 'PENDING', items: [['golden-product-2', 'TEST-SKU-2', 1, '0.00']] })
    await order({ marketplace: 'DE', currency: 'EUR', total: '18.00', at: hoursAgo(5), status: 'AWAITING_PAYMENT', items: [['golden-product-3', 'TEST-SKU-3', 1, '18.00'], [null, 'TEST-SKU-GONE', 1, '0.00']] })
    await order({ marketplace: 'IT', currency: 'EUR', total: '99.00', at: hoursAgo(1.5), deleted: true, items: [['golden-product-1', 'TEST-SKU-1', 1, '99.00']] })
    // Yesterday (Rome): UK in GBP, an IT €0 cancellation (no estimate), an IT on-hold order.
    await order({ marketplace: 'UK', currency: 'GBP', total: '40.00', at: hoursAgo(22), items: [['golden-product-1', 'TEST-SKU-1', 1, '40.00']] })
    await order({ marketplace: 'IT', currency: 'EUR', total: '0.00', at: hoursAgo(26), status: 'CANCELLED', items: [['golden-product-1', 'TEST-SKU-1', 1, '0.00']] })
    await order({ marketplace: 'IT', currency: 'EUR', total: '12.00', at: hoursAgo(28), status: 'ON_HOLD', fulfillment: 'FBM', items: [['golden-product-3', 'TEST-SKU-3', 1, '12.00']] })
    // Earlier: an IT €0 shipped order three days ago (folded into the sparkline as an estimate), the same day last
    // week (the "vs same day last week" base), PL four days ago (silent market), eBay ten days ago, IT 45 days ago.
    await order({ marketplace: 'IT', currency: 'EUR', total: '0.00', at: hoursAgo(72), items: [['golden-product-1', 'TEST-SKU-1', 1, '0.00']] })
    await order({ marketplace: 'IT', currency: 'EUR', total: '20.00', at: hoursAgo(7 * 24 + 1), items: [['golden-product-1', 'TEST-SKU-1', 1, '20.00']] })
    await order({ marketplace: 'PL', currency: 'PLN', total: '80.00', at: hoursAgo(96), items: [['golden-product-2', 'TEST-SKU-2', 2, '40.00']] })
    await order({ channel: 'EBAY', marketplace: 'IT', currency: 'EUR', total: '15.00', at: hoursAgo(240), fulfillment: null, items: [['golden-product-2', 'TEST-SKU-2', 1, '15.00']] })
    await order({ marketplace: 'IT', currency: 'EUR', total: '33.00', at: hoursAgo(45 * 24), items: [['golden-product-3', 'TEST-SKU-3', 3, '11.00']] })
    await order({ marketplace: null, currency: 'EUR', total: '7.00', at: hoursAgo(6), status: 'PROCESSING', items: [['golden-product-3', 'TEST-SKU-3', 1, '7.00']] })
  })
  app = await goldenApp([{ plugin: dashboardRoutes, prefix: '/api' }])
}, 60_000)

afterAll(async () => {
  await app?.close()
  vi.useRealTimers()
})

describe('P3 — dashboard snapshot and market health: the routes answer exactly as before', () => {
  it('GET /api/dashboard/global-snapshot for every period', async () => {
    await expectGolden(app, 'global-snapshot-today', '/api/dashboard/global-snapshot', GOLDEN)
    await expectGolden(app, 'global-snapshot-yesterday', '/api/dashboard/global-snapshot?period=yesterday', GOLDEN)
    await expectGolden(app, 'global-snapshot-7d', '/api/dashboard/global-snapshot?period=7d', GOLDEN)
    await expectGolden(app, 'global-snapshot-30d', '/api/dashboard/global-snapshot?period=30d', GOLDEN)
    await expectGolden(app, 'global-snapshot-90d-eur-equiv', '/api/dashboard/global-snapshot?period=90d&baseCurrency=EUR_EQUIV', GOLDEN)
  })

  it('GET /api/dashboard/global-snapshot with a marketplace and the EUR-equivalent basis', async () => {
    await expectGolden(app, 'global-snapshot-7d-it', '/api/dashboard/global-snapshot?period=7d&marketplace=%20it%20', GOLDEN)
    await expectGolden(app, 'global-snapshot-today-eur-equiv', '/api/dashboard/global-snapshot?baseCurrency=eur_equiv', GOLDEN)
    await expectGolden(app, 'global-snapshot-yesterday-uk-eur-equiv', '/api/dashboard/global-snapshot?period=yesterday&marketplace=UK&baseCurrency=EUR_EQUIV', GOLDEN)
  })

  it('GET /api/dashboard/market-health', async () => {
    await expectGolden(app, 'market-health', '/api/dashboard/market-health', GOLDEN)
  })
})
