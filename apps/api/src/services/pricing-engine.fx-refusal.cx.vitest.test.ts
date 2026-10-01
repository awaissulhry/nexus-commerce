/**
 * CX review 2026-09-26 — a missing FX rate is a refusal, never 1:1.
 *
 * `resolvePrice` priced a GBP market at the EUR number (fxRate 1, one warning in the snapshot) whenever no EUR→GBP
 * rate was stored: `getFxRate` answers 1 for "no rate at all". It now refuses (FxRateMissingError,
 * code fx_rate_missing). Its batch callers refuse THAT cell and carry on: the snapshot refresh skips it (and drops
 * the cell's old snapshot, which was computed the same 1:1 way, so nothing can push it), the promotion scheduler
 * skips that listing. A stored rate — or the same currency — prices exactly as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./connection-resolver.service.js', () => ({ primaryConnectionIds: vi.fn(async () => new Map()) }))
vi.mock('./price-history.service.js', () => ({ recordPriceChange: vi.fn(async () => undefined) }))
// The promotion's sale goes through the price door (2026-10-01); this file pins only which listings get one.
const door = vi.hoisted(() => ({ writeChannelPrices: vi.fn(async ({ targets }: any) => ({ results: targets.map((t: any) => ({ listingId: t.listingId, outcome: 'applied' })) })) }))
vi.mock('./pim/channel-price-write.service.js', () => door)

const { resolvePrice } = await import('./pricing-engine.service.js')
const { refreshSnapshotsForSkus } = await import('./pricing-snapshot.service.js')
const { runPromotionScheduler } = await import('./promotion-scheduler.service.js')

const CURRENCY: Record<string, string> = { IT: 'EUR', DE: 'EUR', UK: 'GBP', SE: 'SEK' }
function fakePrisma(opts: { rates?: Record<string, number> } = {}) {
  const snapshots = new Map<string, Record<string, unknown>>()
  const key = (w: any) => `${w.sku}|${w.channel}|${w.marketplace}|${w.fulfillmentMethod ?? ''}`
  const client = {
    // A market with no Marketplace row answers null (as Prisma does).
    marketplace: {
      findUnique: vi.fn(async ({ where }: any) => (CURRENCY[where.channel_code.code] === undefined ? null : { currency: CURRENCY[where.channel_code.code], vatRate: null, taxInclusive: false })),
      // The promotion scheduler reads every market's currency once per tick (the rows behind `listingMarketCurrency`).
      findMany: vi.fn(async () => Object.entries(CURRENCY).map(([code, currency]) => ({ channel: 'AMAZON', code, currency }))),
    },
    productVariation: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    product: {
      findFirst: vi.fn(async ({ where }: any) => ({ id: `p-${where.sku}`, basePrice: 10, costPrice: null, minPrice: null, maxPrice: null })),
      findMany: vi.fn(async ({ where }: any) => (where.sku?.in ?? []).map((sku: string) => ({ sku, id: `p-${sku}` }))),
    },
    channelListing: {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async ({ where, select }: any) => {
        const rows = [{ id: 'L-A', productId: 'p-A', channel: 'AMAZON', marketplace: 'UK' }, { id: 'L-B', productId: 'p-B', channel: 'AMAZON', marketplace: 'IT' }]
          .filter((r) => !where?.productId?.in || where.productId.in.includes(r.productId))
        return select?.id ? rows : rows.map(({ productId, channel, marketplace }) => ({ productId, channel, marketplace }))
      }),
      update: vi.fn(async () => ({})),
    },
    offer: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) },
    // The promotion's own audit rows (a listing it already put on sale is left alone): none here.
    channelListingOverride: { findFirst: vi.fn(async () => null) },
    fxRate: { findFirst: vi.fn(async ({ where }: any) => (opts.rates?.[where.toCurrency] != null ? { rate: opts.rates[where.toCurrency] } : null)) },
    stockCostLayer: { findFirst: vi.fn(async () => null) },
    pricingRuleVariation: { findMany: vi.fn(async () => []) },
    pricingSnapshot: {
      findFirst: vi.fn(async ({ where }: any) => (snapshots.has(key(where)) ? { id: key(where) } : null)),
      create: vi.fn(async ({ data }: any) => { snapshots.set(key(data), data); return {} }),
      update: vi.fn(async ({ where, data }: any) => { snapshots.set(where.id, { ...snapshots.get(where.id), ...data }); return {} }),
      deleteMany: vi.fn(async ({ where }: any) => { const k = key(where); const had = snapshots.delete(k); return { count: had ? 1 : 0 } }),
    },
    retailEventPriceAction: { findMany: vi.fn(async () => []) },
  }
  return { client: client as any, snapshots }
}

beforeEach(() => vi.clearAllMocks())

describe('resolvePrice — no stored FX rate is a refusal, not 1:1', () => {
  it('GBP market, no EUR→GBP rate at all → refused with fx_rate_missing (it used to price £10 for €10)', async () => {
    const { client } = fakePrisma()
    await expect(resolvePrice(client, { sku: 'A', channel: 'AMAZON', marketplace: 'UK' })).rejects.toMatchObject({ code: 'fx_rate_missing', statusCode: 400 })
    await expect(resolvePrice(client, { sku: 'A', channel: 'AMAZON', marketplace: 'UK' })).rejects.toThrow(/EUR→GBP/)
  })
  it('a stored rate prices exactly as before (positive control)', async () => {
    const { client } = fakePrisma({ rates: { GBP: 0.85 } })
    const r = await resolvePrice(client, { sku: 'A', channel: 'AMAZON', marketplace: 'UK' })
    expect(r).toMatchObject({ price: 8.5, currency: 'GBP', source: 'MASTER_INHERIT' })
    expect(r.breakdown.fxRate).toBe(0.85)
    expect(r.warnings.join(' ')).not.toMatch(/1:1/)
  })
  it('the master currency needs no rate', async () => {
    const { client } = fakePrisma()
    const r = await resolvePrice(client, { sku: 'A', channel: 'AMAZON', marketplace: 'IT' })
    expect(r).toMatchObject({ price: 10, currency: 'EUR' })
    expect(client.fxRate.findFirst).not.toHaveBeenCalled()
  })
})

describe('resolvePrice — a market with no Marketplace row is a refusal, not EUR (main-session ruling 2026-09-26)', () => {
  it('no Marketplace row → refused with market_currency_unconfigured (it used to price in EUR)', async () => {
    const { client } = fakePrisma()
    await expect(resolvePrice(client, { sku: 'A', channel: 'AMAZON', marketplace: 'XX' })).rejects.toMatchObject({ code: 'market_currency_unconfigured', statusCode: 400 })
    await expect(resolvePrice(client, { sku: 'A', channel: 'AMAZON', marketplace: 'XX' })).rejects.toThrow(/No currency is configured for AMAZON\/XX/)
  })
  it('a Marketplace row with a blank currency is refused the same way', async () => {
    const { client } = fakePrisma()
    client.marketplace.findUnique.mockResolvedValueOnce({ currency: '', vatRate: null, taxInclusive: false })
    await expect(resolvePrice(client, { sku: 'A', channel: 'AMAZON', marketplace: 'IT' })).rejects.toMatchObject({ code: 'market_currency_unconfigured' })
  })
  it('the snapshot refresh refuses that cell (dropping its old EUR-priced snapshot) and carries on', async () => {
    const { client, snapshots } = fakePrisma({ rates: { GBP: 0.85 } })
    client.channelListing.findMany.mockImplementation(async ({ where, select }: any) => {
      const rows = [{ id: 'L-A', productId: 'p-A', channel: 'AMAZON', marketplace: 'XX' }, { id: 'L-B', productId: 'p-B', channel: 'AMAZON', marketplace: 'IT' }]
        .filter((r) => !where?.productId?.in || where.productId.in.includes(r.productId))
      return select?.id ? rows : rows.map(({ productId, channel, marketplace }) => ({ productId, channel, marketplace }))
    })
    snapshots.set('A|AMAZON|XX|', { computedPrice: '10.00', currency: 'EUR' })
    await expect(refreshSnapshotsForSkus(client, ['A', 'B'])).resolves.toMatchObject({ rowsRefreshed: 1, refused: 1 })
    expect([...snapshots.keys()]).toEqual(['B|AMAZON|IT|'])
  })
})

describe('callers refuse the one cell and carry on', () => {
  it('snapshot refresh: the EUR cell is written; the GBP cell is not, and its old 1:1 snapshot is dropped', async () => {
    const { client, snapshots } = fakePrisma()
    snapshots.set('A|AMAZON|UK|', { computedPrice: '10.00', currency: 'GBP' }) // materialized earlier at 1:1
    // The run must RESOLVE: one refused cell never aborts the batch.
    await expect(refreshSnapshotsForSkus(client, ['A', 'B'])).resolves.toMatchObject({ rowsRefreshed: 1, refused: 1 })
    expect([...snapshots.keys()]).toEqual(['B|AMAZON|IT|'])
  })
  it('promotion scheduler: a PERCENT_OFF listing in a market with no rate is skipped; the run goes on', async () => {
    const { client } = fakePrisma()
    door.writeChannelPrices.mockClear()
    const event = { name: 'Sale', startDate: new Date('2026-10-01T00:00:00Z'), endDate: new Date('2026-10-03T00:00:00Z') }
    client.retailEventPriceAction.findMany.mockResolvedValueOnce([{ eventId: 'ev', action: 'PERCENT_OFF', value: 10, channel: 'AMAZON', event }]).mockResolvedValueOnce([])
    client.channelListing.findMany.mockResolvedValueOnce([
      { id: 'L-A', productId: 'p-A', channel: 'AMAZON', marketplace: 'UK', price: 10, priceOverride: null, salePrice: null, product: { sku: 'A', variations: [] } },
      { id: 'L-B', productId: 'p-B', channel: 'AMAZON', marketplace: 'IT', price: 10, priceOverride: null, salePrice: null, product: { sku: 'B', variations: [] } },
    ])
    await expect(runPromotionScheduler(client)).resolves.toMatchObject({ listingsUpdated: 1 })
    expect(door.writeChannelPrices.mock.calls.map((c: any) => [c[0].targets[0].listingId, c[0].targets[0].sale])).toEqual([['L-B', { value: 9, start: '2026-10-01', end: '2026-10-03' }]])
  })
})
