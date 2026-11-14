import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validateXML } from 'xmllint-wasm'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { dueDateUnder } from '@nexus/factory-domain/money/terms/due-dates'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedMoney, type MoneySeed } from '../../../../../../packages/factory-db/seed/money'
import { seed as seedSamples } from '../../../../../../packages/factory-db/seed/samples'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { fileTravelDocuments, TRAVEL_DOCUMENT_PERMISSIONS } from '../../shipping/documents/testing/compliance'

/**
 * Invoicing in depth (B-W2b-396; FIN-063, FIN-068, FIN-076, FIN-080; VI1:01-03) on the local stack: a throwaway PostgreSQL
 * 17 database from the migrations (the runtime login: row-level security, the grants and the money and
 * …_tax_currency_w2b_guards triggers are real), the factory-db seeds of one tenant (core, money, samples), the real office
 * sign-in (finance steps up to issue), and a second app on the same database with test sessions (the warehouse that ships,
 * the walls). Seed Customer One (P1) is invoiced MONTHLY on terms "Ri.Ba. 60 days end of month, August skipped" made through
 * the terms library; SEED-SO-0003 carries a priced change whose fee needs no new yes; two shipments of two orders leave
 * today. Every name, number, rate and amount is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs apps/factory-api/src/modules/invoicing/runs`.
 */

let h: Harness
let walls: FastifyInstance
let finance: Browser
let secret: string
let moneyA: MoneySeed

