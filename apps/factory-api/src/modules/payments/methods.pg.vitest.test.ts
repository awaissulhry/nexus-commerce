import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { monthOfDay, periodOfMonth } from '@nexus/factory-domain/accounting/periods'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { PAYMENT_REFUSALS, type PaymentMethod } from '@nexus/factory-domain/payments/payments'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedReceivables } from '../../../../../packages/factory-db/seed/receivables'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { callerFor, command } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { startHarness, type Harness } from '../../platform/auth/sessions/testing/harness'
import { systemContext } from '../../platform/outbox/system'
import { documentsOf, readPeriodFacts } from '../accounting/facts'
import { COMPANY_SELECT } from '../accounting/store'
import { insertPayment } from './payments'

/**
 * B-W2b-F7 — card and SEPA debit as payment methods, on the local stack through the app's real routes: a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login; PaymentMethod CARD and SEPA_DEBIT from
 * …_payment_methods_w2b_schema), the factory-db seeds of one tenant, test sessions.
 *   - the office types bank transfers only: a CARD or SEPA_DEBIT payment typed by hand (POST /payments, "deposit
 *     received") is refused in words (400, `body/method/PROVIDER_ONLY`), nothing is written;
 *   - a card and a SEPA debit payment recorded as a succeeded payment intent will record them (B-W2b-185: insertPayment
 *     in the system scope, payment.recorded naming the method) read back through the list (filtered by method), the record
 *     and the accounting export's PAYMENTS journal.
 * Every name, number and amount is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/payments/methods`.
 */

let h: Harness
let app: FastifyInstance

const NS = 'w2bf7-payment-methods'
const id = (name: string) => seedUuid(NS, name)
const A = { tenant: id('tenant'), company: id('company:A'), P1: id('party:P1'), SO2: id('production:sales-order:SO-0002'), actor: id('actor') }
const TODAY = businessDate(new Date())

