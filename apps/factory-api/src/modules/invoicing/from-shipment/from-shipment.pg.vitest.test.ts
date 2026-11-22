import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { validateXML } from 'xmllint-wasm'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedMoney, type MoneySeed } from '../../../../../../packages/factory-db/seed/money'
import { seed as seedOrderPage } from '../../../../../../packages/factory-db/seed/order-page' // B-OP-046 (P16)
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { FakeSdi } from '../../../adapters/sdi/fake'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { createGateway } from '../../../platform/gateway/gateway'
import { systemContext } from '../../../platform/outbox/system'
import { fileTravelDocuments, TRAVEL_DOCUMENT_PERMISSIONS } from '../../shipping/documents/testing/compliance'
import { pollSend } from '../sdi/poll'
import { createSdiRuntime, useSdi, type SdiRuntime } from '../sdi/runtime'
// ---- B-W2b-F53: this file fixes its clock on a day of the seeds' story, so it runs the seeds as written (seed-calendar)
await vi.hoisted(async () => (await import('@nexus/factory-db/testing')).seedsAsWritten())

// ---- B-W2b-F43: the clock is fixed at Friday 13 Nov 2026 09:00 UTC (10:00 at the plant), in the seeds' week, and runs on from
// there: the expectations read the seeds' fixed days and failed once those days passed (a fake clock on 2026-12-07 or 2027-01-15
// found it). The routes read the same clock (serverClock); the office sign-in keeps its own movable clock.
vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-13T09:00:00.000Z'), shouldAdvanceTime: true })
afterAll(() => vi.useRealTimers())
// ---- end B-W2b-F43

/**
 * Invoices from shipped goods (B-W1-51; FIN-054, FIN-055, FIN-069, FIN-078, FIN-090, FIN-098, FIN-121; PLAN §4.7 stage
 * 15-invoice) on the local stack: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level
 * security, the grants and the …_money_guards, …_quality_shipping_guards and …_numbering_guards triggers are real), the
 * factory-db seeds of two tenants (SEED-SO-0003's serial-tracked jackets released on WO-0003 and the DRAFT shipment
 * SH-0002; SEED-SO-0002's last released BLK 52), the real office sign-in (finance steps up to issue and send), the FAKE
 * SDI intermediary behind the real gateway, and a second app on the same database with test sessions (the warehouse
 * that packs and ships, and the walls). The seed dates its documents in late 2026: the DDT and invoice series' last
 * dates are cleared so today's documents may follow. SO-0003 is amended to the two jackets made. Every name, number and
 * amount is made up. Run with `node scripts/factory/run-pg-tests.mjs from-shipment`.
 */

let h: Harness
let walls: FastifyInstance
let finance: Browser
let secret: string
let moneyA: MoneySeed
let sdi: SdiRuntime

const ns = { a: 'invs-a', b: 'invs-b' } as const
const A = { tenant: seedUuid(ns.a, 'tenant'), companyA: seedUuid(ns.a, 'company:A'), companyB: seedUuid(ns.a, 'company:B'), siteA1: seedUuid(ns.a, 'site:A1'), brand: seedUuid(ns.a, 'party:P1') }
const B = { tenant: seedUuid(ns.b, 'tenant'), companyA: seedUuid(ns.b, 'company:A') }
const YEAR = businessDate(new Date()).slice(0, 4)
const TODAY = () => businessDate(new Date())
const ids = { depositSo3: newId(), depositSo2: newId() }
const S: Record<string, any> = {}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]

/** A request of the signed-in finance browser. */
async function as(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await finance.send(method as 'POST', url, method === 'GET' ? undefined : (body ?? {}))
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}
const refused = async (method: 'GET' | 'POST' | 'DELETE', url: string, body: unknown, status: number): Promise<Json> => (await as(method, url, body, status)).error

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

