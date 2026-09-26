/**
 * CX Etsy E5/E6 — the pure pieces: when an account's orders count as current, a receipt's own
 * identifiers read defensively, and the exact page request the poller makes.
 */
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ paths: [] as string[] }))
vi.mock('./read-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./read-client.js')>()),
  etsyReader: vi.fn(async () => ({ shopId: '10000001', get: async (path: string) => { h.paths.push(path); return { count: 1, results: [{ receipt_id: 1 }] } } })),
}))

const { etsyReceiptFreshness, receiptIdentity } = await import('./receipt-ingest.js')
const { pullEtsyReceiptsPage } = await import('./receipts.service.js')

const T = new Date('2026-09-24T12:00:00.000Z')
const mins = (n: number) => new Date(T.getTime() - n * 60_000)
const TEN = 10 * 60_000

describe('E6 — only a successful poll proves the orders are current', () => {
  it.each([
    ['not activated', null, 'not_activated'],
    ['never polled successfully', { activatedAt: mins(60), lastPollSucceededAt: null, backlog: false }, 'never'],
    ['polled 5 min ago', { activatedAt: mins(60), lastPollSucceededAt: mins(5), backlog: false }, 'fresh'],
    ['polled exactly two periods ago', { activatedAt: mins(60), lastPollSucceededAt: mins(20), backlog: false }, 'fresh'],
    ['polled 21 min ago (over two 10-min periods)', { activatedAt: mins(60), lastPollSucceededAt: mins(21), backlog: false }, 'stale'],
    ['a recent poll that left a backlog', { activatedAt: mins(60), lastPollSucceededAt: mins(1), backlog: true }, 'stale'],
    ['a success time in the future', { activatedAt: mins(60), lastPollSucceededAt: new Date(T.getTime() + 60_000), backlog: false }, 'stale'],
  ] as const)('%s → %s', (_name, state, status) => {
    expect(etsyReceiptFreshness(state as never, T, TEN).status).toBe(status)
  })

  it('names every reason', () => {
    expect(etsyReceiptFreshness({ activatedAt: mins(60), lastPollSucceededAt: mins(30), backlog: true }, T, TEN).reasons).toEqual([
      'the last successful poll is older than 20 minutes', 'the last poll stopped with receipts still waiting',
    ])
  })
})

describe('a receipt\'s identifiers, read defensively', () => {
  it.each([
    [{ receipt_id: 12, updated_timestamp: 1_758_000_000 }, { receiptId: '12', updatedAt: 1_758_000_000 }],
    [{ receipt_id: 12, update_timestamp: 1_758_000_001 }, { receiptId: '12', updatedAt: 1_758_000_001 }],
    [{ receipt_id: '12', updated_timestamp: 'x' }, { receiptId: 'unknown', updatedAt: null }],
    [null, { receiptId: 'unknown', updatedAt: null }],
  ])('%j', (raw, expected) => { expect(receiptIdentity(raw)).toEqual(expected) })
})

describe('E5 — the page the poller asks for', () => {
  it('asks newest change first inside the bounded recent window', async () => {
    h.paths.length = 0
    expect(await pullEtsyReceiptsPage('acct', { minCreated: 1_758_000_000, minLastModified: 1_758_000_000, offset: 200 })).toEqual({ shopId: '10000001', count: 1, results: [{ receipt_id: 1 }] })
    expect(h.paths).toEqual(['/shops/10000001/receipts?limit=100&offset=200&min_created=1758000000&min_last_modified=1758000000&sort_on=updated&sort_order=desc'])
  })
  it('reconciles a fixed creation window in explicit receipt-ID order', async () => {
    h.paths.length = 0
    await pullEtsyReceiptsPage('acct', { minCreated: 1_758_000_000, maxCreated: 1_758_086_400, offset: 100 })
    expect(h.paths).toEqual(['/shops/10000001/receipts?limit=100&offset=100&min_created=1758000000&max_created=1758086400&sort_on=receipt_id&sort_order=asc'])
  })
  it.each([
    [{ minCreated: 1_758_000_000, minLastModified: 1_000, offset: 0 }, /min_last_modified/],
    [{ minCreated: 1_758_000_000, minLastModified: 1_758_000_000, offset: 12_100 }, /offset/],
    [{ minCreated: 1_758_000_000, minLastModified: 1_758_000_000, offset: -1 }, /offset/],
    [{ minCreated: 1_758_000_000, minLastModified: 1_758_000_000, offset: 0, limit: 101 }, /limit/],
  ])('refuses %j before asking Etsy', async (page, message) => {
    h.paths.length = 0
    await expect(pullEtsyReceiptsPage('acct', page)).rejects.toThrow(message)
    expect(h.paths).toEqual([])
  })
})
