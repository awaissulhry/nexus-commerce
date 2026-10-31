import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedAccounting } from '../../../../../packages/factory-db/seed/accounting'
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedReceivables, type ReceivablesSeed } from '../../../../../packages/factory-db/seed/receivables'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { startHarness, type Harness } from '../../platform/auth/sessions/testing/harness'
import { openInvoices } from '../receivables/store'

/**
 * B-W2b-21 — payments follow-ups on the local stack, through the app's real routes: a throwaway PostgreSQL 17 database from
 * the migrations (the runtime login: row-level security and the …_money_guards / …_followups_quality_money_w2b_guards
 * triggers are real), the factory-db seeds of one tenant (P1's SEED-SO-0002; FT-2026-00001 paid in part on account; a
 * duplicate transfer of 100.00 with 50.00 to refund; September 2026 HARD-locked), test sessions.
 *   Z8:01  a PAID deposit that issues no deposit invoice (NONE) carried onto its order's invoice in ONE command
 *   Z8:02  refunds carry a reason: the source's by default, a person's while DUE, fixed once PAID
 *   Z8:10  a HARD-locked month answers 409 in words on payments (B-W2a-F8's guard), never a 500
 * Every name, number and amount is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/payments/followups`.
 */

let h: Harness
let app: FastifyInstance
let receivables: ReceivablesSeed

const NS = 'w2b21-payments-a'
const id = (name: string) => seedUuid(NS, name)
const A = { tenant: id('tenant'), company: id('company:A'), P1: id('party:P1'), SO2: id('production:sales-order:SO-0002'), actor: id('actor') }
const TODAY = businessDate(new Date())
const SELLER = { vatNumber: '00000003038', name: 'Seed Company A', taxRegime: 'RF01' }
const BILL_TO = { kind: 'IT_BUSINESS', vatNumber: '00000001016', name: 'Seed Customer One S.r.l.', sdiCode: 'SEEDC01' }

const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (permissions: Permission[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(permissions)] })
const SESSIONS: Record<string, SessionContext> = {
  finance: office(['payments.view', 'payments.record', 'payments.refund', 'payments.void', 'invoices.view', 'money.price']),
  viewer: office(['payments.view', 'invoices.view']),
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
let keys = 0
const call = (session: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `w2b21-pay-${++keys}-${newId()}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const insertSql = (table: string, row: Record<string, unknown>): [string, string] => {
  const columns = Object.keys(row).map((column) => `"${column}"`).join(', ')
  return [`INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row)]
}

/** An issued TD01 of SEED-SO-0002, written as the issuing command writes it (the …_money_guards accept it). */
async function issuedInvoiceOfOrder(net: number): Promise<string> {
  const invoiceId = randomUUID()
  const vat = Math.round((net * 22) / 100)
  const number = `T-W2B21-${invoiceId.slice(0, 6)}`
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) =>
    client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(...insertSql('Invoice', { id: invoiceId, companyId: A.company, buyerPartyId: A.P1, docType: 'TD01', priceBasis: 'NET', billTo: BILL_TO, netTotal: net, vatTotal: vat, grossTotal: net + vat, vatSummary: [{ rate: '22.00', nature: null, taxable: net, vat, rounding: 0 }], salesOrderId: A.SO2 }))
      await tx.$executeRawUnsafe(...insertSql('InvoiceLine', { id: randomUUID(), invoiceId, buyerPartyId: A.P1, seq: 1, kind: 'GOODS', description: 'Test jacket', quantity: '1', unitPrice: `${net / 100}`, netAmount: net, vatRatePct: '22.00' }))
      await tx.$executeRawUnsafe(
        ...insertSql('NumberAllocation', { id: randomUUID(), companyId: A.company, seriesId: receivables.money.invoiceSeriesId, kind: 'INVOICE', value: 400_000 + ++keys, formatted: number, documentDate: '2026-11-15', recordType: 'Invoice', recordId: invoiceId, allocatedAt: new Date().toISOString(), allocatedById: A.actor, requestId: `test-${invoiceId.slice(0, 8)}` }),
      )
      await tx.$executeRawUnsafe(
        `UPDATE "Invoice" SET status = 'ISSUED', "numberSeriesId" = $2::uuid, number = $3, year = 2026, "issueDate" = '2026-11-15'::date, "issuedAt" = now(), "issuedById" = $4::uuid, "partyId" = "buyerPartyId", seller = $5::jsonb WHERE id = $1::uuid`,
        invoiceId,
        receivables.money.invoiceSeriesId,
        number,
        A.actor,
        JSON.stringify(SELLER),
      )
    }),
  )
  return invoiceId
}