const ns = 'invdepth-a'
const A = { tenant: seedUuid(ns, 'tenant'), companyA: seedUuid(ns, 'company:A'), companyB: seedUuid(ns, 'company:B'), siteA1: seedUuid(ns, 'site:A1'), brand: seedUuid(ns, 'party:P1'), other: seedUuid(ns, 'party:P2') }
const YEAR = businessDate(new Date()).slice(0, 4)
const TODAY = () => businessDate(new Date())
const MONTH = () => TODAY().slice(0, 7)
const YESTERDAY = () => new Date(Date.parse(`${TODAY()}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10)
const S: Record<string, any> = {}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]

async function as(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await finance.send(method as 'POST', url, method === 'GET' ? undefined : (body ?? {}))
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}
const refused = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body: unknown, status: number): Promise<Json> => (await as(method, url, body, status)).error

const SHIPPING: Permission[] = ['shipping.view', 'shipping.manage', 'shipping.pack', 'shipping.ddt.issue', 'shipping.ddt.cancel', 'files.read']
const MONEY: Permission[] = ['invoices.view', 'invoices.manage', 'invoices.issue', 'money.price']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants })
const SESSIONS: Record<string, () => SessionContext> = {
  warehouse: () => office([grant(SHIPPING)]),
  quality: () => office([grant(TRAVEL_DOCUMENT_PERMISSIONS)]),
  noPrice: () => office([grant(['invoices.view', 'invoices.manage'])]),
  companyB: () => office([grant([...MONEY, 'invoices.depositRules.manage'], [A.companyB])]),
  reader: () => office([grant(['invoices.view', 'money.price'])]),
  floor: () => ({ audience: 'floor', tenantId: A.tenant, actorId: newId(), siteId: A.siteA1, deviceId: newId(), grants: [grant(MONEY)] }),
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

beforeAll(async () => {
  h = await startHarness('invoicing_depth')
  await seedCore({ db: h.database, namespace: ns })
  moneyA = await seedMoney({ db: h.database, namespace: ns })
  await seedSamples({ db: h.database, namespace: ns })
  for (const companyId of [A.companyA, A.companyB]) {
    await admin(`UPDATE "Company" SET "vatNumber" = 'IT12345670009', "fiscalCode" = '12345670009', "regimeFiscale" = 'RF01', "reaOffice" = 'MI', "reaNumber" = '0000001', address = $2::jsonb WHERE id = $1`, [
      companyId,
      JSON.stringify({ line1: 'Via Esempio 1', postalCode: '20121', city: 'Milano', province: 'MI', country: 'IT' }),
    ])
    await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'SHIPMENT', 'MAIN', 'ALL', 'NEVER', 'SH-{N:5}', false) ON CONFLICT DO NOTHING`, [newId(), A.tenant, companyId])
    await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'DDT', 'MAIN', $4, 'YEARLY', '{N}/{YYYY}', true) ON CONFLICT DO NOTHING`, [newId(), A.tenant, companyId, YEAR])
    await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'INVOICE', 'MAIN', $4, 'YEARLY', 'FT-{YYYY}-{N:5}', true) ON CONFLICT DO NOTHING`, [newId(), A.tenant, companyId, YEAR])
  }
  await admin(`UPDATE "NumberSeries" SET "lastIssuedDate" = NULL WHERE "tenantId" = $1 AND kind IN ('DDT', 'INVOICE')`, [A.tenant])
  if ((await admin(`SELECT 1 FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2'`, [A.tenant])).length === 0) {
    await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), A.tenant])
  }
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1`, [A.tenant])
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId }))
  // SO-0003 trimmed to the two jackets made; a priced change on it whose fee (25.00) needs no new yes (VI1:01).
  const so3 = moneyA.shipping.quality.serialSalesOrderId
  await admin(`UPDATE "SalesOrderLineSize" SET quantity = 2 WHERE "lineId" = $1`, [moneyA.shipping.quality.serialSalesOrderLineId])
  await admin(`UPDATE "SalesOrderLine" SET quantity = 2, "netAmount" = 84000, "vatAmount" = 18480 WHERE id = $1`, [moneyA.shipping.quality.serialSalesOrderLineId])
  await admin(`UPDATE "SalesOrder" SET "netAmount" = 84000, "vatAmount" = 18480, "grossAmount" = 102480 WHERE id = $1`, [so3])
  S.changeRevision = (await admin<{ next: number }>(`SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM "SalesOrderAmendment" WHERE "orderId" = $1`, [so3]))[0]!.next
  await admin(
    `INSERT INTO "SalesOrderAmendment" (id, "tenantId", "companyId", "orderId", "partyId", revision, reason, before, after, "netAmountBefore", "netAmountAfter", "grossAmountBefore", "grossAmountAfter", "reacceptanceNeeded", "feeAmount", "requestId")
     SELECT $1, "tenantId", "companyId", id, "partyId", $2, 'Recut of the collar (made up)', '{}'::jsonb, '{}'::jsonb, 84000, 84000, 102480, 102480, false, 2500, 'req-w396-1' FROM "SalesOrder" WHERE id = $3`,
    [newId(), S.changeRevision, so3],
  )
  // A second priced change waiting for the customer's yes: its fee is not invoiced.
  await admin(
    `INSERT INTO "SalesOrderAmendment" (id, "tenantId", "companyId", "orderId", "partyId", revision, reason, before, after, "netAmountBefore", "netAmountAfter", "grossAmountBefore", "grossAmountAfter", "reacceptanceNeeded", "feeAmount", "requestId")
     SELECT $1, "tenantId", "companyId", id, "partyId", $2, 'Another change (made up)', '{}'::jsonb, '{}'::jsonb, 84000, 84000, 102480, 102480, true, 1000, 'req-w396-2' FROM "SalesOrder" WHERE id = $3`,
    [newId(), S.changeRevision + 1, so3],
  )
  S.so3Number = (await admin<{ number: string }>(`SELECT number FROM "SalesOrder" WHERE id = $1`, [so3]))[0]!.number
  // A development fee on SO-0002 (invoiced with its goods, on the first DDT) and one on SO-0001 (invoiced on its own).
  const fee = `INSERT INTO "SalesOrderLine" (id, "tenantId", "companyId", "orderId", "partyId", seq, kind, "feeKind", "styleId", "colourwayId", description, quantity, "unitPrice", "netAmount", "vatRatePct", "vatAmount", "unitCost", "costAmount")
     SELECT $1, "tenantId", "companyId", "orderId", "partyId", 90, 'FEE', 'DEVELOPMENT', "styleId", "colourwayId", 'Development of the jacket (made up)', 1, 500, 50000, 22, 11000, 0, 0 FROM "SalesOrderLine" WHERE "orderId" = $2 AND kind <> 'FEE' ORDER BY seq LIMIT 1`
  S.so1 = (await admin<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = 'SEED-SO-0001'`, [A.tenant]))[0]!.id
  S.feeSo2 = newId()
  S.feeSo1 = newId()
  await admin(fee, [S.feeSo2, moneyA.shipping.quality.production.salesOrderId])
  await admin(fee, [S.feeSo1, S.so1])

  const user = await addUser(h, { id: A.tenant, slug: ns, companies: [{ id: A.companyA, code: 'SCA' }] }, { email: 'fina.depth@invdepth-a.example.com', role: 'finance' })
  finance = new Browser(h.app)
  const signedIn = await finance.signIn(ns, user.email, user.password)
  expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200)
  secret = await enrolTotp(h, finance)
  walls = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null), logger: false },
  )
  await fileTravelDocuments(walls, 'quality', moneyA.shipping.quality.serialStyleId, moneyA.shipping.quality.serialRevisionId)
  await fileTravelDocuments(walls, 'quality', moneyA.shipping.quality.production.styleId, moneyA.shipping.quality.production.revisionId)
}, 300_000)

