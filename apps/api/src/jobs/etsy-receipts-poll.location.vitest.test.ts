/**
 * CX Etsy E5 — a poll run resolves the business's warehouse ONCE and hands it to every receipt it writes.
 *
 * The writer used to look it up per receipt, outside its transaction: one extra statement transaction for
 * every receipt of a page (an N+1 on the poller's path; a 230-receipt reconciliation paid 230 lookups of
 * the same row). The webhook path writes one receipt and still resolves it in the writer.
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

it('resolves the warehouse once per run and passes it to every receipt', async () => {
  const outcome = await pollEtsyConnection('conn-1')
  expect(outcome.counts.written).toBe(3)
  expect(h.resolve).toHaveBeenCalledTimes(1)
  expect(h.resolve).toHaveBeenCalledWith('IT-MAIN')
  expect(h.ingest.mock.calls.map(([args]) => args.locationId)).toEqual(['loc-main', 'loc-main', 'loc-main'])
})

it('a business with no warehouse passes that null answer on, not "resolve it again"', async () => {
  h.resolve.mockResolvedValue(null)
  await pollEtsyConnection('conn-1')
  expect(h.resolve).toHaveBeenCalledTimes(1)
  expect(h.ingest.mock.calls.map(([args]) => args.locationId)).toEqual([null, null, null])
})
