import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { heldByDepositInvoiceWords, UNDO_HELD_WORDS } from '@nexus/factory-domain/sales/orders/money-plan'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedMoney, type MoneySeed } from '../../../../../../packages/factory-db/seed/money'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'

/**
 * B-OM-004 — an order's money plan, read (order money tab M4-B1, B12, M3 §2c; 13-backend §1): GET /sales/orders/:orderId/schedule
 * on the local stack (a throwaway PostgreSQL 17 database from the migrations, the core and money seeds, the app's real routes with
 * test sessions). SEED-SO-0003 of Brand Alpha (the seeds' P1) gets a plan written beside the seed with the database's rules off
 * for those rows (as an order of the time would have it):
 *
 *   DEPOSIT 300.00 (its request R1, TD02) — 100.00 paid, its deposit invoice issued: the undo is held, "a credit note first"
 *   BEFORE_SHIPPING 500.00 (its request R2) — due yesterday, 50.00 paid: overdue 450.00; its due day moved by hand (the audit)
 *   ON_INVOICE 224.80 — no request: the goods' invoice of the order is paid in full, so it is "Paid with the invoices"
 *   an extra deposit 50.00 (R3), asked by the order's priced change revision 1, no step
 *
 * Finance (orders.view, payments.view/record/void, the price grain) reads every figure, the payments and the undo verdicts; a
 * reader without payments.record and payments.void reads the payments with no undo door; the real Sales template reads no amount,
 * no reason and no payment's amount; a person limited to another customer gets the same words as an unknown order. Every name,
 * number and amount is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/sales/orders/money-plan.pg`.
 */

type Json = Record<string, any>
const NS = 'om-money-plan'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')
const TODAY = () => businessDate(new Date())
const dayPlus = (days: number): string => {
  const at = new Date(`${TODAY()}T00:00:00.000Z`)
  at.setUTCDate(at.getUTCDate() + days)
  return at.toISOString().slice(0, 10)
}

const FINANCE_USER = newId()
const ids = {
  r1: newId(),
  r2: newId(),
  r3: newId(),
  depositStep: newId(),
  balanceStep: newId(),
  invoiceStep: newId(),
  amendment: newId(),
  td02: newId(),
  goods: newId(),
  pay1: newId(),
  pay2: newId(),
  pay3: newId(),
  alloc1: newId(),
  alloc2: newId(),
  alloc3: newId(),
}

const grant = (permissions: Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
function templateGrant(role: string): Grant {
  const template = templateOf(role)!
  return grant([...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)])
}
const SESSIONS: Record<string, () => SessionContext> = {
  finance: () => ({ audience: 'office', tenantId: T, actorId: FINANCE_USER, grants: [grant(['orders.view', 'payments.view', 'payments.record', 'payments.void', 'money.price'])] }),
  // B-OM-027: the same with invoices.view — the TD02's number is named.
  financeInvoices: () => ({ audience: 'office', tenantId: T, actorId: FINANCE_USER, grants: [grant(['orders.view', 'payments.view', 'payments.record', 'payments.void', 'invoices.view', 'money.price'])] }),
  viewer: () => ({ audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['orders.view', 'payments.view', 'money.price'])] }),
  sales: () => ({ audience: 'office', tenantId: T, actorId: newId(), grants: [templateGrant('sales')] }),
  otherCustomer: () => ({ audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['orders.view', 'payments.view', 'money.price'], [newId()])] }),
}