afterAll(async () => {
  await walls?.close()
  await h?.close()
}, 60_000)

describe('Italian due-date conventions (FIN-076): terms counted from the end of the month, August skipped', () => {
  it('keeps the conventions on a terms entry, says them in words, refuses a month twice', async () => {
    const made = await as('POST', '/sales/payment-terms', { code: 'RB60FM-NOAUG', name: 'Ri.Ba. 60 gg d.f.f.m., escluso agosto', method: 'MP12', instalments: [{ sharePct: '100', from: 'INVOICE', days: 60, endOfMonth: true }], skipMonths: [8] }, 201)
    expect(made.terms).toMatchObject({ fromEndOfMonth: false, skipMonths: [8] })
    expect(made.terms.summary.it).toContain('escluso agosto (la scadenza passa al mese dopo)')
    const twice = await finance.post('/sales/payment-terms', { code: 'RB60-BAD', name: 'Bad', method: 'MP12', instalments: [{ sharePct: '100', from: 'INVOICE', days: 60 }], skipMonths: [8, 8] })
    expect(twice.status).toBe(400)
    expect((twice.body as Json).error.issues.map((issue: Json) => issue.path)).toEqual(['body/skipMonths'])
    const changed = await as('PATCH', `/sales/payment-terms/${made.terms.id}`, { version: made.terms.version, fromEndOfMonth: true })
    expect(changed.terms).toMatchObject({ fromEndOfMonth: true, skipMonths: [8] })
    S.terms = (await as('PATCH', `/sales/payment-terms/${made.terms.id}`, { version: changed.terms.version, fromEndOfMonth: false })).terms
    await admin(`UPDATE "Party" SET "invoiceTiming" = 'MONTHLY', "paymentTermsId" = $2 WHERE id = $1`, [A.brand, S.terms.id])
  })
})

describe('two shipments of two orders leave today', () => {
  it('SH-0002 (2 jackets of SO-0003) and SO-0002 BLK 52 ship with their DDTs', async () => {
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
  }, 60_000)
})

