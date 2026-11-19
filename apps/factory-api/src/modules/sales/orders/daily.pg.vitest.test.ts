import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCompliance } from '../../../../../../packages/factory-db/seed/compliance'
import { seed as seedCosting } from '../../../../../../packages/factory-db/seed/costing'
import { seed as seedPricing, type PricingSeed } from '../../../../../../packages/factory-db/seed/pricing'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { systemContext } from '../../../platform/outbox/system'
import { orderHandlers } from './handlers'
// ---- B-W2b-F53: this file fixes its clock on a day of the seeds' story, so it runs the seeds as written (seed-calendar)
await vi.hoisted(async () => (await import('@nexus/factory-db/testing')).seedsAsWritten())

// ---- B-W2b-F43: the clock is fixed at Friday 13 Nov 2026 09:00 UTC (10:00 at the plant), in the seeds' week, and runs on from
// there: the expectations read the seeds' fixed days and failed once those days passed (a fake clock on 2026-12-07 or 2027-01-15
// found it). The routes read the same clock (serverClock); the office sign-in keeps its own movable clock.
vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-13T09:00:00.000Z'), shouldAdvanceTime: true })
afterAll(() => vi.useRealTimers())
// ---- end B-W2b-F43

/**
 * Orders every day (B-W2a-30; SAL-202 manual entry, SAL-155 duplicate a quote, SAL-209 + SAL-217 locked orders and
 * amendments with their snapshot, SAL-210 close remaining lines, SAL-211 cancel with its impact check, SAL-216 the payment
 * schedule) on the local stack: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level
 * security, the column grants and the …_sales_guards / …_sales_w2a_guards triggers are real) and the real app with test
 * sessions. One made-up tenant from the factory-db seeds up to pricing: P1 buys on DEP30 (30 % on the order, the rest
 * before shipping) from its list SEED-PL-P1 (SEED-JKT-01 420.00, its RED 430.00; SEED-JKT-02 from the base list,
 * 410.00); SEED-SO-0001 (CONFIRMED, deposit PAID, schedule, amendment 1), SEED-SO-0002 (WO-0001 released, WO-0002 a
 * draft, SH-0001 SHIPPED with 2 of its 7 jackets, a DRAFT TD24), SEED-Q-0001 (ACCEPTED). Every name, price and number is
 * made up. Run with `node scripts/factory/run-pg-tests.mjs sales/orders/daily`.
 */

let h: Harness
let app: FastifyInstance
let seeded: PricingSeed

const NS = 'w2a30-daily-a'
const idIn = (key: string) => seedUuid(NS, key)
const T = idIn('tenant')
const companyA = idIn('company:A')
const P1 = idIn('party:P1')
const P3 = idIn('party:P3')
const JKT01 = idIn('product:style:JKT-01')
const JKT01_BLK = idIn('product:colourway:JKT-01:BLK')
const JKT01_RED = idIn('product:colourway:JKT-01:RED')
const JKT02 = idIn('production:style:JKT-02')
const JKT02_RED = idIn('production:colourway:JKT-02:RED')
const TODAY = businessDate(new Date())
const YEAR = TODAY.slice(0, 4)
const PROMISE = addDays(TODAY, 40)

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
let counter = 0
const key = (label = 'k'): string => `daily-${label}-${++counter}-${newId()}`

const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (permissions: Permission[], actorId = newId()): (() => SessionContext) => () => ({ audience: 'office', tenantId: T, actorId, grants: [grant(permissions)] })
const SALES: Permission[] = ['orders.view', 'orders.manage', 'quotes.view', 'quotes.manage', 'paymentterms.view', 'money.price', 'money.cost']
const SALES_ACTOR = newId()
// B-OP-013: the Owner (every right of the order and its work orders) and a Sales person limited to another customer (P3).
const OWNER_ACTOR = newId()
const SESSIONS: Record<string, () => SessionContext> = {
  sales: office(SALES, SALES_ACTOR),
  owner: office([...SALES, 'workorders.view', 'workorders.manage'], OWNER_ACTOR),
  salesP3: () => ({ audience: 'office', tenantId: T, actorId: newId(), grants: [{ permissions: SALES, companies: 'all', sites: 'all', parties: [P3] }] }),
  pricesOnly: office(['orders.view', 'orders.manage', 'quotes.view', 'quotes.manage', 'money.price']),
  viewer: office(['orders.view']),
  floor: () => ({ audience: 'floor', tenantId: T, actorId: newId(), siteId: idIn('site:A1'), deviceId: newId(), grants: [{ permissions: ['floor.work', ...SALES], companies: [companyA], sites: [idIn('site:A1')], parties: 'all' }] }),
}

