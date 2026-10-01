/**
 * CX review 2026-09-26 — "refuse, don't convert": the master-price cascade sent the master (EUR) NUMBER to every
 * following listing, so a GBP market received £19.90 for a €19.90 master. A listing whose market currency is not
 * the master currency (or is not configured) is not sent a master price: its price stays, its masterPrice snapshot
 * moves, nothing is queued, and the refusal is recorded (result, audit, a sync-health conflict) — the way the EU
 * shared-quantity guard records its refusals.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ createRows: vi.fn(), logConflict: vi.fn(), addJob: vi.fn() }))
vi.mock('../db.js', () => ({ default: {} }))
vi.mock('./outbound-rows.js', () => ({ createOutboundRows: (...a: unknown[]) => h.createRows(...a) }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, addJobSafely: (...a: unknown[]) => h.addJob(...a) }))
vi.mock('./sync-health.service.js', () => ({ syncHealthService: { logConflict: (...a: unknown[]) => h.logConflict(...a) } }))

const { MasterPriceService } = await import('./master-price.service.js')

type Listing = { id: string; channel: string; region: string; marketplace: string; externalListingId: string | null; price: number | null; masterPrice: number | null; pricingRule: string; priceAdjustmentPercent: number | null; followMasterPrice: boolean }
const listing = (id: string, channel: string, marketplace: string, extra: Partial<Listing> = {}): Listing =>
  ({ id, channel, region: marketplace, marketplace, externalListingId: null, price: 10, masterPrice: 10, pricingRule: 'FIXED', priceAdjustmentPercent: null, followMasterPrice: true, ...extra })
const MARKETS = [{ channel: 'EBAY', code: 'IT', currency: 'EUR' }, { channel: 'EBAY', code: 'UK', currency: 'GBP' }, { channel: 'AMAZON', code: 'DE', currency: 'EUR' }, { channel: 'AMAZON', code: 'SE', currency: '' }]

function fakeClient(listings: Listing[], productExtra: Record<string, unknown> = {}) {
  const listingUpdates: Array<{ id: string; data: Record<string, unknown> }> = []
  const audits: Array<Record<string, any>> = []
  const tx = {
    // The product row lock the cascade takes first (`lockProductStock`): nothing to lock in a stand-in.
    $queryRaw: vi.fn(async () => []),
    product: { findUnique: vi.fn(async () => ({ id: 'p1', basePrice: 10, sku: 'SKU-P1', ...productExtra })), update: vi.fn(async () => ({})) },
    channelListing: { findMany: vi.fn(async () => listings), update: vi.fn(async ({ where, data }: any) => { listingUpdates.push({ id: where.id, data }); return {} }) },
    marketplace: { findMany: vi.fn(async () => MARKETS) },
    outboundSyncQueue: { findMany: vi.fn(async ({ where }: any) => (where.channelListingId.in as string[]).map((id) => ({ id: `q-${id}` }))) },
    auditLog: { create: vi.fn(async ({ data }: any) => { audits.push(data); return { id: 'audit-1' } }) },
  }
  const client = { ...tx, $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) }
  return { client: client as any, tx: tx as any, listingUpdates, audits }
}
const queued = () => (h.createRows.mock.calls.flatMap((c) => (c[1] as { data: Array<{ channelListingId: string; payload: any }> }).data))

beforeEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); h.logConflict.mockResolvedValue({ id: 'log' }) })

describe('master price cascade — a different-currency market is refused, never sent the master number', () => {
  it('EUR market cascades and queues; GBP market keeps its price, gets only the snapshot, is not queued, and the refusal is recorded', async () => {
    const f = fakeClient([listing('L-IT', 'EBAY', 'IT'), listing('L-UK', 'EBAY', 'UK', { price: 17 })])
    const r = await new MasterPriceService(f.client).update('p1', 19.9)
    expect(r.cascadedListingIds).toEqual(['L-IT'])
    expect(queued().map((row) => row.channelListingId)).toEqual(['L-IT'])
    expect(queued()[0].payload).toMatchObject({ price: 19.9, marketplace: 'IT' })
    expect(f.listingUpdates.find((u) => u.id === 'L-UK')?.data).toEqual({ masterPrice: '19.90' })
    expect(r.snapshottedListingIds).toContain('L-UK')
    expect(r.currencyRefused).toEqual([{ listingId: 'L-UK', channel: 'EBAY', marketplace: 'UK', currency: 'GBP', masterCurrency: 'EUR' }])
    expect(f.audits[0].metadata).toMatchObject({ currencyRefusedListingIds: ['L-UK'] })
    expect(h.logConflict).toHaveBeenCalledTimes(1)
    expect(h.logConflict.mock.calls[0][0]).toMatchObject({ channel: 'EBAY', conflictType: 'MASTER_PRICE_CURRENCY_REFUSED', productId: 'p1',
      localData: { masterPrice: 19.9, masterCurrency: 'EUR' }, remoteData: { listingId: 'L-UK', marketplace: 'UK', marketCurrency: 'GBP' } })
    expect(h.logConflict.mock.calls[0][0].message).toMatch(/not sent/i)
    expect(h.logConflict.mock.calls[0][0].message).toMatch(/GBP/)
  })
  it('a market with no configured currency is refused too (unknown is not the master currency)', async () => {
    const f = fakeClient([listing('L-SE', 'AMAZON', 'SE'), listing('L-XX', 'AMAZON', 'XX')])
    const r = await new MasterPriceService(f.client).update('p1', 19.9)
    expect(r.cascadedListingIds).toEqual([])
    expect(r.currencyRefused.map((x) => [x.listingId, x.currency])).toEqual([['L-SE', null], ['L-XX', null]])
    expect(queued()).toEqual([])
  })
  it('PERCENT_OF_MASTER on a GBP market is refused like FIXED', async () => {
    const f = fakeClient([listing('L-UK', 'EBAY', 'UK', { pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 10 })])
    const r = await new MasterPriceService(f.client).update('p1', 20)
    expect(r.cascadedListingIds).toEqual([])
    expect(r.currencyRefused.map((x) => x.listingId)).toEqual(['L-UK'])
  })
  it('a GBP listing that does not follow the master is snapshot-only as before — nothing would be sent, so nothing is refused', async () => {
    const f = fakeClient([listing('L-UK', 'EBAY', 'UK', { followMasterPrice: false })])
    const r = await new MasterPriceService(f.client).update('p1', 20)
    expect(r.currencyRefused).toEqual([])
    expect(h.logConflict).not.toHaveBeenCalled()
  })
  it('inside the caller\'s transaction: refused in the result and the audit, no conflict written outside that transaction', async () => {
    const f = fakeClient([listing('L-UK', 'EBAY', 'UK')])
    const r = await new MasterPriceService(f.client).update('p1', 20, { tx: f.tx })
    expect(r.currencyRefused.map((x) => x.listingId)).toEqual(['L-UK'])
    expect(f.audits[0].metadata.currencyRefusedListingIds).toEqual(['L-UK'])
    expect(h.logConflict).not.toHaveBeenCalled()
  })
  it('the master currency is configuration (NEXUS_MASTER_CURRENCY): a GBP master cascades to GBP and refuses EUR', async () => {
    vi.stubEnv('NEXUS_MASTER_CURRENCY', 'GBP')
    const f = fakeClient([listing('L-IT', 'EBAY', 'IT'), listing('L-UK', 'EBAY', 'UK')])
    const r = await new MasterPriceService(f.client).update('p1', 20)
    expect(r.cascadedListingIds).toEqual(['L-UK'])
    expect(r.currencyRefused.map((x) => [x.listingId, x.currency, x.masterCurrency])).toEqual([['L-IT', 'EUR', 'GBP']])
  })
  it('a recording failure never undoes the edit', async () => {
    h.logConflict.mockRejectedValue(new Error('db down'))
    const f = fakeClient([listing('L-UK', 'EBAY', 'UK')])
    await expect(new MasterPriceService(f.client).update('p1', 20)).resolves.toMatchObject({ changed: true })
  })
})

describe('master price cascade — a follower price outside the product\'s floor or ceiling is not stored or sent (2026-10-01)', () => {
  it('🔴 as the price door refuses it at the edit: the listing keeps its price, gets only the snapshot, is not queued, and the refusal is recorded', async () => {
    // Master 10 → 19.90; ceiling 21: FIXED follows at 19.90 (sent), PERCENT +10 would be 21.89 (refused).
    const f = fakeClient([listing('L-FIX', 'EBAY', 'IT'), listing('L-PCT', 'AMAZON', 'DE', { pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 10, price: 11 })], { maxPrice: 21 })
    const r = await new MasterPriceService(f.client).update('p1', 19.9)
    expect(r.cascadedListingIds).toEqual(['L-FIX'])
    expect(queued().map((row) => row.channelListingId)).toEqual(['L-FIX'])
    expect(f.listingUpdates.find((u) => u.id === 'L-PCT')?.data).toEqual({ masterPrice: '19.90' })
    expect(r.boundsRefused).toEqual([{ listingId: 'L-PCT', channel: 'AMAZON', marketplace: 'DE', price: 21.89, reason: '21.89 is above its pricing ceiling of 21.00' }])
    expect(f.audits[0].metadata).toMatchObject({ boundsRefusedListingIds: ['L-PCT'] })
    const logged = h.logConflict.mock.calls.map((c) => c[0]).filter((c) => c.conflictType === 'MASTER_PRICE_BOUNDS_REFUSED')
    expect(logged).toHaveLength(1)
    expect(logged[0].message).toContain('the listing would follow it at 21.89, but 21.89 is above its pricing ceiling of 21.00')
  })

  it('a GBP market is refused for its currency only, never compared with the EUR bounds', async () => {
    // The master 19.90 is inside its own ceiling of 21 (a master outside it is refused whole); PERCENT +10 would be
    // 21.89, above that EUR ceiling — but a GBP price is never compared with EUR bounds: refused for its currency only.
    const f = fakeClient([listing('L-UK', 'EBAY', 'UK', { price: 17, pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 10 })], { maxPrice: 21 })
    const r = await new MasterPriceService(f.client).update('p1', 19.9)
    expect(r.boundsRefused).toEqual([])
    expect(r.currencyRefused.map((x) => x.listingId)).toEqual(['L-UK'])
  })
})