beforeAll(async () => {
  h = await startHarness('payments_followups')
  await seedCore({ db: h.database, namespace: NS })
  receivables = await seedReceivables({ db: h.database, namespace: NS })
  await seedAccounting({ db: h.database, namespace: NS })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
}, 240_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('a deposit paid without a deposit invoice, carried onto its order’s invoice (Z8:01)', () => {
  const request = randomUUID()
  let paymentId = ''
  let invoiceId = ''

  it('the deposit is paid; before the order’s invoice exists nothing can be carried, and a reversal is refused in words', async () => {
    await admin(`INSERT INTO "DepositRequest" (id, "tenantId", "companyId", "partyId", "orderId", kind, currency, amount, "dueDate", "fiscalDocument", "fiscalRule") VALUES ($1, $2, $3, $4, $5, 'ACCONTO', 'EUR', 30000, $6, 'NONE', 'test.deposit.EU_B2B_VIES')`, [request, A.tenant, A.company, A.P1, A.SO2, TODAY])
    const { payment } = await ok('finance', 'POST', '/payments', { companyId: A.company, partyId: A.P1, amount: 30000, receivedOn: TODAY, externalRef: 'TRN-W2B21-DEPOSIT', allocations: [{ depositRequestId: request }] }, 201)
    paymentId = payment.id
    expect((await admin(`SELECT status FROM "DepositRequest" WHERE id = $1`, [request]))[0]!.status).toBe('PAID')
    const early = await refused('finance', 'POST', `/payments/deposit-requests/${request}/carry`, {}, 409)
    expect(early.message).toContain('has no issued invoice (TD01 or TD24) open yet')
    const reversal = await refused('finance', 'POST', `/payments/${paymentId}/allocations/${payment.allocations[0].id}/reverse`, { note: 'Try' }, 409)
    expect(reversal.message).toContain('carry it onto the order')
  })

  it('the open items name the deposit waiting for the invoice; the ladder holds the invoice', async () => {
    invoiceId = await issuedInvoiceOfOrder(100_000)
    const { items } = await ok('finance', 'GET', `/payments/open-items?companyId=${A.company}&partyId=${A.P1}`)
    const row = items.find((item: Json) => item.id === invoiceId)
    expect(row).toMatchObject({ openAmount: 122_000, noInvoiceDepositAmount: 30_000, depositToCarry: [{ depositRequestId: request, amount: 30_000 }], carriedDepositAmount: 0 })
    const held = await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) => openInvoices(client, { companyId: A.company, partyId: A.P1, asOf: '2026-12-31' }))
    expect(held.find((invoice) => invoice.id === invoiceId)).toMatchObject({ depositToCarry: true })
  })

  it('refused onto an invoice that cannot take it, or onto another order’s invoice; without the money grain nothing moves', async () => {
    const other = await refused('finance', 'POST', `/payments/deposit-requests/${request}/carry`, { invoiceId: receivables.money.sampleInvoiceId }, 409)
    expect(other.message).toContain('not an issued invoice (TD01 or TD24) of order')
    expect((await call('viewer', 'POST', `/payments/deposit-requests/${request}/carry`, {})).statusCode).toBe(403)
  })

  it('carried in ONE command: the reversal and the carry, the invoice open for less, the request still PAID at 0', async () => {
    const carried = await ok('finance', 'POST', `/payments/deposit-requests/${request}/carry`, { invoiceId })
    expect(carried).toMatchObject({ depositRequestId: request, orderId: A.SO2, amount: 30_000, carried: [{ paymentId, invoiceId, amount: 30_000 }], invoices: [{ id: invoiceId, openAmount: 92_000 }] })
    const rows = await admin<{ amount: number; depositRequestId: string | null; invoiceId: string | null; reversalOfId: string | null; carriedFromId: string | null }>(`SELECT amount, "depositRequestId", "invoiceId", "reversalOfId", "carriedFromId" FROM "PaymentAllocation" WHERE "paymentId" = $1 ORDER BY "createdAt", amount`, [paymentId])
    expect(rows).toHaveLength(3)
    const reversal = rows.find((row) => row.amount === -30_000)!
    expect(rows.find((row) => row.invoiceId === invoiceId)).toMatchObject({ amount: 30_000, carriedFromId: expect.any(String) })
    expect(reversal).toMatchObject({ depositRequestId: request, reversalOfId: expect.any(String) })
    expect((await admin(`SELECT status FROM "DepositRequest" WHERE id = $1`, [request]))[0]!.status).toBe('PAID')
    const { items } = await ok('finance', 'GET', `/payments/open-items?companyId=${A.company}&partyId=${A.P1}`)
    expect(items.find((item: Json) => item.id === invoiceId)).toMatchObject({ openAmount: 92_000, noInvoiceDepositAmount: null, depositToCarry: [], carriedDepositAmount: 30_000 })
    const held = await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) => openInvoices(client, { companyId: A.company, partyId: A.P1, asOf: '2026-12-31' }))
    expect(held.find((invoice) => invoice.id === invoiceId)).toMatchObject({ depositToCarry: false })
    const events = await admin<{ type: string; payload: Json }>(`SELECT type, payload FROM "OutboxEvent" WHERE subject IN ($1, $2) AND type IN ('payment.deposit_carried', 'payment.allocated', 'payment.allocation_reversed') ORDER BY "occurredAt", id`, [request, paymentId])
    expect(events.map((row) => row.type)).toEqual(expect.arrayContaining(['payment.allocation_reversed', 'payment.allocated', 'payment.deposit_carried']))
    expect(events.find((row) => row.type === 'payment.deposit_carried')!.payload).toEqual({ depositRequestId: request, partyId: A.P1, orderId: A.SO2, invoiceIds: [invoiceId], allocations: 1 })
    const { payment } = await ok('finance', 'GET', `/payments/${paymentId}`)
    expect(payment.allocations.find((row: Json) => row.target === 'INVOICE')).toMatchObject({ carriedFromId: expect.any(String) })
  })

  it('twice: nothing is left to carry', async () => {
    const again = await refused('finance', 'POST', `/payments/deposit-requests/${request}/carry`, { invoiceId }, 409)
    expect(again.message).toContain('carried onto the invoice already')
  })
})