const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (permissions: Permission[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(permissions)] })
const SESSIONS: Record<string, SessionContext> = {
  finance: office(['payments.view', 'payments.record', 'payments.void', 'invoices.view', 'money.price']),
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
let keys = 0
const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': 'finance', ...(method === 'GET' ? {} : { 'idempotency-key': `w2bf7-${++keys}-${newId()}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(method: 'GET' | 'POST', url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(url: string, payload: unknown): Promise<Json> {
  const response = await call('POST', url, payload)
  expect(response.statusCode, response.body).toBe(400)
  return response.json().error
}
const recordedEvents = (paymentId: string) => admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = 'payment.recorded' AND subject = $1`, [paymentId])

beforeAll(async () => {
  h = await startHarness('payment_methods')
  await seedCore({ db: h.database, namespace: NS })
  await seedReceivables({ db: h.database, namespace: NS })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
}, 240_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('the office types bank transfers only (B-W2b-F7)', () => {
  it.each<PaymentMethod>(['CARD', 'SEPA_DEBIT'])('a %s payment typed by hand is refused in words; nothing is written', async (method) => {
    const externalRef = `TRN-W2BF7-HAND-${method.replace('_', '')}`
    const error = await refused('/payments', { companyId: A.company, partyId: A.P1, amount: 12_000, receivedOn: TODAY, externalRef, method })
    expect(error).toMatchObject({ code: 'validation_failed', message: PAYMENT_REFUSALS.PROVIDER_ONLY, issues: [{ path: 'body/method/PROVIDER_ONLY', message: PAYMENT_REFUSALS.PROVIDER_ONLY }] })
    expect(await admin(`SELECT id FROM "Payment" WHERE "externalRef" = $1`, [externalRef])).toEqual([])
  })

  it('"deposit received" by card or SEPA debit is refused in the same words; the deposit request stays OPEN', async () => {
    const request = randomUUID()
    await admin(`INSERT INTO "DepositRequest" (id, "tenantId", "companyId", "partyId", "orderId", kind, currency, amount, "dueDate", "fiscalDocument", "fiscalRule") VALUES ($1, $2, $3, $4, $5, 'ACCONTO', 'EUR', 30000, $6, 'NONE', 'test.deposit.EU_B2B_VIES')`, [request, A.tenant, A.company, A.P1, A.SO2, TODAY])
    for (const method of ['CARD', 'SEPA_DEBIT'] as const) {
      const error = await refused('/payments/deposit-received', { depositRequestId: request, amount: 30_000, receivedOn: TODAY, externalRef: `TRN-W2BF7-DEP-${method.replace('_', '')}`, method, issueDepositInvoice: false })
      expect(error.issues).toEqual([{ path: 'body/method/PROVIDER_ONLY', message: PAYMENT_REFUSALS.PROVIDER_ONLY }])
    }
    expect(await admin(`SELECT status FROM "DepositRequest" WHERE id = $1`, [request])).toEqual([{ status: 'OPEN' }])
    expect(await admin(`SELECT id FROM "PaymentAllocation" WHERE "depositRequestId" = $1`, [request])).toEqual([])
  })

  it('a bank transfer goes in as before, named or not; a method the API does not know is a plain 400', async () => {
    const named = (await ok('POST', '/payments', { companyId: A.company, partyId: A.P1, amount: 5_000, receivedOn: TODAY, externalRef: 'TRN-W2BF7-BANK-1', method: 'BANK_TRANSFER' }, 201)).payment
    const unnamed = (await ok('POST', '/payments', { companyId: A.company, partyId: A.P1, amount: 5_000, receivedOn: TODAY, externalRef: 'TRN-W2BF7-BANK-2' }, 201)).payment
    expect([named.method, unnamed.method]).toEqual(['BANK_TRANSFER', 'BANK_TRANSFER'])
    expect((await recordedEvents(named.id)).map((row) => row.payload.method)).toEqual(['BANK_TRANSFER'])
    const unknown = await refused('/payments', { companyId: A.company, partyId: A.P1, amount: 5_000, receivedOn: TODAY, externalRef: 'TRN-W2BF7-CASH', method: 'CASH' })
    expect(unknown.issues.map((issue: Json) => issue.path)).toEqual(['body/method'])
  })
})

describe('a card and a SEPA debit payment of a payment intent read back (B-W2b-F7)', () => {
  const ids: Partial<Record<PaymentMethod, string>> = {}

  beforeAll(async () => {
    // As B-W2b-185 will record a succeeded intent's payment: the system scope (a provider's webhook), insertPayment.
    for (const method of ['CARD', 'SEPA_DEBIT'] as const) {
      const system = callerFor(h.database, systemContext(A.tenant, newId()))
      const { result } = await command(system, { name: 'payments.record', input: { method } }, async (tools) => {
        const payment = await insertPayment(tools, { companyId: A.company, partyId: A.P1, amount: method === 'CARD' ? 24_400 : 36_600, currency: 'EUR', receivedOn: TODAY, externalRef: `PI-W2BF7-${method.replace('_', '')}`, method, internalNote: null })
        return { id: payment.id }
      })
      ids[method] = result.id
    }
  })

  it('the list keeps one method when asked, and says each payment’s; the record says it too', async () => {
    for (const method of ['CARD', 'SEPA_DEBIT'] as const) {
      const { payments } = await ok('GET', `/payments?companyId=${A.company}&method=${method}`)
      expect(payments.map((row: Json) => row.id)).toEqual([ids[method]])
      expect(payments[0]).toMatchObject({ method, externalRef: `PI-W2BF7-${method.replace('_', '')}`, status: 'RECEIVED' })
      expect((await ok('GET', `/payments/${ids[method]}`)).payment).toMatchObject({ method, amount: method === 'CARD' ? 24_400 : 36_600 })
      expect((await recordedEvents(ids[method]!)).map((row) => row.payload)).toEqual([{ paymentId: ids[method], partyId: A.P1, method }])
    }
    const banks = (await ok('GET', `/payments?companyId=${A.company}&method=BANK_TRANSFER&limit=200`)).payments
    expect(banks.length).toBeGreaterThan(0)
    expect(new Set(banks.map((row: Json) => row.method))).toEqual(new Set(['BANK_TRANSFER']))
    const all = (await ok('GET', `/payments?companyId=${A.company}&limit=200`)).payments
    expect(new Set(all.map((row: Json) => row.method))).toEqual(new Set(['BANK_TRANSFER', 'CARD', 'SEPA_DEBIT']))
  })

  it('the accounting export’s PAYMENTS journal carries each method as recorded', async () => {
    const rows = await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, async (client) => {
      const company = await client.company.findUniqueOrThrow({ where: { id: A.company }, select: COMPANY_SELECT })
      const facts = await readPeriodFacts(client, company, periodOfMonth(monthOfDay(TODAY)), ['PAYMENTS'])
      return (documentsOf(facts, company, ['PAYMENTS']).journals.get('PAYMENTS') ?? []).flatMap((document) => document.rows)
    })
    // Kind, date, reference, customer code, customer, method, amount …
    const byReference = new Map(rows.map((row) => [row[2], row]))
    expect(byReference.get('PI-W2BF7-CARD')?.[5]).toBe('CARD')
    expect(byReference.get('PI-W2BF7-SEPADEBIT')?.[5]).toBe('SEPA_DEBIT')
    expect(byReference.get('TRN-W2BF7-BANK-1')?.[5]).toBe('BANK_TRANSFER')
  })
})