async function call(session: string, method: 'GET' | 'POST', url: string, body?: unknown) {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key(session) }) }, ...(body === undefined ? {} : { payload: body as object }) })
  return { status: response.statusCode, body: response.json() as Json }
}
async function ok(session: string, method: 'GET' | 'POST', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await call(session, method, url, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body
}
async function refused(session: string, method: 'GET' | 'POST', url: string, body: unknown, status: number): Promise<Json> {
  const answer = await call(session, method, url, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body.error
}

const orderUrl = (id: string) => `/sales/orders/${id}`
const systemCaller = () => callerFor(h.database, systemContext(T, newId()))
const handler = (name: string) => orderHandlers().find((entry) => entry.name === name)!
const envelope = (type: string, payload: Json) => ({ eventId: newId(), type, version: 1, tenantId: T, payload }) as never
const events = (type: string, subject: string) => admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = $1 AND subject = $2 ORDER BY "occurredAt", id`, [type, subject])
const recordOf = async (orderId: string, session = 'sales') => (await ok(session, 'GET', orderUrl(orderId))).order

const grid = (rows: [string, number][]) => rows.map(([size, quantity]) => ({ size, quantity }))
const MANUAL = {
  companyId: companyA,
  partyId: P1,
  customerRef: 'PO-REPEAT-77',
  promiseDate: PROMISE,
  lines: [
    // P1's list: 420.00 for SEED-JKT-01.
    { styleId: JKT01, colourwayId: JKT01_BLK, sizes: grid([['50', 2], ['52', 2]]) },
    // A typed price for SEED-JKT-02 (its list price would be the base list's 410.00).
    { styleId: JKT02, colourwayId: JKT02_RED, sizes: grid([['52', 3]]), unitPrice: '400' },
  ],
}

beforeAll(async () => {
  h = await startHarness('sales_orders_daily')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedCompliance({ db: h.database, namespace: NS })
  await seedCosting({ db: h.database, namespace: NS })
  seeded = await seedPricing({ db: h.database, namespace: NS })
  // B-OP-012: Sales is an active office person, so its office changes propose (and carry along) the gap to the work orders.
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, 'daily-sales@example.com', 'Made-up Sales', 'ACTIVE')`, [SALES_ACTOR, T])
  // B-OP-013: the Owner proposes (and carries along) too.
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, 'daily-owner@example.com', 'Made-up Owner', 'ACTIVE')`, [OWNER_ACTOR, T])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
}, 300_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

let manual: Json

describe('manual order entry (SAL-202): an order without a quote, for repeat business', () => {
  it('shows the number it will get and prices the draft from the customer’s terms and list', async () => {
    expect(await ok('sales', 'GET', `/sales/order-numbers/next?companyId=${companyA}`)).toEqual({ number: `SO-${YEAR}-0001` })
    const preview = await ok('sales', 'POST', '/sales/orders/manual/preview', MANUAL)
    expect(preview).toMatchObject({ ok: true, number: `SO-${YEAR}-0001`, problems: [] })
    expect(preview.order).toMatchObject({ taxMode: 'IT_B2B', priceBasis: 'NET', paymentTermsId: seeded.paymentTermsIds.DEP30, depositPct: '30', netAmount: 288_000, vatAmount: 63_360, grossAmount: 351_360, depositAmount: 105_408 })
    expect(preview.order.lines.map((line: Json) => [line.seq, line.unitPrice, line.quantity, line.netAmount])).toEqual([
      [10, '420', 4, 168_000],
      [20, '400', 3, 120_000],
    ])
    expect(preview.order.schedule.map((step: Json) => [step.kind, step.amount, step.dueDate])).toEqual([
      ['DEPOSIT', 105_408, null],
      ['BEFORE_SHIPPING', 245_952, PROMISE],
    ])
    // Without the cost grain the costs are not answered; without the price grain no amount at all.
    const priceOnly = await ok('pricesOnly', 'POST', '/sales/orders/manual/preview', MANUAL)
    expect(priceOnly.order).not.toHaveProperty('costAmount')
    expect(priceOnly.order.lines[0]).not.toHaveProperty('costAmount')
    await refused('viewer', 'POST', '/sales/orders/manual/preview', MANUAL, 403)
  })

  it('refuses what it cannot make, in words: a size the colourway does not offer, a past promise, no lines', async () => {
    const wrong = { ...MANUAL, promiseDate: addDays(TODAY, -1), lines: [{ styleId: JKT01, colourwayId: JKT01_BLK, sizes: grid([['60', 1]]) }] }
    const preview = await ok('sales', 'POST', '/sales/orders/manual/preview', wrong)
    expect(preview).toMatchObject({ ok: false, order: null })
    expect(preview.problems.map((issue: Json) => issue.path)).toEqual(['body/promiseDate', 'body/lines/0/sizes/0/size'])
    const made = await refused('sales', 'POST', '/sales/orders/manual', wrong, 400)
    expect(made.issues.map((issue: Json) => issue.path)).toEqual(['body/promiseDate', 'body/lines/0/sizes/0/size'])
    await refused('sales', 'POST', '/sales/orders/manual', { ...MANUAL, lines: [] }, 400)
    await refused('floor', 'POST', '/sales/orders/manual', MANUAL, 403)
    expect((await admin('SELECT count(*)::int AS n FROM "SalesOrder" WHERE "quoteVersionId" IS NULL AND number LIKE $1', [`SO-${YEAR}-%`]))[0]!.n).toBe(0)
  })

  it('Confirm order makes it CONFIRMED in one command: number, lines, deposit request, payment schedule, audit, event', async () => {
    const made = await ok('sales', 'POST', '/sales/orders/manual', MANUAL, 201)
    manual = made.order
    expect(manual).toMatchObject({
      number: `SO-${YEAR}-0001`,
      status: 'CONFIRMED',
      customerRef: 'PO-REPEAT-77',
      paymentTermsId: seeded.paymentTermsIds.DEP30,
      promiseDate: PROMISE,
      originalPromiseDate: PROMISE,
      depositRequired: true,
      netAmount: 288_000,
      grossAmount: 351_360,
      locked: true,
      amendments: { count: 0, latestRevision: null },
      chain: { quote: null, workOrders: [], shipments: [], invoices: [] },
    })
    expect(manual.billTo).toMatchObject({ taxMode: 'IT_B2B' })
    expect(manual.shipTo).toHaveProperty('line1')
    expect(manual.chain.depositRequests).toEqual([
      expect.objectContaining({ orderId: manual.id, quoteVersionId: null, status: 'OPEN', amount: 105_408, depositPct: '30', stepKind: 'DEPOSIT' }),
      // B-W2a-F2: the balance before shipping has its own request — an advance (TD02 when paid before the goods leave),
      // of the step's amount, due on its day, with the deposit's fiscal rule.
      expect.objectContaining({ orderId: manual.id, quoteVersionId: null, status: 'OPEN', kind: 'ACCONTO', amount: 245_952, depositPct: '70', dueDate: PROMISE, fiscalDocument: 'TD02', stepKind: 'BEFORE_SHIPPING' }),
    ])
    // The orders list and the release gate read the deposit only: the balance's request is not "the deposit".
    expect((await ok('sales', 'GET', `/sales/orders?q=${manual.number}`)).orders[0].deposit).toEqual({ state: 'OPEN', dueDate: manual.chain.depositRequests[0].dueDate })
    expect(manual.dailyActions.map((action: Json) => [action.action, action.allowed])).toEqual([['amend', true], ['closeLines', true], ['reopenLines', false], ['copyAsQuote', true]])
    const audit = await one(`SELECT after FROM "AuditLog" WHERE action = 'orders.makeManual' AND "recordId" = $1`, [manual.id])
    expect(audit.after).toMatchObject({ number: manual.number, quoteVersionId: null, depositRequired: true, lines: 2, pieces: 7 })
    expect((await events('sales_order.created', manual.id)).map((row) => row.payload)).toEqual([expect.objectContaining({ quoteId: null, versionId: null, partyId: P1, depositRequestIds: [manual.chain.depositRequests[0].id] })])
    expect(await ok('sales', 'GET', `/sales/order-numbers/next?companyId=${companyA}`)).toEqual({ number: `SO-${YEAR}-0002` })
  })
})

describe('the payment schedule (SAL-216)', () => {
  it('the deposit and the balance before shipping, with their state; the deposit step follows its request', async () => {
    const schedule = await ok('sales', 'GET', `${orderUrl(manual.id)}/schedule`)
    expect(schedule.steps.map((step: Json) => [step.seq, step.kind, step.amount, step.status, step.dueDate, step.depositRequestId])).toEqual([
      [10, 'DEPOSIT', 105_408, 'OPEN', manual.chain.depositRequests[0].dueDate, manual.chain.depositRequests[0].id],
      [20, 'BEFORE_SHIPPING', 245_952, 'OPEN', PROMISE, manual.chain.depositRequests[1].id],
    ])
    expect(schedule).toMatchObject({ grossAmount: 351_360, openAmount: 351_360, paidAmount: 0, cancelled: [] })
    // A viewer without the price grain sees the steps, not their amounts.
    const viewer = await ok('viewer', 'GET', `${orderUrl(manual.id)}/schedule`)
    expect(viewer.steps[0]).not.toHaveProperty('amount')
    expect(viewer).not.toHaveProperty('grossAmount')

    // The money module marks the request PAID (payments markDepositPaid) and emits payment.deposit_paid.
    const requestId = manual.chain.depositRequests[0].id
    await admin(`UPDATE "DepositRequest" SET status = 'PAID', "paidAt" = now(), version = version + 1 WHERE id = $1`, [requestId])
    for (let attempt = 1; attempt <= 2; attempt++) {
      await handler('sales.ordersFollowDeposits').handle(envelope('payment.deposit_paid', { depositRequestId: requestId, partyId: P1, orderId: manual.id }), { caller: systemCaller(), attempt })
    }
    const paid = await ok('sales', 'GET', `${orderUrl(manual.id)}/schedule`)
    expect(paid.steps.map((step: Json) => [step.kind, step.status])).toEqual([['DEPOSIT', 'PAID'], ['BEFORE_SHIPPING', 'OPEN']])
    expect(paid).toMatchObject({ paidAmount: 105_408, openAmount: 245_952 })
    expect((await events('sales_order.schedule_changed', manual.id)).map((row) => row.payload.change)).toEqual(['MADE', 'PAID'])
  })

  it('an order made at acceptance has its schedule from the quote’s terms (SEED-SO-0001 already has one: none is added)', async () => {
    const schedule = await ok('sales', 'GET', `${orderUrl(seeded.money.sales.orderId)}/schedule`)
    expect(schedule.steps.map((step: Json) => [step.kind, step.status])).toEqual([['DEPOSIT', 'PAID'], ['BEFORE_SHIPPING', 'OPEN']])
  })
})

describe('amendments (SAL-209, SAL-217): a confirmed order changes only through a reviewed amendment with its snapshot', () => {
  const change = () => {
    const [blk, red] = manual.lines
    return {
      reason: 'The customer wants two more 52s and one red jacket in 54.',
      lines: [
        { id: blk.id, sizes: grid([['50', 2], ['52', 4]]) },
        { id: red.id },
        { styleId: JKT01, colourwayId: JKT01_RED, sizes: grid([['54', 1]]) },
      ],
    }
  }

  it('the review: lines old → new by size, the money change and whether the customer accepts again', async () => {
    const review = await ok('sales', 'POST', `${orderUrl(manual.id)}/amendments/preview`, { version: manual.version, ...change() })
    expect(review).toMatchObject({ ok: true, revision: 1, problems: [] })
    expect(review.diff.lines.map((line: Json) => [line.change, line.seq, line.piecesBefore, line.piecesAfter, line.sizes])).toEqual([
      ['CHANGED', 10, 4, 6, [{ size: '52', before: 2, after: 4 }]],
      ['ADDED', 30, 0, 1, [{ size: '54', before: 0, after: 1 }]],
    ])
    // P1's list: 430.00 for the RED colourway; the net goes 2880.00 → 3880.00 (+2 × 420 + 430).
    expect(review.diff).toMatchObject({ netAmountBefore: 288_000, netAmountAfter: 415_000, reacceptanceNeeded: true })
    const noReason = await ok('sales', 'POST', `${orderUrl(manual.id)}/amendments/preview`, { ...change(), reason: '' })
    expect(noReason).toMatchObject({ ok: false, diff: null })
    expect(noReason.problems.map((issue: Json) => issue.path)).toEqual(['body/reason'])
    const viewer = await ok('viewer', 'GET', `${orderUrl(manual.id)}/amendments`)
    expect(viewer.amendments).toEqual([])
  })

  it('applies it in one command: lines, totals, re-acceptance, the amendment with before / after, the schedule made again', async () => {
    await refused('sales', 'POST', `${orderUrl(manual.id)}/amendments`, { version: manual.version + 3, ...change() }, 409)
    await refused('viewer', 'POST', `${orderUrl(manual.id)}/amendments`, { version: manual.version, ...change() }, 403)
    const applied = await ok('sales', 'POST', `${orderUrl(manual.id)}/amendments`, { version: manual.version, ...change() }, 201)
    expect(applied.order).toMatchObject({ netAmount: 415_000, grossAmount: 506_300, amendments: { count: 1, latestRevision: 1 } })
    expect(applied.order.reapprovalNeededAt).not.toBeNull()
    expect(applied.order.lines.map((line: Json) => [line.seq, line.colourway.code, line.unitPrice, line.quantity])).toEqual([
      [10, 'BLK', '420', 6],
      [20, 'RED', '400', 3],
      [30, 'RED', '430', 1],
    ])
    expect(applied.amendment).toMatchObject({ revision: 1, reason: change().reason, reacceptance: 'NEEDED', diff: { netAmountBefore: 288_000, netAmountAfter: 415_000 } })
    const row = await one('SELECT revision, before, after, "netAmountBefore", "netAmountAfter", "reacceptanceNeeded", "requestId" FROM "SalesOrderAmendment" WHERE "orderId" = $1', [manual.id])
    expect(row).toMatchObject({ revision: 1, netAmountBefore: 288_000, netAmountAfter: 415_000, reacceptanceNeeded: true })
    expect(row.before.lines.map((line: Json) => line.quantity)).toEqual([4, 3])
    expect(row.after.lines.map((line: Json) => [line.id, line.quantity])).toEqual(applied.order.lines.map((line: Json) => [line.id, line.quantity]))
    // The snapshot never carries a cost.
    expect(JSON.stringify(row.before) + JSON.stringify(row.after)).not.toMatch(/cost/i)
    // The deposit (PAID) stays; the balance is made again for the new total: 5063.00 − 1054.08.
    const schedule = await ok('sales', 'GET', `${orderUrl(manual.id)}/schedule`)
    expect(schedule.steps.map((step: Json) => [step.kind, step.status, step.amount])).toEqual([
      ['DEPOSIT', 'PAID', 105_408],
      ['BEFORE_SHIPPING', 'OPEN', 400_892],
    ])
    expect(schedule.cancelled.map((step: Json) => [step.kind, step.statusNote])).toEqual([['BEFORE_SHIPPING', 'Amendment 1: the schedule was made again for the new total.']])
    // B-W2a-F2: the old balance's request (nothing paid on it) is cancelled with its step; the new balance has its own.
    const requests = await admin<{ status: string; amount: number; statusNote: string | null }>('SELECT status::text AS status, amount, "statusNote" FROM "DepositRequest" WHERE id = ANY($1::uuid[]) ORDER BY "createdAt", id', [[schedule.cancelled[0].depositRequestId, schedule.steps[1].depositRequestId]])
    expect(requests).toEqual([
      { status: 'CANCELLED', amount: 245_952, statusNote: 'Amendment 1: the schedule was made again for the new total.' },
      { status: 'OPEN', amount: 400_892, statusNote: null },
    ])
    expect((await events('sales_order.amended', manual.id)).map((event) => event.payload)).toEqual([expect.objectContaining({ revision: 1, reacceptanceNeeded: true })])
    // The append-only ledger: nobody changes an amendment, the owner included.
    await expect(admin(`UPDATE "SalesOrderAmendment" SET reason = 'x' WHERE "orderId" = $1`, [manual.id])).rejects.toThrow(/append-only/)
    const list = await ok('sales', 'GET', `${orderUrl(manual.id)}/amendments`)
    expect(list.amendments.map((entry: Json) => [entry.revision, entry.reacceptance, entry.diff.lines.length])).toEqual([[1, 'NEEDED', 2]])
    manual = applied.order
  })

  it('numbers after what the order has (SEED-SO-0001 has amendment 1); a line in work orders may drop under them (B-SA-042), and is closed short when left out (B-OP-014)', async () => {
    const so1 = await recordOf(seeded.money.sales.orderId)
    const first = so1.lines[0]
    const bump = first.sizes.map((size: Json, index: number) => ({ size: size.size, quantity: size.quantity + (index === 0 ? 1 : 0) }))
    const applied = await ok('sales', 'POST', `${orderUrl(so1.id)}/amendments`, { version: so1.version, reason: 'One more of the first size.', lines: [{ id: first.id, sizes: bump }, ...so1.lines.slice(1).map((line: Json) => ({ id: line.id }))] }, 201)
    expect(applied.amendment.revision).toBe(2)
    // SEED-SO-0002: WO-0001 makes BLK 52 twice (WO-0002 once more) — B-SA-042 (P6', R1): a size may now go under what work orders
    // make (the gap is proposed to them, never below what is cut); the preview names the extra pieces it would leave. B-OP-014: a line
    // in work orders left out is closed short (never deleted: their cells point at it), not refused.
    const so2 = await recordOf(seeded.money.shipping.quality.production.salesOrderId)
    const blk = so2.lines.find((line: Json) => line.colourway.code === 'BLK')
    const red = so2.lines.find((line: Json) => line.colourway.code === 'RED')
    const lower = await ok('sales', 'POST', `${orderUrl(so2.id)}/amendments/preview`, { reason: 'Fewer.', lines: [{ id: blk.id, sizes: grid([['50', 1], ['52', 1], ['54', 1]]) }, { id: red.id }] })
    expect((lower.problems as Json[]).some((issue) => /work orders already make/.test(issue.message))).toBe(false)
    expect(lower.workOrders).toMatchObject({ extra: expect.any(Array), needsOutcome: expect.any(Boolean) })
    const removal = await ok('sales', 'POST', `${orderUrl(so2.id)}/amendments/preview`, { reason: 'Only black.', lines: [{ id: blk.id }] })
    expect(removal).toMatchObject({ ok: true, problems: [] })
    expect(removal.diff.lines.map((line: Json) => [line.change, line.seq, line.closedShort])).toEqual([['REMOVED', 20, true]])
    expect(removal.workOrders.plan.length).toBeGreaterThan(0)
  })
})

// ── B-OP-013 (order page plan N2, D1 + D3; 13-backend §1.3): each preview says what the apply then does, for Sales and the Owner ──
/** Rows written whole, the database's rules off for them (as an import would). */
async function planted(rows: readonly { sql: string; values: unknown[] }[]): Promise<void> {
  await h.db.admin.query('BEGIN')
  try {
    await h.db.admin.query("SET LOCAL session_replication_role = 'replica'")
    for (const row of rows) await h.db.admin.query(row.sql, row.values)
    await h.db.admin.query('COMMIT')
  } catch (error) {
    await h.db.admin.query('ROLLBACK')
    throw error
  }
}
const copyRow = (table: string, from: string, over: Json) => ({ sql: `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, values: [JSON.stringify(over), from] })
let copies = 0
/**
 * SEED-SO-0002 copied whole, nothing shipped (IN_PRODUCTION): its lines BLK 1/2/1 and RED 1/1/1 of 50/52/54, made by a copy of
 * WO-0001 (in progress, both colours, nothing cut on the copy) and of WO-0002 (a DRAFT of one cell, BLK 52).
 */
