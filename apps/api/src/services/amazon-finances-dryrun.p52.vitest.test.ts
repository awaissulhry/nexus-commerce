/** P5.2 identity-only dry run. Official-contract regressions exposed wrong IDs and
 * unsafe write expectations in the original fixtures. The new writer is held until
 * legacy reconciliation and concurrency-safe money mapping are proved. These cases
 * retain the read-path controls and explicitly require refusal before live writes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  orderFind: vi.fn(),
  txFindFirst: vi.fn(),
  txCreate: vi.fn(),
  sellerFetch: vi.fn(),
  amazonAccount: vi.fn(),
}))

vi.mock('../db.js', () => ({
  default: {
    order: { findFirst: m.orderFind },
    // CX A2: the dry run now also READS v0's rows for cents parity (findMany); no assertion changed.
    financialTransaction: { findFirst: m.txFindFirst, findMany: vi.fn(async () => []), create: m.txCreate },
  },
}))
vi.mock('./gateway/amazon-sdk.js', () => ({ amazonSellerFetch: m.sellerFetch }))
vi.mock('../lib/amazon-sp-client.js', () => ({
  getAmazonAccessToken: vi.fn(async () => 'tok'),
  amazonAccount: m.amazonAccount,
}))

const { syncFinancialTransactions, financialsDryRunRefusal } = await import('./amazon-financial-events.service.js')

const ORDER_ID = '404-1234567-1234567'
const ORDER_ROW = { id: 'order-1', currencyCode: 'EUR' }

/** One Amazon Transaction in the 2024-06-19 shape, with the provider transaction id. */
const TX = {
  transactionType: 'Shipment',
  postedDate: '2026-09-20T10:00:00Z',
  transactionId: 'tx-provider-9',
  totalAmount: { currencyAmount: 31.98, currencyCode: 'EUR' },
  relatedIdentifiers: [{ relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: ORDER_ID }],
  breakdowns: [{ breakdownType: 'Principal', breakdownAmount: { currencyAmount: 31.98, currencyCode: 'EUR' } }],
}

/** The provider transaction identity, never an invented order/date key. */
const NEW_SHAPE = 'tx-provider-9'

function page(transactions: unknown[]) {
  m.sellerFetch.mockResolvedValue({ ok: true, json: async () => ({ transactions }), text: async () => '' })
}

const WINDOW: [Date, Date] = [new Date('2026-09-20T00:00:00Z'), new Date('2026-09-20T23:00:00Z')]
const run = (opts?: { dryRun?: boolean }) => syncFinancialTransactions(WINDOW[0], WINDOW[1], 'APJ6JRA9NG5V4', opts)

beforeEach(() => {
  vi.clearAllMocks()
  m.amazonAccount.mockResolvedValue({ id: 'acct-1' })
  m.orderFind.mockResolvedValue(ORDER_ROW)
  m.txFindFirst.mockResolvedValue(null)
  m.txCreate.mockResolvedValue({ id: 'ft-1' })
  page([TX])
})

describe('1. the dry run writes nothing — and the control proves that is not "nothing happened"', () => {
  it('🔴 creates no row, and counts the one it would have created', async () => {
    const s = await run({ dryRun: true })
    expect(m.txCreate).not.toHaveBeenCalled()
    expect(s.txWouldCreate).toBe(1)
    expect(s.dryRun).toBe(true)
  })

  it('the same candidate is held before a real money write or channel call', async () => {
    // Without this, "txCreate was not called" is equally explained by a fixture that
    // never reaches the write at all.
    await expect(run()).rejects.toThrow(/cutover is held/)
    expect(m.txCreate).not.toHaveBeenCalled()
    expect(m.sellerFetch).not.toHaveBeenCalled()
  })

  it('🔴 txCreated is ZERO on a dry run, because zero rows were created', async () => {
    // Every existing reader of txCreated sums writes. A dry run reporting 1 there would
    // be a claim that does not match its measurement.
    const s = await run({ dryRun: true })
    expect(s.txCreated).toBe(0)
    expect(s.txWouldCreate).toBe(1)
  })

  it('does not return write counts while the real arm is held', async () => {
    await expect(run()).rejects.toThrow(/cutover is held/)
    expect(m.txCreate).not.toHaveBeenCalled()
  })
})

describe('2. the decision path is SHARED, not re-derived', () => {
  it('a transaction with no ORDER_ID is skipped in the dry run while the writer remains held', async () => {
    page([{ ...TX, relatedIdentifiers: [] }])
    const dry = await run({ dryRun: true })
    await expect(run()).rejects.toThrow(/cutover is held/)
    expect([dry.txWouldCreate, dry.txSkipped]).toEqual([0, 1])
    expect(m.sellerFetch).toHaveBeenCalledTimes(1)
    expect(m.txCreate).not.toHaveBeenCalled()
  })

  it('an unmatched order is skipped in the dry run while the writer remains held', async () => {
    m.orderFind.mockResolvedValue(null)
    const dry = await run({ dryRun: true })
    await expect(run()).rejects.toThrow(/cutover is held/)
    expect(dry.txSkipped).toBe(1)
    expect(m.sellerFetch).toHaveBeenCalledTimes(1)
    expect(m.txCreate).not.toHaveBeenCalled()
  })

  it('🔴 a row THIS path already wrote is skipped in the dry run while the writer remains held', async () => {
    // The idempotency check must run in the dry run too, or the count is of "rows in
    // the window" rather than "rows this run would add".
    m.txFindFirst.mockImplementation(async ({ where }: any) =>
      where.amazonTransactionId === NEW_SHAPE ? { id: 'existing' } : null)
    const dry = await run({ dryRun: true })
    await expect(run()).rejects.toThrow(/cutover is held/)
    expect(dry.txWouldCreate).toBe(0)
    expect(dry.txSkipped).toBe(1)
    expect(m.sellerFetch).toHaveBeenCalledTimes(1)
    expect(m.txCreate).not.toHaveBeenCalled()
  })

  it('the dry run queries the SAME identifier the write path dedupes on', async () => {
    await run({ dryRun: true })
    const identifiers = m.txFindFirst.mock.calls.map((c: any) => c[0].where.amazonTransactionId)
    expect(identifiers).toContain(NEW_SHAPE)
  })
})

