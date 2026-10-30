import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validateXML } from 'xmllint-wasm'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/invoicing/from-shipment/deadlines'
import { fifteenthOfNextMonth } from '@nexus/factory-domain/invoicing/fatturapa/format'
import { dueDateOf } from '@nexus/factory-domain/sales/terms/terms'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedMoney, type MoneySeed } from '../../../../../../packages/factory-db/seed/money'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { DATED } from '../../../platform/alerts/evaluators'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { systemContext } from '../../../platform/outbox/system'
import { fileTravelDocuments, TRAVEL_DOCUMENT_PERMISSIONS } from '../../shipping/documents/testing/compliance'
import { ddtDeadlines } from './deadlines'
import { readDdts } from './store'

/**
 * Invoicing every day (B-W2a-54; FIN-058 partial invoicing, FIN-059 one invoice for many shipments, FIN-060 charge lines,
 * FIN-065 invoice deadline timers) on the local stack: a throwaway PostgreSQL 17 database from the migrations (the runtime
 * login: row-level security, the grants and the …_money_guards / …_money_w2a_guards triggers are real), the factory-db
 * seeds of two tenants, the real office sign-in (finance steps up to issue), a second app on the same database with test
 * sessions (the warehouse that ships, the walls). Seed Customer One is set to be invoiced MONTHLY with library terms
 * "30 days end of month"; SO-0003 gets a payment schedule (its deposit and the balance before shipping). Two shipments of
 * two orders leave today: SH-0002 (2 jackets of SO-0003) and SO-0002's BLK 52; their freight is set as the shipping module
 * records it. Every name, number and amount is made up. Run with `node scripts/factory/run-pg-tests.mjs invoicing/from-shipment/daily`.
 */

let h: Harness
let walls: FastifyInstance
let finance: Browser
let secret: string
let moneyA: MoneySeed

const ns = { a: 'invd-a', b: 'invd-b' } as const
const A = { tenant: seedUuid(ns.a, 'tenant'), companyA: seedUuid(ns.a, 'company:A'), companyB: seedUuid(ns.a, 'company:B'), siteA1: seedUuid(ns.a, 'site:A1'), brand: seedUuid(ns.a, 'party:P1') }
const B = { tenant: seedUuid(ns.b, 'tenant'), companyA: seedUuid(ns.b, 'company:A') }
const YEAR = businessDate(new Date()).slice(0, 4)
const TODAY = () => businessDate(new Date())
const MONTH = () => TODAY().slice(0, 7)
const ids = { depositSo3: newId(), depositSo2: newId(), terms: newId(), depositStep: newId(), balanceStep: newId(), invoiceStep: newId() }
const S: Record<string, any> = {}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]

async function as(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await finance.send(method as 'POST', url, method === 'GET' ? undefined : (body ?? {}))
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}
const refused = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body: unknown, status: number): Promise<Json> => (await as(method, url, body, status)).error

const SHIPPING: Permission[] = ['shipping.view', 'shipping.manage', 'shipping.pack', 'shipping.ddt.issue', 'shipping.ddt.cancel', 'files.read']
const MONEY: Permission[] = ['invoices.view', 'invoices.manage', 'payments.view', 'payments.record', 'money.price']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants })
const SESSIONS: Record<string, () => SessionContext> = {
  warehouse: () => office(A.tenant, [grant(SHIPPING)]),
  quality: () => office(A.tenant, [grant(TRAVEL_DOCUMENT_PERMISSIONS)]),
  noPrice: () => office(A.tenant, [grant(['invoices.view', 'invoices.manage'])]),
  companyB: () => office(A.tenant, [grant(MONEY, [A.companyB])]),
  otherTenant: () => office(B.tenant, [grant(MONEY)]),
  floor: () => ({ audience: 'floor', tenantId: A.tenant, actorId: newId(), siteId: A.siteA1, deviceId: newId(), grants: [grant(MONEY)] }),
  partner: () => ({ audience: 'partner', tenantId: A.tenant, actorId: newId(), partyId: A.brand, grants: [grant(MONEY)] }),
}
async function wall(session: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, status?: number): Promise<Json> {
  const response = await walls.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
  if (status !== undefined) expect(response.statusCode, response.body).toBe(status)
  return { status: response.statusCode, body: response.json() as Json }
}