async function orderInWork(): Promise<{ id: string; version: number; blk: Json; red: Json; inProgress: string; draft: string }> {
  const source = seeded.money.shipping.quality.production.salesOrderId
  const tag = `T-OP013-${++copies}`
  const lines = await admin<{ id: string }>('SELECT id::text AS id FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq', [source])
  const lineIds = lines.map((line) => line.id)
  const sizes = await admin<{ id: string; lineId: string }>('SELECT id::text AS id, "lineId"::text AS "lineId" FROM "SalesOrderLineSize" WHERE "lineId" = ANY($1::uuid[])', [lineIds])
  const cells = await admin<{ id: string; workOrderId: string; salesOrderLineId: string }>('SELECT id::text AS id, "workOrderId"::text AS "workOrderId", "salesOrderLineId"::text AS "salesOrderLineId" FROM "WorkOrderSize" WHERE "salesOrderLineId" = ANY($1::uuid[])', [lineIds])
  const workOrders = await admin<{ id: string; status: string }>('SELECT id::text AS id, status::text AS status FROM "WorkOrder" WHERE id = ANY($1::uuid[]) ORDER BY number', [[...new Set(cells.map((cell) => cell.workOrderId))]])
  const orderId = newId()
  const lineOf = new Map(lineIds.map((id) => [id, newId()]))
  const workOrderOf = new Map(workOrders.map((row) => [row.id, newId()]))
  const seq = (await one<{ seq: number }>('SELECT coalesce(max(o."customerSeq"), 0) + 1 AS seq FROM "SalesOrder" o JOIN "SalesOrder" f ON f.id = $1 WHERE o."tenantId" = f."tenantId" AND o."companyId" = f."companyId" AND o."partyId" = f."partyId"', [source])).seq
  await planted([
    copyRow('SalesOrder', source, { id: orderId, number: tag, status: 'IN_PRODUCTION', version: 1, reapprovalNeededAt: null, customerSeq: seq }),
    ...lineIds.map((id) => copyRow('SalesOrderLine', id, { id: lineOf.get(id), orderId, closedShortQuantity: null, closedShortAt: null, closedShortById: null, closeShortReason: null, closedShortReasonCode: null, version: 1 })),
    ...sizes.map((size) => copyRow('SalesOrderLineSize', size.id, { id: newId(), lineId: lineOf.get(size.lineId) })),
    ...workOrders.map((row, index) => copyRow('WorkOrder', row.id, { id: workOrderOf.get(row.id), number: `${tag}-WO${index + 1}`, batchNumber: row.status === 'DRAFT' ? null : `${tag}-BT${index + 1}`, version: 1 })),
    ...cells.map((cell) => copyRow('WorkOrderSize', cell.id, { id: newId(), workOrderId: workOrderOf.get(cell.workOrderId), salesOrderLineId: lineOf.get(cell.salesOrderLineId), version: 1 })),
  ])
  const record = await recordOf(orderId)
  return {
    id: orderId,
    version: record.version,
    blk: record.lines.find((line: Json) => line.colourway.code === 'BLK'),
    red: record.lines.find((line: Json) => line.colourway.code === 'RED'),
    inProgress: workOrderOf.get(workOrders.find((row) => row.status !== 'DRAFT')!.id)!,
    draft: workOrderOf.get(workOrders.find((row) => row.status === 'DRAFT')!.id)!,
  }
}
/** BLK 52 down from 2 to 1: the DRAFT's one cell goes (it is cancelled), the work order in progress makes one less. */
const fewerBlack = (order: { blk: Json; red: Json }) => ({ reason: 'One black 52 less.', lines: [{ id: order.blk.id, sizes: grid([['50', 1], ['52', 1], ['54', 1]]) }, { id: order.red.id }] })
/** The plan's rows as the apply answers them: the ones that follow now, and the ones that wait. */
const asApplied = (plan: Json[]) => plan.filter((row) => row.appliesNow).map((row) => [row.workOrderId, row.number, row.route, row.reprint])
const asWaiting = (plan: Json[]) => plan.filter((row) => !row.appliesNow).map((row) => [row.workOrderId, row.number, row.held])
const cellsOfWorkOrder = (workOrderId: string) => admin<{ size: string; quantity: number }>('SELECT size, quantity FROM "WorkOrderSize" WHERE "workOrderId" = $1 ORDER BY "colourwayId", size', [workOrderId])
const statusOfWorkOrder = async (workOrderId: string) => (await one<{ status: string }>('SELECT status::text AS status FROM "WorkOrder" WHERE id = $1', [workOrderId])).status