describe('the monthly invoice run (FIN-068): pick customers, preview, issue and send in one run', () => {
  it("lists the company's customers with deferred invoicing for the month", async () => {
    const candidates = await as('GET', `/invoicing/runs/candidates?companyId=${A.companyA}&month=${MONTH()}`)
    const brand = candidates.customers.find((entry: Json) => entry.partyId === A.brand)
    expect(brand).toMatchObject({ invoiceTiming: 'MONTHLY', ddts: 2, inRunId: null })
    expect((await wall('companyB', 'GET', `/invoicing/runs/candidates?companyId=${A.companyA}&month=${MONTH()}`)).status).toBe(404)
  })

  it('makes a preview: each customer its deferred invoice (the change fee once, on the first DDT); one with nothing to invoice says why', async () => {
    const made = await as('POST', '/invoicing/runs', { companyId: A.companyA, month: MONTH(), partyIds: [A.brand, A.other] }, 201)
    S.run = made.run
    expect(made.skipped).toEqual([{ partyId: A.other, reason: `No DDT of ${MONTH()} of this customer waits for an invoice (shipped, not cancelled).` }])
    expect(made.run).toMatchObject({ status: 'PREVIEW', month: MONTH(), counts: { customers: 2, drafts: 1, issued: 0 }, can: { pick: true, issue: true, delete: true } })
    const brand = made.run.customers.find((entry: Json) => entry.partyId === A.brand)
    expect(brand.invoice).toMatchObject({ docType: 'TD24', status: 'DRAFT', ddts: 2 })
    expect(brand.invoice.problems).toEqual([])
    expect(brand.invoice.ready).toBe(true)
    const invoice = (await as('GET', `/invoicing/invoices/${brand.invoice.id}`)).invoice
    const fee = invoice.lines.find((line: Json) => line.kind === 'CHARGE' && line.chargeKind === 'FEE')
    expect(fee).toMatchObject({ itemCode: `${S.so3Number}/R${S.changeRevision}`, netAmount: 2500, ddtId: expect.any(String) })
    expect(invoice.lines.filter((line: Json) => line.chargeKind === 'FEE')).toHaveLength(1)
    // SO-0002's development fee rides on the first DDT (with two DDTs each line names one).
    expect(invoice.lines.find((line: Json) => line.salesOrderLineId === S.feeSo2)).toMatchObject({ kind: 'SERVICE', netAmount: 50000, ddtId: expect.any(String) })
    // FIN-076: the due date counts 60 days end of month from today, out of August.
    expect(invoice.paymentTerms.installments[0].dueDate).toBe(dueDateUnder(TODAY(), { days: 60, endOfMonth: true }, { fromEndOfMonth: false, skipMonths: [8] }))
    S.runInvoice = invoice
  })

  it('refuses the customer in a second preview of the month, and a month not started; walls hold', async () => {
    expect((await refused('POST', '/invoicing/runs', { companyId: A.companyA, month: MONTH(), partyIds: [A.brand] }, 409)).message).toMatch(/in another preview of/)
    const future = `${Number(YEAR) + 1}-01`
    expect((await refused('POST', '/invoicing/runs', { companyId: A.companyA, month: future, partyIds: [A.brand] }, 400)).issues.map((issue: Json) => issue.path)).toEqual(['body/month'])
    expect((await wall('companyB', 'GET', `/invoicing/runs/${S.run.id}`)).status).toBe(404)
    expect((await wall('floor', 'GET', `/invoicing/runs/${S.run.id}`)).status).toBe(403)
    const noPrice = (await wall('noPrice', 'GET', `/invoicing/runs/${S.run.id}`, undefined, 200)).body.run
    expect(noPrice.customers.find((entry: Json) => entry.partyId === A.brand).invoice.grossTotal).toBeUndefined()
  })

  it('picks again: the customer taken out leaves the run', async () => {
    const picked = await as('PUT', `/invoicing/runs/${S.run.id}/customers`, { version: S.run.version, partyIds: [A.brand] })
    expect(picked.removed).toEqual([A.other])
    expect(picked.run.counts).toMatchObject({ customers: 1, drafts: 1 })
    S.run = picked.run
  })

  it('issues the run with a step-up: the draft gets its number and files; the run is ISSUED and frozen', async () => {
    const noStepUp = await finance.post(`/invoicing/runs/${S.run.id}/issue`, { version: S.run.version, send: false })
    expect(noStepUp.status).toBe(403)
    await stepUp(h, finance, secret)
    const issued = await as('POST', `/invoicing/runs/${S.run.id}/issue`, { version: S.run.version, send: false })
    expect(issued.held).toEqual([])
    expect(issued.issued).toEqual([expect.objectContaining({ invoiceId: S.runInvoice.id, number: expect.stringMatching(/^FT-/), filesPending: false, sent: false, sendProblem: null })])
    expect(issued.run).toMatchObject({ status: 'ISSUED', counts: { drafts: 0, issued: 1 }, can: { pick: false, issue: false, delete: false } })
    const invoice = (await as('GET', `/invoicing/invoices/${S.runInvoice.id}`)).invoice
    expect(invoice.status).toBe('ISSUED')
    expect(await xsdErrors(await downloaded(invoice.xmlFileId))).toEqual([])
    // Frozen: issued again, re-picked or deleted, each refused in words.
    await stepUp(h, finance, secret)
    expect((await refused('POST', `/invoicing/runs/${S.run.id}/issue`, {}, 409)).message).toMatch(/is issued already/)
    expect((await refused('DELETE', `/invoicing/runs/${S.run.id}`, undefined, 409)).message).toMatch(/is issued: it is kept/)
    const list = await as('GET', `/invoicing/runs?companyId=${A.companyA}`)
    expect(list.runs.find((run: Json) => run.id === S.run.id)).toMatchObject({ status: 'ISSUED', invoices: 1 })
  })

  it('a change fee issued once is never invoiced again; a preview with nothing issued is deleted with its drafts', async () => {
    const answer = await as('POST', `/invoicing/orders/${moneyA.shipping.quality.serialSalesOrderId}/fees/invoice`, {}, 409)
    expect(answer.error.message).toMatch(/is on invoice FT-/)
    const october = await as('POST', '/invoicing/runs', { companyId: A.companyA, month: '2026-10', partyIds: [A.other] }, 201)
    expect(october.run.counts.drafts).toBe(0)
    expect((await as('DELETE', `/invoicing/runs/${october.run.id}?version=${october.run.version}`)).deleted).toBe(true)
  })
})

