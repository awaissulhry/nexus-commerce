import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validateXML } from 'xmllint-wasm'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/invoicing/from-shipment/deadlines'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedMoney, type MoneySeed } from '../../../../../packages/factory-db/seed/money'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { FakeSdi } from '../../adapters/sdi/fake'
import { buildApp } from '../../core/app'
import { callerFor } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness } from '../../platform/auth/sessions/testing/harness'
import { createGateway } from '../../platform/gateway/gateway'
import { systemContext } from '../../platform/outbox/system'
import { orderHandlers } from '../sales/orders/handlers'
import { fileTravelDocuments, TRAVEL_DOCUMENT_PERMISSIONS } from '../shipping/documents/testing/compliance'
import { pollSend } from './sdi/poll'
import { createSdiRuntime, useSdi, type SdiRuntime } from './sdi/runtime'

/**
 * B-W2a-F2 — the legal case of an advance before shipping (DPR 633/1972 art. 6 c.4: a payment received before the goods
 * leave makes the supply happen at the payment, for the amount paid — an invoice is due then), on the local stack: a
 * throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security, the grants and the
 * …_sales_advance_invoice_guards / …_money_guards triggers are real), the factory-db seeds of two tenants, the real office
 * sign-in (finance steps up to issue), the FAKE SDI, and a second app on the same database with test sessions (sales,
 * the warehouse, the walls).
 *
 * SEED-SO-0003 (two jackets, gross 1024.80) has a payment schedule written before this step: the DEPOSIT (300.00, its
 * request), the balance BEFORE_SHIPPING (500.00, no request yet, no day) and ON_INVOICE (224.80). Sales opens the
 * balance (its own request), the customer pays the deposit and then the balance before anything ships: each payment
 * issues its TD02 for the amount paid through the deposit's path (one gapless series, SDI). The goods ship: the goods'
 * invoice deducts BOTH TD02s, each once. Every name, number and amount is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/invoicing/advance`.
 */

let h: Harness
let walls: FastifyInstance
let finance: Browser
let secret: string
let sdi: SdiRuntime
let moneyA: MoneySeed

const ns = { a: 'invadv-a', b: 'invadv-b' } as const
const A = { tenant: seedUuid(ns.a, 'tenant'), companyA: seedUuid(ns.a, 'company:A'), companyB: seedUuid(ns.a, 'company:B'), siteA1: seedUuid(ns.a, 'site:A1'), brand: seedUuid(ns.a, 'party:P1') }
const B = { tenant: seedUuid(ns.b, 'tenant'), companyA: seedUuid(ns.b, 'company:A') }
const YEAR = businessDate(new Date()).slice(0, 4)
const TODAY = () => businessDate(new Date())
const ids = { deposit: newId(), depositStep: newId(), balanceStep: newId(), invoiceStep: newId() }
const S: Record<string, any> = {}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]

async function as(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await finance.send(method as 'POST', url, method === 'GET' ? undefined : (body ?? {}))
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}
const refused = async (method: 'GET' | 'POST', url: string, body: unknown, status: number): Promise<Json> => (await as(method, url, body, status)).error

const SHIPPING: Permission[] = ['shipping.view', 'shipping.manage', 'shipping.pack', 'shipping.ddt.issue', 'shipping.ddt.cancel', 'files.read']
const SALES: Permission[] = ['orders.view', 'orders.manage', 'money.price']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants })
const SESSIONS: Record<string, () => SessionContext> = {
  sales: () => office(A.tenant, [grant(SALES)]),
  viewer: () => office(A.tenant, [grant(['orders.view', 'money.price'])]),
  warehouse: () => office(A.tenant, [grant(SHIPPING)]),
  quality: () => office(A.tenant, [grant(TRAVEL_DOCUMENT_PERMISSIONS)]),
  otherTenant: () => office(B.tenant, [grant(SALES)]),
  floor: () => ({ audience: 'floor', tenantId: A.tenant, actorId: newId(), siteId: A.siteA1, deviceId: newId(), grants: [grant(SALES)] }),
  partner: () => ({ audience: 'partner', tenantId: A.tenant, actorId: newId(), partyId: A.brand, grants: [grant(SALES)] }),
}
let counter = 0
async function wall(session: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, status?: number): Promise<Json> {
  const headers = { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `advance-${++counter}-${newId()}` }) }
  const response = await walls.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) })
  if (status !== undefined) expect(response.statusCode, response.body).toBe(status)
  return { status: response.statusCode, body: response.json() as Json }
}