describe('B-OP-013: the previews say what the work orders will do — and the apply then does exactly that', () => {
  it('Sales: the DRAFT follows in the click, the work order in progress waits for production; nothing named to Sales', async () => {
    const order = await orderInWork()
    const preview = await ok('sales', 'POST', `${orderUrl(order.id)}/amendments/preview`, fewerBlack(order))
    expect(preview).toMatchObject({ ok: true, workOrders: { extra: [], needsOutcome: false } })
    const plan = preview.workOrders.plan as Json[]
    expect(plan.map((row) => [row.kind, row.route, row.appliesNow, row.cells.map((cell: Json) => [cell.size, cell.from, cell.to, cell.cut])])).toEqual([
      ['LOWER_TO_ORDER', 'CANCEL_WORK_ORDER', true, [['52', 1, 0, 0]]],
      ['LOWER_TO_ORDER', 'LOWER_RELEASED', false, [['52', 2, 1, 0]]],
    ])
    // The wall: Sales holds no workorders.view — no id, number or status, words that name no work order.
    for (const row of plan) expect(row).toMatchObject({ workOrderId: null, number: null, status: null })
    expect(plan[1]).toMatchObject({ held: { en: 'A work order waits: production applies the change on its own page.' }, reprint: true })
    const applied = await ok('sales', 'POST', `${orderUrl(order.id)}/amendments`, { version: order.version, ...fewerBlack(order) }, 201)
    expect(applied.workOrders.applied.map((entry: Json) => [entry.workOrderId, entry.number, entry.route, entry.reprint])).toEqual(asApplied(plan))
    expect(applied.workOrders.waiting.map((entry: Json) => [entry.workOrderId, entry.number, entry.words])).toEqual(asWaiting(plan))
    expect(await statusOfWorkOrder(order.draft)).toBe('CANCELLED')
    expect((await cellsOfWorkOrder(order.inProgress)).find((cell) => cell.size === '52' && cell.quantity === 2)).toBeDefined()
  })

  it('the Owner: both follow in the click, the one in progress lowered with its reprint mark — as the preview said', async () => {
    const order = await orderInWork()
    const preview = await ok('owner', 'POST', `${orderUrl(order.id)}/amendments/preview`, fewerBlack(order))
    const plan = preview.workOrders.plan as Json[]
    expect(plan.map((row) => [row.workOrderId, row.status === 'DRAFT', row.route, row.appliesNow, row.held, row.reprint])).toEqual([
      [order.draft, true, 'CANCEL_WORK_ORDER', true, null, false],
      [order.inProgress, false, 'LOWER_RELEASED', true, null, true],
    ])
    expect(plan.every((row) => typeof row.number === 'string' && row.number.startsWith('T-OP013-'))).toBe(true)
    const applied = await ok('owner', 'POST', `${orderUrl(order.id)}/amendments`, { version: order.version, ...fewerBlack(order) }, 201)
    expect(applied.workOrders.applied.map((entry: Json) => [entry.workOrderId, entry.number, entry.route, entry.reprint])).toEqual(asApplied(plan))
    expect(applied.workOrders.waiting).toEqual([])
    expect(await statusOfWorkOrder(order.draft)).toBe('CANCELLED')
    expect((await cellsOfWorkOrder(order.inProgress)).filter((cell) => cell.size === '52').map((cell) => cell.quantity).sort()).toEqual([1, 1])
  })

  it('the close of lines has its preview: what it closes, and each work order as the close then carries it', async () => {
    const order = await orderInWork()
    const body = { lineIds: [order.blk.id] }
    const preview = await ok('owner', 'POST', `${orderUrl(order.id)}/close-lines/preview`, body)
    expect(preview).toMatchObject({ ok: true, version: order.version, problems: [], closed: [{ lineId: order.blk.id, seq: order.blk.seq, closedShortQuantity: 4 }], workOrders: { extra: [], needsOutcome: false } })
    // The rows in the gap's order (its sizes as read): compared by route here, and row for row with the close's answer below.
    const plan = preview.workOrders.plan as Json[]
    expect(plan.map((row) => [row.workOrderId, row.route, row.appliesNow]).sort((a, b) => String(a[1]).localeCompare(String(b[1])))).toEqual([
      [order.draft, 'CANCEL_WORK_ORDER', true],
      [order.inProgress, 'LOWER_RELEASED', true],
    ])
    // Nothing was written by the preview.
    expect(await statusOfWorkOrder(order.draft)).toBe('DRAFT')
    const closed = await ok('owner', 'POST', `${orderUrl(order.id)}/close-lines`, { version: preview.version, reason: 'The customer takes the red ones only.', ...body })
    expect(closed.closed).toEqual(preview.closed)
    expect(closed.workOrders.applied.map((entry: Json) => [entry.workOrderId, entry.number, entry.route, entry.reprint])).toEqual(expect.arrayContaining(asApplied(plan)))
    expect(closed.workOrders.applied).toHaveLength(plan.length)
    expect(closed.workOrders.waiting).toEqual([])
    // A state that takes no close is a 409, as the close; a line named twice comes back as a problem.
    const twice = await ok('owner', 'POST', `${orderUrl(order.id)}/close-lines/preview`, { lineIds: [order.red.id, order.red.id] })
    expect(twice).toMatchObject({ ok: false, workOrders: null, problems: [{ path: 'body/lineIds/1', message: 'This line is named twice.' }] })
  })

  it('the cancel check names each work order too; its extra pieces never hold the cancel (production decides without an outcome)', async () => {
    const order = await orderInWork()
    // Every line wants none: each work order's every cell goes to 0, so each is cancelled (nothing is cut on the copies).
    const sales = await ok('sales', 'GET', `${orderUrl(order.id)}/cancel-check`)
    expect(sales.workOrders).toMatchObject({ extra: [], needsOutcome: false, words: null })
    expect((sales.workOrders.plan as Json[]).map((row) => [row.route, row.appliesNow, row.number]).sort((a, b) => Number(b[1]) - Number(a[1]))).toEqual([
      ['CANCEL_WORK_ORDER', true, null],
      ['CANCEL_WORK_ORDER', false, null],
    ])
    const owner = await ok('owner', 'GET', `${orderUrl(order.id)}/cancel-check`)
    expect((owner.workOrders.plan as Json[]).map((row) => [row.workOrderId, row.appliesNow]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))).toEqual(
      [
        [order.draft, true],
        [order.inProgress, true],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    )
  })

  it('the wall: another customer\'s order is not found, in the words of an unknown id; Sales without the right is refused', async () => {
    const order = await orderInWork()
    const unknown = await refused('salesP3', 'POST', `${orderUrl(newId())}/close-lines/preview`, {}, 404)
    const walled = await refused('salesP3', 'POST', `${orderUrl(order.id)}/close-lines/preview`, {}, 404)
    expect(walled).toMatchObject({ code: 'not_found', message: 'Sales order not found.' })
    expect(walled.message).toBe(unknown.message)
    expect(JSON.stringify(walled)).not.toContain('T-OP013-')
    await refused('viewer', 'POST', `${orderUrl(order.id)}/close-lines/preview`, {}, 403)
  })
})
// ── end B-OP-013 ──

