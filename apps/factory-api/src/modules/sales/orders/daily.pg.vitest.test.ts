import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
const SESSIONS: Record<string, () => SessionContext> = {
  sales: office(SALES, SALES_ACTOR),
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
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
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
    expect(manual.chain.depositRequests).toEqual([expect.objectContaining({ orderId: manual.id, quoteVersionId: null, status: 'OPEN', amount: 105_408, depositPct: '30' })])
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
    expect(schedule.steps.map((step: Json) => [step.seq, step.kind, step.amount, step.status, step.dueDate])).toEqual([
      [10, 'DEPOSIT', 105_408, 'OPEN', manual.chain.depositRequests[0].dueDate],
      [20, 'BEFORE_SHIPPING', 245_952, 'OPEN', PROMISE],
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
    expect((await events('sales_order.amended', manual.id)).map((event) => event.payload)).toEqual([expect.objectContaining({ revision: 1, reacceptanceNeeded: true })])
    // The append-only ledger: nobody changes an amendment, the owner included.
    await expect(admin(`UPDATE "SalesOrderAmendment" SET reason = 'x' WHERE "orderId" = $1`, [manual.id])).rejects.toThrow(/append-only/)
    const list = await ok('sales', 'GET', `${orderUrl(manual.id)}/amendments`)
    expect(list.amendments.map((entry: Json) => [entry.revision, entry.reacceptance, entry.diff.lines.length])).toEqual([[1, 'NEEDED', 2]])
    manual = applied.order
  })

  it('numbers after what the order has (SEED-SO-0001 has amendment 1); a line in work orders never drops under them', async () => {
    const so1 = await recordOf(seeded.money.sales.orderId)
    const first = so1.lines[0]
    const bump = first.sizes.map((size: Json, index: number) => ({ size: size.size, quantity: size.quantity + (index === 0 ? 1 : 0) }))
    const applied = await ok('sales', 'POST', `${orderUrl(so1.id)}/amendments`, { version: so1.version, reason: 'One more of the first size.', lines: [{ id: first.id, sizes: bump }, ...so1.lines.slice(1).map((line: Json) => ({ id: line.id }))] }, 201)
    expect(applied.amendment.revision).toBe(2)
    // SEED-SO-0002: WO-0001 makes BLK 52 twice (WO-0002 once more) — a size never goes under it, a line in work orders is never removed.
    const so2 = await recordOf(seeded.money.shipping.quality.production.salesOrderId)
    const blk = so2.lines.find((line: Json) => line.colourway.code === 'BLK')
    const red = so2.lines.find((line: Json) => line.colourway.code === 'RED')
    const lower = await ok('sales', 'POST', `${orderUrl(so2.id)}/amendments/preview`, { reason: 'Fewer.', lines: [{ id: blk.id, sizes: grid([['50', 1], ['52', 1], ['54', 1]]) }, { id: red.id }] })
    expect(lower.problems).toEqual([{ path: 'body/lines/0/sizes', message: 'Size 52: work orders already make 3 piece(s); lower the work order first (1 asked).' }])
    const removal = await ok('sales', 'POST', `${orderUrl(so2.id)}/amendments/preview`, { reason: 'Only black.', lines: [{ id: blk.id }] })
    expect(removal.problems.map((issue: Json) => issue.message)).toEqual([expect.stringMatching(/^Line 20 is in work orders \(3 piece\(s\)\): it cannot be removed/)])
  })
})

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
    expect(check.impact.touches.map((item: Json) => [item.code, item.amount])).toEqual([
      ['DEPOSITS_CANCELLED', 61_488],
      ['PAYMENT_STEPS_CANCELLED', 204_960],
    ])
    const wrong = await refused('sales', 'POST', `${orderUrl(second.id)}/cancel`, { version: second.version, reason: 'Duplicate order.', confirmNumber: 'SO-WRONG' }, 400)
    expect(wrong.issues).toEqual([{ path: 'body/confirmNumber', message: `Type ${second.number} to confirm.` }])
    const cancelled = await ok('sales', 'POST', `${orderUrl(second.id)}/cancel`, { version: second.version, reason: 'Duplicate order.', confirmNumber: second.number })
    expect(cancelled.order).toMatchObject({ status: 'CANCELLED', cancelReason: 'Duplicate order.' })
    expect(cancelled.impact.touches.map((item: Json) => item.code)).toEqual(['DEPOSITS_CANCELLED', 'PAYMENT_STEPS_CANCELLED'])
    const schedule = await ok('sales', 'GET', `${orderUrl(second.id)}/schedule`)
    expect(schedule.steps).toEqual([])
    expect(schedule.cancelled.map((step: Json) => step.statusNote)).toEqual([`Order ${second.number} cancelled: Duplicate order.`, `Order ${second.number} cancelled: Duplicate order.`])
    expect((await one('SELECT status FROM "DepositRequest" WHERE "orderId" = $1', [second.id])).status).toBe('CANCELLED')
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