const FIXTURES = new URL('../../../../../packages/factory-domain/src/invoicing/fatturapa/__fixtures__/', import.meta.url)
const DSIG = 'xmldsig-core-schema.xsd'
async function xsdErrors(xml: string): Promise<string[]> {
  const schema = readFileSync(new URL('Schema_VFPR12_v1.2.3.xsd', FIXTURES), 'utf8')
    .replace(/^﻿/, '')
    .replace('schemaLocation="http://www.w3.org/TR/2002/REC-xmldsig-core-20020212/xmldsig-core-schema.xsd"', `schemaLocation="${DSIG}"`)
  const result = await validateXML({ xml: [{ fileName: 'invoice.xml', contents: xml }], schema: [{ fileName: 'fatturapa.xsd', contents: schema }], preload: [{ fileName: DSIG, contents: readFileSync(new URL(DSIG, FIXTURES), 'utf8') }] })
  return result.errors.map((error) => error.rawMessage)
}
async function downloaded(fileId: string): Promise<string> {
  const presigned = await as('GET', `/files/${fileId}/download`)
  const fetched = await h.app.inject({ method: 'GET', url: presigned.download.url })
  expect(fetched.statusCode).toBe(200)
  return fetched.rawPayload.toString('utf8')
}
async function issue(invoiceId: string, status = 200): Promise<Json> {
  await stepUp(h, finance, secret)
  return as('POST', `/invoicing/invoices/${invoiceId}/issue`, {}, status)
}
/** Sends an issued invoice to the FAKE SDI and records its answer (the worker's poll, run here): DELIVERED. */
async function deliver(invoiceId: string): Promise<void> {
  await stepUp(h, finance, secret)
  const sent = await as('POST', `/invoicing/invoices/${invoiceId}/sdi/send`, {})
  const submissionId = sent.sdi.sends.at(-1).id as string
  expect(await pollSend(sdi, callerFor(h.database, systemContext(A.tenant, newId())), submissionId)).toBe('recorded')
  expect((await as('GET', `/invoicing/invoices/${invoiceId}`)).invoice.status).toBe('DELIVERED')
}
const invoiceSeriesNext = async (): Promise<number> => (await admin<{ next: number }>(`SELECT "nextValue" AS next FROM "NumberSeries" WHERE "tenantId" = $1 AND "companyId" = $2 AND kind = 'INVOICE' AND "scopeKey" = $3`, [A.tenant, A.companyA, YEAR]))[0]!.next
const invoiceNumber = (value: number) => `FT-${YEAR}-${String(value).padStart(5, '0')}`
const scheduleUrl = () => `/sales/orders/${moneyA.shipping.quality.serialSalesOrderId}/schedule`
const stepOf = async (milestoneId: string): Promise<Json> => (await wall('sales', 'GET', scheduleUrl(), undefined, 200)).body.steps.find((step: Json) => step.id === milestoneId)
/** The worker's handler on payment.deposit_paid (run here): the step that names the request becomes PAID. */
async function followDeposit(depositRequestId: string): Promise<void> {
  const handler = orderHandlers().find((entry) => entry.name === 'sales.ordersFollowDeposits')!
  const envelope = { eventId: newId(), type: 'payment.deposit_paid', version: 1, tenantId: A.tenant, payload: { depositRequestId, partyId: A.brand, orderId: moneyA.shipping.quality.serialSalesOrderId } } as never
  await handler.handle(envelope, { caller: callerFor(h.database, systemContext(A.tenant, newId())), attempt: 1 } as never)
}