// ── B-OP-014 (order page plan N1; 13-backend §1.4): a line in work orders left out of an amendment is closed short in its command ──
describe('B-OP-014: a line work orders make, left out of an amendment, is closed short — its cut pieces need their outcome', () => {
  it('held without the outcome (nothing written); with it ONE command closes the line short, never deleted, and its gap goes to the work orders', async () => {
    const order = await orderInWork()
    // 2 of the BLK 52 pieces on the work order in progress are bundled: cut.
    const cell = await one<{ id: string }>(`SELECT id::text AS id FROM "WorkOrderSize" WHERE "workOrderId" = $1 AND "salesOrderLineId" = $2 AND size = '52'`, [order.inProgress, order.blk.id])
    await planted([{ sql: `INSERT INTO "Bundle" (id, "tenantId", "siteId", "workOrderId", "workOrderSizeId", code, quantity) SELECT $1, "tenantId", "siteId", $2, $3, $4, 2 FROM "WorkOrderSize" WHERE id = $3::uuid`, values: [newId(), order.inProgress, cell.id, `T-OP014-BN-${cell.id.slice(-8)}`] }])
    const body = { reason: 'The customer drops the black jackets.', lines: [{ id: order.red.id }] }

    const preview = await ok('sales', 'POST', `${orderUrl(order.id)}/amendments/preview`, body)
    expect(preview).toMatchObject({ ok: false, problems: [], workOrders: { needsOutcome: true, words: { en: 'Choose what happens to the 2 extra pieces' } } })
    expect(preview.diff.lines.map((line: Json) => [line.change, line.lineId, line.piecesBefore, line.piecesAfter, line.closedShort])).toEqual([['REMOVED', order.blk.id, 4, 0, true]])
    // Closing short moves no money: the line keeps its price (a closed line is not billed); no new acceptance for it.
    expect(preview.diff).toMatchObject({ netAmountBefore: preview.diff.netAmountAfter, reacceptanceNeeded: false })
    expect(preview.workOrders.extra.map((entry: Json) => [entry.size, entry.count])).toEqual([['52', 2]])

    const held = await refused('sales', 'POST', `${orderUrl(order.id)}/amendments`, { version: order.version, ...body }, 409)
    expect(held.issues).toEqual([{ path: 'refusal/EXTRA_OUTCOME', message: 'Choose what happens to the 2 extra pieces' }])
    expect(await one('SELECT "closedShortQuantity" AS closed FROM "SalesOrderLine" WHERE id = $1', [order.blk.id])).toEqual({ closed: null })

    const applied = await ok('sales', 'POST', `${orderUrl(order.id)}/amendments`, { version: order.version, ...body, extraOutcome: 'LEFTOVER' }, 201)
    expect(await one('SELECT "closedShortQuantity" AS closed, "closeShortReason" AS reason, "closedShortById"::text AS by FROM "SalesOrderLine" WHERE id = $1', [order.blk.id])).toEqual({ closed: 4, reason: body.reason, by: SALES_ACTOR })
    expect(applied.order.lines.find((line: Json) => line.id === order.blk.id)).toMatchObject({ closedShort: { quantity: 4, reason: body.reason } })
    expect(applied.amendment.diff.lines).toEqual([expect.objectContaining({ change: 'REMOVED', lineId: order.blk.id, closedShort: true })])
    // The work orders, as the preview said: the DRAFT's one cell (BLK 52) goes with the click, so it is cancelled; the work order in
    // progress waits for production (Sales holds no workorders.manage) with its 2 cut pieces kept as leftover — never below cut.
    expect(applied.workOrders.applied.map((entry: Json) => entry.route)).toEqual(['CANCEL_WORK_ORDER'])
    expect(applied.workOrders.waiting).toHaveLength(1)
    expect(await statusOfWorkOrder(order.draft)).toBe('CANCELLED')
    expect(await one(`SELECT status::text AS status, "extraOutcome"::text AS outcome, extra FROM "WorkOrderChange" WHERE "workOrderId" = $1 AND "amendmentId" = $2`, [order.inProgress, applied.amendment.id])).toMatchObject({
      status: 'PROPOSED',
      outcome: 'LEFTOVER',
      extra: [expect.objectContaining({ workOrderSizeId: cell.id, size: '52', count: 2 })],
    })
    // Announced as a close of lines is (the floor's note, the settlement), beside the amendment.
    expect((await events('sales_order.lines_closed', order.id)).map((event) => event.payload)).toEqual([expect.objectContaining({ change: 'CLOSED', lineIds: [order.blk.id], partyId: P1 })])
    expect((await events('sales_order.amended', order.id)).map((event) => event.payload.lineIds)).toEqual([[order.blk.id]])
  })

  it('a line closed short already is never left out; reopen it first', async () => {
    const order = await orderInWork()
    const closed = await ok('sales', 'POST', `${orderUrl(order.id)}/close-lines`, { version: order.version, reason: 'No red after all.', lineIds: [order.red.id] })
    const refusedLeave = await ok('sales', 'POST', `${orderUrl(order.id)}/amendments/preview`, { reason: 'Only black.', lines: [{ id: order.blk.id }] })
    expect(refusedLeave).toMatchObject({ ok: false, diff: null, problems: [{ path: 'body/lines', message: `Line ${order.red.seq} is closed short: reopen it before removing it.` }] })
    expect(closed.order.version).toBeGreaterThan(order.version)
  })
})
// ── end B-OP-014 ──