const FIXTURES = new URL('../../../../../../packages/factory-domain/src/invoicing/fatturapa/__fixtures__/', import.meta.url)
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
const invoiceSeriesNext = async (): Promise<number> => (await admin<{ next: number }>(`SELECT "nextValue" AS next FROM "NumberSeries" WHERE "tenantId" = $1 AND "companyId" = $2 AND kind = 'INVOICE' AND "scopeKey" = $3`, [A.tenant, A.companyA, YEAR]))[0]!.next
const setFreight = (shipmentId: string, amount: number | null) => admin(`UPDATE "Shipment" SET "freightCharge" = $2 WHERE id = $1`, [shipmentId, amount])

beforeAll(async () => {
  h = await startHarness('invoicing_daily')
  for (const namespace of [ns.a, ns.b]) await seedCore({ db: h.database, namespace })
  moneyA = await seedMoney({ db: h.database, namespace: ns.a })
  await seedMoney({ db: h.database, namespace: ns.b })
  for (const [tenantId, companies] of [
    [A.tenant, [A.companyA, A.companyB]],
    [B.tenant, [B.companyA]],
  ] as const) {
    for (const companyId of companies) {
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

  // SO-0003 amended to the two jackets made, with a 30% deposit request; SO-0002 with its own (not paid here).
  const so3 = moneyA.shipping.quality.serialSalesOrderId
  await admin(`UPDATE "SalesOrderLineSize" SET quantity = 2 WHERE "lineId" = $1`, [moneyA.shipping.quality.serialSalesOrderLineId])
  await admin(`UPDATE "SalesOrderLine" SET quantity = 2, "netAmount" = 84000, "vatAmount" = 18480 WHERE id = $1`, [moneyA.shipping.quality.serialSalesOrderLineId])
  await admin(`UPDATE "SalesOrder" SET "netAmount" = 84000, "vatAmount" = 18480, "grossAmount" = 102480 WHERE id = $1`, [so3])
  const request = `INSERT INTO "DepositRequest" (id, "tenantId", "companyId", "partyId", "orderId", kind, "depositPct", currency, amount, "dueDate", "fiscalDocument", "fiscalRule") VALUES ($1, $2, $3, $4, $5, 'ACCONTO', 30, 'EUR', $6, '2026-12-31', 'TD02', 'DEPOSIT_INVOICE_IT')`
  await admin(request, [ids.depositSo3, A.tenant, A.companyA, A.brand, so3, 30000])
  await admin(request, [ids.depositSo2, A.tenant, A.companyA, A.brand, moneyA.shipping.quality.production.salesOrderId, 20000])
  // SO-0003's payment schedule (B-W2a-30): the deposit (its request), the balance before shipping, one more on the invoice.
  const step = `INSERT INTO "SalesOrderMilestone" (id, "tenantId", "companyId", "orderId", "partyId", seq, kind, amount, "depositRequestId") VALUES ($1, $2, $3, $4, $5, $6, $7::"SalesMilestoneKind", $8, $9)`
  await admin(step, [ids.depositStep, A.tenant, A.companyA, so3, A.brand, 10, 'DEPOSIT', 30000, ids.depositSo3])
  await admin(step, [ids.balanceStep, A.tenant, A.companyA, so3, A.brand, 20, 'BEFORE_SHIPPING', 50000, null])
  await admin(step, [ids.invoiceStep, A.tenant, A.companyA, so3, A.brand, 30, 'ON_INVOICE', 22480, null])
  // Seed Customer One: invoiced once a month, on library terms "bank transfer 30 days end of month".
  await admin(`INSERT INTO "PaymentTerms" (id, "tenantId", code, name, method, instalments) VALUES ($1, $2, 'DAILY30FM', 'Bonifico 30 gg d.f.f.m.', 'MP05', '[{"sharePct":"100.0000","from":"INVOICE","days":30,"endOfMonth":true}]'::jsonb)`, [ids.terms, A.tenant])
  await admin(`UPDATE "Party" SET "invoiceTiming" = 'MONTHLY', "paymentTermsId" = $2 WHERE id = $1`, [A.brand, ids.terms])

  const user = await addUser(h, { id: A.tenant, slug: ns.a, companies: [{ id: A.companyA, code: 'SCA' }] }, { email: 'fina.daily@invd-a.example.com', role: 'finance' })
  finance = new Browser(h.app)
  const signedIn = await finance.signIn(ns.a, user.email, user.password)
  expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200)
  secret = await enrolTotp(h, finance)
  walls = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null), logger: false },
  )
  await fileTravelDocuments(walls, 'quality', moneyA.shipping.quality.serialStyleId, moneyA.shipping.quality.serialRevisionId)
  await fileTravelDocuments(walls, 'quality', moneyA.shipping.quality.production.styleId, moneyA.shipping.quality.production.revisionId)
}, 240_000)