describe('refunds carry a reason (Z8:02)', () => {
  it('the source’s reason by default, a person’s while DUE, fixed once PAID', async () => {
    const { refund } = await ok('finance', 'POST', '/payments/refunds', { paymentId: receivables.overpaymentId, amount: 1_000 }, 201)
    expect(refund).toMatchObject({ status: 'DUE', reasonCode: 'OVERPAYMENT', reasonWords: { en: 'Paid too much' } })
    const changed = await ok('finance', 'PATCH', `/payments/refunds/${refund.id}`, { version: refund.version, reasonCode: 'OTHER' })
    expect(changed.refund).toMatchObject({ reasonCode: 'OTHER' })
    const paid = await ok('finance', 'POST', `/payments/refunds/${refund.id}/paid`, { version: changed.refund.version, paidOn: TODAY, externalRef: 'OUT-W2B21-1' })
    expect(paid.refund).toMatchObject({ status: 'PAID', reasonCode: 'OTHER' })
    const frozen = await refused('finance', 'PATCH', `/payments/refunds/${refund.id}`, { version: paid.refund.version, reasonCode: 'RETURN' }, 409)
    expect(frozen.message).toContain('what was paid never changes')
    const said = await ok('finance', 'POST', '/payments/refunds', { paymentId: receivables.overpaymentId, amount: 500, reasonCode: 'PRICE_ADJUSTMENT' }, 201)
    expect(said.refund.reasonCode).toBe('PRICE_ADJUSTMENT')
  })
})

describe('a HARD-locked month answers 409 in words on payments (Z8:10)', () => {
  it('a payment dated in closed September is refused in words, never a 500', async () => {
    const answer = await call('finance', 'POST', '/payments', { companyId: A.company, partyId: A.P1, amount: 1_000, receivedOn: '2026-09-15', externalRef: 'CRO-W2B21-HARD' })
    expect(answer.statusCode, answer.body).toBe(409)
    expect(answer.json().error.message).toMatch(/closed for good/)
  })
})