beforeAll(async () => {
  h = await startHarness('invoicing_advance')
  for (const namespace of [ns.a, ns.b]) await seedCore({ db: h.database, namespace })
  moneyA = await seedMoney({ db: h.database, namespace: ns.a })
  await seedMoney({ db: h.database, namespace: ns.b })
  for (const [tenantId, companies] of [
    [A.tenant, [A.companyA, A.companyB]],
    [B.tenant, [B.companyA]],
  ] as const) {
    for (const companyId of companies) {
      // Made-up legal data (c.c. art. 2250, FatturaPA CedentePrestatore) and this year's series with no last date.
      await admin(`UPDATE "Company" SET "vatNumber" = 'IT12345670009', "fiscalCode" = '12345670009', "regimeFiscale" = 'RF01', "reaOffice" = 'MI', "reaNumber" = '0000001', address = $2::jsonb WHERE id = $1`, [
        companyId,
        JSON.stringify({ line1: 'Via Esempio 1', postalCode: '20121', city: 'Milano', province: 'MI', country: 'IT' }),
      ])
      await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'SHIPMENT', 'MAIN', 'ALL', 'NEVER', 'SH-{N:5}', false) ON CONFLICT DO NOTHING`, [newId(), tenantId, companyId])
      await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'DDT', 'MAIN', $4, 'YEARLY', '{N}/{YYYY}', true) ON CONFLICT DO NOTHING`, [newId(), tenantId, companyId, YEAR])
      await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'INVOICE', 'MAIN', $4, 'YEARLY', 'FT-{YYYY}-{N:5}', true) ON CONFLICT DO NOTHING`, [newId(), tenantId, companyId, YEAR])
    }
    await admin(`UPDATE "NumberSeries" SET "lastIssuedDate" = NULL WHERE "tenantId" = $1 AND kind IN ('DDT', 'INVOICE')`, [tenantId])
    if ((await admin(`SELECT 1 FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2'`, [tenantId])).length === 0) {
      await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), tenantId])
    }
    await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1`, [tenantId])
  }
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId }))

  // SO-0003 amended to the two jackets made (gross 1024.80), its 30% deposit request (TD02), and the payment schedule as
  // an order made before this step has it: the balance before shipping with no request and no day.
  const so3 = moneyA.shipping.quality.serialSalesOrderId
  await admin(`UPDATE "SalesOrderLineSize" SET quantity = 2 WHERE "lineId" = $1`, [moneyA.shipping.quality.serialSalesOrderLineId])
  await admin(`UPDATE "SalesOrderLine" SET quantity = 2, "netAmount" = 84000, "vatAmount" = 18480 WHERE id = $1`, [moneyA.shipping.quality.serialSalesOrderLineId])
  await admin(`UPDATE "SalesOrder" SET "netAmount" = 84000, "vatAmount" = 18480, "grossAmount" = 102480 WHERE id = $1`, [so3])
  await admin(`INSERT INTO "DepositRequest" (id, "tenantId", "companyId", "partyId", "orderId", kind, "depositPct", currency, amount, "dueDate", "fiscalDocument", "fiscalRule") VALUES ($1, $2, $3, $4, $5, 'ACCONTO', 30, 'EUR', 30000, '2026-12-31', 'TD02', 'DEPOSIT_INVOICE_IT')`, [
    ids.deposit,
    A.tenant,
    A.companyA,
    A.brand,
    so3,
  ])
  const step = `INSERT INTO "SalesOrderMilestone" (id, "tenantId", "companyId", "orderId", "partyId", seq, kind, amount, "depositRequestId") VALUES ($1, $2, $3, $4, $5, $6, $7::"SalesMilestoneKind", $8, $9)`
  await admin(step, [ids.depositStep, A.tenant, A.companyA, so3, A.brand, 10, 'DEPOSIT', 30000, ids.deposit])
  await admin(step, [ids.balanceStep, A.tenant, A.companyA, so3, A.brand, 20, 'BEFORE_SHIPPING', 50000, null])
  await admin(step, [ids.invoiceStep, A.tenant, A.companyA, so3, A.brand, 30, 'ON_INVOICE', 22480, null])

  const user = await addUser(h, { id: A.tenant, slug: ns.a, companies: [{ id: A.companyA, code: 'SCA' }] }, { email: 'fina.advance@invadv-a.example.com', role: 'finance' })
  finance = new Browser(h.app)
  const signedIn = await finance.signIn(ns.a, user.email, user.password)
  expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200)
  secret = await enrolTotp(h, finance)
  const gateway = createGateway({ environment: 'test', redis: h.redis, prefix: h.redisPrefix, secrets: h.secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  sdi = createSdiRuntime({ gateway, fake: new FakeSdi({ answerAfterMs: 0 }) })
  useSdi(sdi)
  walls = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null), logger: false },
  )
  await fileTravelDocuments(walls, 'quality', moneyA.shipping.quality.serialStyleId, moneyA.shipping.quality.serialRevisionId)
}, 240_000)

afterAll(async () => {
  useSdi(undefined)
  await walls?.close()
  await h?.close()
}, 60_000)

describe('the office opens the balance before shipping: a deposit request of its own (POST …/schedule/:milestoneId/request)', () => {
  it('refused in words: another kind of step, no day to fall due, a stale version; walls: who may not and who cannot see it', async () => {
    const url = (milestoneId: string) => `${scheduleUrl()}/${milestoneId}/request`
    const balance = await stepOf(ids.balanceStep)
    expect(balance).toMatchObject({ kind: 'BEFORE_SHIPPING', status: 'OPEN', depositRequestId: null, dueDate: null })
    expect((await wall('sales', 'POST', url(ids.invoiceStep), { version: 1, dueDate: addDays(TODAY(), 10) }, 409)).body.error.message).toBe(
      'This step of order SEED-SO-0003 falls due with the invoice of the shipped goods (on the invoice): it has no deposit request; only a step before shipping is opened here.',
    )
    expect((await wall('sales', 'POST', url(ids.depositStep), { version: 1 }, 409)).body.error.message).toContain('The deposit step of order SEED-SO-0003 has its request from the order itself')
    const noDay = (await wall('sales', 'POST', url(ids.balanceStep), { version: balance.version }, 400)).body.error
    expect(noDay.issues).toEqual([{ path: 'body/dueDate', message: 'This step of order SEED-SO-0003 has no due day (the order had no promise date when it was made): give the day the customer pays it.' }])
    expect((await wall('sales', 'POST', url(ids.balanceStep), { version: balance.version + 1, dueDate: addDays(TODAY(), 10) })).status).toBe(409)
    expect((await wall('viewer', 'POST', url(ids.balanceStep), { version: balance.version, dueDate: addDays(TODAY(), 10) })).status).toBe(403)
    expect((await wall('floor', 'POST', url(ids.balanceStep), { version: balance.version, dueDate: addDays(TODAY(), 10) })).status).toBe(403)
    expect((await wall('partner', 'POST', url(ids.balanceStep), { version: balance.version, dueDate: addDays(TODAY(), 10) })).status).toBe(403)
    expect((await wall('otherTenant', 'POST', url(ids.balanceStep), { version: balance.version, dueDate: addDays(TODAY(), 10) })).status).toBe(404)
    // Nothing was made.
    expect(await admin('SELECT count(*)::int AS n FROM "DepositRequest" WHERE "orderId" = $1', [moneyA.shipping.quality.serialSalesOrderId])).toEqual([{ n: 1 }])
    // The invoice of the step waits for its request, and says which route opens it.
    expect((await refused('POST', '/invoicing/invoices/from-milestone', { milestoneId: ids.balanceStep }, 409)).message).toContain('Sales opens it first')
  }, 60_000)

  it('opened: an advance of the step\'s amount, due the day given, the deposit\'s fiscal rule; the step names it; once only', async () => {
    const balance = await stepOf(ids.balanceStep)
    const due = addDays(TODAY(), 10)
    const opened = (await wall('sales', 'POST', `${scheduleUrl()}/${ids.balanceStep}/request`, { version: balance.version, dueDate: due }, 201)).body
    S.balanceRequest = opened.depositRequestId
    expect(opened.steps.map((entry: Json) => [entry.kind, entry.status, entry.amount, entry.dueDate, entry.depositRequestId])).toEqual([
      ['DEPOSIT', 'OPEN', 30000, null, ids.deposit],
      ['BEFORE_SHIPPING', 'OPEN', 50000, due, S.balanceRequest],
      ['ON_INVOICE', 'OPEN', 22480, null, null],
    ])
    const [row] = await admin('SELECT "orderId", "quoteVersionId", kind::text AS kind, amount, "dueDate"::text AS due, "fiscalDocument"::text AS fiscal, "fiscalRule", status::text AS status FROM "DepositRequest" WHERE id = $1', [S.balanceRequest])
    expect(row).toEqual({ orderId: moneyA.shipping.quality.serialSalesOrderId, quoteVersionId: null, kind: 'ACCONTO', amount: 50000, due, fiscal: 'TD02', fiscalRule: 'DEPOSIT_INVOICE_IT', status: 'OPEN' })
    const [event] = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = 'sales_order.schedule_changed' AND subject = $1 ORDER BY "occurredAt" DESC, id DESC LIMIT 1`, [moneyA.shipping.quality.serialSalesOrderId])
    expect(event!.payload).toMatchObject({ change: 'REQUESTED', milestoneIds: [ids.balanceStep] })
    // Once: a second call says it has its request.
    const again = await stepOf(ids.balanceStep)
    expect((await wall('sales', 'POST', `${scheduleUrl()}/${ids.balanceStep}/request`, { version: again.version, dueDate: due }, 409)).body.error.message).toBe(
      'This step of order SEED-SO-0003 has its deposit request already: the customer pays it (payments: deposit received).',
    )
    // The order record names which step each request is for; the release gate and the list read the deposit only.
    const record = (await wall('sales', 'GET', `/sales/orders/${moneyA.shipping.quality.serialSalesOrderId}`, undefined, 200)).body.order
    expect(record.chain.depositRequests.map((entry: Json) => [entry.id, entry.stepKind])).toEqual([
      [ids.deposit, 'DEPOSIT'],
      [S.balanceRequest, 'BEFORE_SHIPPING'],
    ])
  }, 60_000)
})