describe('3. 🔴 legacy order/type overlap risk, not proof of duplicate amounts', () => {
  /** v0 stored the money under the BARE order id, which the idempotency check cannot see. */
  const v0RowExists = () =>
    m.txFindFirst.mockImplementation(async ({ where }: any) =>
      where.amazonTransactionId === ORDER_ID ? { id: 'v0-row' } : null)

  it('🔴 counts legacy order/type overlap risk when v0 already recorded this order', async () => {
    v0RowExists()
    const s = await run({ dryRun: true })
    // The row is still "new" to this path — that is exactly the defect.
    expect(s.txWouldCreate).toBe(1)
    expect(s.txWouldDuplicateV0).toBe(1)
    expect(m.txCreate).not.toHaveBeenCalled()
  })

  it('🟢 NEGATIVE ARM — no v0 row means no duplicate, so the count is not always 1', async () => {
    // A counter that reports 1 whatever the database holds measures nothing.
    const s = await run({ dryRun: true })
    expect(s.txWouldCreate).toBe(1)
    expect(s.txWouldDuplicateV0).toBe(0)
  })

  it('looks for the BARE order id, which is the shape v0 wrote', async () => {
    v0RowExists()
    await run({ dryRun: true })
    const identifiers = m.txFindFirst.mock.calls.map((c: any) => c[0].where.amazonTransactionId)
    expect(identifiers).toContain(ORDER_ID)
    expect(identifiers).toContain(NEW_SHAPE)
  })

  it('a row this path already wrote is NOT counted as a v0 duplicate', async () => {
    // Skipped rows never reach the duplicate check; counting them would inflate the
    // very number the Owner would decide on.
    m.txFindFirst.mockResolvedValue({ id: 'existing' })
    const s = await run({ dryRun: true })
    expect(s.txSkipped).toBe(1)
    expect(s.txWouldDuplicateV0).toBe(0)
  })
})

describe('4. the flag reaches the fetch, and the window is unchanged by it', () => {
  it('a dry run still asks Amazon for the real window', async () => {
    await run({ dryRun: true })
    expect(m.sellerFetch).toHaveBeenCalledTimes(1)
    const path = m.sellerFetch.mock.calls[0][0].path as string
    expect(path).toContain('/finances/2024-06-19/transactions?')
    expect(path).toContain('postedAfter=2026-09-20T00')
  })

  it('missing dry-run options are refused while the cutover remains held', async () => {
    // The nightly v0 sync is separate and remains operational.
    await expect(syncFinancialTransactions(WINDOW[0], WINDOW[1], 'APJ6JRA9NG5V4')).rejects.toThrow(/cutover is held/)
    expect(m.txCreate).not.toHaveBeenCalled()
    expect(m.sellerFetch).not.toHaveBeenCalled()
  })

  it.each([undefined, null, false, 0, 'true', 1])('dryRun: %p is NOT a dry run', async (v) => {
    // Only `true`. Malformed or non-dry-run values must never authorize a financial write.
    await expect(syncFinancialTransactions(WINDOW[0], WINDOW[1], 'APJ6JRA9NG5V4', { dryRun: v as never })).rejects.toThrow(/cutover is held/)
    expect(m.txCreate).not.toHaveBeenCalled()
    expect(m.sellerFetch).not.toHaveBeenCalled()
  })

  it('🟢 CONTROL for the case above — `true` really does disarm it', async () => {
    await run({ dryRun: true })
    expect(m.txCreate).not.toHaveBeenCalled()
  })
})

describe('5. the flag is refused on the path that cannot honour it', () => {
  it('🔴 {dryRun: true} with the DEFAULT path (v0) is refused, not silently written', async () => {
    // v0 has no dry-run arm. Accepting the flag there would write real rows while the
    // caller believed nothing was at stake — an API accepting a flag it ignores, on the
    // money path.
    expect(financialsDryRunRefusal({ dryRun: true })).toMatch(/only available on the 2024-06-19 path/)
    expect(financialsDryRunRefusal({ dryRun: true, useV0: true })).toMatch(/Nothing was written/)
  })

  it('🟢 {dryRun: true, useV0: false} is allowed — the control for the refusal above', async () => {
    expect(financialsDryRunRefusal({ dryRun: true, useV0: false })).toBeNull()
  })

  it('keeps v0 operational but refuses the new writer without a dry run', async () => {
    for (const body of [{}, { useV0: true }, { dryRun: false, useV0: true }]) {
      expect(financialsDryRunRefusal(body), JSON.stringify(body)).toBeNull()
    }
  })

  it('the route asks the service for the rule rather than restating it', async () => {
    // Two copies of a routing predicate diverge on the first case that differs; this is
    // the one assertion here that has to look at the wiring.
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const route = readFileSync(join(import.meta.dirname, '..', 'routes', 'amazon-financials.routes.ts'), 'utf8')
    expect(route).toContain('financialsDryRunRefusal(body)')
    expect(route).toContain('{ dryRun, accountId: body.accountId }')
  })
})
