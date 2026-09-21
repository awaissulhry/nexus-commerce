/**
 * P5.2 — the Amazon Finances 2024-06-19 envelope, and the silent zero it would produce.
 *
 * ## Measured first (development database, 2026-09-21)
 *
 * | | |
 * |---|---|
 * | `listFinancialEvents` (**v0**) in `OutboundApiCallLog` | **112** calls, **108 × 200**, last 2026-09-08 |
 * | `/finances/2024-06-19/transactions` | **0 calls ever** |
 * | `FinancialTransaction` rows | **1,792**, all from the v0 path |
 *
 * So the new endpoint is **built** — `syncFinancialTransactions`, through the channel
 * gateway, reachable by `useV0: false` — and **has never run**. Nobody has seen
 * Amazon's answer to it.
 *
 * ## The defect that would have shown up on its first real run
 *
 * The parse was `data.transactions ?? []`. If Amazon wraps the list, that yields `[]`,
 * the pagination loop ends on the first page, and the sync returns **success** with
 * `orderEventsFetched: 0` and `txCreated: 0`.
 *
 * 🔴 A settlement day recorded as "no transactions", indistinguishable from a genuinely
 * quiet day — and on the money path. P5.1 found exactly this class and named it:
 * *"Three envelopes in one migration. v0 wraps in `payload`; `searchOrders` puts the
 * list under `orders`; `getOrder` wraps one order in `order`. The wrong one gives every
 * field `undefined` and no error."*
 *
 * ## What this slice does NOT do
 *
 * It does not flip the default to 2024-06-19. The deadline is **2027-08-27** (plan
 * target 2027-03), the shape is unverified, and settling it needs one live call — the
 * Owner's. Accepting both envelopes and refusing an unreadable one is what can be done
 * honestly today, and it is the part that stops the silent zero.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readTransactionsPage } from './amazon-financial-events.service.js'

const TX = { transactionType: 'Shipment', totalAmount: { currencyAmount: 12.5, currencyCode: 'EUR' } }

describe('readTransactionsPage (P5.2)', () => {
  it('reads the bare shape', () => {
    expect(readTransactionsPage({ transactions: [TX], nextToken: 'n1' })).toEqual({ transactions: [TX], nextToken: 'n1' })
  })

  it('reads the payload-wrapped shape — the one the old code returned [] for', () => {
    expect(readTransactionsPage({ payload: { transactions: [TX], nextToken: 'n2' } }))
      .toEqual({ transactions: [TX], nextToken: 'n2' })
  })

  it('takes the nextToken from the SAME envelope as the list', () => {
    // A token read from the root while the list came from `payload` would page a
    // different thing — the kind of half-migration that loses rows rather than failing.
    const got = readTransactionsPage({ nextToken: 'root-token', payload: { transactions: [TX], nextToken: 'payload-token' } })
    expect(got.nextToken).toBe('payload-token')
  })

  it('an EMPTY list is a real answer and passes through', () => {
    // The opposite error would be just as bad: refusing a genuinely quiet day.
    expect(readTransactionsPage({ transactions: [] })).toEqual({ transactions: [], nextToken: undefined })
    expect(readTransactionsPage({ payload: { transactions: [] } })).toEqual({ transactions: [], nextToken: undefined })
  })

  it('REFUSES a body with no list in either envelope, naming what Amazon sent', () => {
    // "Could not measure" is not "measured empty". This is the whole slice.
    expect(() => readTransactionsPage({ payload: { items: [TX] } }))
      .toThrow(/no transactions list in either envelope/)
    expect(() => readTransactionsPage({ payload: { items: [TX] } }))
      .toThrow(/payload keys: items/)
    expect(() => readTransactionsPage({ somethingElse: 1 }))
      .toThrow(/root keys: somethingElse/)
  })

  it('REFUSES null, a string and an array rather than reading them as empty', () => {
    for (const body of [null, undefined, 'nope', [TX], 42]) {
      expect(() => readTransactionsPage(body), `${JSON.stringify(body)} should not read as an empty day`).toThrow()
    }
  })

  it('a non-array `transactions` is refused, not coerced', () => {
    expect(() => readTransactionsPage({ transactions: 'lots' })).toThrow(/no transactions list/)
  })

  it('the refusal says nothing was recorded', () => {
    // The sentence an operator or a log reader sees has to distinguish this from a
    // partial write.
    expect(() => readTransactionsPage({})).toThrow(/Nothing was recorded/)
  })
})

describe('wiring (P5.2)', () => {
  const HERE = import.meta.dirname
  const svc = readFileSync(join(HERE, 'amazon-financial-events.service.ts'), 'utf8')
  const route = readFileSync(join(HERE, '..', 'routes', 'amazon.routes.ts'), 'utf8')

  it('the pagination loop goes through the reader', () => {
    expect(svc).toContain('const page = readTransactionsPage(await res.json())')
    const code = svc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    expect(code.filter((l) => l.includes('data.transactions ?? []'))).toEqual([])
  })

  it('v0 is still the default, and the comment no longer claims an un-updated parser', () => {
    expect(route).toContain('const useV0 = body.useV0 !== false')
    expect(route).not.toContain("the parser hasn't been updated")
    expect(route).toContain('0 calls ever')
  })

  it('the v0 path was not touched (positive control)', () => {
    // v0 carries all 1,792 rows and 108 successful calls. This slice must not have
    // changed how it reads anything.
    expect(svc).toContain('export async function syncFinancialEvents(')
    expect(svc).toContain('export async function syncYesterdayFinancialEvents(')
    expect(svc).toContain('amazonService.fetchFinancialEvents(windowStart, windowEnd)')
  })
})