describe("the invoice's language and currency (FIN-063)", () => {
  it("a new draft takes the invoices contact's language; the office changes it or lets it be decided again", async () => {
    await admin(`INSERT INTO "PartyContact" (id, "tenantId", "partyId", name, email, roles, language) VALUES ($1, $2, $3, 'Ada Accounts (made up)', 'ada.accounts@p1.example.com', '{INVOICES}', 'en')`, [newId(), A.tenant, A.brand])
    S.draft = (await as('POST', '/invoicing/invoices', { companyId: A.companyA, buyerPartyId: A.brand, docType: 'TD01', payment: { method: 'MP05', dueDate: `${YEAR}-12-31` }, lines: [{ description: 'Giacca moto (campione)', quantity: '1', unitPrice: '1000' }] }, 201)).invoice
    const first = (await as('GET', `/invoicing/invoices/${S.draft.id}/language-currency`)).languageCurrency
    expect(first).toMatchObject({ language: { code: 'en', source: 'INVOICE', decided: { code: 'en', source: 'CONTACT' } }, currency: { code: 'EUR', euro: true }, rate: null, euro: null, waits: null, rule: { status: 'UNVERIFIED' } })
    const german = (await as('PUT', `/invoicing/invoices/${S.draft.id}/language`, { version: first.version, language: 'de' })).languageCurrency
    expect(german.language).toMatchObject({ code: 'de', source: 'INVOICE' })
    expect((await refused('PUT', `/invoicing/invoices/${S.draft.id}/language`, { version: german.version, language: 'd1' }, 400)).issues.map((issue: Json) => issue.path)).toEqual(['body/language'])
    const back = (await as('PUT', `/invoicing/invoices/${S.draft.id}/language`, { version: german.version, language: null })).languageCurrency
    expect(back.language).toMatchObject({ code: 'en', source: 'INVOICE' })
  })

  it('an invoice in USD takes the day rate, or the rate the office types; refuses a future day; issued with the trio and Divisa USD', async () => {
    await admin(`UPDATE "Invoice" SET currency = 'USD' WHERE id = $1`, [S.draft.id])
    await admin(`INSERT INTO "ExchangeRate" (id, "tenantId", base, quote, "rateDate", rate, source, key) VALUES ($1, $2, 'EUR', 'USD', $3::date, 1.08, 'ECB', $4)`, [newId(), A.tenant, YESTERDAY(), `EUR:USD:${YESTERDAY()}:ECB`])
    const day = (await as('GET', `/invoicing/invoices/${S.draft.id}/language-currency`)).languageCurrency
    expect(day).toMatchObject({ currency: { code: 'USD', euro: false }, rate: { source: 'DAY_RATE', rateDate: YESTERDAY(), words: '1 EUR = 1.08 USD' }, waits: null })
    expect(day.euro.grossEur).toBe(Math.round(122_000 / 1.08))
    expect((await refused('PUT', `/invoicing/invoices/${S.draft.id}/rate`, { version: day.version, exchangeRate: '1.10', rateDate: `${Number(YEAR) + 1}-01-01` }, 400)).issues.map((issue: Json) => issue.path)).toEqual(['body/rateDate'])
    const typed = (await as('PUT', `/invoicing/invoices/${S.draft.id}/rate`, { version: day.version, exchangeRate: '1.10', rateDate: TODAY() })).languageCurrency
    expect(typed.rate).toMatchObject({ exchangeRate: '1.10000000', rateDate: TODAY(), source: 'TYPED' })
    expect((await as('GET', `/invoicing/invoices/${S.draft.id}/checks`)).problems.filter((problem: Json) => problem.code === 'CURRENCY')).toEqual([])
    const issued = (await issue(S.draft.id)).invoice
    expect(issued).toMatchObject({ status: 'ISSUED', currency: 'USD' })
    expect(await admin(`SELECT "exchangeRate"::text AS rate, "rateDate"::text AS day, "totalEur" AS eur FROM "Invoice" WHERE id = $1`, [S.draft.id])).toEqual([{ rate: '1.10000000', day: TODAY(), eur: Math.round(122_000 / 1.1) }])
    const xml = await downloaded(issued.xmlFileId)
    expect(xml).toContain('<Divisa>USD</Divisa>')
    expect(xml).toContain('Euro equivalent at 1 EUR = 1.10 USD')
    expect(await xsdErrors(xml)).toEqual([])
    const kept = (await as('GET', `/invoicing/invoices/${S.draft.id}/language-currency`)).languageCurrency
    expect(kept.rate).toMatchObject({ source: 'KEPT', exchangeRate: '1.10000000' })
    expect((await refused('PUT', `/invoicing/invoices/${S.draft.id}/language`, { version: kept.version, language: 'it' }, 409)).message).toMatch(/an issued invoice never changes/)
  })
})