afterAll(async () => {
  await walls?.close()
  await h?.close()
}, 60_000)

describe('the deposit milestone: its TD02 names the step and pays in advance (TP03)', () => {
  it('the deposit is received: its TD02 line names the order DEPOSIT step; its terms are an advance paid today', async () => {
    await stepUp(h, finance, secret)
    const answer = await as('POST', '/payments/deposit-received', { depositRequestId: ids.depositSo3, amount: 30000, receivedOn: TODAY(), externalRef: 'TRN-W254-0001' }, 201)
    S.td02 = answer.depositInvoice.invoice
    expect(S.td02).toMatchObject({ docType: 'TD02', status: 'ISSUED', grossTotal: 30000, paymentTerms: { condition: 'TP03', installments: [{ method: 'MP05', amount: 30000, dueDate: TODAY() }], source: { kind: 'ADVANCE' } } })
    expect(S.td02.lines).toEqual([expect.objectContaining({ kind: 'GOODS', milestoneId: ids.depositStep, chargeKind: null })])
    const xml = await downloaded(S.td02.xmlFileId)
    expect(await xsdErrors(xml)).toEqual([])
    expect(xml).toContain('<CondizioniPagamento>TP03</CondizioniPagamento>')
  })

  it('a step is invoiced through its deposit request only: the deposit has nothing paid left, the others say why', async () => {
    expect((await refused('POST', '/invoicing/invoices/from-milestone', { milestoneId: ids.depositStep }, 409)).message).toBe('Nothing paid on this deposit request is waiting for a deposit invoice.')
    expect((await refused('POST', '/invoicing/invoices/from-milestone', { milestoneId: ids.balanceStep }, 409)).message).toContain('a deposit invoice names the deposit request it invoices: this step of order SEED-SO-0003 has none')
    expect((await refused('POST', '/invoicing/invoices/from-milestone', { milestoneId: ids.invoiceStep }, 409)).message).toContain('falls due with the invoice of the shipped goods')
    expect((await refused('POST', '/invoicing/invoices/from-milestone', { milestoneId: newId() }, 404)).message).toBe('Payment schedule step not found.')
    expect((await wall('otherTenant', 'POST', '/invoicing/invoices/from-milestone', { milestoneId: ids.balanceStep })).status).toBe(404)
  })
})

