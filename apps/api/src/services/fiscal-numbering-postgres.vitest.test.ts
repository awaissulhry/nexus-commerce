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
 * Two businesses (plan O2): the counter's key is ("fiscalYear", "issuer") and its rows are row-secured per business, so
 * a second business bumping the row Xavia owns ('XAVIA') is refused by row-level security. Each business numbers its
 * own series: Xavia (the legacy business) keeps 'XAVIA', every other business its own issuer. Forced race again:
 * both businesses at once, each 1…N with no gap, and Xavia's series goes on from where it was.
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

const inBusiness = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const scoped = <T>(work: () => Promise<T>) => inBusiness(LEGACY_WORKSPACE_ID, work)
/** O2 — a second business, invented. */
const SECOND = 'test_fiscal_second_business'
const RACERS = 8
// Fiscal years no other test touches; mid-year, so no time zone moves a date into another year.
const SEQUENTIAL_AT = new Date(Date.UTC(2031, 5, 15, 12))
const RACE_AT = new Date(Date.UTC(2032, 5, 15, 12))
const TWO_BUSINESSES_AT = new Date(Date.UTC(2033, 5, 15, 12))
const orders: string[] = []
const refunds: string[] = []
/** O2 — per business: two numbered first, then RACERS / 2 numbered at the same moment as the other business's. */
const PER_BUSINESS = 2 + RACERS / 2
const own = { xavia: { orders: [] as string[], refunds: [] as string[] }, second: { orders: [] as string[], refunds: [] as string[] } }