describe('the cancel with its impact check (SAL-211)', () => {
  it('SEED-SO-0002: names what stops it (a draft work order, goods that left, a draft invoice) and what it would leave behind', async () => {
    const so2 = seeded.money.shipping.quality.production.salesOrderId
    const check = await ok('sales', 'GET', `${orderUrl(so2)}/cancel-check`)
    expect(check.impact.cancellable).toBe(false)
    expect(check.impact.blocks.map((item: Json) => item.code)).toEqual(['DRAFT_WORK_ORDERS', 'SHIPPED', 'INVOICE_DRAFT'])
    expect(check.impact.leavesBehind.map((item: Json) => item.code)).toEqual(expect.arrayContaining(['WORK_ORDERS_OPEN', 'LEATHER_CUT']))
    expect(check.leatherCut).toEqual([expect.objectContaining({ number: 'SEED-WO-0001', hides: 1 })])
    const refusedCancel = await refused('sales', 'POST', `${orderUrl(so2)}/cancel`, { version: (await recordOf(so2)).version, reason: 'The customer withdrew.' }, 409)
    expect(refusedCancel.message).toMatch(/draft work orders cancelled first \(SEED-WO-0002\)/)
    expect(refusedCancel.message).toMatch(/a fiscal document is never deleted|Draft invoices of the order/)
  })

  it('a typed order: its open deposit and steps are cancelled with it, the typed number confirms it', async () => {
    const second = (await ok('sales', 'POST', '/sales/orders/manual', { ...MANUAL, customerRef: 'PO-REPEAT-78', lines: [MANUAL.lines[0]] }, 201)).order
    const check = await ok('sales', 'GET', `${orderUrl(second.id)}/cancel-check`)
    expect(check.impact).toMatchObject({ cancellable: true, blocks: [], leavesBehind: [] })
    // B-W2a-F2: the deposit and the balance's own request, both open, are cancelled with it.
    expect(check.impact.touches.map((item: Json) => [item.code, item.amount, item.message])).toEqual([
      ['DEPOSITS_CANCELLED', 204_960, 'The deposit and the balance before shipping not paid yet are cancelled with the order: the customer is no longer asked for them.'],
      ['PAYMENT_STEPS_CANCELLED', 204_960, '2 open step(s) of the payment schedule are cancelled.'],
    ])
    const wrong = await refused('sales', 'POST', `${orderUrl(second.id)}/cancel`, { version: second.version, reason: 'Duplicate order.', confirmNumber: 'SO-WRONG' }, 400)
    expect(wrong.issues).toEqual([{ path: 'body/confirmNumber', message: `Type ${second.number} to confirm.` }])
    const cancelled = await ok('sales', 'POST', `${orderUrl(second.id)}/cancel`, { version: second.version, reason: 'Duplicate order.', confirmNumber: second.number })
    expect(cancelled.order).toMatchObject({ status: 'CANCELLED', cancelReason: 'Duplicate order.' })
    expect(cancelled.impact.touches.map((item: Json) => item.code)).toEqual(['DEPOSITS_CANCELLED', 'PAYMENT_STEPS_CANCELLED'])
    const schedule = await ok('sales', 'GET', `${orderUrl(second.id)}/schedule`)
    expect(schedule.steps).toEqual([])
    expect(schedule.cancelled.map((step: Json) => step.statusNote)).toEqual([`Order ${second.number} cancelled: Duplicate order.`, `Order ${second.number} cancelled: Duplicate order.`])
    expect(await admin('SELECT status::text AS status FROM "DepositRequest" WHERE "orderId" = $1', [second.id])).toEqual([{ status: 'CANCELLED' }, { status: 'CANCELLED' }])
  })

  it('SEED-SO-0001: a paid deposit and its deposit invoice are left behind, named; the cancelled order copies as a new quote', async () => {
    const so1 = await recordOf(seeded.money.sales.orderId)
    const cancelled = await ok('sales', 'POST', `${orderUrl(so1.id)}/cancel`, { version: so1.version, reason: 'The brand stopped the line.' })
    expect(cancelled.order.status).toBe('CANCELLED')
    const paid = cancelled.impact.leavesBehind.find((item: Json) => item.code === 'DEPOSIT_PAID')
    expect(paid).toMatchObject({ refs: expect.arrayContaining([expect.objectContaining({ type: 'Invoice', number: 'FT-2026-00003' })]) })
    expect(cancelled.paidDepositRequestIds).toEqual([seeded.money.sales.depositRequestId])
    const copy = await ok('sales', 'POST', `${orderUrl(so1.id)}/copy-as-quote`, {}, 201)
    expect(copy.quote).toMatchObject({ status: 'DRAFT', partyId: P1 })
    expect(copy.quote.lines.length).toBe(so1.lines.length)
    expect(copy.quote.lines.map((line: Json) => line.unitPrice)).toEqual(so1.lines.map((line: Json) => line.unitPrice))
    expect((await one(`SELECT after FROM "AuditLog" WHERE action = 'quotes.duplicate' AND "recordId" = $1`, [copy.quote.id])).after).toMatchObject({ from: { orderId: so1.id }, sameCustomer: true })
  })
})