describe('two shipments of two orders leave today; the customer is invoiced monthly', () => {
  it('SH-0002 (2 jackets of SO-0003) and SO-0002 BLK 52 ship with their DDTs; the shipping module records their freight', async () => {
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
    S.ddtA = (await wall('warehouse', 'POST', `/shipping/shipments/${sh2}/ddt`, { ship: true, carrier: { name: 'Seed Express' } }, 201)).body.ddt
    const production = moneyA.shipping.quality.production
    const sb = (await wall('warehouse', 'POST', '/shipping/shipments', { salesOrderId: production.salesOrderId, lines: [{ workOrderSizeId: production.cellIds['BLK-52'], quantity: 1 }] }, 201)).body.shipment
    const parcel = (await wall('warehouse', 'POST', `/shipping/packing/${sb.id}/parcels`, { grossWeightKg: '2.5' }, 201)).body.parcelId
    await wall('warehouse', 'PUT', `/shipping/packing/${sb.id}/lines/${sb.lines[0].id}/parcel`, { parcelId: parcel }, 200)
    expect((await wall('warehouse', 'POST', `/shipping/packing/${sb.id}/pack`, {}, 200)).body.shipment.status).toBe('PACKED')
    S.ddtB = (await wall('warehouse', 'POST', `/shipping/shipments/${sb.id}/ddt`, { ship: true, carrier: { name: 'Seed Express' } }, 201)).body.ddt
    S.shipmentA = sh2
    S.shipmentB = sb.id
    await setFreight(sh2, 1500)
    await setFreight(sb.id, 900)
  }, 60_000)

  it("shipped, not invoiced: the customer's preset (monthly, TD24), each DDT's own deadline and its freight", async () => {
    const queue = await as('GET', `/invoicing/shipped-not-invoiced?partyId=${A.brand}`)
    const customer = queue.customers.find((entry: Json) => entry.partyId === A.brand && entry.companyId === A.companyA)
    expect(customer).toMatchObject({ invoiceTiming: 'MONTHLY', preset: 'TD24' })
    const deferredBy = fifteenthOfNextMonth(TODAY())
    for (const [ddt, freight] of [
      [S.ddtA, 1500],
      [S.ddtB, 900],
    ] as const) {
      const row = customer.ddts.find((entry: Json) => entry.ddtId === ddt.id)
      expect(row).toMatchObject({ deadline: { docType: 'TD24', dueBy: deferredBy }, immediate: { docType: 'TD01', dueBy: addDays(TODAY(), 12) }, freight: { amount: freight, currency: 'EUR', billed: false } })
    }
    const month = customer.months.find((entry: Json) => entry.month === MONTH())
    expect(month).toMatchObject({ suggested: 'TD24', allowed: ['TD24'], deadline: { docType: 'TD24', dueBy: deferredBy } })
  })

  it('the deferred invoices due: one group for the month, both DDTs, value and freight to bill; the tile counts it', async () => {
    const due = await as('GET', `/invoicing/deferred?partyId=${A.brand}`)
    const group = due.groups.find((entry: Json) => entry.month === MONTH() && entry.partyId === A.brand)
    expect(group).toMatchObject({ companyId: A.companyA, invoiceTiming: 'MONTHLY', freightAmount: 2400, drafts: [], deadline: { docType: 'TD24', dueBy: fifteenthOfNextMonth(TODAY()) } })
    expect(group.ddts.map((ddt: Json) => ddt.ddtId).sort()).toEqual([S.ddtA.id, S.ddtB.id].sort())
    expect(group.valueAmount).toBe(84000 + 40000)
    expect(due.counts.groups).toBeGreaterThanOrEqual(1)
  })

  it('the date timers count down to the preset deadline: monthly the 15th; per shipment the DDT 12 days', async () => {
    const at = new Date()
    const rows = await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) => readDdts(client, { id: { in: [S.ddtA.id, S.ddtB.id] } }))
    const monthly = await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) => ddtDeadlines(client, rows, TODAY()))
    expect(monthly.get(S.ddtA.id)).toMatchObject({ docType: 'TD24', dueBy: fifteenthOfNextMonth(TODAY()) })
    // The engine's DATE source for B-W2a-33's INVOICE_DEADLINE rule reads the same day.
    const dated = await callerFor(h.database, systemContext(A.tenant, `test-${newId()}`)).withClient(async (client) => DATED.INVOICE_DEADLINE!(client as never, { companyId: A.companyA, siteId: null, threshold: {} }, at))
    expect(dated.find((record) => record.recordId === S.ddtA.id)).toMatchObject({ recordType: 'Ddt', date: fifteenthOfNextMonth(TODAY()) })
    await admin(`UPDATE "Party" SET "invoiceTiming" = 'PER_SHIPMENT' WHERE id = $1`, [A.brand])
    const perShipment = await callerFor(h.database, systemContext(A.tenant, `test-${newId()}`)).withClient(async (client) => DATED.INVOICE_DEADLINE!(client as never, { companyId: A.companyA, siteId: null, threshold: {} }, at))
    expect(perShipment.find((record) => record.recordId === S.ddtA.id)).toMatchObject({ date: addDays(TODAY(), 12) })
    await admin(`UPDATE "Party" SET "invoiceTiming" = 'MONTHLY' WHERE id = $1`, [A.brand])
  })
})