let h: Harness
let app: FastifyInstance
let money: MoneySeed
let orderId: string
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
/** Rows written with the database's rules off (its triggers): a world as an order of the time would have it. */
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
const copy = (table: string, from: string, over: Json) => ({ sql: `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, values: [JSON.stringify(over), from] })
async function read(session: string, url: string, status = 200): Promise<Json> {
  const response = await app.inject({ method: 'GET', url, headers: { 'x-test-session': session } })
  expect(response.statusCode, `${session} GET ${url}: ${response.body}`).toBe(status)
  return response.json() as Json
}
const plan = (session: string) => read(session, `/sales/orders/${orderId}/schedule`)

beforeAll(async () => {
  h = await startHarness('om_money_plan')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  money = await seedMoney({ db: h.database, namespace: NS })
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId }))
  orderId = money.shipping.quality.serialSalesOrderId
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, 'Made-up Finance Person', 'ACTIVE')`, [FINANCE_USER, T, `om-plan-finance-${FINANCE_USER.slice(-6)}@example.com`])
  const request = `INSERT INTO "DepositRequest" (id, "tenantId", "companyId", "partyId", "orderId", kind, "depositPct", currency, amount, "dueDate", "fiscalDocument", "fiscalRule") VALUES ($1, $2, $3, $4, $5, 'ACCONTO', NULL, 'EUR', $6, $7::date, 'TD02', 'DEPOSIT_INVOICE_IT')`
  const step = `INSERT INTO "SalesOrderMilestone" (id, "tenantId", "companyId", "orderId", "partyId", seq, kind, amount, "dueDate", "depositRequestId") VALUES ($1, $2, $3, $4, $5, $6, $7::"SalesMilestoneKind", $8, $9::date, $10)`
  const payment = `INSERT INTO "Payment" (id, "tenantId", "companyId", "partyId", amount, "receivedOn", "externalRef") VALUES ($1, $2, $3, $4, $5, $6::date, $7)`
  const allocation = `INSERT INTO "PaymentAllocation" (id, "tenantId", "companyId", "partyId", "paymentId", "depositRequestId", "invoiceId", amount) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`
  await planted([
    { sql: request, values: [ids.r1, T, companyA, P1, orderId, 30000, dayPlus(10)] },
    { sql: request, values: [ids.r2, T, companyA, P1, orderId, 50000, dayPlus(-1)] },
    { sql: request, values: [ids.r3, T, companyA, P1, orderId, 5000, dayPlus(15)] },
    { sql: step, values: [ids.depositStep, T, companyA, orderId, P1, 10, 'DEPOSIT', 30000, dayPlus(10), ids.r1] },
    { sql: step, values: [ids.balanceStep, T, companyA, orderId, P1, 20, 'BEFORE_SHIPPING', 50000, dayPlus(-1), ids.r2] },
    { sql: step, values: [ids.invoiceStep, T, companyA, orderId, P1, 30, 'ON_INVOICE', 22480, null, null] },
    // The priced change (revision 1) that asked the extra deposit R3.
    {
      sql: `INSERT INTO "SalesOrderAmendment" (id, "tenantId", "companyId", "orderId", "partyId", revision, reason, before, after, "netAmountBefore", "netAmountAfter", "grossAmountBefore", "grossAmountAfter", "depositRequestId", "requestId") VALUES ($1, $2, $3, $4, $5, 1, 'Made-up: two more jackets.', '{}'::jsonb, '{}'::jsonb, 84000, 88100, 102480, 107480, $6, $7)`,
      values: [ids.amendment, T, companyA, orderId, P1, ids.r3, newId()],
    },
    // R1's deposit invoice (TD02) issued for the 100.00 paid; the order's goods invoice (TD01) of 224.80 — copies of the seed's FT-2026-00001.
    copy('Invoice', money.sampleInvoiceId, { id: ids.td02, docType: 'TD02', number: `FT-OM-${ids.td02.slice(-6)}`, status: 'ISSUED', depositRequestId: ids.r1, salesOrderId: orderId, creditOfId: null, grossTotal: 10000, xmlFileId: null, pdfFileId: null }),
    copy('Invoice', money.sampleInvoiceId, { id: ids.goods, docType: 'TD01', number: `FT-OM-${ids.goods.slice(-6)}`, status: 'ISSUED', depositRequestId: null, salesOrderId: orderId, creditOfId: null, grossTotal: 22480, xmlFileId: null, pdfFileId: null }),
    { sql: payment, values: [ids.pay1, T, companyA, P1, 10000, dayPlus(-3), 'OM-PLAN-0001'] },
    { sql: payment, values: [ids.pay2, T, companyA, P1, 5000, dayPlus(-2), 'OM-PLAN-0002'] },
    { sql: payment, values: [ids.pay3, T, companyA, P1, 22480, dayPlus(-1), 'OM-PLAN-0003'] },
    { sql: allocation, values: [ids.alloc1, T, companyA, P1, ids.pay1, ids.r1, null, 10000] },
    { sql: allocation, values: [ids.alloc2, T, companyA, P1, ids.pay2, ids.r2, null, 5000] },
    { sql: allocation, values: [ids.alloc3, T, companyA, P1, ids.pay3, null, ids.goods, 22480] },
    // The balance's due day moved by hand (what PR S2's POST …/money-plan writes): the read tags the step from this row.
    {
      sql: `INSERT INTO "AuditLog" (id, "tenantId", "companyId", audience, "actorId", action, "recordType", "recordId", after, reason, "requestId") VALUES ($1, $2, $3, 'OFFICE', $4, 'orders.planByHand', 'SalesOrder', $5, $6::jsonb, 'Made-up: the customer asked for a week more.', $7)`,
      values: [newId(), T, companyA, FINANCE_USER, orderId, JSON.stringify({ act: 'MOVE_DUE', milestoneIds: [ids.balanceStep], depositRequestIds: [ids.r2] }), newId()],
    },
  ])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null), logger: false },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('B-OM-004 the plan read: paid per step, ON_* covered, set by hand, every request with its payments', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('per step: what is paid on its request so far, how it is settled, what the invoices cover, its hand change', async () => {
    const answer = await plan('finance')
    const stepOf = (id: string) => (answer.steps as Json[]).find((row) => row.id === id)!
    expect(stepOf(ids.depositStep)).toMatchObject({ kind: 'DEPOSIT', status: 'OPEN', paidSoFar: 10000, settledBy: null, coveredByInvoices: 0, byHand: null })
    expect(stepOf(ids.balanceStep)).toMatchObject({ kind: 'BEFORE_SHIPPING', paidSoFar: 5000, settledBy: null, byHand: { act: 'MOVE_DUE', by: 'Made-up Finance Person', reason: 'Made-up: the customer asked for a week more.', at: expect.any(String) } })
    // The step stays OPEN in the database; the goods' invoice paid in full covers it (before: it never became Paid).
    expect(stepOf(ids.invoiceStep)).toMatchObject({ kind: 'ON_INVOICE', status: 'OPEN', paidSoFar: null, coveredByInvoices: 22480, settledBy: 'INVOICES' })
    // Overdue: the balance due yesterday, less the 50.00 paid on it.
    expect(answer.overdue).toBe(45000)
  })

  it('every request: its step, what is paid, the change that asked the extra deposit, its payments with the undo verdict', async () => {
    const answer = await plan('finance')
    const requestOf = (id: string) => (answer.requests as Json[]).find((row) => row.id === id)!
    expect(requestOf(ids.r1)).toMatchObject({ milestoneId: ids.depositStep, stepKind: 'DEPOSIT', status: 'OPEN', amount: 30000, paid: 10000, fromChange: null, replacedBy: null, acceptedShort: null, byHand: null })
    // The deposit invoice of R1 is issued: the undo is held, a credit note first (an Italian company's usual answer).
    // B-OM-027: the TD02 issued for this payment is named by id; its number only for invoices.view (this reader has none).
    expect(requestOf(ids.r1).payments).toEqual([
      { paymentId: ids.pay1, allocationId: ids.alloc1, receivedOn: dayPlus(-3), externalRef: 'OM-PLAN-0001', method: 'BANK_TRANSFER', amount: 10000, td02: { id: ids.td02, number: null }, undo: { may: false, why: UNDO_HELD_WORDS.DEPOSIT_INVOICE_ISSUED, code: 'DEPOSIT_INVOICE_ISSUED' } },
    ])
    // R2 has no deposit invoice yet: its part payment may be undone here.
    expect(requestOf(ids.r2)).toMatchObject({ milestoneId: ids.balanceStep, stepKind: 'BEFORE_SHIPPING', paid: 5000, byHand: { act: 'MOVE_DUE' } })
    expect(requestOf(ids.r2).payments).toEqual([expect.objectContaining({ paymentId: ids.pay2, amount: 5000, td02: null, undo: { may: true, why: null, code: null } })])
    // The extra deposit of the priced change: a row by request, no step, with its change.
    expect(requestOf(ids.r3)).toMatchObject({ milestoneId: null, stepKind: null, amount: 5000, paid: 0, fromChange: { amendmentId: ids.amendment, revision: 1 }, payments: [] })
  })

  // ── B-OM-027 (order money tab W-14): the TD02 issued for a payment, and the undo held by it naming its number ──
  it('B-OM-027: with invoices.view the payment names its TD02’s number, and the held words name it too (EN / IT)', async () => {
    const answer = await plan('financeInvoices')
    const r1 = (answer.requests as Json[]).find((row) => row.id === ids.r1)!
    const number = `FT-OM-${ids.td02.slice(-6)}`
    expect(r1.payments).toEqual([expect.objectContaining({ paymentId: ids.pay1, td02: { id: ids.td02, number }, undo: { may: false, why: heldByDepositInvoiceWords(number), code: 'DEPOSIT_INVOICE_ISSUED' } })])
    expect(r1.payments[0].undo.why.en).toBe(`A deposit invoice (TD02 ${number}) was issued for this payment: a credit note first, in Finance.`)
    // The balance's part payment has no TD02: none named, the undo free.
    const r2 = (answer.requests as Json[]).find((row) => row.id === ids.r2)!
    expect(r2.payments).toEqual([expect.objectContaining({ paymentId: ids.pay2, td02: null, undo: { may: true, why: null, code: null } })])
  })

  // ── B-OM-024 (order money tab W-01, W-02): short, and within the company's write-off tolerance or not ──
  it('B-OM-024: a part-paid open request is short; with no tolerance set it is never within it; nothing paid is not short', async () => {
    const answer = await plan('finance')
    const requestOf = (id: string) => (answer.requests as Json[]).find((row) => row.id === id)!
    // This world sets no write-off tolerance (neither the company's nor the tenant-wide one).
    expect(answer.tolerance).toBeNull()
    expect(requestOf(ids.r1).short).toEqual({ amount: 20000, withinTolerance: false })
    expect(requestOf(ids.r2).short).toEqual({ amount: 45000, withinTolerance: false })
    // Nothing placed on the extra deposit: not short (Accept short is not its act).
    expect(requestOf(ids.r3).short).toBeNull()
  })

  it('still open is the order read’s one figure (B-OM-002)', async () => {
    const answer = await plan('finance')
    const order = (await read('finance', `/sales/orders/${orderId}`)).order
    expect(answer.stillOpen).toBe(order.money.stillToPay)
  })

  it('a reader without payments.record and payments.void reads the payments, with no undo door and no words', async () => {
    const answer = await plan('viewer')
    const r2 = (answer.requests as Json[]).find((row) => row.id === ids.r2)!
    expect(r2.payments).toEqual([expect.objectContaining({ paymentId: ids.pay2, undo: { may: false, why: null, code: null } })])
  })
})