describe('close remaining lines (SAL-210) and reopen them', () => {
  const so2 = () => seeded.money.shipping.quality.production.salesOrderId

  it('the shipped part stays, what is left will not be made: the order is SHIPPED, an approved reduction is done', async () => {
    // WO-0001 released and SH-0001 shipped 2 of 7: the order follows to PARTLY_SHIPPED.
    const production = seeded.money.shipping.quality.production
    await handler('sales.ordersFollowWorkOrders').handle(envelope('workorder.released', { workOrderId: production.workOrderId, number: 'SEED-WO-0001', salesOrderIds: [so2()] }), { caller: systemCaller(), attempt: 1 })
    expect((await recordOf(so2())).status).toBe('PARTLY_SHIPPED')
    // An approved REDUCE (B-W2a-13) of BLK 54 waits for the order line to be lowered.
    const reduceId = newId()
    await admin(
      `INSERT INTO "ReplacementRequest" (id, "tenantId", "companyId", "siteId", "workOrderId", "workOrderSizeId", kind, quantity, reason, status, "createdById", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, 'REDUCE', 1, 'Scrapped at sewing.', 'OPEN', $7, now())`,
      [reduceId, T, companyA, idIn('site:A1'), production.workOrderId, production.cellIds['BLK-54'], newId()],
    )
    await admin(`UPDATE "ReplacementRequest" SET status = 'APPROVED', "decidedAt" = now(), "decidedById" = $2 WHERE id = $1`, [reduceId, newId()])

    const record = await recordOf(so2())
    // B-OP-012: the released SEED-WO-0001's cells as they are before the close.
    const released = () => admin<{ id: string; quantity: number }>('SELECT id::text AS id, quantity FROM "WorkOrderSize" WHERE "workOrderId" = $1 ORDER BY id', [production.workOrderId])
    const releasedBefore = await released()
    expect(record.dailyActions.find((action: Json) => action.action === 'amend')).toMatchObject({ allowed: false })
    await refused('sales', 'POST', `${orderUrl(so2())}/amendments`, { version: record.version, reason: 'More.', lines: record.lines.map((line: Json) => ({ id: line.id })) }, 409)
    await refused('sales', 'POST', `${orderUrl(so2())}/close-lines`, { version: record.version, reason: '  ' }, 400)
    const closed = await ok('sales', 'POST', `${orderUrl(so2())}/close-lines`, { version: record.version, reason: 'The customer takes what shipped; the rest is not made.' })
    expect(closed.closed.map((line: Json) => [line.seq, line.closedShortQuantity])).toEqual([
      [10, 3],
      [20, 2],
    ])
    expect(closed.reducesDone).toEqual([reduceId])
    expect((await one('SELECT status, "doneAt" FROM "ReplacementRequest" WHERE id = $1', [reduceId])).status).toBe('DONE')
    expect(closed.order).toMatchObject({ status: 'SHIPPED', progress: { ordered: 7, shipped: 2, toShip: 0, closedShort: 5 } })
    expect(closed.order.lines[0].closedShort).toMatchObject({ quantity: 3, byId: SALES_ACTOR, reason: 'The customer takes what shipped; the rest is not made.' })
    expect((await events('sales_order.lines_closed', so2())).map((event) => event.payload.change)).toEqual(['CLOSED'])
    expect((await events('sales_order.status_changed', so2())).at(-1)!.payload).toMatchObject({ from: 'PARTLY_SHIPPED', to: 'SHIPPED', by: 'person' })
    // B-OP-012 (D1, the wall): Sales (orders.manage, no workorders.manage nor workorders.view) closes — the released SEED-WO-0001
    // waits for production, untouched; the answer names no work order to a person who does not reach them.
    expect(await released()).toEqual(releasedBefore)
    expect(await admin('SELECT status::text AS status FROM "WorkOrderChange" WHERE "workOrderId" = $1', [production.workOrderId])).toEqual(expect.arrayContaining([{ status: 'PROPOSED' }]))
    expect(closed.workOrders.waiting.length).toBeGreaterThan(0)
    for (const entry of [...closed.workOrders.applied, ...closed.workOrders.waiting]) expect(entry).toMatchObject({ workOrderId: null, number: null })
    for (const entry of closed.workOrders.waiting) expect(entry.words).toEqual({ en: 'A work order waits: production applies the change on its own page.', it: 'Un ordine di lavoro è in attesa: la modifica la applica la produzione dalla sua pagina.' })
    expect(JSON.stringify(closed.workOrders)).not.toMatch(/SEED-WO-/)
  })

  it('reopen lines: the closed pieces are back to ship, the order PARTLY_SHIPPED again', async () => {
    const record = await recordOf(so2())
    const reopened = await ok('sales', 'POST', `${orderUrl(so2())}/reopen-lines`, { version: record.version, reason: 'The customer wants the rest after all.', lineIds: [record.lines[0].id] })
    expect(reopened.reopened).toEqual([record.lines[0].id])
    expect(reopened.order).toMatchObject({ status: 'PARTLY_SHIPPED', progress: { toShip: 3, closedShort: 2 } })
    expect(reopened.order.lines.map((line: Json) => line.closedShort?.quantity ?? null)).toEqual([null, 2])
    const again = await refused('sales', 'POST', `${orderUrl(so2())}/reopen-lines`, { version: reopened.order.version, reason: 'Again.', lineIds: [record.lines[0].id] }, 400)
    expect(again.issues).toEqual([{ path: 'body/lineIds/0', message: 'Line 10 is not closed short.' }])
  })
})