describe('partial invoicing per shipment (FIN-058) with charge lines (FIN-060)', () => {
  it('a part of DDT A: one jacket now, its freight, the deposit deducted; TD24 by the preset; the terms of the customer', async () => {
    const line = moneyA.shipping.quality.serialSalesOrderLineId
    const over = await refused('POST', '/invoicing/invoices/from-ddts', { ddtIds: [S.ddtA.id], lines: [{ ddtId: S.ddtA.id, salesOrderLineId: line, size: '52', quantity: 3 }] }, 409)
    expect(over.issues).toEqual([{ path: 'body/lines/0/quantity', message: `DDT ${S.ddtA.number} size 52: 2 left to invoice (shipped 2, invoiced 0, in drafts 0); asked 3.` }])
    const made = await as('POST', '/invoicing/invoices/from-ddts', { ddtIds: [S.ddtA.id], lines: [{ ddtId: S.ddtA.id, salesOrderLineId: line, size: '52', quantity: 1 }] }, 201)
    expect(made.choice).toMatchObject({ docType: 'TD24', suggested: 'TD24', allowed: ['TD01', 'TD24'] })
    expect(made.choice.words).toContain('The customer is invoiced once a month')
    expect(made.freight).toEqual([])
    S.part = made.invoice
    expect(S.part).toMatchObject({ docType: 'TD24', status: 'DRAFT', salesOrderId: moneyA.shipping.quality.serialSalesOrderId, netTotal: 18910, grossTotal: 23070, deadline: { docType: 'TD24', dueBy: fifteenthOfNextMonth(TODAY()) } })
    expect(S.part.lines.map((entry: Json) => [entry.kind, entry.chargeKind, entry.quantity, entry.netAmount, entry.ddtId])).toEqual([
      ['GOODS', null, '1.0000', 42000, S.ddtA.id],
      ['CHARGE', 'FREIGHT', '1.0000', 1500, S.ddtA.id],
      ['DEPOSIT_DEDUCTION', null, '1.0000', -24590, null],
    ])
    expect(S.part.lines[1]).toMatchObject({ description: `Spese di trasporto DDT n. ${S.ddtA.number} del ${TODAY().split('-').reverse().join('/')}`, vatRatePct: '22.00', salesOrderLineId: null, size: null })
    expect(S.part.paymentTerms).toMatchObject({ condition: 'TP02', installments: [{ method: 'MP05', amount: 23070, dueDate: dueDateOf(TODAY(), { days: 30, endOfMonth: true }) }], source: { kind: 'TERMS', termsId: ids.terms, code: 'DAILY30FM' } })
    // The rest stays shipped, not invoiced (1 jacket in no draft); its freight is on the draft.
    const row = (await as('GET', `/invoicing/shipped-not-invoiced?partyId=${A.brand}`)).customers.flatMap((entry: Json) => entry.ddts).find((entry: Json) => entry.ddtId === S.ddtA.id)
    expect(row.lines[0]).toMatchObject({ shipped: '2', invoiced: '0', inDraft: '1', notInvoiced: '2' })
    expect(row.freight).toMatchObject({ billed: true })
  })

  it('charge lines are typed on the draft: their kind said, their VAT the goods; a charge bills no order line', async () => {
    const lines = S.part.lines.filter((entry: Json) => entry.kind !== 'DEPOSIT_DEDUCTION').map((entry: Json) => ({
      kind: entry.kind,
      chargeKind: entry.chargeKind,
      description: entry.description,
      quantity: entry.quantity,
      uom: entry.uom,
      unitPrice: entry.unitPrice,
      salesOrderLineId: entry.salesOrderLineId,
      size: entry.size,
      ddtId: entry.ddtId,
    }))
    const noKind = await refused('PUT', `/invoicing/invoices/${S.part.id}/lines`, { lines: [...lines, { kind: 'CHARGE', description: 'Imballo', quantity: '1', unitPrice: '8' }] }, 400)
    expect(noKind.issues).toEqual([{ path: 'body/lines/2/chargeKind', message: 'Say what the charge bills: FREIGHT, PACKAGING, SAMPLES, FEE or OTHER.' }])
    const withSize = await refused('PUT', `/invoicing/invoices/${S.part.id}/lines`, { lines: [...lines, { kind: 'CHARGE', chargeKind: 'FEE', description: 'Urgenza', quantity: '1', unitPrice: '8', salesOrderLineId: moneyA.shipping.quality.serialSalesOrderLineId, size: '52' }] }, 400)
    expect(withSize.issues[0].path).toBe('body/lines/2/salesOrderLineId')
    const goodsKind = await refused('PUT', `/invoicing/invoices/${S.part.id}/lines`, { lines: [...lines, { kind: 'GOODS', chargeKind: 'FEE', description: 'Urgenza', quantity: '1', unitPrice: '8' }] }, 400)
    expect(goodsKind.issues[0].message).toBe('Only a charge line (kind CHARGE) says what charge it is.')
    const replaced = await as('PUT', `/invoicing/invoices/${S.part.id}/lines`, { lines: [...lines, { kind: 'CHARGE', chargeKind: 'PACKAGING', description: 'Imballo speciale', quantity: '1', unitPrice: '8', ddtId: S.ddtA.id }] })
    expect(replaced.invoice.lines.map((entry: Json) => [entry.kind, entry.chargeKind, entry.netAmount, entry.vatRatePct])).toEqual([
      ['GOODS', null, 42000, '22.00'],
      ['CHARGE', 'FREIGHT', 1500, '22.00'],
      ['CHARGE', 'PACKAGING', 800, '22.00'],
      ['DEPOSIT_DEDUCTION', null, -24590, '22.00'],
    ])
    expect(replaced.invoice).toMatchObject({ netTotal: 19710, grossTotal: 24046, paymentTerms: { installments: [{ amount: 24046 }] } })
    S.part = replaced.invoice
  })

  it("at issue the freight is the shipment's: a changed figure is refused in words, then the TD24 is issued", async () => {
    await setFreight(S.shipmentA, 1800)
    const checks = await as('GET', `/invoicing/invoices/${S.part.id}/checks`)
    expect(checks.ready).toBe(false)
    expect(checks.problems).toEqual([expect.objectContaining({ code: 'CHARGE_FREIGHT_CHANGED', path: 'lines/1/unitPrice', message: expect.stringContaining('is now 18.00 EUR; line 2 bills 15.00 EUR') })])
    const before = await invoiceSeriesNext()
    expect((await issue(S.part.id, 409)).error.issues).toEqual([expect.objectContaining({ path: 'lines/1/unitPrice' })])
    expect(await invoiceSeriesNext()).toBe(before)
    await setFreight(S.shipmentA, 1500)
    const issued = await issue(S.part.id)
    expect(issued).toMatchObject({ filesPending: false, invoice: { status: 'ISSUED', docType: 'TD24', grossTotal: 24046, deadline: null } })
    expect(issued.invoice.paymentTerms).toMatchObject({ installments: [{ dueDate: dueDateOf(issued.invoice.issueDate, { days: 30, endOfMonth: true }) }] })
    const xml = await downloaded(issued.invoice.xmlFileId)
    expect(await xsdErrors(xml)).toEqual([])
    expect(xml).toContain('<Descrizione>Imballo speciale</Descrizione>')
    expect(xml).toContain(`<NumeroDDT>${S.ddtA.number}</NumeroDDT>`)
    expect(xml).toContain('<ImportoTotaleDocumento>240.46</ImportoTotaleDocumento>')
    expect(xml).toContain('<IBAN>')
    S.part = issued.invoice
    const audit = await admin(`SELECT after FROM "AuditLog" WHERE action = 'invoices.fromDdts' AND "recordId" = $1`, [S.part.id])
    expect(audit[0]!.after).toMatchObject({ part: true, preset: 'TD24', freight: [S.ddtA.id] })
  })
})

