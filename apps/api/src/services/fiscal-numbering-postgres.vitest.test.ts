import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Invoice and credit-note numbers on a REAL PostgreSQL (MCP full control, early fix #14 / plan O2).
 *
 * Both counters are bumped with `INSERT … ON CONFLICT (…) DO UPDATE … RETURNING`. PostgreSQL accepts that statement
 * only when the conflict target is exactly a unique key of the table, and the counters' only unique key is their
 * primary key ("fiscalYear", "issuer"). A target that names any other column set is refused on EVERY call
 * ("there is no unique or exclusion constraint matching the ON CONFLICT specification"), whether a row exists or not.
 * Mocked or PGlite-free unit tests cannot see that, so these run on the disposable multi-connection server
 * (`concurrent-database.ts`) as the restricted runtime login, with row security on, as production runs.
 *
 * The race is FORCED, not hoped for: a third connection holds a SHARE lock on the counter table, so every caller has
 * read its order or refund and is blocked on the counter INSERT before the lock is released. Gap-free numbering then
 * means exactly 1…N, each once. Every id and name is invented.
 *
 * Run: node scripts/run-real-postgres-tests.mjs (it starts a throwaway PostgreSQL 17 and sets NEXUS_TEST_CONCURRENT_PG_URL).
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', () => ({
  default: new Proxy({}, { get: (_target, property) => {
    const client = state.db?.client
    if (!client) throw new Error(`fiscal-numbering-postgres: no database (needs NEXUS_TEST_CONCURRENT_PG_URL); read "${String(property)}"`)
    const value = client[property]
    return typeof value === 'function' ? value.bind(client) : value
  } }),
}))

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { assignInvoiceNumber } from './fiscal-invoice.service.js'
import { assignCreditNoteNumber } from './credit-note.service.js'
import { CONCURRENT_PG_ENV, concurrentDatabase, concurrentDatabaseUrl } from '../test-support/concurrent-database.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const RACERS = 8
// Fiscal years no other test touches; mid-year, so no time zone moves a date into another year.
const SEQUENTIAL_AT = new Date(Date.UTC(2031, 5, 15, 12))
const RACE_AT = new Date(Date.UTC(2032, 5, 15, 12))
const orders: string[] = []
const refunds: string[] = []

/** Runs `calls` at once, all blocked on their counter INSERT until every one of them is waiting. */
async function forcedRace<T>(table: 'FiscalInvoiceCounter' | 'CreditNoteCounter', calls: Array<() => Promise<T>>): Promise<T[]> {
  const locker = await state.db.pool.connect()
  let running: Array<Promise<{ value: T } | { error: unknown }>> = []
  let released = false
  try {
    await locker.query('BEGIN')
    await locker.query(`LOCK TABLE "${table}" IN SHARE MODE`)
    running = calls.map(call => scoped(call).then(value => ({ value }), error => ({ error })))
    let waiting = 0
    const deadline = Date.now() + 40_000
    while (waiting < calls.length && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
      const { rows } = await state.db.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'`, [state.db.name])
      waiting = rows[0].n
    }
    const forced = waiting === calls.length
    await locker.query(forced ? 'COMMIT' : 'ROLLBACK')
    released = true
    const settled = await Promise.all(running)
    if (!forced) throw new Error(`The race was not forced: ${waiting} of ${calls.length} calls were blocked on the counter before the lock was released.`)
    for (const outcome of settled) if ('error' in outcome) throw outcome.error
    return settled.map(outcome => (outcome as { value: T }).value)
  } finally {
    if (!released) {
      await locker.query('ROLLBACK').catch(() => undefined)
      await Promise.all(running)
    }
    locker.release()
  }
}

const counter = (table: 'FiscalInvoiceCounter' | 'CreditNoteCounter', year: number) =>
  state.db.pool.query(`SELECT "current", "workspaceId" FROM "${table}" WHERE "fiscalYear" = $1 AND "issuer" = 'XAVIA'`, [year]).then((r: any) => r.rows)