describe('B-OM-004 the walls: the money wall and the brand wall', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('the real Sales template reads the plan with no amount, no reason and no payment amount', async () => {
    const answer = await plan('sales')
    for (const key of ['grossAmount', 'openAmount', 'paidAmount', 'stillOpen', 'overdue', /* B-OM-024 */ 'tolerance']) expect(answer, key).not.toHaveProperty(key)
    for (const row of answer.steps as Json[]) for (const key of ['amount', 'paidSoFar', 'coveredByInvoices']) expect(row, key).not.toHaveProperty(key)
    const balance = (answer.steps as Json[]).find((row) => row.id === ids.balanceStep)!
    expect(balance.byHand).toMatchObject({ act: 'MOVE_DUE', by: 'Made-up Finance Person' })
    expect(balance.byHand).not.toHaveProperty('reason')
    expect(balance.settledBy).toBeNull()
    for (const row of answer.requests as Json[]) {
      for (const key of ['amount', 'paid']) expect(row, key).not.toHaveProperty(key)
      for (const paid of row.payments as Json[]) expect(paid).not.toHaveProperty('amount')
    }
    // B-OM-024: the short word is kept without prices (within the tolerance or not), never its amount.
    expect((answer.requests as Json[]).find((row) => row.id === ids.r1)!.short).toEqual({ withinTolerance: false })
    expect(JSON.stringify(answer)).not.toContain('a week more')
  })

  it('a person limited to another customer gets the same words as an unknown order', async () => {
    const hidden = await read('otherCustomer', `/sales/orders/${orderId}/schedule`, 404)
    const unknown = await read('finance', `/sales/orders/${newId()}/schedule`, 404)
    expect(hidden.error.message).toBe(unknown.error.message)
    expect(JSON.stringify(hidden)).not.toContain('OM-PLAN')
  })
})