describe('one invoice for many shipments (FIN-059): the month of the customer in one TD24', () => {
  it('the deferred draft takes every DDT of the month still to invoice: the jacket left, BLK 52, the freight not billed yet', async () => {
    const answer = await as('POST', '/invoicing/invoices/deferred', { companyId: A.companyA, partyId: A.brand, month: MONTH() }, 201)
    expect(answer.choice).toMatchObject({ docType: 'TD24' })
    expect(answer.freight).toEqual([{ ddtId: S.ddtA.id, number: S.ddtA.number, reason: `The freight of DDT ${S.ddtA.number} is on invoice ${S.part.number} already.` }])
    S.month = answer.invoice
    expect(S.month).toMatchObject({ docType: 'TD24', salesOrderId: null, netTotal: 82900, grossTotal: 101138 })
    expect(S.month.lines.map((entry: Json) => [entry.kind, entry.chargeKind, entry.ddtId, entry.netAmount])).toEqual([
      ['GOODS', null, S.ddtA.id, 42000],
      ['GOODS', null, S.ddtB.id, 40000],
      ['CHARGE', 'FREIGHT', S.ddtB.id, 900],
    ])
    expect(S.month.paymentTerms).toMatchObject({ source: { kind: 'TERMS', termsId: ids.terms } })
    const due = await as('GET', `/invoicing/deferred?partyId=${A.brand}`)
    expect(due.groups.find((entry: Json) => entry.month === MONTH() && entry.partyId === A.brand)).toMatchObject({ drafts: [S.month.id], freightAmount: 0 })
    expect((await refused('POST', '/invoicing/invoices/deferred', { companyId: A.companyA, partyId: A.brand, month: MONTH() }, 409)).message).toContain('in a draft invoice already')
    expect((await refused('POST', '/invoicing/invoices/deferred', { companyId: A.companyA, partyId: A.brand, month: '2001-01' }, 409)).message).toBe('No DDT of 2001-01 of this customer waits for an invoice (shipped, not cancelled).')
  })

  it('issued: one XSD-valid TD24 citing both DDTs, each line on its DDT', async () => {
    const issued = await issue(S.month.id)
    const xml = await downloaded(issued.invoice.xmlFileId)
    expect(await xsdErrors(xml)).toEqual([])
    expect(xml).toContain(`<NumeroDDT>${S.ddtA.number}</NumeroDDT>`)
    expect(xml).toContain(`<NumeroDDT>${S.ddtB.number}</NumeroDDT>`)
    expect(xml).toContain('<ImportoTotaleDocumento>1011.38</ImportoTotaleDocumento>')
    S.month = issued.invoice
    const queue = await as('GET', `/invoicing/shipped-not-invoiced?partyId=${A.brand}`)
    expect(queue.customers.flatMap((entry: Json) => entry.ddts).filter((entry: Json) => entry.ddtId === S.ddtA.id || entry.ddtId === S.ddtB.id)).toEqual([])
  })

  it("a shipment's freight is billed once: a typed invoice billing DDT B's freight again is refused at issue", async () => {
    const typed = (
      await as('POST', '/invoicing/invoices', { companyId: A.companyA, buyerPartyId: A.brand, docType: 'TD01', lines: [{ kind: 'CHARGE', chargeKind: 'FREIGHT', description: 'Trasporto', quantity: '1', unitPrice: '9', ddtId: S.ddtB.id }] }, 201)
    ).invoice
    expect(typed.paymentTerms).toMatchObject({ source: { kind: 'TERMS' } })
    expect((await issue(typed.id, 409)).error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'lines/0', message: `The freight of DDT ${S.ddtB.number} is invoiced already (${S.month.number}): a shipment's freight is billed once.` })]))
    await as('DELETE', `/invoicing/invoices/${typed.id}`, {})
  })
})