describe("a sample round's charge and an order's fees, invoiced once; a fee credited against the bulk order (VI1:01-03)", () => {
  it("invoices a round's charge once; an internal round has no customer to charge", async () => {
    const rounds = await admin<{ id: string; number: string; party: string | null }>(`SELECT id, number, "partyId" AS party FROM "SampleRound" WHERE "tenantId" = $1 AND number IN ('SEED-SR-0002', 'SEED-SR-0003') ORDER BY number`, [A.tenant])
    const made = (await as('POST', '/invoicing/invoices/from-sample-round', { sampleRoundId: rounds[1]!.id }, 201)).invoice
    expect(made.lines).toEqual([expect.objectContaining({ kind: 'CHARGE', chargeKind: 'SAMPLES', itemCode: 'SEED-SR-0003', netAmount: 15000 })])
    expect((await refused('POST', '/invoicing/invoices/from-sample-round', { sampleRoundId: rounds[1]!.id }, 409)).message).toBe('The charge of sample round SEED-SR-0003 is on a draft invoice already: it is invoiced once.')
    expect((await refused('POST', '/invoicing/invoices/from-sample-round', { sampleRoundId: rounds[0]!.id }, 409)).message).toBe('Sample round SEED-SR-0002 is internal: it has no customer to charge.')
  })

  it("invoices an order's fee on its own, then credits it against the bulk order with a credit note; the credit is given at its issue", async () => {
    const order = (await admin<{ id: string; party: string }>(`SELECT id, "partyId" AS party FROM "SalesOrder" WHERE id = $1`, [S.so1]))[0]!
    S.feeLine = S.feeSo1
    const fees = await as('POST', `/invoicing/orders/${order.id}/fees/invoice`, {}, 201)
    expect(fees.invoice.lines).toEqual([expect.objectContaining({ kind: 'SERVICE', salesOrderLineId: S.feeLine, netAmount: 50000 })])
    const invoiced = (await issue(fees.invoice.id)).invoice
    expect((await refused('POST', `/invoicing/orders/${order.id}/fees/invoice`, {}, 409)).message).toMatch(/is on invoice FT-/)
    const bulk = (await admin<{ id: string; number: string }>(`SELECT o.id, o.number FROM "SalesOrder" o WHERE o."partyId" = $1 AND o.id <> $2 AND o.status <> 'CANCELLED' AND EXISTS (SELECT 1 FROM "SalesOrderLine" l WHERE l."orderId" = o.id AND l.kind <> 'FEE') ORDER BY o.number LIMIT 1`, [order.party, order.id]))[0]!
    expect((await refused('POST', `/invoicing/fee-lines/${S.feeLine}/credit`, { bulkOrderId: order.id }, 400)).message).toBe('A fee is credited against another order than its own.')
    const credit = await as('POST', `/invoicing/fee-lines/${S.feeLine}/credit`, { bulkOrderId: bulk.id })
    expect(credit).toMatchObject({ state: 'NAMED', bulkOrderId: bulk.id, creditNote: { docType: 'TD04', status: 'DRAFT', creditOfId: invoiced.id } })
    expect(await admin(`SELECT "feeCreditOrderId" AS bulk, "feeCreditedAt" AS at FROM "SalesOrderLine" WHERE id = $1`, [S.feeLine])).toEqual([{ bulk: bulk.id, at: null }])
    expect((await refused('POST', `/invoicing/fee-lines/${S.feeLine}/credit`, { bulkOrderId: bulk.id }, 409)).message).toBe('A credit note of this fee is a draft already: issue or delete it first.')
    await issue(credit.creditNote.id)
    const [row] = await admin<{ at: Date | null }>(`SELECT "feeCreditedAt" AS at FROM "SalesOrderLine" WHERE id = $1`, [S.feeLine])
    expect(row!.at).not.toBeNull()
    expect((await refused('POST', `/invoicing/fee-lines/${S.feeLine}/credit`, { bulkOrderId: bulk.id }, 409)).message).toMatch(/was credited already/)
  })
})