describe('duplicate a quote (SAL-155)', () => {
  it('a new DRAFT with its own number, the lines copied and costed again; for another customer its own terms', async () => {
    const source = (await ok('sales', 'GET', `/sales/quotes/${seeded.money.sales.quoteId}`)).quote
    const copy = await ok('sales', 'POST', `/sales/quotes/${source.id}/duplicate`, { customerRef: 'RFQ-AGAIN' }, 201)
    expect(copy.quote).toMatchObject({ status: 'DRAFT', partyId: P1, customerRef: 'RFQ-AGAIN', current: { revision: 1, status: 'DRAFT' } })
    expect(copy.quote.number).not.toBe(source.number)
    expect(copy.quote.lines.map((line: Json) => [line.colourwayId, line.quantity])).toEqual(source.lines.map((line: Json) => [line.colourwayId, line.quantity]))
    expect(copy.dropped).toEqual([])
    const audit = await one(`SELECT after FROM "AuditLog" WHERE action = 'quotes.duplicate' AND "recordId" = $1`, [copy.quote.id])
    expect(audit.after).toMatchObject({ from: { quoteId: source.id, versionId: source.current.id }, sameCustomer: true })
    expect((await events('quote.created', copy.quote.id)).length).toBe(1)

    const other = await ok('sales', 'POST', `/sales/quotes/${source.id}/duplicate`, { partyId: P3 }, 201)
    expect(other.quote).toMatchObject({ partyId: P3, status: 'DRAFT' })
    expect(other.quote.current.taxMode).toBe('EU_B2B')
    await refused('viewer', 'POST', `/sales/quotes/${source.id}/duplicate`, {}, 403)
  })
})