describe('the order settled with a line closed short (B-W2a-30)', () => {
  it('SO-0002 closes its BLK line short: its pieces never shipped are done', async () => {
    const order = moneyA.shipping.quality.production.salesOrderId
    const before = (await as('GET', `/invoicing/orders/${order}/settlement`)).settlement
    const blk = before.lines.filter((line: Json) => line.toShip > 0)[0]
    expect(blk).toBeDefined()
    const [line] = await admin<{ quantity: number }>(`SELECT quantity FROM "SalesOrderLine" WHERE id = $1`, [blk.salesOrderLineId])
    const shipped = before.lines.filter((entry: Json) => entry.salesOrderLineId === blk.salesOrderLineId).reduce((sum: number, entry: Json) => sum + entry.shipped, 0)
    await admin(`UPDATE "SalesOrderLine" SET "closedShortQuantity" = $2, "closedShortAt" = now(), "closedShortById" = $3, "closeShortReason" = 'Customer takes what shipped' WHERE id = $1`, [blk.salesOrderLineId, line!.quantity - shipped, newId()])
    const after = (await as('GET', `/invoicing/orders/${order}/settlement`)).settlement
    const closed = after.lines.filter((entry: Json) => entry.salesOrderLineId === blk.salesOrderLineId)
    expect(closed.every((entry: Json) => entry.toShip === 0)).toBe(true)
    expect(closed.reduce((sum: number, entry: Json) => sum + entry.closedShort, 0)).toBe(line!.quantity - shipped)
  })
})