describe.skipIf(!concurrentDatabaseUrl())(`fiscal numbering — invoice and credit-note counters (needs ${CONCURRENT_PG_ENV})`, () => {
  beforeAll(async () => {
    state.db = await concurrentDatabase()
    await scoped(async () => {
      for (let i = 0; i < RACERS + 2; i++) {
        const order = await prisma.order.create({ data: {
          channel: 'EBAY', channelOrderId: `TEST-FISCAL-ORDER-${i}`, marketplace: 'IT', currencyCode: 'EUR', totalPrice: '10.00',
          customerName: 'Test Buyer', customerEmail: `buyer-${i}@example.test`, shippingAddress: { city: 'Testville' }, purchaseDate: new Date(),
        } as never })
        orders.push(order.id)
        const ret = await prisma.return.create({ data: { orderId: order.id, channel: 'EBAY', rmaNumber: `TEST-RMA-${i}` } })
        refunds.push((await prisma.refund.create({ data: { returnId: ret.id, amountCents: 1000, channel: 'EBAY' } })).id)
      }
    })
  }, 120_000)
  afterAll(async () => { await state.db?.close() }, 60_000)

  it('invoices: two orders get 00001 and 00002, and asking again returns the same number', async () => {
    const first = await scoped(() => assignInvoiceNumber(orders[0], { at: SEQUENTIAL_AT }))
    const second = await scoped(() => assignInvoiceNumber(orders[1], { at: SEQUENTIAL_AT }))
    expect([first.invoiceNumber, second.invoiceNumber]).toEqual(['00001/2031', '00002/2031'])
    expect([first.newlyAssigned, second.newlyAssigned]).toEqual([true, true])
    const again = await scoped(() => assignInvoiceNumber(orders[0], { at: SEQUENTIAL_AT }))
    expect(again).toMatchObject({ invoiceNumber: '00001/2031', newlyAssigned: false })
    expect(await counter('FiscalInvoiceCounter', 2031)).toEqual([{ current: 2, workspaceId: LEGACY_WORKSPACE_ID }])
  }, 60_000)

  it(`invoices: ${RACERS} orders numbered at the same moment get 1…${RACERS}, no duplicate and no gap`, async () => {
    const results = await forcedRace('FiscalInvoiceCounter', orders.slice(2).map(id => () => assignInvoiceNumber(id, { at: RACE_AT })))
    expect(results.map(r => r.sequenceNumber).sort((a, b) => a - b)).toEqual(Array.from({ length: RACERS }, (_, i) => i + 1))
    expect(new Set(results.map(r => r.invoiceNumber)).size).toBe(RACERS)
    expect(await counter('FiscalInvoiceCounter', 2032)).toEqual([{ current: RACERS, workspaceId: LEGACY_WORKSPACE_ID }])
  }, 90_000)

  it('credit notes: two refunds get NC-00001 and NC-00002, and asking again returns the same number', async () => {
    const first = await scoped(() => assignCreditNoteNumber(refunds[0], { at: SEQUENTIAL_AT }))
    const second = await scoped(() => assignCreditNoteNumber(refunds[1], { at: SEQUENTIAL_AT }))
    expect([first.creditNoteNumber, second.creditNoteNumber]).toEqual(['NC-00001/2031', 'NC-00002/2031'])
    const again = await scoped(() => assignCreditNoteNumber(refunds[0], { at: SEQUENTIAL_AT }))
    expect(again).toMatchObject({ creditNoteNumber: 'NC-00001/2031', newlyAssigned: false })
    expect(await counter('CreditNoteCounter', 2031)).toEqual([{ current: 2, workspaceId: LEGACY_WORKSPACE_ID }])
  }, 60_000)

  it(`credit notes: ${RACERS} refunds numbered at the same moment get 1…${RACERS}, no duplicate and no gap`, async () => {
    const results = await forcedRace('CreditNoteCounter', refunds.slice(2).map(id => () => assignCreditNoteNumber(id, { at: RACE_AT })))
    expect(results.map(r => r.sequenceNumber).sort((a, b) => a - b)).toEqual(Array.from({ length: RACERS }, (_, i) => i + 1))
    expect(new Set(results.map(r => r.creditNoteNumber)).size).toBe(RACERS)
    expect(await counter('CreditNoteCounter', 2032)).toEqual([{ current: RACERS, workspaceId: LEGACY_WORKSPACE_ID }])
  }, 90_000)
})