describe('the deposit when an order is cancelled (FIN-080)', () => {
  it("keeps the company's rules: one active per kind, side and order; checked in words; changed and archived", async () => {
    const rule = (await as('POST', '/invoicing/deposit-rules', { companyId: A.companyA, depositKind: 'ACCONTO', cancelledBy: 'CUSTOMER', madeToMeasure: null, refundRule: 'KEEP_PERCENT', keepPct: '30', documentKind: 'CREDIT_NOTE', note: 'Spese di avvio trattenute (made up)' }, 201)).rule
    expect(rule).toMatchObject({ keepPct: '30', status: 'ACTIVE' })
    expect((await refused('POST', '/invoicing/deposit-rules', { companyId: A.companyA, depositKind: 'ACCONTO', cancelledBy: 'CUSTOMER', madeToMeasure: null, refundRule: 'REFUND_ALL', documentKind: 'CREDIT_NOTE' }, 409)).message).toMatch(/has an active rule/)
    expect((await refused('POST', '/invoicing/deposit-rules', { companyId: A.companyA, depositKind: 'ACCONTO', cancelledBy: 'CUSTOMER', madeToMeasure: true, refundRule: 'REFUND_DOUBLE', documentKind: 'CREDIT_NOTE' }, 400)).issues.map((issue: Json) => issue.path)).toEqual(['body/refundRule'])
    const doubled = (await as('POST', '/invoicing/deposit-rules', { companyId: A.companyA, depositKind: 'CAPARRA', cancelledBy: 'COMPANY', madeToMeasure: null, refundRule: 'REFUND_DOUBLE', documentKind: 'CREDIT_NOTE' }, 201)).rule
    await as('POST', `/invoicing/deposit-rules/${doubled.id}/archive`, { version: doubled.version })
    S.rule = (await as('PATCH', `/invoicing/deposit-rules/${rule.id}`, { version: rule.version, keepPct: '40' })).rule
    expect(S.rule.keepPct).toBe('40')
    const listed = await as('GET', `/invoicing/deposit-rules?companyId=${A.companyA}`)
    expect(listed).toMatchObject({ mayManage: true, rule: { status: 'UNVERIFIED' } })
    expect(listed.rules.map((entry: Json) => entry.id)).toEqual([rule.id])
    expect((await wall('reader', 'POST', '/invoicing/deposit-rules', { companyId: A.companyA, depositKind: 'CAPARRA', cancelledBy: 'CUSTOMER', madeToMeasure: null, refundRule: 'REFUND_ALL', documentKind: 'CREDIT_NOTE' })).status).toBe(403)
  })

  it("shows what follows before the cancel; on the cancelled order drafts the credit note of what is paid back, once", async () => {
    const order = (await admin<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = 'SEED-SO-0001'`, [A.tenant]))[0]!
    const before = await as('GET', `/invoicing/orders/${order.id}/deposit-cancellation?cancelledBy=CUSTOMER`)
    expect(before.deposits).toHaveLength(1)
    const deposit = before.deposits[0]
    expect(deposit).toMatchObject({ source: 'RULE', ruleId: S.rule.id, refundRule: 'KEEP_PERCENT', document: 'CREDIT_NOTE', decided: false })
    expect(deposit.kept).toBe(Math.round(deposit.paid * 0.4))
    expect(deposit.creditAmount).toBe(Math.min(deposit.paid - deposit.kept, deposit.invoiced))
    const byUs = await as('GET', `/invoicing/orders/${order.id}/deposit-cancellation?cancelledBy=COMPANY`)
    expect(byUs.deposits[0]).toMatchObject({ source: 'NO_RULE', kept: 0, refund: deposit.paid })
    expect((await refused('POST', `/invoicing/orders/${order.id}/deposit-cancellation`, { cancelledBy: 'CUSTOMER' }, 409)).message).toMatch(/its deposits are decided once it is cancelled/)
    await admin(`UPDATE "SalesOrder" SET status = 'CANCELLED', "cancelReason" = 'The customer withdrew (made up).', "closedAt" = now() WHERE id = $1`, [order.id])
    const decided = await as('POST', `/invoicing/orders/${order.id}/deposit-cancellation`, { cancelledBy: 'CUSTOMER' })
    expect(decided.creditNotes).toEqual([expect.objectContaining({ docType: 'TD04', status: 'DRAFT', grossTotal: deposit.creditAmount })])
    expect(decided.deposits[0].decided).toBe(true)
    expect(decided.creditNotes[0].causale).toMatch(/Restituzione acconto - annullamento dell'ordine SEED-SO-0001/)
    expect((await refused('POST', `/invoicing/orders/${order.id}/deposit-cancellation`, { cancelledBy: 'CUSTOMER' }, 409)).message).toMatch(/are decided already/)
    expect((await wall('companyB', 'GET', `/invoicing/orders/${order.id}/deposit-cancellation?cancelledBy=CUSTOMER`)).status).toBe(404)
  })
})