describe('the walls: office only, the price grain, tenants and companies', () => {
  it('floor and portal sessions are refused the new routes', async () => {
    for (const session of ['floor', 'partner']) {
      expect((await wall(session, 'GET', '/invoicing/deferred')).status).toBe(403)
      expect((await wall(session, 'POST', '/invoicing/invoices/deferred', { companyId: A.companyA, partyId: A.brand, month: MONTH() })).status).toBe(403)
      expect((await wall(session, 'POST', '/invoicing/invoices/from-milestone', { milestoneId: ids.depositStep })).status).toBe(403)
    }
  })

  it('without the price grain the deferred list keeps no amount; another company and tenant see none of it', async () => {
    const plain = (await wall('noPrice', 'GET', '/invoicing/deferred', undefined, 200)).body
    for (const group of plain.groups) {
      expect(group).not.toHaveProperty('valueAmount')
      expect(group).not.toHaveProperty('freightAmount')
    }
    const line = (await wall('noPrice', 'GET', `/invoicing/invoices/${S.part.id}`, undefined, 200)).body.invoice.lines[1]
    expect(line).toMatchObject({ kind: 'CHARGE', chargeKind: 'FREIGHT' })
    expect(line).not.toHaveProperty('unitPrice')
    expect((await wall('companyB', 'GET', '/invoicing/deferred', undefined, 200)).body.groups).toEqual([])
    expect((await wall('companyB', 'POST', '/invoicing/invoices/deferred', { companyId: A.companyA, partyId: A.brand, month: MONTH() })).status).toBe(404)
    expect((await wall('otherTenant', 'GET', '/invoicing/deferred', undefined, 200)).body.groups).toEqual([])
    expect((await wall('noPrice', 'POST', '/invoicing/invoices/from-ddts', { ddtIds: [S.ddtA.id], lines: [{ ddtId: S.ddtA.id, salesOrderLineId: newId(), size: '52', quantity: 1 }] })).status).toBe(409)
  })
})