describe('art. 6 c.4: the deposit and the balance paid before the goods leave, each invoiced with its TD02 for the amount paid', () => {
  it('the deposit is received: its TD02 (the W1 path)', async () => {
    S.firstNumber = await invoiceSeriesNext()
    await stepUp(h, finance, secret)
    const answer = await as('POST', '/payments/deposit-received', { depositRequestId: ids.deposit, amount: 30000, receivedOn: TODAY(), externalRef: 'TRN-F2-0001' }, 201)
    S.td02Deposit = answer.depositInvoice.invoice
    expect(S.td02Deposit).toMatchObject({ docType: 'TD02', status: 'ISSUED', number: invoiceNumber(S.firstNumber), grossTotal: 30000 })
    expect(S.td02Deposit.lines).toEqual([expect.objectContaining({ kind: 'GOODS', milestoneId: ids.depositStep })])
  }, 60_000)

  it('the customer pays the balance before anything ships: its TD02 for the amount paid, next in the series, naming the step', async () => {
    expect(await admin('SELECT count(*)::int AS n FROM "Shipment" WHERE "salesOrderId" = $1 AND "shippedAt" IS NOT NULL', [moneyA.shipping.quality.serialSalesOrderId])).toEqual([{ n: 0 }])
    await stepUp(h, finance, secret)
    const answer = await as('POST', '/payments/deposit-received', { depositRequestId: S.balanceRequest, amount: 50000, receivedOn: TODAY(), externalRef: 'TRN-F2-0002' }, 201)
    expect(answer.depositRequest).toEqual({ id: S.balanceRequest, status: 'PAID' })
    expect(answer.depositInvoice).toMatchObject({ required: true, filesPending: false })
    S.td02Balance = answer.depositInvoice.invoice
    expect(S.td02Balance).toMatchObject({
      docType: 'TD02',
      status: 'ISSUED',
      number: invoiceNumber(S.firstNumber + 1),
      issueDate: TODAY(),
      salesOrderId: moneyA.shipping.quality.serialSalesOrderId,
      depositRequestId: S.balanceRequest,
      grossTotal: 50000,
      paymentTerms: { condition: 'TP03', installments: [{ method: 'MP05', amount: 50000, dueDate: TODAY() }], source: { kind: 'ADVANCE' } },
    })
    expect(S.td02Balance.lines).toEqual([expect.objectContaining({ kind: 'GOODS', milestoneId: ids.balanceStep, description: expect.stringMatching(/^Acconto su ordine n\. SEED-SO-0003 del /) })])
    expect(S.td02Balance.causale).toContain('(art. 6 c.4 DPR 633/1972)')
    const xml = await downloaded(S.td02Balance.xmlFileId)
    expect(await xsdErrors(xml)).toEqual([])
    expect(xml).toContain('<TipoDocumento>TD02</TipoDocumento>')
    expect(xml).toContain('<ImportoTotaleDocumento>500.00</ImportoTotaleDocumento>')
    // The series is gapless: the two TD02s took two consecutive numbers, nothing else did.
    expect(await invoiceSeriesNext()).toBe(S.firstNumber + 2)
    // SDI (FAKE): delivered like the deposit's.
    await deliver(S.td02Balance.id)
  }, 60_000)

  it('the step follows its request (PAID with the payment); invoicing the step again finds nothing left to invoice', async () => {
    await followDeposit(ids.deposit)
    await followDeposit(S.balanceRequest)
    const schedule = (await wall('sales', 'GET', scheduleUrl(), undefined, 200)).body
    expect(schedule.steps.map((entry: Json) => [entry.kind, entry.status])).toEqual([
      ['DEPOSIT', 'PAID'],
      ['BEFORE_SHIPPING', 'PAID'],
      ['ON_INVOICE', 'OPEN'],
    ])
    expect(schedule).toMatchObject({ paidAmount: 80000, openAmount: 22480 })
    // POST /invoicing/invoices/from-milestone routes the step like the deposit: through its request.
    expect((await refused('POST', '/invoicing/invoices/from-milestone', { milestoneId: ids.balanceStep }, 409)).message).toBe('Nothing paid on this deposit request is waiting for a deposit invoice.')
    expect((await refused('POST', '/invoicing/invoices/from-milestone', { milestoneId: ids.invoiceStep }, 409)).message).toContain('falls due with the invoice of the shipped goods')
    // Paid: nothing more is taken on the request.
    await stepUp(h, finance, secret)
    expect((await refused('POST', '/payments/deposit-received', { depositRequestId: S.balanceRequest, amount: 100, receivedOn: TODAY(), externalRef: 'TRN-F2-0003' }, 409)).message).toBe('The deposit request is PAID: a payment goes to an OPEN request.')
  }, 60_000)
})

