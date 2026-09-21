/**
 * P5.2 — the dry-run counting mode, and the double-write it measures.
 *
 * ## Why this exists
 *
 * `build/P5.2.md` §4b withdrew the plan's own next step. The plan said *"one live
 * `{useV0:false}` call, then compare counts against v0"* — and that call is a **write**
 * over a window v0 has already synced. The two paths cannot dedupe against each other:
 *
 * | path | `amazonTransactionId` |
 * |---|---|
 * | v0 | `404-1234567-1234567` — the bare order id |
 * | 2024-06-19 | `404-1234567-1234567/ITEM-9/2026-09-20` |
 *
 * Both write `FinancialTransaction`, both dedupe on
 * `(orderId, transactionType, amazonTransactionId)`, and **nothing bridges the two
 * shapes** — §4b listed all 7 writers and matchers and searched for a migration. So the
 * comparison run would have created a second row for money v0 already recorded.
 *
 * §4b named three safe alternatives and called a dry-run counting mode the cheapest.
 * This is it.
 *
 * ## What these tests hold, and the traps they are built against
 *
 * - **The dry run must not be a second predicate.** It skips exactly one statement, the
 *   `create`. A count produced by a re-derived "equivalent" decision is a count of
 *   something else, and diverges on the first case that differs.
 * - **A zero-change round trip cannot test the write.** Every "wrote nothing" assertion
 *   here is paired with a **positive control**: the same fixture through the real arm,
 *   which must create. Otherwise "nothing was written" and "nothing happened at all"
 *   are the same observation.
 * - **A claim must match its measurement.** `txCreated` is **0** on a dry run, because
 *   zero rows were created; the count lives in `txWouldCreate`. Every existing reader of
 *   `txCreated` sums writes.
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
    financialTransaction: { findFirst: m.txFindFirst, create: m.txCreate },
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

/** One Amazon Transaction in the 2024-06-19 shape, with a seller order item id. */
const TX = {
  transactionType: 'Shipment',
  postedDate: '2026-09-20T10:00:00Z',
  sellerOrderItemId: 'ITEM-9',
  totalAmount: { currencyAmount: 31.98, currencyCode: 'EUR' },
  relatedIdentifiers: [{ relatedIdentifierName: 'AMAZON_ORDER_ID', relatedIdentifierValue: ORDER_ID }],
  breakdowns: [{ breakdownType: 'Principal', breakdownAmount: { currencyAmount: 31.98, currencyCode: 'EUR' } }],
}

/** The identifier THIS path builds — the one the idempotency check looks for. */
const NEW_SHAPE = `${ORDER_ID}/ITEM-9/2026-09-20T10:00:00Z`

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

  it('🟢 POSITIVE CONTROL — the same fixture through the real arm DOES create', async () => {
    // Without this, "txCreate was not called" is equally explained by a fixture that
    // never reaches the write at all.
    const s = await run()
    expect(m.txCreate).toHaveBeenCalledTimes(1)
    expect(s.txCreated).toBe(1)
    expect(s.dryRun).toBe(false)
  })

  it('🔴 txCreated is ZERO on a dry run, because zero rows were created', async () => {
    // Every existing reader of txCreated sums writes. A dry run reporting 1 there would
    // be a claim that does not match its measurement.
    const s = await run({ dryRun: true })
    expect(s.txCreated).toBe(0)
    expect(s.txWouldCreate).toBe(1)
  })

  it('on a REAL run the two counts agree, so one number can be read as the other', async () => {
    const s = await run()
    expect(s.txCreated).toBe(s.txWouldCreate)
  })
})

describe('2. the decision path is SHARED, not re-derived', () => {
  it('a transaction with no AMAZON_ORDER_ID is skipped in both modes alike', async () => {
    page([{ ...TX, relatedIdentifiers: [] }])
    const dry = await run({ dryRun: true })
    const real = await run()
    expect([dry.txWouldCreate, dry.txSkipped]).toEqual([0, 1])
    expect([real.txCreated, real.txSkipped]).toEqual([0, 1])
    expect(m.txCreate).not.toHaveBeenCalled()
  })

  it('an unmatched order is skipped in both modes alike', async () => {
    m.orderFind.mockResolvedValue(null)
    const dry = await run({ dryRun: true })
    const real = await run()
    expect(dry.txSkipped).toBe(1)
    expect(real.txSkipped).toBe(1)
    expect(m.txCreate).not.toHaveBeenCalled()
  })

  it('🔴 a row THIS path already wrote is skipped in both modes alike', async () => {
    // The idempotency check must run in the dry run too, or the count is of "rows in
    // the window" rather than "rows this run would add".
    m.txFindFirst.mockImplementation(async ({ where }: any) =>
      where.amazonTransactionId === NEW_SHAPE ? { id: 'existing' } : null)
    const dry = await run({ dryRun: true })
    const real = await run()
    expect(dry.txWouldCreate).toBe(0)
    expect(dry.txSkipped).toBe(1)
    expect(real.txCreated).toBe(0)
    expect(m.txCreate).not.toHaveBeenCalled()
  })

  it('the dry run queries the SAME identifier the write path dedupes on', async () => {
    await run({ dryRun: true })
    const identifiers = m.txFindFirst.mock.calls.map((c: any) => c[0].where.amazonTransactionId)
    expect(identifiers).toContain(NEW_SHAPE)
  })
})

describe('3. 🔴 the number this mode exists for — would it duplicate a v0 row?', () => {
  /** v0 stored the money under the BARE order id, which the idempotency check cannot see. */
  const v0RowExists = () =>
    m.txFindFirst.mockImplementation(async ({ where }: any) =>
      where.amazonTransactionId === ORDER_ID ? { id: 'v0-row' } : null)

  it('🔴 counts a would-be duplicate when v0 already recorded this order', async () => {
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

  it('no options at all means a REAL run — the flag must be opt-in', async () => {
    // A dry run that happened by default would quietly stop the nightly sync writing.
    const s = await syncFinancialTransactions(WINDOW[0], WINDOW[1], 'APJ6JRA9NG5V4')
    expect(s.dryRun).toBe(false)
    expect(m.txCreate).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, null, false, 0, 'true', 1])('dryRun: %p is NOT a dry run', async (v) => {
    // Only `true`. A truthy string arriving from a JSON body must not disarm the write,
    // and a falsy one must not either — both are read as "the caller did not ask".
    await syncFinancialTransactions(WINDOW[0], WINDOW[1], 'APJ6JRA9NG5V4', { dryRun: v as never })
    expect(m.txCreate).toHaveBeenCalledTimes(1)
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

  it('no dryRun means no refusal, on either path', async () => {
    for (const body of [{}, { useV0: true }, { useV0: false }, { dryRun: false, useV0: true }]) {
      expect(financialsDryRunRefusal(body), JSON.stringify(body)).toBeNull()
    }
  })

  it('the route asks the service for the rule rather than restating it', async () => {
    // Two copies of a routing predicate diverge on the first case that differs; this is
    // the one assertion here that has to look at the wiring.
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const route = readFileSync(join(import.meta.dirname, '..', 'routes', 'amazon.routes.ts'), 'utf8')
    expect(route).toContain('financialsDryRunRefusal(body)')
    expect(route).toContain('{ dryRun }')
  })
})
