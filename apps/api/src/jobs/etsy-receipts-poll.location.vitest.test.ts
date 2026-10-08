/**
 * Step 2 "Sells from" — a poll run no longer chooses a warehouse for its receipts.
 *
 * Before Step 2 the run looked up IT-MAIN once and handed it to every receipt (CX Etsy E5: one lookup per run instead
 * of one statement transaction per receipt). A sale now takes its stock from the first location of the shop's
 * "Sells from" list that has enough for the product's units, so the location is a per-PRODUCT answer: the writer
 * picks it inside each receipt's transaction, after its order-stock lock (and looks up the IT-MAIN / default fallback
 * there, in the same transaction — still no extra transaction per receipt). The poller passes nothing.
 */
import { beforeEach, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ resolve: vi.fn(), ingest: vi.fn(), pages: [] as unknown[][] }))

vi.mock('../db.js', () => ({
  default: {
    $queryRaw: vi.fn(async () => [{ activatedAt: new Date(1_000_000_000), scanCreatedThrough: null, scanExpectedCount: null, scanOffset: 0, lastPollCounts: null, now: new Date(1_000_000_000) }]),
    $executeRaw: vi.fn(async () => 1),
  },
}))
vi.mock('../lib/cron/clustered.js', () => ({ default: { validate: () => true, schedule: () => ({ stop() {} }) } }))
// Any warehouse lookup by the poller would land here.
vi.mock('../services/stock-level.service.js', () => ({ resolveLocationByCode: h.resolve }))
vi.mock('../services/etsy/receipts.service.js', () => ({
  ETSY_MAX_OFFSET: 12_000, ETSY_RECEIPTS_PAGE: 100,
  pullEtsyReceiptsPage: vi.fn(async () => { const results = h.pages.shift() ?? []; return { shopId: 'shop', count: results.length, results } }),
}))
vi.mock('../services/etsy/receipt-ingest.js', () => ({
  etsyIngestBinding: async () => ({ shopId: 'shop', sellerUserId: 'seller' }),
  etsyOrderIngestEnabled: () => true,
  etsyReceiptFreshness: () => ({ status: 'fresh', reasons: [] }),
  ingestEtsyReceipt: h.ingest,
  receiptIdentity: (raw: { receipt_id: number }) => ({ receiptId: String(raw.receipt_id), updatedAt: 1 }),
}))

const { pollEtsyConnection } = await import('./etsy-receipts-poll.job.js')

beforeEach(() => {
  vi.clearAllMocks()
  h.resolve.mockResolvedValue('loc-main')
  h.ingest.mockResolvedValue({ kind: 'written', created: true })
  // A recent page of three receipts; the creation window (from T0) is empty.
  h.pages = [[{ receipt_id: 1 }, { receipt_id: 2 }, { receipt_id: 3 }], []]
})

it('looks up no warehouse for the run and hands none to the receipts: the writer picks per product', async () => {
  const outcome = await pollEtsyConnection('conn-1')
  expect(outcome.counts.written).toBe(3)
  expect(h.resolve).not.toHaveBeenCalled()
  expect(h.ingest).toHaveBeenCalledTimes(3)
  for (const [args] of h.ingest.mock.calls) {
    expect(args).toMatchObject({ connectionId: 'conn-1', source: 'poll' })
    // Not even `locationId: undefined` with the key present: the writer's "omitted" branch is what runs.
    expect('locationId' in args).toBe(false)
  }
})

it('a business with no warehouse is the writer\'s to report (per product, no_stock_location), not the poller\'s', async () => {
  h.resolve.mockResolvedValue(null)
  h.ingest.mockResolvedValue({ kind: 'written', created: true, stock: { '1': 'no_stock_location' } })
  const outcome = await pollEtsyConnection('conn-1')
  expect(outcome.error).toBeNull()
  expect(outcome.counts.written).toBe(3)
  expect(h.resolve).not.toHaveBeenCalled()
})