/** Company A's INVOICE series this year: the number it gives next. */
const invoiceSeriesNext = async (): Promise<number> => (await admin<{ next: number }>(`SELECT "nextValue" AS next FROM "NumberSeries" WHERE "tenantId" = $1 AND "companyId" = $2 AND kind = 'INVOICE' AND "scopeKey" = $3`, [A.tenant, A.companyA, YEAR]))[0]!.next
const invoiceNumber = (value: number) => `FT-${YEAR}-${String(value).padStart(5, '0')}`
const events = async (type: string, subject: string) => admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = $1 AND subject = $2 ORDER BY "occurredAt", id`, [type, subject])

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

async function packAndShip(shipmentId: string, parcels: { lineIds?: string[]; serial?: string; parcelId?: string; weight: string }[]): Promise<Json> {
  for (const parcel of parcels) {
    if (parcel.serial) await wall('warehouse', 'POST', `/shipping/packing/${shipmentId}/serials`, { serial: parcel.serial, parcelId: parcel.parcelId }, 200)
    await wall('warehouse', 'PATCH', `/shipping/packing/${shipmentId}/parcels/${parcel.parcelId}`, { grossWeightKg: parcel.weight }, 200)
  }
  expect((await wall('warehouse', 'POST', `/shipping/packing/${shipmentId}/pack`, {}, 200)).body.shipment.status).toBe('PACKED')
  const issued = (await wall('warehouse', 'POST', `/shipping/shipments/${shipmentId}/ddt`, { ship: true, carrier: { name: 'Seed Express' } }, 201)).body
  expect(issued.shipment.status).toBe('SHIPPED')
  return issued.ddt
}

beforeAll(async () => {
  h = await startHarness('invoices_shipped')
  for (const namespace of [ns.a, ns.b]) await seedCore({ db: h.database, namespace })
  // The money seed runs the shipping seed (and those it builds on): orders, released garments, SH-0002, invoices.
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
  // Tenant A's system roles (the finance template), as tenant set-up makes them.
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId }))

  // SO-0003 amended to the two jackets WO-0003 released (CONFIRMED: its lines may change), and a 30% deposit (TD02).
  const so3 = moneyA.shipping.quality.serialSalesOrderId
  await admin(`UPDATE "SalesOrderLineSize" SET quantity = 2 WHERE "lineId" = $1`, [moneyA.shipping.quality.serialSalesOrderLineId])
  await admin(`UPDATE "SalesOrderLine" SET quantity = 2, "netAmount" = 84000, "vatAmount" = 18480 WHERE id = $1`, [moneyA.shipping.quality.serialSalesOrderLineId])
  await admin(`UPDATE "SalesOrder" SET "netAmount" = 84000, "vatAmount" = 18480, "grossAmount" = 102480 WHERE id = $1`, [so3])
  const request = `INSERT INTO "DepositRequest" (id, "tenantId", "companyId", "partyId", "orderId", kind, "depositPct", currency, amount, "dueDate", "fiscalDocument", "fiscalRule") VALUES ($1, $2, $3, $4, $5, 'ACCONTO', 30, 'EUR', $6, '2026-12-31', 'TD02', 'DEPOSIT_INVOICE_IT')`
  await admin(request, [ids.depositSo3, A.tenant, A.companyA, A.brand, so3, 30000])
  await admin(request, [ids.depositSo2, A.tenant, A.companyA, A.brand, moneyA.shipping.quality.production.salesOrderId, 20000])

  const user = await addUser(h, { id: A.tenant, slug: ns.a, companies: [{ id: A.companyA, code: 'SCA' }] }, { email: 'fiona.finance@invs-a.example.com', role: 'finance' })
  finance = new Browser(h.app)
  const signedIn = await finance.signIn(ns.a, user.email, user.password)
  expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200)
  secret = await enrolTotp(h, finance)

  const gateway = createGateway({ environment: 'test', redis: h.redis, prefix: h.redisPrefix, secrets: h.secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  sdi = createSdiRuntime({ gateway, fake: new FakeSdi({ answerAfterMs: 0 }) })
  useSdi(sdi)
  walls = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null), logger: false },
  )
  // PPE leaves only with its styles' signed DoC and user information on file (B-W1-49): both jackets' revisions.
  await fileTravelDocuments(walls, 'quality', moneyA.shipping.quality.serialStyleId, moneyA.shipping.quality.serialRevisionId)
  await fileTravelDocuments(walls, 'quality', moneyA.shipping.quality.production.styleId, moneyA.shipping.quality.production.revisionId)
}, 240_000)

afterAll(async () => {
  useSdi(undefined)
  await walls?.close()
  await h?.close()
}, 60_000)

describe('stage 15-invoice: deposit TD02 → 2 parcels shipped with a DDT → TD24 with the deposit deducted → SDI delivered → balance paid → order settled', () => {
  it('the deposit is received and its TD02 issued before the goods ship (DPR 633/1972 art. 6 c.4)', async () => {
    await stepUp(h, finance, secret)
    const answer = await as('POST', '/payments/deposit-received', { depositRequestId: ids.depositSo3, amount: 30000, receivedOn: TODAY(), externalRef: 'TRN-W151-0001' }, 201)
    expect(answer.depositInvoice.invoice).toMatchObject({ docType: 'TD02', status: 'ISSUED', netTotal: 24590, vatTotal: 5410, grossTotal: 30000 })
    S.td02 = answer.depositInvoice.invoice
  })

  it('SH-0002 is packed into two parcels on the floor and leaves with its DDT', async () => {
    const sh2 = moneyA.shipping.draftShipmentId
    const [, second, third] = moneyA.shipping.quality.serialIds
    const codes = Object.fromEntries((await admin<{ id: string; serial: string }>('SELECT id, serial FROM "GarmentSerial" WHERE id = ANY($1::uuid[])', [[second, third]])).map((row) => [row.id, row.serial]))
    const added = (await wall('warehouse', 'POST', `/shipping/shipments/${sh2}/lines`, { lines: [{ workOrderSizeId: moneyA.shipping.quality.serialCellId, quantity: 1 }] }, 200)).body.shipment
    const p2 = (await wall('warehouse', 'POST', `/shipping/packing/${sh2}/parcels`, {}, 201)).body.parcelId
    const loose = added.lines.find((line: Json) => line.parcelId === null)
    await wall('warehouse', 'PUT', `/shipping/packing/${sh2}/lines/${loose.id}/parcel`, { parcelId: p2 }, 200)
    S.ddt = await packAndShip(sh2, [
      { serial: codes[second!], parcelId: moneyA.shipping.draftParcelId, weight: '1.85' },
      { serial: codes[third!], parcelId: p2, weight: '2.15' },
    ])
    expect(S.ddt).toMatchObject({ packages: 2 })
  })

  it('lists the DDT under its customer as shipped, not invoiced: 2 jackets, their value, the deposit paid and the deadlines in words', async () => {
    const queue = await as('GET', `/invoicing/shipped-not-invoiced?partyId=${A.brand}`)
    const customer = queue.customers.find((entry: Json) => entry.ddts.some((ddt: Json) => ddt.ddtId === S.ddt.id))
    expect(customer).toMatchObject({ partyId: A.brand, companyId: A.companyA, legalName: 'Seed Customer One S.r.l.' })
    const ddt = customer.ddts.find((entry: Json) => entry.ddtId === S.ddt.id)
    expect(ddt).toMatchObject({ number: S.ddt.number, date: TODAY(), valueAmount: 84000, depositPaidAmount: 30000, immediate: { docType: 'TD01', daysLeft: 12, state: 'OPEN' } })
    expect(ddt.lines).toEqual([expect.objectContaining({ size: '52', shipped: '2', invoiced: '0', inDraft: '0', notInvoiced: '2', unitPrice: '420.000000', netAmount: 84000, orderNumber: 'SEED-SO-0003' })])
    const month = customer.months.find((entry: Json) => entry.ddtIds.includes(S.ddt.id))
    expect(month.allowed).toContain('TD24')
    expect(month.words).toMatch(/TD0?1|TD24/)
  })

  it('two drafts of the same DDT at once: one is made, the other is refused (the DDT is billed once)', async () => {
    const answers = await Promise.all([
      finance.post('/invoicing/invoices/from-ddts', { ddtIds: [S.ddt.id], docType: 'TD24' }),
      finance.post('/invoicing/invoices/from-ddts', { ddtIds: [S.ddt.id], docType: 'TD24' }),
    ])
    expect(answers.map((answer) => answer.status).sort()).toEqual([201, 409])
    const made = answers.find((answer) => answer.status === 201)!.body
    const other = answers.find((answer) => answer.status === 409)!.body
    expect(other.error.message).toContain('in a draft invoice already')
    S.td24 = made.invoice
    expect(made.choice).toMatchObject({ docType: 'TD24', suggested: 'TD01', allowed: ['TD01', 'TD24'], deadline: { docType: 'TD24' } })
    expect(made.deductions).toEqual([])
    expect(S.td24).toMatchObject({ docType: 'TD24', status: 'DRAFT', priceBasis: 'NET', salesOrderId: moneyA.shipping.quality.serialSalesOrderId, netTotal: 59410, vatTotal: 13070, grossTotal: 72480, documentRefs: [{ kind: 'PURCHASE_ORDER', number: 'SEED-PO-91' }] })
    expect(S.td24.lines).toMatchObject([
      { seq: 1, kind: 'GOODS', description: expect.stringContaining('taglia 52'), quantity: '2.0000', unitPrice: '420.000000', netAmount: 84000, vatRatePct: '22.00', size: '52', ddtId: S.ddt.id, salesOrderLineId: moneyA.shipping.quality.serialSalesOrderLineId },
      { seq: 2, kind: 'DEPOSIT_DEDUCTION', quantity: '1.0000', netAmount: -24590, grossAmount: -30000, depositInvoiceId: S.td02.id, description: `Storno acconto fattura n. ${S.td02.number} del ${S.td02.issueDate.split('-').reverse().join('/')}` },
    ])
  })

  it('its goods lines may be replaced, the deduction stays; the deduction is only removed (then the deposit is left to deduct)', async () => {
    const replaced = await as('PUT', `/invoicing/invoices/${S.td24.id}/lines`, { lines: [{ description: S.td24.lines[0].description, quantity: '2', uom: 'PZ', unitPrice: '420', salesOrderLineId: S.td24.lines[0].salesOrderLineId, size: '52', ddtId: S.ddt.id }] })
    expect(replaced.invoice.lines.map((line: Json) => line.kind)).toEqual(['GOODS', 'DEPOSIT_DEDUCTION'])
    expect(replaced.invoice.grossTotal).toBe(72480)
    const tooSmall = await finance.send('PUT' as 'POST', `/invoicing/invoices/${S.td24.id}/lines`, { lines: [{ description: 'Campione', quantity: '1', unitPrice: '100' }] })
    expect(tooSmall.status).toBe(409)
    expect(tooSmall.body.error.message).toContain('The deposit deducted is more than the goods')
    S.td24 = replaced.invoice
  })

  it('checks before issue: ready, with the number the series gives next', async () => {
    const checks = await as('GET', `/invoicing/invoices/${S.td24.id}/checks`)
    expect(checks).toMatchObject({ ready: true, problems: [], numberPreview: invoiceNumber(await invoiceSeriesNext()) })
  })

  it('issues the TD24 with the next number (no gap), an XSD-valid XML citing the DDT and the TD02 deducted', async () => {
    const next = await invoiceSeriesNext()
    const answer = await issue(S.td24.id)
    expect(answer).toMatchObject({ filesPending: false, invoice: { status: 'ISSUED', number: invoiceNumber(next), issueDate: TODAY(), grossTotal: 72480 } })
    expect(await invoiceSeriesNext()).toBe(next + 1)
    expect(await admin('SELECT formatted FROM "NumberAllocation" WHERE "recordId" = $1', [S.td24.id])).toEqual([{ formatted: invoiceNumber(next) }])
    const xml = await downloaded(answer.invoice.xmlFileId)
    expect(await xsdErrors(xml)).toEqual([])
    expect(xml).toContain('<TipoDocumento>TD24</TipoDocumento>')
    expect(xml).toContain(`<NumeroDDT>${S.ddt.number}</NumeroDDT>`)
    expect(xml).toContain(`<IdDocumento>${S.td02.number}</IdDocumento>`)
    expect(xml).toContain('<ImportoTotaleDocumento>724.80</ImportoTotaleDocumento>')
    S.td24 = answer.invoice
    // An invoiced DDT is never cancelled (B-W1-47's rule, on this invoice).
    const [shipment] = await admin<{ version: number }>('SELECT version FROM "Shipment" WHERE id = $1', [moneyA.shipping.draftShipmentId])
    const cancel = await wall('warehouse', 'POST', `/shipping/ddts/${S.ddt.id}/cancel`, { version: shipment!.version, reason: 'Wrong appearance' })
    expect(cancel.status).toBe(409)
    expect(cancel.body.error.message).toContain(`Invoice ${answer.invoice.number} bills the goods of this DDT`)
  })

  it('a second invoice of the same DDT is refused: as a draft from the DDT, and at issue when typed by hand', async () => {
    const again = await refused('POST', '/invoicing/invoices/from-ddts', { ddtIds: [S.ddt.id] }, 409)
    expect(again.message).toBe(`DDT ${S.ddt.number} is invoiced already (${S.td24.number}): shipped goods are invoiced once; a correction is a credit note.`)
    const typed = (
      await as(
        'POST',
        '/invoicing/invoices',
        { companyId: A.companyA, buyerPartyId: A.brand, docType: 'TD24', lines: [{ description: 'Giacca, taglia 52', quantity: '1', uom: 'PZ', unitPrice: '420', salesOrderLineId: moneyA.shipping.quality.serialSalesOrderLineId, size: '52', ddtId: S.ddt.id }] },
        201,
      )
    ).invoice
    const before = await invoiceSeriesNext()
    const issueRefused = (await issue(typed.id, 409)).error
    expect(issueRefused.issues).toEqual([expect.objectContaining({ path: 'lines/0/quantity', message: expect.stringContaining(`are invoiced already (${S.td24.number})`) })])
    expect(await invoiceSeriesNext()).toBe(before)
    await as('DELETE', `/invoicing/invoices/${typed.id}`, {})
  })

  it('SDI delivers both; the order is not settled until the balance is paid', async () => {
    await deliver(S.td02.id)
    await deliver(S.td24.id)
    const { settlement } = await as('GET', `/invoicing/orders/${moneyA.shipping.quality.serialSalesOrderId}/settlement`)
    expect(settlement).toMatchObject({ settled: false, gaps: ['BALANCE_DUE'], fullyShipped: true, fullyInvoiced: true, documentsFinal: true, balanceDueAmount: 72480 })
    expect(settlement.missing).toEqual([{ code: 'BALANCE_DUE', message: "724.80 EUR is still to be paid on the order's invoices." }])
    // B-OM-023: the balance invoice reads OPEN (nothing placed on it yet).
    expect((settlement.invoices as Json[]).find((row) => row.id === S.td24.id)).toMatchObject({ paymentState: 'OPEN' })
    expect(await events('order.fully_settled', moneyA.shipping.quality.serialSalesOrderId)).toEqual([])
  })

  it('the finance screens read it: the list row with its balance, the record beside it, the open items, the settings', async () => {
    const so3 = moneyA.shipping.quality.serialSalesOrderId
    const rows = (await as('GET', `/invoicing/invoices?partyId=${A.brand}`)).invoices
    expect(rows.find((row: Json) => row.id === S.td24.id)).toMatchObject({ status: 'DELIVERED', grossTotal: 72480, paidAmount: 0, creditedAmount: 0, openAmount: 72480, dueDate: null, creditOfId: null, salesOrderId: so3 })
    // A TD02 is paid through its deposit: it asks nothing itself.
    expect(rows.find((row: Json) => row.id === S.td02.id)).toMatchObject({ docType: 'TD02', paidAmount: 0, openAmount: 0 })
    const { related } = await as('GET', `/invoicing/invoices/${S.td24.id}/related`)
    expect(related.ddts).toEqual([expect.objectContaining({ id: S.ddt.id, number: S.ddt.number, date: TODAY(), shipmentId: moneyA.shipping.draftShipmentId })])
    expect(related.depositInvoices).toEqual([{ id: S.td02.id, number: S.td02.number, issueDate: S.td02.issueDate, status: 'DELIVERED', depositRequestId: ids.depositSo3 }])
    expect(related.orders).toEqual([{ id: so3, number: 'SEED-SO-0003' }])
    expect(related.depositRequests).toEqual([expect.objectContaining({ id: ids.depositSo3, orderId: so3, kind: 'ACCONTO', depositPct: '30', amount: 30000, paidAmount: 30000, fiscalDocument: 'TD02', status: 'PAID', depositInvoices: [expect.objectContaining({ id: S.td02.id, number: S.td02.number })] })])
    expect(related).toMatchObject({ payments: [], creditOf: null, creditNotes: [] })
    const { items } = await as('GET', `/payments/open-items?companyId=${A.companyA}&partyId=${A.brand}`)
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: 'INVOICE', id: S.td24.id, number: S.td24.number, docType: 'TD24', fiscalDocument: null, orderId: so3, orderNumber: 'SEED-SO-0003', amount: 72480, openAmount: 72480 }),
      expect.objectContaining({ target: 'DEPOSIT_REQUEST', id: ids.depositSo2, number: null, fiscalDocument: 'TD02', amount: 20000, openAmount: 20000 }),
    ]))
    // Paid and deposit invoices are not open items; the oldest comes first.
    expect(items.some((item: Json) => item.id === S.td02.id || item.id === ids.depositSo3)).toBe(false)
    expect(items.map((item: Json) => item.date)).toEqual([...items.map((item: Json) => item.date)].sort())
    const { settings } = await as('GET', '/invoicing/settings')
    const company = settings.companies.find((entry: Json) => entry.id === A.companyA)
    expect(company).toMatchObject({ identity: { vatNumber: 'IT12345670009', regimeFiscale: 'RF01', address: { city: 'Milano' } }, seller: { ready: true, problems: [] }, sdi: { state: 'ACTIVE', accounts: [expect.objectContaining({ mode: 'FAKE', status: 'ACTIVE' })] } })
    expect(company.series).toEqual(expect.arrayContaining([{ kind: 'INVOICE', next: invoiceNumber(await invoiceSeriesNext()) }]))
    expect(company.archive.archivedSends).toBeGreaterThanOrEqual(0)
    // No money in the settings; another tenant's companies are not there.
    expect(JSON.stringify(settings)).not.toMatch(/Amount/)
    expect(settings.companies.some((entry: Json) => entry.id === B.companyA)).toBe(false)
  })

  it('the balance payment, allocated to the TD24, settles the order: order.fully_settled once', async () => {
    const paid = await as('POST', '/payments', { companyId: A.companyA, partyId: A.brand, amount: 72480, receivedOn: TODAY(), externalRef: 'TRN-W151-0002', allocations: [{ invoiceId: S.td24.id }] }, 201)
    expect(paid.payment).toMatchObject({ allocated: 72480, unallocated: 0 })
    S.balancePayment = paid.payment
    // What the payment is placed on, by name, and who placed it (the payments list's chips, the record's ledger).
    expect(paid.payment.placedOn).toEqual([{ target: 'INVOICE', targetId: S.td24.id, amount: 72480, number: S.td24.number, docType: 'TD24', orderNumber: 'SEED-SO-0003' }])
    expect(paid.payment.allocations[0].label).toEqual({ number: S.td24.number, docType: 'TD24', orderNumber: 'SEED-SO-0003' })
    expect(paid.payment.people.map((person: Json) => person.id)).toContain(paid.payment.createdById)
    expect((await as('GET', '/payments')).payments.find((row: Json) => row.id === paid.payment.id).placedOn).toEqual(paid.payment.placedOn)
    expect((await as('GET', `/invoicing/invoices?partyId=${A.brand}&docType=TD24`)).invoices.find((row: Json) => row.id === S.td24.id)).toMatchObject({ paidAmount: 72480, openAmount: 0 })
    expect((await as('GET', `/invoicing/invoices/${S.td24.id}/related`)).related.payments).toEqual([expect.objectContaining({ paymentId: paid.payment.id, externalRef: 'TRN-W151-0002', amount: 72480, reversed: false, reversalOfId: null })])
    expect((await as('GET', `/payments/open-items?companyId=${A.companyA}&partyId=${A.brand}`)).items.some((item: Json) => item.id === S.td24.id)).toBe(false)
    const order = moneyA.shipping.quality.serialSalesOrderId
    expect((await as('GET', `/invoicing/invoices/${S.td24.id}`)).invoice).toMatchObject({ paidAmount: 72480, openAmount: 0, creditedAmount: 0, refundDueAmount: 0 })
    const { settlement } = await as('GET', `/invoicing/orders/${order}/settlement`)
    expect(settlement).toMatchObject({ settled: true, gaps: [], balanceDueAmount: 0, refundDueAmount: 0, invoices: [{ id: S.td24.id, openAmount: 0 }] })
    expect(settlement.invoices[0].paymentState).toBe('PAID') // B-OM-023
    expect(await events('order.fully_settled', order)).toEqual([{ payload: { orderId: order, partyId: A.brand } }])
    const [audit] = await admin<{ action: string }>(`SELECT action FROM "AuditLog" WHERE "recordType" = 'SalesOrder' AND "recordId" = $1`, [order])
    expect(audit).toEqual({ action: 'invoices.orderSettled' })
    // The order's own status is the sales module's (B-W1-25's close command consumes the event).
    expect((await admin('SELECT status FROM "SalesOrder" WHERE id = $1', [order]))[0]).toEqual({ status: 'CONFIRMED' })
  })

  it('the payment taken back unsettles the order: order.unsettled once, what is missing in codes', async () => {
    const order = moneyA.shipping.quality.serialSalesOrderId
    const allocation = S.balancePayment.allocations[0]
    const reversed = await as('POST', `/payments/${S.balancePayment.id}/allocations/${allocation.id}/reverse`, { note: 'Allocated to the wrong document' })
    expect(reversed.payment.placedOn).toEqual([])
    expect((await as('GET', `/invoicing/invoices/${S.td24.id}/related`)).related.payments).toEqual([
      expect.objectContaining({ allocationId: allocation.id, reversed: true, reversalOfId: null }),
      expect.objectContaining({ amount: -72480, reversalOfId: allocation.id, note: 'Allocated to the wrong document' }),
    ])
    expect((await as('GET', `/payments/open-items?companyId=${A.companyA}&partyId=${A.brand}`)).items.find((item: Json) => item.id === S.td24.id)).toMatchObject({ openAmount: 72480 })
    expect(await events('order.unsettled', order)).toEqual([{ payload: { orderId: order, partyId: A.brand, missing: ['BALANCE_DUE'] } }])
    expect(await events('order.fully_settled', order)).toHaveLength(1)
  })
})

describe('credit notes (TD04; DPR 633/1972 art. 26; FIN-069)', () => {
  const order = () => moneyA.shipping.quality.serialSalesOrderId

  it('a TD04 within what is creditable on the open TD24 (no refund due); paid, then delivered by SDI: the SDI outcome settles the order', async () => {
    const made = await as('POST', `/invoicing/invoices/${S.td24.id}/credit-note`, { reason: 'PRICE_REDUCTION', reasonText: 'abbuono concordato', amount: 5000, amountBasis: 'NET' }, 201)
    expect(made).toMatchObject({ creditableAmount: 72480, refundDueAmount: 0, invoice: { docType: 'TD04', status: 'DRAFT', creditOfId: S.td24.id, netTotal: 5000, vatTotal: 1100, grossTotal: 6100 } })
    expect(made.invoice.causale).toBe(`Nota di credito: Riduzione di prezzo (abbuono) - abbuono concordato - rif. fattura n. ${S.td24.number} del ${S.td24.issueDate.split('-').reverse().join('/')} (art. 26 DPR 633/1972)`)
    const issued = await issue(made.invoice.id)
    expect(issued.invoice).toMatchObject({ status: 'ISSUED', number: expect.stringMatching(/^FT-/) })
    const xml = await downloaded(issued.invoice.xmlFileId)
    expect(await xsdErrors(xml)).toEqual([])
    expect(xml).toContain('<TipoDocumento>TD04</TipoDocumento>')
    expect(xml).toContain(`<IdDocumento>${S.td24.number}</IdDocumento>`)
    expect((await as('GET', `/invoicing/invoices/${S.td24.id}`)).invoice).toMatchObject({ creditedAmount: 6100, paidAmount: 0, openAmount: 66380, refundDueAmount: 0 })
    expect(await events('invoice.refund_due', made.invoice.id)).toEqual([])
    // The rest of the transfer pays what the TD24 still asks: the credit note is not delivered yet, nothing settles.
    await as('POST', `/payments/${S.balancePayment.id}/allocations`, { allocations: [{ invoiceId: S.td24.id, amount: 66380 }] })
    expect((await as('GET', `/invoicing/orders/${order()}/settlement`)).settlement.gaps).toEqual(['AT_SDI'])
    expect(await events('order.fully_settled', order())).toHaveLength(1)
    await deliver(made.invoice.id)
    expect(await events('order.fully_settled', order())).toHaveLength(2)
    expect((await as('GET', `/invoicing/orders/${order()}/settlement`)).settlement).toMatchObject({ settled: true, creditedAmount: 6100, paidAmount: 66380, balanceDueAmount: 0 })
    S.firstCredit = issued.invoice
  })

  it('above what is creditable is refused: when it is made, and at issue when two drafts together pass it', async () => {
    const over = await refused('POST', `/invoicing/invoices/${S.td24.id}/credit-note`, { reason: 'BILLING_ERROR', amount: 60000, amountBasis: 'NET' }, 409)
    expect(over.message).toContain('passes the 663.80 EUR still creditable')
    const a = (await as('POST', `/invoicing/invoices/${S.td24.id}/credit-note`, { reason: 'RETURN', lines: [{ lineId: S.td24.lines[0].id, quantity: '1' }] }, 201)).invoice
    const b = (await as('POST', `/invoicing/invoices/${S.td24.id}/credit-note`, { reason: 'RETURN', lines: [{ lineId: S.td24.lines[0].id, quantity: '1' }] }, 201)).invoice
    expect([a.grossTotal, b.grossTotal]).toEqual([51240, 51240])
    // A credit note on what is paid: a refund is due (W2b), and the order is unsettled again.
    await issue(a.id)
    expect((await as('GET', `/invoicing/invoices/${S.td24.id}`)).invoice).toMatchObject({ creditedAmount: 57340, openAmount: 0, refundDueAmount: 51240 })
    expect(await events('invoice.refund_due', a.id)).toEqual([{ payload: { invoiceId: a.id, creditOfId: S.td24.id, partyId: A.brand } }])
    expect((await events('order.unsettled', moneyA.shipping.quality.serialSalesOrderId)).at(-1)).toEqual({ payload: { orderId: moneyA.shipping.quality.serialSalesOrderId, partyId: A.brand, missing: ['AT_SDI', 'REFUND_DUE'] } })
    expect(await events('order.unsettled', moneyA.shipping.quality.serialSalesOrderId)).toHaveLength(2)
    const before = await invoiceSeriesNext()
    const second = (await issue(b.id, 409)).error
    expect(second.message).toContain('still creditable (DPR 633/1972 art. 26)')
    expect(await invoiceSeriesNext()).toBe(before)
    await as('DELETE', `/invoicing/invoices/${b.id}`, {})
  })

  it('a draft, a credit note and an unknown line are not credited', async () => {
    expect((await refused('POST', `/invoicing/invoices/${S.firstCredit.id}/credit-note`, { reason: 'OTHER', full: true }, 409)).message).toContain('A credit note is not credited')
    expect((await refused('POST', `/invoicing/invoices/${S.td24.id}/credit-note`, { reason: 'OTHER', lines: [{ lineId: newId() }] }, 400)).issues).toEqual([{ path: 'body/lines/0/lineId', message: 'Not a line of this invoice.' }])
    expect((await refused('POST', `/invoicing/invoices/${S.td24.id}/credit-note`, { reason: 'OTHER', full: true, amount: 100 }, 400)).issues[0].path).toBe('body')
  })
})

describe('TD01: one DDT within its 12 days, its deposit deducted within the TD02 net less its credit note', () => {
  it('SO-0002 deposit TD02, then its last released BLK 52 ships alone with a DDT', async () => {
    await stepUp(h, finance, secret)
    S.td02b = (await as('POST', '/payments/deposit-received', { depositRequestId: ids.depositSo2, amount: 20000, receivedOn: TODAY(), externalRef: 'TRN-W151-0003' }, 201)).depositInvoice.invoice
    expect(S.td02b).toMatchObject({ netTotal: 16393, grossTotal: 20000 })
    const production = moneyA.shipping.quality.production
    const sb = (await wall('warehouse', 'POST', '/shipping/shipments', { salesOrderId: production.salesOrderId, lines: [{ workOrderSizeId: production.cellIds['BLK-52'], quantity: 1 }] }, 201)).body.shipment
    const parcel = (await wall('warehouse', 'POST', `/shipping/packing/${sb.id}/parcels`, { grossWeightKg: '2.5' }, 201)).body.parcelId
    await wall('warehouse', 'PUT', `/shipping/packing/${sb.id}/lines/${sb.lines[0].id}/parcel`, { parcelId: parcel }, 200)
    expect((await wall('warehouse', 'POST', `/shipping/packing/${sb.id}/pack`, {}, 200)).body.shipment.status).toBe('PACKED')
    S.ddtB = (await wall('warehouse', 'POST', `/shipping/shipments/${sb.id}/ddt`, { ship: true, carrier: { name: 'Seed Express' } }, 201)).body.ddt
  })

  it('the rule picks TD01 and deducts the whole TD02; a credit note on the TD02 meanwhile makes the issue refuse the deduction', async () => {
    const draft = await as('POST', '/invoicing/invoices/from-ddts', { ddtIds: [S.ddtB.id] }, 201)
    expect(draft.choice).toMatchObject({ docType: 'TD01', suggested: 'TD01', deadline: { docType: 'TD01', daysLeft: 12 } })
    expect(draft.invoice).toMatchObject({ docType: 'TD01', causale: null, netTotal: 23607, grossTotal: 28801 })
    expect(draft.invoice.lines.map((line: Json) => [line.kind, line.netAmount])).toEqual([
      ['GOODS', 40000],
      ['DEPOSIT_DEDUCTION', -16393],
    ])
    // The deposit is given back in part: a TD04 on the TD02 (its net less what issued invoices deduct allows it).
    const credit = await as('POST', `/invoicing/invoices/${S.td02b.id}/credit-note`, { reason: 'DEPOSIT_REFUND', amount: 6100 }, 201)
    expect(credit.invoice).toMatchObject({ priceBasis: 'GROSS', netTotal: 5000, grossTotal: 6100 })
    expect(credit.refundDueAmount).toBe(6100)
    await issue(credit.invoice.id)
    const before = await invoiceSeriesNext()
    const refusal = (await issue(draft.invoice.id, 409)).error
    expect(refusal.issues).toEqual([expect.objectContaining({ path: 'lines/1', message: expect.stringContaining(`Deposit invoice ${S.td02b.number} has a net of 163.93 EUR; 50.00 EUR of it is credited`) })])
    expect(await invoiceSeriesNext()).toBe(before)
    // The deduction is removed only by its own route (the totals follow), then the draft is deleted and made again.
    const removed = await as('DELETE', `/invoicing/invoices/${draft.invoice.id}/deductions/${draft.invoice.lines[1].id}`, {})
    expect(removed.invoice).toMatchObject({ netTotal: 40000, grossTotal: 48800, lines: [{ kind: 'GOODS' }] })
    expect((await refused('DELETE', `/invoicing/invoices/${draft.invoice.id}/deductions/${draft.invoice.lines[0].id}`, {}, 404)).message).toBe('Deposit deduction not found on this invoice.')
    S.td01Draft = removed.invoice
  })

  it('made again from its DDT, it deducts what is left and issues as an XSD-valid TD01', async () => {
    await as('DELETE', `/invoicing/invoices/${S.td01Draft.id}`, {})
    const again = await as('POST', '/invoicing/invoices/from-ddts', { ddtIds: [S.ddtB.id] }, 201)
    expect(again.invoice.lines.map((line: Json) => [line.kind, line.netAmount, line.grossAmount])).toEqual([
      ['GOODS', 40000, null],
      ['DEPOSIT_DEDUCTION', -11393, -13899],
    ])
    const issued = await issue(again.invoice.id)
    expect(issued.invoice).toMatchObject({ docType: 'TD01', status: 'ISSUED', netTotal: 28607, vatTotal: 6294, grossTotal: 34901 })
    const xml = await downloaded(issued.invoice.xmlFileId)
    expect(await xsdErrors(xml)).toEqual([])
    expect(xml).toContain('<TipoDocumento>TD01</TipoDocumento>')
    expect(xml).toContain(`<NumeroDDT>${S.ddtB.number}</NumeroDDT>`)
    // SO-0002 is far from settled: most of it has not shipped.
    expect((await as('GET', `/invoicing/orders/${moneyA.shipping.quality.production.salesOrderId}/settlement`)).settlement.gaps).toContain('NOT_SHIPPED')
  })

  it('an issued invoice keeps its deduction', async () => {
    const td24 = await as('GET', `/invoicing/invoices/${S.td24.id}`)
    const lineId = td24.invoice.lines[1].id
    expect((await refused('DELETE', `/invoicing/invoices/${S.td24.id}/deductions/${lineId}`, {}, 409)).message).toContain('never changes')
  })
})

describe('the walls: office only, the price grain, tenants and companies', () => {
  const order = () => moneyA.shipping.quality.serialSalesOrderId

  it('floor and portal sessions are refused every route', async () => {
    for (const session of ['floor', 'partner']) {
      expect((await wall(session, 'GET', '/invoicing/shipped-not-invoiced')).status).toBe(403)
      expect((await wall(session, 'POST', '/invoicing/invoices/from-ddts', { ddtIds: [S.ddt.id] })).status).toBe(403)
      expect((await wall(session, 'GET', `/invoicing/orders/${order()}/settlement`)).status).toBe(403)
      expect((await wall(session, 'POST', `/invoicing/invoices/${S.td24.id}/credit-note`, { reason: 'OTHER', full: true })).status).toBe(403)
      expect((await wall(session, 'GET', `/invoicing/invoices/${S.td24.id}/related`)).status).toBe(403)
      expect((await wall(session, 'GET', '/invoicing/settings')).status).toBe(403)
      expect((await wall(session, 'GET', `/payments/open-items?companyId=${A.companyA}&partyId=${A.brand}`)).status).toBe(403)
    }
  })

  it('without the price grain: the lists and the settlement keep no amount', async () => {
    const { body } = await wall('noPrice', 'GET', `/invoicing/orders/${order()}/settlement`, undefined, 200)
    expect(body.settlement.gaps).toEqual(['AT_SDI', 'REFUND_DUE'])
    expect(body.settlement).not.toHaveProperty('missing')
    expect(body.settlement).not.toHaveProperty('balanceDueAmount')
    expect(body.settlement.invoices[0]).not.toHaveProperty('openAmount')
    // B-OM-023: the payment state in a word-code, the same as a price holder reads, with no amount beside it.
    const priced = (await as('GET', `/invoicing/orders/${order()}/settlement`)).settlement
    expect((body.settlement.invoices as Json[]).map((row) => row.paymentState)).toEqual((priced.invoices as Json[]).map((row) => row.paymentState))
    expect(['OPEN', 'PART_PAID', 'PAID', 'CREDITED', 'REFUND_DUE']).toContain(body.settlement.invoices[0].paymentState)
    const row = (await wall('noPrice', 'GET', '/invoicing/invoices', undefined, 200)).body.invoices.find((entry: Json) => entry.id === S.td24.id)
    for (const field of ['grossTotal', 'paidAmount', 'creditedAmount', 'openAmount']) expect(row).not.toHaveProperty(field)
    expect(row).toHaveProperty('dueDate')
    const related = (await wall('noPrice', 'GET', `/invoicing/invoices/${S.td24.id}/related`, undefined, 200)).body.related
    expect(related.ddts).toHaveLength(1)
    expect(related.depositRequests[0]).not.toHaveProperty('amount')
    for (const payment of related.payments) expect(payment).not.toHaveProperty('amount')
    expect((await wall('noPrice', 'GET', '/invoicing/settings', undefined, 200)).body.settings.companies.length).toBeGreaterThan(0)
    const queue = (await wall('noPrice', 'GET', '/invoicing/shipped-not-invoiced', undefined, 200)).body
    for (const customer of queue.customers) {
      expect(customer).not.toHaveProperty('valueAmount')
      for (const ddt of customer.ddts) for (const line of ddt.lines) expect(line).not.toHaveProperty('unitPrice')
    }
  })

  it('another company and another tenant see nothing of it', async () => {
    expect((await wall('companyB', 'GET', `/invoicing/invoices/${S.td24.id}/related`)).status).toBe(404)
    expect((await wall('companyB', 'GET', `/payments/open-items?companyId=${A.companyA}&partyId=${A.brand}`)).status).toBe(404)
    expect((await wall('otherTenant', 'GET', `/invoicing/invoices/${S.td24.id}/related`)).status).toBe(404)
    expect((await wall('companyB', 'GET', '/invoicing/settings', undefined, 200)).body.settings.companies.map((entry: Json) => entry.id)).toEqual([A.companyB])
    expect((await wall('companyB', 'GET', `/invoicing/orders/${order()}/settlement`)).status).toBe(404)
    expect((await wall('companyB', 'POST', '/invoicing/invoices/from-ddts', { ddtIds: [S.ddtB.id] })).status).toBe(404)
    expect((await wall('companyB', 'GET', '/invoicing/shipped-not-invoiced', undefined, 200)).body.customers).toEqual([])
    expect((await wall('otherTenant', 'GET', `/invoicing/orders/${order()}/settlement`)).status).toBe(404)
    expect((await wall('otherTenant', 'POST', `/invoicing/invoices/${S.td24.id}/credit-note`, { reason: 'OTHER', amount: 100 })).status).toBe(404)
    expect((await wall('otherTenant', 'POST', '/invoicing/invoices/from-ddts', { ddtIds: [S.ddt.id] })).status).toBe(404)
  })
})

// ---- B-OP-022 (order page plan N3; 13-backend §3; review N-4): Money = this order's share -----------------------------------------
/**
 * A monthly customer's two orders on ONE issued TD24 (made up, written with the database's rules off: the read is what is tested),
 * partly paid, with its freight: each order's settlement says its own share by the rule the orders list reads (its row's paid and
 * balance), the invoice's whole beside it, the freight apart (in no order), and the other order it bills — of the same customer,
 * named only to a reader of orders, else counted.
 *
 *   O1  2 jackets, net 200.00 + VAT 44.00 = 244.00          the TD24: O1's line (200.00), O2's line (600.00), freight 10.00 net
 *   O2  6 jackets, net 600.00 + VAT 132.00 = 732.00                    (12.20 with VAT): net 810.00, VAT 178.20, gross 988.20
 *   payment 300.00 placed on the TD24: O1's share 75.00 (200 of 800), O2's 225.00
 */
describe('B-OP-022: Money = this order’s share — two orders on one TD24, partly paid, freight apart', () => {
  const fx = { o1: newId(), o2: newId(), l1: newId(), l2: newId(), invoice: newId(), payment: newId() }
  const settlementOf = async (session: string, orderId: string): Promise<Json> => (await wall(session, 'GET', `/invoicing/orders/${orderId}/settlement`, undefined, 200)).body.settlement

  beforeAll(async () => {
    SESSIONS['shareReader'] = () => office(A.tenant, [grant(['orders.view', 'invoices.view', 'money.price'])])
    SESSIONS['shareNoOrders'] = () => office(A.tenant, [grant(['invoices.view', 'money.price'])])
    SESSIONS['shareOtherParty'] = () => office(A.tenant, [{ permissions: ['orders.view', 'invoices.view', 'money.price'], companies: 'all', sites: 'all', parties: [seedUuid(ns.a, 'party:P3')] }])
    const [style] = await admin<{ styleId: string; colourwayId: string }>(`SELECT "styleId", "colourwayId" FROM "SalesOrderLine" WHERE id = $1`, [moneyA.shipping.quality.serialSalesOrderLineId])
    const q = (value: string) => `'${value}'`
    const order = (id: string, number: string, net: number, vat: number) =>
      `INSERT INTO "SalesOrder" (id, "tenantId", "companyId", "partyId", number, status, "orderDate", "taxMode", "billTo", "shipTo", "netAmount", "vatAmount", "grossAmount")
       VALUES (${q(id)}, ${q(A.tenant)}, ${q(A.companyA)}, ${q(A.brand)}, '${number}', 'SHIPPED', '2026-11-02', 'IT_B2B', '{}'::jsonb, '{}'::jsonb, ${net}, ${vat}, ${net + vat});`
    const line = (id: string, orderId: string, quantity: number, net: number, vat: number) =>
      `INSERT INTO "SalesOrderLine" (id, "tenantId", "companyId", "orderId", "partyId", seq, kind, "styleId", "colourwayId", quantity, "unitPrice", "netAmount", "vatRatePct", "vatAmount")
       VALUES (${q(id)}, ${q(A.tenant)}, ${q(A.companyA)}, ${q(orderId)}, ${q(A.brand)}, 10, 'SIZE_GRID', ${q(style!.styleId)}, ${q(style!.colourwayId)}, ${quantity}, 100, ${net}, 22, ${vat});`
    const invoiceLine = (seq: number, kind: string, net: number, quantity: number, orderLineId: string | null, chargeKind: string | null) =>
      `INSERT INTO "InvoiceLine" (id, "tenantId", "invoiceId", "buyerPartyId", "partyId", seq, kind, description, quantity, "unitPrice", "netAmount", "vatRatePct", "salesOrderLineId", "chargeKind")
       VALUES (${q(newId())}, ${q(A.tenant)}, ${q(fx.invoice)}, ${q(A.brand)}, ${q(A.brand)}, ${seq}, '${kind}', 'T-OP022 line ${seq} (made up)', ${quantity}, ${net / quantity / 100}, ${net}, 22, ${orderLineId ? q(orderLineId) : 'NULL'}, ${chargeKind ? `'${chargeKind}'` : 'NULL'});`
    await admin(
      `BEGIN;
       SET LOCAL session_replication_role = replica;
       ${order(fx.o1, 'T-OP022-SO-1', 20000, 4400)}
       ${order(fx.o2, 'T-OP022-SO-2', 60000, 13200)}
       ${line(fx.l1, fx.o1, 2, 20000, 4400)}
       ${line(fx.l2, fx.o2, 6, 60000, 13200)}
       INSERT INTO "Invoice" (id, "tenantId", "companyId", "buyerPartyId", "partyId", "docType", status, number, year, "issueDate", "issuedAt", "billTo", "netTotal", "vatTotal", "grossTotal", "vatSummary")
       VALUES (${q(fx.invoice)}, ${q(A.tenant)}, ${q(A.companyA)}, ${q(A.brand)}, ${q(A.brand)}, 'TD24', 'ISSUED', 'T-OP022-1', 2026, '2026-11-05', '2026-11-05T09:00:00Z', '{}'::jsonb, 81000, 17820, 98820, '[{"rate":"22.00","nature":null,"legalRef":null,"taxable":81000,"vat":17820,"rounding":0}]'::jsonb);
       ${invoiceLine(1, 'GOODS', 20000, 2, fx.l1, null)}
       ${invoiceLine(2, 'GOODS', 60000, 6, fx.l2, null)}
       ${invoiceLine(3, 'CHARGE', 1000, 1, null, 'FREIGHT')}
       INSERT INTO "Payment" (id, "tenantId", "companyId", "partyId", amount, "receivedOn", "externalRef") VALUES (${q(fx.payment)}, ${q(A.tenant)}, ${q(A.companyA)}, ${q(A.brand)}, 30000, '2026-11-10', 'T-OP022-TRN-1');
       INSERT INTO "PaymentAllocation" (id, "tenantId", "companyId", "partyId", "paymentId", "invoiceId", amount) VALUES (${q(newId())}, ${q(A.tenant)}, ${q(A.companyA)}, ${q(A.brand)}, ${q(fx.payment)}, ${q(fx.invoice)}, 30000);
       COMMIT;`,
    )
  })

  it('each order reads its own share — the same paid and still to pay as its row in Sales › Orders', async () => {
    const list = (await wall('shareReader', 'GET', `/sales/orders?ids=${fx.o1},${fx.o2}`, undefined, 200)).body.orders as Json[]
    for (const orderId of [fx.o1, fx.o2]) {
      const row = list.find((entry) => entry.id === orderId)!
      const { thisOrder } = await settlementOf('shareReader', orderId)
      expect([thisOrder.paid, thisOrder.stillToPay], orderId).toEqual([row.paid, row.balance])
    }
    expect((await settlementOf('shareReader', fx.o1)).thisOrder).toEqual({ paid: 7500, stillToPay: 16900, invoicedShare: 24400, depositsPaid: 0, writtenOff: 0 })
    expect((await settlementOf('shareReader', fx.o2)).thisOrder).toEqual({ paid: 22500, stillToPay: 50700, invoicedShare: 73200, depositsPaid: 0, writtenOff: 0 })
  })

  it('the shared invoice: its whole, this order’s share and what of it is open, the freight apart, the other order it bills', async () => {
    const one = ((await settlementOf('shareReader', fx.o1)).invoices as Json[]).find((invoice) => invoice.id === fx.invoice)!
    expect(one).toMatchObject({ docType: 'TD24', grossTotal: 98820, paidAmount: 30000, share: 24400, openShare: 16900, freight: 1220, otherOrders: [{ id: fx.o2, number: 'T-OP022-SO-2' }], otherOrdersHidden: 0 })
    const two = ((await settlementOf('shareReader', fx.o2)).invoices as Json[]).find((invoice) => invoice.id === fx.invoice)!
    expect(two).toMatchObject({ share: 73200, openShare: 50700, freight: 1220, otherOrders: [{ id: fx.o1, number: 'T-OP022-SO-1' }], otherOrdersHidden: 0 })
    // The shares and the freight make the whole: the freight is in no order.
    expect(one.share + two.share + one.freight).toBe(one.grossTotal)
  })

  it('the other orders are named only to a reader of orders (counted otherwise); without the price grain no amount; another customer’s person: 404', async () => {
    const blind = ((await settlementOf('shareNoOrders', fx.o1)).invoices as Json[]).find((invoice) => invoice.id === fx.invoice)!
    expect(blind).toMatchObject({ otherOrders: [], otherOrdersHidden: 1, share: 24400 })
    expect(JSON.stringify(blind)).not.toContain(fx.o2)
    const plain = await settlementOf('noPrice', fx.o1)
    expect(plain.thisOrder).toEqual({})
    const row = (plain.invoices as Json[]).find((invoice) => invoice.id === fx.invoice)!
    for (const field of ['share', 'openShare', 'freight', 'grossTotal']) expect(row).not.toHaveProperty(field)
    expect(row).toMatchObject({ otherOrders: [], otherOrdersHidden: 1 })
    const other = await wall('shareOtherParty', 'GET', `/invoicing/orders/${fx.o1}/settlement`)
    expect(other.status).toBe(404)
    expect(JSON.stringify(other.body)).not.toContain('T-OP022')
  })
})
// ---- end B-OP-022

// ---- B-OP-033 (order page N5): goods recorded as made elsewhere are invoiced citing their paper DDT -----------------------------
describe('B-OP-033: a shipment made elsewhere is invoiced citing its paper DDT — TD01 per shipment, TD24 for a monthly customer', () => {
  const fx = { shipment: newId(), line: newId(), paper: 'CART-77/2026' }
  const fromShipment = () => as('POST', '/invoicing/invoices/from-shipment', { shipmentId: fx.shipment }, 201)
  const timing = (value: 'PER_SHIPMENT' | 'MONTHLY') => admin(`UPDATE "Party" SET "invoiceTiming" = $2 WHERE id = $1`, [A.brand, value])

  beforeAll(async () => {
    // The shipment as B-OP-032 records it (made past the guards here: this file tests the invoicing): SHIPPED today with its
    // paper DDT, one BLK 52 of SEED-SO-0002, no Nexus DDT.
    const production = moneyA.shipping.quality.production
    const [cell] = await admin<{ workOrderId: string; salesOrderLineId: string; size: string }>(`SELECT "workOrderId", "salesOrderLineId", size FROM "WorkOrderSize" WHERE id = $1`, [production.cellIds['BLK-52']])
    const left = `${TODAY()}T08:00:00.000Z`
    await admin(
      `BEGIN;
       SET LOCAL session_replication_role = replica;
       INSERT INTO "Shipment" (id, "tenantId", "companyId", "siteId", "partyId", "salesOrderId", number, "shipTo", "transportBy", status, "packedAt", "shippedAt", origin, "externalDdtNumber", "externalDdtDate", "ddtRequired", "createdAt", "updatedAt")
         VALUES ('${fx.shipment}', '${A.tenant}', '${A.companyA}', '${A.siteA1}', '${A.brand}', '${production.salesOrderId}', 'SH-ELSEWHERE-1', '{}'::jsonb, 'SENDER', 'SHIPPED', '${left}', '${left}', 'ELSEWHERE', '${fx.paper}', '${TODAY()}', true, now(), now());
       INSERT INTO "ShipmentLine" (id, "tenantId", "siteId", "partyId", "shipmentId", "workOrderId", "workOrderSizeId", "salesOrderLineId", size, quantity)
         VALUES ('${fx.line}', '${A.tenant}', '${A.siteA1}', '${A.brand}', '${fx.shipment}', '${cell!.workOrderId}', '${production.cellIds['BLK-52']}', '${cell!.salesOrderLineId}', '${cell!.size}', 1);
       COMMIT;`,
    )
  })

  afterAll(async () => {
    await timing('PER_SHIPMENT')
  })

  it('the shipped-not-invoiced list names it with its paper DDT and the deadline by the customer’s terms (TD01: 12 days)', async () => {
    const list = await as('GET', '/invoicing/shipped-not-invoiced')
    const row = (list.customers as Json[]).flatMap((customer) => (customer.shipments ?? []) as Json[]).find((entry) => entry.shipmentId === fx.shipment)
    expect(row).toMatchObject({ number: 'SH-ELSEWHERE-1', paperDdt: { number: fx.paper, date: TODAY() }, deadline: { docType: 'TD01', daysLeft: 12 } })
  })

  it('a customer invoiced per shipment: a TD01 draft citing the paper DDT, its Causale naming it', async () => {
    await timing('PER_SHIPMENT')
    const draft = await fromShipment()
    expect(draft.invoice.docType).toBe('TD01')
    expect(draft.invoice.documentRefs).toContainEqual({ kind: 'DDT', number: fx.paper, date: TODAY() })
    expect(draft.invoice.causale).toBe(`Fattura immediata: merce spedita con DDT n. ${fx.paper} del ${TODAY().split('-').reverse().join('/')} (spedizione SH-ELSEWHERE-1)`)
    expect(draft.invoice.lines.filter((line: Json) => line.kind === 'GOODS').map((line: Json) => line.ddtId ?? null)).toEqual([null])
    await as('DELETE', `/invoicing/invoices/${draft.invoice.id}`, {})
  })

  it('a monthly customer: a TD24 citing the paper DDT; issued, its XML names it in DatiDDT and is XSD-valid', async () => {
    await timing('MONTHLY')
    const draft = await fromShipment()
    expect(draft.invoice).toMatchObject({ docType: 'TD24', causale: 'Fattura differita (art. 21 c.4 lett. a DPR 633/1972)' })
    const issued = await issue(draft.invoice.id)
    expect(issued.invoice).toMatchObject({ docType: 'TD24', status: 'ISSUED' })
    const xml = await downloaded(issued.invoice.xmlFileId)
    expect(await xsdErrors(xml)).toEqual([])
    expect(xml).toContain('<TipoDocumento>TD24</TipoDocumento>')
    expect(xml).toContain(`<NumeroDDT>${fx.paper}</NumeroDDT>`)
    expect(xml).toContain(`<DataDDT>${TODAY()}</DataDDT>`)
    // Invoiced once: the list no longer names it, and a second draft is refused in words.
    const list = await as('GET', '/invoicing/shipped-not-invoiced')
    expect((list.customers as Json[]).flatMap((customer) => (customer.shipments ?? []) as Json[]).some((entry) => entry.shipmentId === fx.shipment)).toBe(false)
    expect((await refused('POST', '/invoicing/invoices/from-shipment', { shipmentId: fx.shipment }, 409)).message).toContain('is invoiced already')
  })
})
// ---- end B-OP-033

// ---- B-OP-046 (P16; order page plan N3): the SEEDED monthly invoice of two orders, read by each order -------------------------------
/**
 * The order page seed's TD24 (seed/order-page.ts, written through the database's rules), in a tenant of its own so this file's
 * series and orders stay as they are: SEED-SO-0101 (1 jacket, 488.00) and SEED-SO-0102 (2 jackets, 976.00) on one ISSUED TD24
 * of 1,464.00, 600.00 paid. Each order's settlement says its own share, the invoice's whole and the other order it bills — the
 * same paid and still to pay as its row in Sales › Orders.
 */
describe('B-OP-046 (P16): the seeded monthly invoice — each of its two orders reads its own share, the whole and the other order', () => {
  const NS_C = 'invs-c'
  const C = { tenant: seedUuid(NS_C, 'tenant') }
  let monthly: Awaited<ReturnType<typeof seedOrderPage>>['monthly']
  const settlementOf = async (orderId: string): Promise<Json> => (await wall('monthlyReader', 'GET', `/invoicing/orders/${orderId}/settlement`, undefined, 200)).body.settlement

  beforeAll(async () => {
    await seedCore({ db: h.database, namespace: NS_C })
    monthly = (await seedOrderPage({ db: h.database, namespace: NS_C })).monthly
    SESSIONS['monthlyReader'] = () => office(C.tenant, [grant(['orders.view', 'invoices.view', 'money.price'])])
  }, 240_000)

  it('each order: its own share of the TD24, what of it is open, and the other order it bills', async () => {
    const [o1, o2] = monthly.salesOrderIds
    const one = await settlementOf(o1)
    expect(one.number).toBe('SEED-SO-0101')
    expect(one.invoices).toEqual([
      expect.objectContaining({ id: monthly.invoiceId, docType: 'TD24', number: 'FT-2026-00004', status: 'ISSUED', grossTotal: 146400, paidAmount: 60000, share: 48800, openShare: 28800, freight: 0, otherOrders: [{ id: o2, number: 'SEED-SO-0102' }], otherOrdersHidden: 0 }),
    ])
    expect(one.thisOrder).toEqual({ paid: 20000, stillToPay: 28800, invoicedShare: 48800, depositsPaid: 0, writtenOff: 0 })
    const two = await settlementOf(o2)
    expect(two.invoices).toEqual([
      expect.objectContaining({ id: monthly.invoiceId, grossTotal: 146400, paidAmount: 60000, share: 97600, openShare: 57600, freight: 0, otherOrders: [{ id: o1, number: 'SEED-SO-0101' }], otherOrdersHidden: 0 }),
    ])
    expect(two.thisOrder).toEqual({ paid: 40000, stillToPay: 57600, invoicedShare: 97600, depositsPaid: 0, writtenOff: 0 })
    // The two shares make the whole (no freight on it); both orders shipped and invoiced, not settled (partly paid, not delivered to SDI).
    expect(one.invoices[0].share + two.invoices[0].share).toBe(146400)
    for (const settlement of [one, two]) expect(settlement).toMatchObject({ settled: false, fullyShipped: true, fullyInvoiced: true })
  })

  it('the same paid and still to pay as each order’s row in Sales › Orders', async () => {
    const list = (await wall('monthlyReader', 'GET', `/sales/orders?ids=${monthly.salesOrderIds.join(',')}`, undefined, 200)).body.orders as Json[]
    for (const orderId of monthly.salesOrderIds) {
      const row = list.find((entry) => entry.id === orderId)!
      const { thisOrder } = await settlementOf(orderId)
      expect([thisOrder.paid, thisOrder.stillToPay], orderId).toEqual([row.paid, row.balance])
    }
  })
})
// ---- end B-OP-046 (P16)