/** Runs `calls` (each already in its business) at once, all blocked on their counter INSERT until every one of them is waiting. */
async function forcedRace<T>(table: 'FiscalInvoiceCounter' | 'CreditNoteCounter', calls: Array<() => Promise<T>>): Promise<T[]> {
  const locker = await state.db.pool.connect()
  let running: Array<Promise<{ value: T } | { error: unknown }>> = []
  let released = false
  try {
    await locker.query('BEGIN')
    await locker.query(`LOCK TABLE "${table}" IN SHARE MODE`)
    running = calls.map(call => call().then(value => ({ value }), error => ({ error })))
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
/** O2 — every counter row of a year, as the owner sees it (row security does not hide any). */
const counters = (table: 'FiscalInvoiceCounter' | 'CreditNoteCounter', year: number) =>
  state.db.pool.query(`SELECT "workspaceId", "issuer", "current" FROM "${table}" WHERE "fiscalYear" = $1 ORDER BY "workspaceId"`, [year]).then((r: any) => r.rows)

/** O2 — an order with a refund, in one business. */
async function orderWithRefund(workspaceId: string, key: string): Promise<{ order: string; refund: string }> {
  return inBusiness(workspaceId, async () => {
    const order = await prisma.order.create({ data: {
      channel: 'EBAY', channelOrderId: `TEST-FISCAL-${key}`, marketplace: 'IT', currencyCode: 'EUR', totalPrice: '10.00',
      customerName: 'Test Buyer', customerEmail: `buyer-${key.toLowerCase()}@example.test`, shippingAddress: { city: 'Testville' }, purchaseDate: new Date(),
    } as never })
    const ret = await prisma.return.create({ data: { orderId: order.id, channel: 'EBAY', rmaNumber: `TEST-RMA-${key}` } })
    return { order: order.id, refund: (await prisma.refund.create({ data: { returnId: ret.id, amountCents: 1000, channel: 'EBAY' } })).id }
  })
}

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
    await state.db.pool.query(`INSERT INTO "Workspace" (id, name, status, "isLegacy", "createdByUserId", "creationKey", "updatedAt")
      VALUES ($1, 'Second test business', 'active', false, 'test-bootstrap', 'test-fiscal-second', CURRENT_TIMESTAMP)`, [SECOND])
    for (let i = 0; i < PER_BUSINESS; i++) {
      for (const [who, workspaceId] of [['xavia', LEGACY_WORKSPACE_ID], ['second', SECOND]] as const) {
        const made = await orderWithRefund(workspaceId, `${who.toUpperCase()}-${i}`)
        own[who].orders.push(made.order)
        own[who].refunds.push(made.refund)
      }
    }
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
    const results = await forcedRace('FiscalInvoiceCounter', orders.slice(2).map(id => () => scoped(() => assignInvoiceNumber(id, { at: RACE_AT }))))
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
    const results = await forcedRace('CreditNoteCounter', refunds.slice(2).map(id => () => scoped(() => assignCreditNoteNumber(id, { at: RACE_AT }))))
    expect(results.map(r => r.sequenceNumber).sort((a, b) => a - b)).toEqual(Array.from({ length: RACERS }, (_, i) => i + 1))
    expect(new Set(results.map(r => r.creditNoteNumber)).size).toBe(RACERS)
    expect(await counter('CreditNoteCounter', 2032)).toEqual([{ current: RACERS, workspaceId: LEGACY_WORKSPACE_ID }])
  }, 90_000)

  describe('O2 — two businesses number the same year', () => {
    const half = RACERS / 2
    const oneTo = (n: number, from = 1) => Array.from({ length: n }, (_, i) => from + i)

    it(`invoices: Xavia numbers 2, then both businesses number ${half} each at the same moment — each its own series, no gap, Xavia's unchanged`, async () => {
      const xaviaFirst = []
      for (const id of own.xavia.orders.slice(0, 2)) xaviaFirst.push(await scoped(() => assignInvoiceNumber(id, { at: TWO_BUSINESSES_AT })))
      expect(xaviaFirst.map(r => r.invoiceNumber)).toEqual(['00001/2033', '00002/2033'])
      // The second business numbers its first two on its own (no race yet): 1 and 2 of ITS series.
      const secondFirst = []
      for (const id of own.second.orders.slice(0, 2)) secondFirst.push(await inBusiness(SECOND, () => assignInvoiceNumber(id, { at: TWO_BUSINESSES_AT })))
      expect(secondFirst.map(r => r.invoiceNumber)).toEqual(['00001/2033', '00002/2033'])
      expect(secondFirst[0].issuer).not.toBe('XAVIA')
      expect(xaviaFirst[0].issuer).toBe('XAVIA')

      const results = await forcedRace('FiscalInvoiceCounter', [
        ...own.xavia.orders.slice(2).map(id => () => scoped(() => assignInvoiceNumber(id, { at: TWO_BUSINESSES_AT })).then(r => ({ who: 'xavia', r }))),
        ...own.second.orders.slice(2).map(id => () => inBusiness(SECOND, () => assignInvoiceNumber(id, { at: TWO_BUSINESSES_AT })).then(r => ({ who: 'second', r }))),
      ])
      const seq = (who: string) => results.filter(x => x.who === who).map(x => x.r.sequenceNumber).sort((a, b) => a - b)
      expect(seq('xavia')).toEqual(oneTo(half, 3))
      expect(seq('second')).toEqual(oneTo(half, 3))
      expect(new Set(results.filter(x => x.who === 'xavia').map(x => x.r.issuer))).toEqual(new Set(['XAVIA']))
      expect(new Set(results.filter(x => x.who === 'second').map(x => x.r.issuer))).toEqual(new Set([secondFirst[0].issuer]))
      // One counter row per business, each in its own business, each at its own last number.
      expect(await counters('FiscalInvoiceCounter', 2033)).toEqual([
        { workspaceId: LEGACY_WORKSPACE_ID, issuer: 'XAVIA', current: 2 + half },
        { workspaceId: SECOND, issuer: secondFirst[0].issuer, current: 2 + half },
      ].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)))
      // Xavia's first two keep their numbers, and asking again returns them.
      const again = await scoped(() => assignInvoiceNumber(own.xavia.orders[0], { at: TWO_BUSINESSES_AT }))
      expect(again).toMatchObject({ invoiceNumber: '00001/2033', issuer: 'XAVIA', newlyAssigned: false })
      // Row security: neither business sees the other's invoices.
      const seen = await inBusiness(SECOND, () => prisma.fiscalInvoice.findMany({ where: { fiscalYear: 2033 }, select: { orderId: true } }))
      expect(seen.map(r => r.orderId).sort()).toEqual([...own.second.orders].sort())
    }, 90_000)

    it(`credit notes: Xavia numbers 2, then both businesses number ${half} each at the same moment — each its own series, no gap, Xavia's unchanged`, async () => {
      const xaviaFirst = []
      for (const id of own.xavia.refunds.slice(0, 2)) xaviaFirst.push(await scoped(() => assignCreditNoteNumber(id, { at: TWO_BUSINESSES_AT })))
      expect(xaviaFirst.map(r => r.creditNoteNumber)).toEqual(['NC-00001/2033', 'NC-00002/2033'])
      const secondFirst = []
      for (const id of own.second.refunds.slice(0, 2)) secondFirst.push(await inBusiness(SECOND, () => assignCreditNoteNumber(id, { at: TWO_BUSINESSES_AT })))
      expect(secondFirst.map(r => r.creditNoteNumber)).toEqual(['NC-00001/2033', 'NC-00002/2033'])
      expect(secondFirst[0].issuer).not.toBe('XAVIA')

      const results = await forcedRace('CreditNoteCounter', [
        ...own.xavia.refunds.slice(2).map(id => () => scoped(() => assignCreditNoteNumber(id, { at: TWO_BUSINESSES_AT })).then(r => ({ who: 'xavia', r }))),
        ...own.second.refunds.slice(2).map(id => () => inBusiness(SECOND, () => assignCreditNoteNumber(id, { at: TWO_BUSINESSES_AT })).then(r => ({ who: 'second', r }))),
      ])
      const seq = (who: string) => results.filter(x => x.who === who).map(x => x.r.sequenceNumber).sort((a, b) => a - b)
      expect(seq('xavia')).toEqual(oneTo(half, 3))
      expect(seq('second')).toEqual(oneTo(half, 3))
      expect(await counters('CreditNoteCounter', 2033)).toEqual([
        { workspaceId: LEGACY_WORKSPACE_ID, issuer: 'XAVIA', current: 2 + half },
        { workspaceId: SECOND, issuer: secondFirst[0].issuer, current: 2 + half },
      ].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)))
      const again = await scoped(() => assignCreditNoteNumber(own.xavia.refunds[0], { at: TWO_BUSINESSES_AT }))
      expect(again).toMatchObject({ creditNoteNumber: 'NC-00001/2033', issuer: 'XAVIA', newlyAssigned: false })
    }, 90_000)
  })
})