describe('the goods leave: the goods\' invoice deducts every TD02 of the order exactly once', () => {
  it('SH-0002 ships the two jackets with its DDT', async () => {
    const sh2 = moneyA.shipping.draftShipmentId
    const [, second, third] = moneyA.shipping.quality.serialIds
    const codes = Object.fromEntries((await admin<{ id: string; serial: string }>('SELECT id, serial FROM "GarmentSerial" WHERE id = ANY($1::uuid[])', [[second, third]])).map((row) => [row.id, row.serial]))
    const added = (await wall('warehouse', 'POST', `/shipping/shipments/${sh2}/lines`, { lines: [{ workOrderSizeId: moneyA.shipping.quality.serialCellId, quantity: 1 }] }, 200)).body.shipment
    const p2 = (await wall('warehouse', 'POST', `/shipping/packing/${sh2}/parcels`, {}, 201)).body.parcelId
    const loose = added.lines.find((line: Json) => line.parcelId === null)
    await wall('warehouse', 'PUT', `/shipping/packing/${sh2}/lines/${loose.id}/parcel`, { parcelId: p2 }, 200)
    for (const [serial, parcelId, weight] of [
      [codes[second!], moneyA.shipping.draftParcelId, '1.85'],
      [codes[third!], p2, '2.15'],
    ] as const) {
      await wall('warehouse', 'POST', `/shipping/packing/${sh2}/serials`, { serial, parcelId }, 200)
      await wall('warehouse', 'PATCH', `/shipping/packing/${sh2}/parcels/${parcelId}`, { grossWeightKg: weight }, 200)
    }
    expect((await wall('warehouse', 'POST', `/shipping/packing/${sh2}/pack`, {}, 200)).body.shipment.status).toBe('PACKED')
    S.ddt = (await wall('warehouse', 'POST', `/shipping/shipments/${sh2}/ddt`, { ship: true, carrier: { name: 'Seed Express' } }, 201)).body.ddt
  }, 60_000)

  it('the invoice of the DDT deducts the deposit\'s TD02 and the balance\'s TD02, each once, and is issued', async () => {
    const made = await as('POST', '/invoicing/invoices/from-ddts', { ddtIds: [S.ddt.id] }, 201)
    expect(made.deductions).toEqual([])
    const draft = made.invoice
    const deductions = draft.lines.filter((line: Json) => line.kind === 'DEPOSIT_DEDUCTION')
    expect(deductions.map((line: Json) => [line.depositInvoiceId, line.netAmount]).sort()).toEqual(
      [
        [S.td02Deposit.id, -S.td02Deposit.netTotal],
        [S.td02Balance.id, -S.td02Balance.netTotal],
      ].sort(),
    )
    const goods = draft.lines.filter((line: Json) => line.kind === 'GOODS').reduce((sum: number, line: Json) => sum + line.netAmount, 0)
    expect(goods).toBe(84000)
    expect(draft.netTotal).toBe(84000 - S.td02Deposit.netTotal - S.td02Balance.netTotal)
    const issued = await issue(draft.id)
    S.final = issued.invoice
    expect(S.final).toMatchObject({ status: 'ISSUED', number: invoiceNumber(S.firstNumber + 2) })
    const xml = await downloaded(S.final.xmlFileId)
    expect(await xsdErrors(xml)).toEqual([])
    for (const deposit of [S.td02Deposit, S.td02Balance]) expect(xml).toContain(`<IdDocumento>${deposit.number}</IdDocumento>`)
  }, 60_000)

  it('exactly once: each TD02 is deducted on one issued invoice for its whole net; the settlement has nothing left to deduct', async () => {
    const counts = await admin<{ id: string; n: number; net: number }>(
      `SELECT l."depositInvoiceId" AS id, count(*)::int AS n, sum(-l."netAmount")::int AS net FROM "InvoiceLine" l JOIN "Invoice" i ON i.id = l."invoiceId" WHERE l."depositInvoiceId" = ANY($1::uuid[]) AND i.status <> 'DRAFT' GROUP BY l."depositInvoiceId" ORDER BY l."depositInvoiceId"`,
      [[S.td02Deposit.id, S.td02Balance.id]],
    )
    expect(counts).toEqual(
      [
        { id: S.td02Deposit.id, n: 1, net: S.td02Deposit.netTotal },
        { id: S.td02Balance.id, n: 1, net: S.td02Balance.netTotal },
      ].sort((a, b) => (a.id < b.id ? -1 : 1)),
    )
    const settlement = await as('GET', `/invoicing/orders/${moneyA.shipping.quality.serialSalesOrderId}/settlement`)
    expect(settlement.settlement.gaps).not.toContain('DEPOSIT_NOT_DEDUCTED')
    expect(settlement.settlement.gaps).not.toContain('DEPOSIT_NOT_INVOICED')
    // What is left to pay is the goods' invoice: the gross less both advances.
    expect(settlement.settlement.balanceDueAmount).toBe(S.final.grossTotal)
  }, 60_000)
})
