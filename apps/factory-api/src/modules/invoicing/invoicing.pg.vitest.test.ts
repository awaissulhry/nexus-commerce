import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validateXML } from 'xmllint-wasm'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { LEGAL_WORDING } from '@nexus/factory-domain/tax/vat-treatment'
import { buildApp } from '../../core/app'
import { callerFor } from '../../core/command'
import { systemContext } from '../../platform/outbox/system'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { addTenant, addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../platform/auth/sessions/testing/harness'
import { lockMoney } from '../payments/locks'
import { invoiceFilesHandler } from './invoice-files'

/**
 * Invoicing and payments (B-W1-28: a deposit payment, its TD02 when the rule requires it, the invoice core) on the local
 * stack: a throwaway PostgreSQL 17 database from the migrations (the runtime login, so row-level security, the column
 * grants and the …_money_guards triggers are real), the real app with the real office sign-in (finance signs in, sets up
 * two-factor and steps up to issue), the local file store for the XML and PDF, and a second app on the same database
 * with test sessions for the walls (grants without the price grain, floor, portal, another tenant, another company).
 * Every company, customer, VAT number (office code 000, as the FatturaPA samples) and amount is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs invoicing`.
 */

let h: Harness
let tenant: TestTenant
let tenantB: TestTenant
let walls: FastifyInstance
let finance: Browser
let financeSecret: string

const YEAR = businessDate(new Date()).slice(0, 4)
const FAKE_VAT = { company: '12345670009', customer: '76543210009', blocked: '90010000009' } as const
const ids = {
  itCustomer: newId(),
  euCustomer: newId(),
  blockedCustomer: newId(),
  order: newId(),
  request: newId(),
  smallRequest: newId(),
  partRequest: newId(),
  raceRequest: newId(),
}
const c1 = () => tenant.companies[0]!.id
const c2 = () => tenant.companies[1]!.id

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]

/** A request of the signed-in finance browser (GET, POST, PUT, PATCH, DELETE: the browser sends the CSRF header). */
async function as(browser: Browser, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await browser.send(method as 'POST', url, method === 'GET' ? undefined : (body ?? {}))
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants })
const READ: Permission[] = ['invoices.view', 'payments.view']
const SESSIONS: Record<string, () => SessionContext> = {
  noPrice: () => office(tenant.id, [grant(READ)]),
  withPrice: () => office(tenant.id, [grant([...READ, 'money.price'])]),
  recorderNoPrice: () => office(tenant.id, [grant([...READ, 'payments.record'])]),
  companyTwo: () => office(tenant.id, [grant([...READ, 'invoices.manage', 'payments.record', 'money.price'], [c2()])]),
  otherTenant: () => office(tenantB.id, [grant([...READ, 'invoices.manage', 'payments.record', 'money.price'])]),
  floor: () => ({ audience: 'floor', tenantId: tenant.id, actorId: newId(), siteId: newId(), deviceId: newId(), grants: [grant([...READ, 'payments.record'])] }),
  partner: () => ({ audience: 'partner', tenantId: tenant.id, actorId: newId(), partyId: ids.itCustomer, grants: [grant([...READ, 'money.price'])] }),
}
async function wall(session: string, method: 'GET' | 'POST', url: string, payload?: unknown) {
  const response = await walls.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
  return { status: response.statusCode, body: response.json() as Json }
}

const seriesNext = async (): Promise<number> => (await admin<{ nextValue: number }>(`SELECT "nextValue" FROM "NumberSeries" WHERE "companyId" = $1 AND kind = 'INVOICE' AND "scopeKey" = $2`, [c1(), YEAR]))[0]!.nextValue
const numberOf = (value: number) => `FT-${YEAR}-${String(value).padStart(5, '0')}`

/** The XML of an issued invoice, the way a browser downloads it (files route, then the local store). */
async function downloaded(fileId: string): Promise<Buffer> {
  const presigned = await as(finance, 'GET', `/files/${fileId}/download`)
  const fetched = await h.app.inject({ method: 'GET', url: presigned.download.url })
  expect(fetched.statusCode).toBe(200)
  return fetched.rawPayload
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

/** Holds a deposit request's money lock in another session until `release` is called (as a concurrent writer would). */
function holdDepositLock(requestId: string) {
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  let locked!: () => void
  const holding = new Promise<void>((resolve) => (locked = resolve))
  const context = { audience: 'office' as const, tenantId: tenant.id, actorId: newId(), grants: [], requestId: newId() }
  const holder = h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: context.actorId }, (client) =>
    client.$transaction(
      async (tx) => {
        await lockMoney(tx, context, 'deposit', requestId)
        locked()
        await released
      },
      { timeout: 30_000 },
    ),
  )
  return { holding, release: async () => (release(), await holder) }
}
const waitingForAdvisoryLocks = async (count: number) => {
  for (let tries = 0; ; tries++) {
    const n = (await admin<{ n: number }>(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`))[0]!.n
    if (n >= count) return
    if (tries > 500) throw new Error(`only ${n} request(s) waited for the deposit request's lock`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function addCustomer(id: string, code: string, identity: { country: string; taxMode: string; vatNumber: string; sdi?: string }, status = 'ACTIVE') {
  await admin(`INSERT INTO "Party" (id, "tenantId", "companyId", code, kind, "legalName", roles, status, country) VALUES ($1, $2, $3, $4, 'ORGANISATION', $5, '{CUSTOMER}', $6::"PartyStatus", $7)`, [id, tenant.id, c1(), code, `Cliente Fittizio ${code} S.r.l.`, status, identity.country])
  await admin(`INSERT INTO "PartyTaxIdentity" (id, "tenantId", "partyId", country, "taxMode", "vatNumber", "sdiRecipientCode", "validFrom") VALUES ($1, $2, $3, $4, $5::"PartyTaxMode", $6, $7, '2026-01-01')`, [newId(), tenant.id, id, identity.country, identity.taxMode, identity.vatNumber, identity.sdi ?? null])
  const italian = identity.country === 'IT'
  await admin(
    `INSERT INTO "PartyAddress" (id, "tenantId", "partyId", kinds, line1, "postalCode", city, province, country, "isDefaultBillTo", "isDefaultShipTo") VALUES ($1, $2, $3, '{REGISTERED,BILL_TO,SHIP_TO}', $4, $5, $6, $7, $8, true, true)`,
    [newId(), tenant.id, id, italian ? 'Viale delle Prove 42' : 'Musterstrasse 1', italian ? '40121' : '10115', italian ? 'Bologna' : 'Berlin', italian ? 'BO' : null, identity.country],
  )
}

async function addRequest(id: string, amount: number, orderId: string | null) {
  await admin(
    `INSERT INTO "DepositRequest" (id, "tenantId", "companyId", "partyId", "orderId", kind, "depositPct", currency, amount, "dueDate", "fiscalDocument", "fiscalRule") VALUES ($1, $2, $3, $4, $5, 'ACCONTO', 30, 'EUR', $6, '2026-12-31', 'TD02', 'DEPOSIT_INVOICE_IT')`,
    [id, tenant.id, c1(), ids.itCustomer, orderId, amount],
  )
}

beforeAll(async () => {
  h = await startHarness('invoicing')
  tenant = await addTenant(h, 'inv-a', 2)
  tenantB = await addTenant(h, 'inv-b')
  for (const t of [tenant, tenantB]) {
    for (const company of t.companies) {
      await admin(
        `UPDATE "Company" SET "vatNumber" = $2, "fiscalCode" = $3, "regimeFiscale" = 'RF01', "reaOffice" = 'MI', "reaNumber" = '0000001', address = $4::jsonb WHERE id = $1`,
        [company.id, `IT${FAKE_VAT.company}`, FAKE_VAT.company, JSON.stringify({ line1: 'Via dei Conciatori Finti 1', postalCode: '20121', city: 'Milano', province: 'MI', country: 'IT' })],
      )
      await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'INVOICE', 'MAIN', $4, 'YEARLY', 'FT-{YYYY}-{N:5}', true)`, [newId(), t.id, company.id, YEAR])
    }
    await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), t.id])
  }
  await addCustomer(ids.itCustomer, 'C-IT', { country: 'IT', taxMode: 'IT_B2B', vatNumber: `IT${FAKE_VAT.customer}`, sdi: 'FAKE001' })
  await addCustomer(ids.euCustomer, 'C-DE', { country: 'DE', taxMode: 'EU_B2B', vatNumber: 'DE999999999' })
  await addCustomer(ids.blockedCustomer, 'C-BLK', { country: 'IT', taxMode: 'IT_B2B', vatNumber: `IT${FAKE_VAT.blocked}`, sdi: 'FAKE002' }, 'BLOCKED')
  await admin(`INSERT INTO "SalesOrder" (id, "tenantId", "companyId", "partyId", number, "orderDate", "taxMode", "billTo", "shipTo") VALUES ($1, $2, $3, $4, 'SO-0001', '2026-10-01', 'IT_B2B', '{}', '{}')`, [ids.order, tenant.id, c1(), ids.itCustomer])
  await addRequest(ids.request, 183000, ids.order)
  await addRequest(ids.smallRequest, 50000, ids.order)
  await addRequest(ids.partRequest, 100000, ids.order)
  await addRequest(ids.raceRequest, 100000, ids.order)

  const user = await addUser(h, tenant, { email: 'fiona.finance@inv-a.example.com', role: 'finance' })
  finance = new Browser(h.app)
  await finance.signIn('inv-a', user.email, user.password)
  financeSecret = await enrolTotp(h, finance)

  walls = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
}, 180_000)

afterAll(async () => {
  await walls?.close()
  await h?.close()
}, 60_000)

const td01 = (lines: unknown[] = [{ description: 'Giacca moto in pelle, nero, 50', itemCode: 'JKT-1-BLK-50', quantity: '2', uom: 'PZ', unitPrice: '305.00' }], buyer = ids.itCustomer) =>
  as(finance, 'POST', '/invoicing/invoices', { companyId: c1(), buyerPartyId: buyer, docType: 'TD01', causale: 'Campionario', payment: { method: 'MP05', dueDate: '2026-12-31' }, lines }, 201)

describe('deposit received → request PAID → TD02 issued (DPR 633/1972 art. 6 c.4; Q12; stage 06b-deposit)', () => {
  it('needs a fresh step-up to issue the TD02; nothing is recorded without it', async () => {
    const answer = await finance.post('/payments/deposit-received', { depositRequestId: ids.request, amount: 183000, receivedOn: businessDate(new Date()), externalRef: 'TRN-0001' })
    expect(answer.status).toBe(403)
    expect(answer.body.error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])
    expect(await admin('SELECT id FROM "Payment"')).toEqual([])
  })

  it('records the transfer, allocates it, marks the request PAID and issues the TD02 with the next number and an XSD-valid XML', async () => {
    await stepUp(h, finance, financeSecret)
    const before = await seriesNext()
    const answer = await as(finance, 'POST', '/payments/deposit-received', { depositRequestId: ids.request, amount: 183000, receivedOn: businessDate(new Date()), externalRef: 'trn 0001 ' }, 201)
    expect(answer.payment).toMatchObject({ amount: 183000, allocated: 183000, unallocated: 0, externalRef: 'TRN0001', status: 'RECEIVED' })
    expect(answer.depositRequest).toEqual({ id: ids.request, status: 'PAID' })
    const td02 = answer.depositInvoice.invoice
    expect(answer.depositInvoice).toMatchObject({ required: true, filesPending: false, filesProblem: null })
    expect(td02).toMatchObject({ docType: 'TD02', status: 'ISSUED', number: numberOf(before), priceBasis: 'GROSS', netTotal: 150000, vatTotal: 33000, grossTotal: 183000, depositRequestId: ids.request, salesOrderId: ids.order, filesPending: false })
    expect(td02.lines).toMatchObject([{ description: 'Acconto 30% su ordine n. SO-0001 del 01/10/2026', vatRatePct: '22.00', netAmount: 150000, grossAmount: 183000 }])
    expect(await seriesNext()).toBe(before + 1)
    const [allocation] = await admin('SELECT formatted, "documentDate"::text AS day FROM "NumberAllocation" WHERE "recordId" = $1', [td02.id])
    expect(allocation).toEqual({ formatted: td02.number, day: td02.issueDate })
    const [request] = await admin('SELECT status, "paidAt" FROM "DepositRequest" WHERE id = $1', [ids.request])
    expect(request!.status).toBe('PAID')
    const xml = (await downloaded(td02.xmlFileId)).toString('utf8')
    expect(await xsdErrors(xml)).toEqual([])
    expect(xml).toContain('<TipoDocumento>TD02</TipoDocumento>')
    expect(xml).toContain(`<Numero>${td02.number}</Numero>`)
    expect(xml).toContain('<ImportoTotaleDocumento>1830.00</ImportoTotaleDocumento>')
    const files = await admin('SELECT kind, "contentType", "retainUntil" IS NOT NULL AS retained FROM "StoredFile" WHERE "recordId" = $1 ORDER BY "contentType"', [td02.id])
    expect(files).toEqual([
      { kind: 'FISCAL_ARCHIVE', contentType: 'application/pdf', retained: true },
      { kind: 'FISCAL_ARCHIVE', contentType: 'application/xml', retained: true },
    ])
    const events = await admin<{ type: string }>('SELECT type FROM "OutboxEvent" WHERE subject IN ($1, $2, $3) ORDER BY type', [td02.id, answer.payment.id, ids.request])
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['invoice.draft_saved', 'invoice.files_attached', 'invoice.issued', 'payment.allocated', 'payment.deposit_paid', 'payment.recorded']))
  })

  it('the same bank reference again is refused: a transfer is counted once', async () => {
    const answer = await finance.post('/payments/deposit-received', { depositRequestId: ids.smallRequest, amount: 100, receivedOn: businessDate(new Date()), externalRef: 'TRN 0001' })
    expect(answer.status).toBe(409)
    expect(answer.body.error.message).toContain('counted once')
  })

  it('a transfer larger than the request allocates only up to it; the rest stays unallocated', async () => {
    await stepUp(h, finance, financeSecret)
    const answer = await as(finance, 'POST', '/payments/deposit-received', { depositRequestId: ids.smallRequest, amount: 80000, receivedOn: businessDate(new Date()), externalRef: 'TRN-0002' }, 201)
    expect(answer.payment).toMatchObject({ amount: 80000, allocated: 50000, unallocated: 30000 })
    expect(answer.payment.allocations).toMatchObject([{ target: 'DEPOSIT_REQUEST', targetId: ids.smallRequest, amount: 50000 }])
    expect(answer.depositRequest.status).toBe('PAID')
    expect(answer.depositInvoice.invoice).toMatchObject({ grossTotal: 50000, status: 'ISSUED' })
  })

  it('a payment recorded without its TD02 leaves the request OPEN for the rest; the TD02 is drafted and issued later', async () => {
    const answer = await as(finance, 'POST', '/payments/deposit-received', { depositRequestId: ids.partRequest, amount: 40000, receivedOn: businessDate(new Date()), externalRef: 'TRN-0003', issueDepositInvoice: false }, 201)
    expect(answer.depositRequest.status).toBe('OPEN')
    expect(answer.depositInvoice).toMatchObject({ required: true, invoice: null })
    const draft = (await as(finance, 'POST', '/invoicing/invoices/deposit-draft', { depositRequestId: ids.partRequest }, 201)).invoice
    expect(draft).toMatchObject({ docType: 'TD02', status: 'DRAFT', number: null, grossTotal: 40000 })
    const checks = await as(finance, 'GET', `/invoicing/invoices/${draft.id}/checks`)
    expect(checks).toMatchObject({ ready: true, problems: [], numberPreview: numberOf(await seriesNext()) })
    await stepUp(h, finance, financeSecret)
    const issued = await as(finance, 'POST', `/invoicing/invoices/${draft.id}/issue`, { version: draft.version })
    expect(issued).toMatchObject({ filesPending: false, invoice: { status: 'ISSUED', number: checks.numberPreview } })
  })

  it('two part payments of one request at once: the second pays and invoices only what is left (allocate BEFORE issuing, under its lock)', async () => {
    await stepUp(h, finance, financeSecret)
    const lock = holdDepositLock(ids.raceRequest)
    await lock.holding
    const day = businessDate(new Date())
    const answers = Promise.all([
      finance.post('/payments/deposit-received', { depositRequestId: ids.raceRequest, amount: 60000, receivedOn: day, externalRef: 'TRN-0901' }),
      finance.post('/payments/deposit-received', { depositRequestId: ids.raceRequest, amount: 60000, receivedOn: day, externalRef: 'TRN-0902' }),
    ])
    await waitingForAdvisoryLocks(2)
    await lock.release()
    const [a, b] = await answers
    expect([a.status, b.status], JSON.stringify([a.body, b.body])).toEqual([201, 201])
    const outcomes = [a.body, b.body].map((body) => [body.payment.allocated, body.payment.unallocated, body.depositInvoice.invoice.grossTotal]).sort((x, y) => y[0] - x[0])
    expect(outcomes).toEqual([
      [60000, 0, 60000],
      [40000, 20000, 40000],
    ])
    expect((await admin('SELECT status FROM "DepositRequest" WHERE id = $1', [ids.raceRequest]))[0]!.status).toBe('PAID')
  })
})

describe('the invoice core: drafts, totals, checks, the issue', () => {
  it('a draft recomputes its totals from its lines; an issued invoice never changes and is never deleted (DPR 633/1972 art. 26)', async () => {
    const draft = (await td01()).invoice
    expect(draft).toMatchObject({ status: 'DRAFT', netTotal: 61000, vatTotal: 13420, grossTotal: 74420, paymentTerms: { condition: 'TP02', installments: [{ method: 'MP05', amount: 74420 }] } })
    const changed = (await as(finance, 'PUT', `/invoicing/invoices/${draft.id}/lines`, { version: draft.version, lines: [{ description: 'Giacca', quantity: '1', unitPrice: '100.00', discountPct: '10' }] })).invoice
    expect(changed).toMatchObject({ netTotal: 9000, vatTotal: 1980, grossTotal: 10980, version: draft.version + 1, paymentTerms: { installments: [{ amount: 10980 }] } })
    expect((await finance.send('PUT' as 'POST', `/invoicing/invoices/${draft.id}/lines`, { version: draft.version, lines: [] })).status).toBe(409)
    await stepUp(h, finance, financeSecret)
    const issued = (await as(finance, 'POST', `/invoicing/invoices/${draft.id}/issue`, {})).invoice
    expect(issued.status).toBe('ISSUED')
    for (const [method, url, body] of [
      ['PUT', `/invoicing/invoices/${draft.id}/lines`, { lines: [] }],
      ['PATCH', `/invoicing/invoices/${draft.id}`, { causale: 'x' }],
      ['DELETE', `/invoicing/invoices/${draft.id}`, undefined],
    ] as const) {
      const answer = await finance.send(method as 'POST', url, body ?? {})
      expect(answer.status, `${method} ${url}`).toBe(409)
      expect(answer.body.error.code).toBe('invalid_state')
    }
    const deleted = (await td01()).invoice
    expect(await as(finance, 'DELETE', `/invoicing/invoices/${deleted.id}?version=${deleted.version}`)).toEqual({ deleted: true, id: deleted.id })
  })

  it('two issues at once get consecutive numbers, without a gap or a deadlock', async () => {
    const [a, b] = [(await td01()).invoice, (await td01()).invoice]
    const before = await seriesNext()
    await stepUp(h, finance, financeSecret)
    const [ra, rb] = await Promise.all([finance.post(`/invoicing/invoices/${a.id}/issue`, {}), finance.post(`/invoicing/invoices/${b.id}/issue`, {})])
    expect([ra.status, rb.status]).toEqual([200, 200])
    expect([ra.body.invoice.number, rb.body.invoice.number].sort()).toEqual([numberOf(before), numberOf(before + 1)])
    expect(await seriesNext()).toBe(before + 2)
  })

  it('a failed issue uses no number: the next issue gets it', async () => {
    const draft = (await td01()).invoice
    const before = await seriesNext()
    // A failure after the number was taken, inside the issuing transaction (any refusal of the database at the write).
    await admin(`CREATE FUNCTION test_fail_issue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'made-up failure at the issue'; END $$`)
    await admin(`CREATE TRIGGER "Invoice_test_fail" BEFORE UPDATE ON "Invoice" FOR EACH ROW WHEN (NEW.id = '${draft.id}'::uuid AND NEW.status = 'ISSUED') EXECUTE FUNCTION test_fail_issue()`)
    try {
      await stepUp(h, finance, financeSecret)
      expect((await finance.post(`/invoicing/invoices/${draft.id}/issue`, {})).status).toBe(500)
      expect(await seriesNext()).toBe(before)
      expect(await admin('SELECT id FROM "NumberAllocation" WHERE "recordId" = $1', [draft.id])).toEqual([])
      expect((await admin('SELECT status FROM "Invoice" WHERE id = $1', [draft.id]))[0]!.status).toBe('DRAFT')
    } finally {
      await admin('DROP TRIGGER "Invoice_test_fail" ON "Invoice"')
      await admin('DROP FUNCTION test_fail_issue()')
    }
    const issued = (await as(finance, 'POST', `/invoicing/invoices/${draft.id}/issue`, {})).invoice
    expect(issued.number).toBe(numberOf(before))
  })

  it('refuses with a clear 409 and takes no number: a blocked customer, a zero-rated EU sale without VIES proof, broken totals', async () => {
    const blocked = (await td01(undefined, ids.blockedCustomer)).invoice
    const eu = (await td01([{ description: 'Giacca moto in pelle', quantity: '1', unitPrice: '500', vatRatePct: '0', vatNature: 'N3.2', vatLegalRef: LEGAL_WORDING.INTRA_EU_SUPPLY }], ids.euCustomer)).invoice
    const broken = (await td01()).invoice
    await admin('UPDATE "Invoice" SET "netTotal" = 1, "vatTotal" = 0, "grossTotal" = 1 WHERE id = $1', [broken.id])
    const before = await seriesNext()
    await stepUp(h, finance, financeSecret)
    const refusals: Record<string, Json> = {}
    for (const [name, invoice] of Object.entries({ blocked, eu, broken })) {
      const answer = await finance.post(`/invoicing/invoices/${invoice.id}/issue`, {})
      expect(answer.status, name).toBe(409)
      refusals[name] = answer.body.error
    }
    expect(refusals.blocked).toMatchObject({ code: 'conflict', message: expect.stringContaining('is blocked'), issues: [{ path: 'party' }] })
    expect(refusals.eu!.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'party/vies', message: expect.stringContaining('VIES proof') })]))
    expect(refusals.broken).toMatchObject({ issues: [{ path: 'totals', message: expect.stringContaining('do not add up') }] })
    expect(await seriesNext()).toBe(before)
    const checks = await as(finance, 'GET', `/invoicing/invoices/${eu.id}/checks`)
    expect(checks.ready).toBe(false)
    expect(checks.problems.map((problem: Json) => problem.code)).toContain('NO_VIES_PROOF')
  })

  it('a store that does not answer leaves the invoice ISSUED with its files pending; "make the files" and the worker finish them', async () => {
    const draft = (await td01()).invoice
    await admin(`UPDATE "IntegrationAccount" SET status = 'PAUSED' WHERE "tenantId" = $1 AND provider = 'R2'`, [tenant.id])
    let issued: Json
    try {
      await stepUp(h, finance, financeSecret)
      issued = await as(finance, 'POST', `/invoicing/invoices/${draft.id}/issue`, {})
    } finally {
      await admin(`UPDATE "IntegrationAccount" SET status = 'ACTIVE' WHERE "tenantId" = $1 AND provider = 'R2'`, [tenant.id])
    }
    expect(issued).toMatchObject({ filesPending: true, invoice: { status: 'ISSUED', xmlFileId: null, filesPending: true } })
    expect(issued.filesProblem).toContain('issued')
    // The worker's handler on invoice.issued, as the tenant's system caller.
    const caller = callerFor(h.database, systemContext(tenant.id, newId()))
    await invoiceFilesHandler({ files: () => h.files }).handle({ eventId: newId(), type: 'invoice.issued', version: 1, tenantId: tenant.id, payload: { invoiceId: draft.id } } as never, { caller, attempt: 1 })
    const made = (await as(finance, 'GET', `/invoicing/invoices/${draft.id}`)).invoice
    expect(made).toMatchObject({ filesPending: false, xmlFileId: expect.any(String), pdfFileId: expect.any(String) })
    const again = (await as(finance, 'POST', `/invoicing/invoices/${draft.id}/files`)).invoice
    expect([again.xmlFileId, again.pdfFileId]).toEqual([made.xmlFileId, made.pdfFileId])
    expect(await xsdErrors((await downloaded(made.xmlFileId)).toString('utf8'))).toEqual([])
  })
})

describe('payments (FIN-121, FIN-122)', () => {
  it('allocates to an issued invoice, refuses to void while it pays something, voids once it is reversed', async () => {
    const issued = (await (async () => {
      const draft = (await td01()).invoice
      await stepUp(h, finance, financeSecret)
      return as(finance, 'POST', `/invoicing/invoices/${draft.id}/issue`, {})
    })()).invoice
    const recorded = (await as(finance, 'POST', '/payments', { companyId: c1(), partyId: ids.itCustomer, amount: 100000, receivedOn: businessDate(new Date()), externalRef: 'TRN-0100', allocations: [{ invoiceId: issued.id }] }, 201)).payment
    expect(recorded).toMatchObject({ allocated: 74420, unallocated: 25580, allocations: [{ target: 'INVOICE', targetId: issued.id, amount: 74420 }] })
    const tooMuch = await finance.post(`/payments/${recorded.id}/allocations`, { allocations: [{ invoiceId: issued.id, amount: 1 }] })
    expect(tooMuch.status).toBe(409)
    expect(tooMuch.body.error.message).toContain('open for 0.00 EUR')
    const refused = await finance.post(`/payments/${recorded.id}/void`, { reason: 'typed twice' })
    expect(refused.status).toBe(409)
    expect(refused.body.error.message).toContain('reverse its allocations first')
    const reversed = (await as(finance, 'POST', `/payments/${recorded.id}/allocations/${recorded.allocations[0].id}/reverse`, { note: 'wrong invoice' })).payment
    expect(reversed).toMatchObject({ allocated: 0, unallocated: 100000 })
    expect(reversed.allocations.map((row: Json) => [row.amount, row.reversed])).toEqual([[74420, true], [-74420, false]])
    const voided = (await as(finance, 'POST', `/payments/${recorded.id}/void`, { reason: 'typed twice' })).payment
    expect(voided).toMatchObject({ status: 'VOIDED', unallocated: 0 })
  })

  it('a PAID deposit request keeps its allocations; a TD02 is not paid directly', async () => {
    const [deposit] = await admin<{ id: string; paymentId: string }>('SELECT id, "paymentId" FROM "PaymentAllocation" WHERE "depositRequestId" = $1', [ids.request])
    const answer = await finance.post(`/payments/${deposit!.paymentId}/allocations/${deposit!.id}/reverse`, { note: 'test' })
    expect(answer.status).toBe(409)
    expect(answer.body.error.message).toContain('PAID')
    const [td02] = await admin<{ id: string }>(`SELECT id FROM "Invoice" WHERE "depositRequestId" = $1`, [ids.request])
    const other = (await as(finance, 'POST', '/payments', { companyId: c1(), partyId: ids.itCustomer, amount: 1000, receivedOn: businessDate(new Date()), externalRef: 'TRN-0101' }, 201)).payment
    const toTd02 = await finance.post(`/payments/${other.id}/allocations`, { allocations: [{ invoiceId: td02!.id }] })
    expect(toTd02.status).toBe(409)
    expect(toTd02.body.error.message).toContain('paid through its deposit request')
  })
})

describe('the walls', () => {
  let invoiceId: string
  beforeAll(async () => {
    invoiceId = (await admin<{ id: string }>(`SELECT id FROM "Invoice" WHERE "depositRequestId" = $1`, [ids.request]))[0]!.id
  })

  it('staff without the price grain see the invoice and the payment, never an amount; and cannot send one', async () => {
    const withPrice = await wall('withPrice', 'GET', `/invoicing/invoices/${invoiceId}`)
    expect(withPrice.body.invoice).toMatchObject({ grossTotal: 183000, lines: [{ unitPrice: '1830.000000', netAmount: 150000 }] })
    const noPrice = await wall('noPrice', 'GET', `/invoicing/invoices/${invoiceId}`)
    expect(noPrice.status).toBe(200)
    for (const field of ['netTotal', 'vatTotal', 'grossTotal', 'vatSummary', 'stampDutyAmount', 'paymentTerms', 'paidAmount']) expect(noPrice.body.invoice).not.toHaveProperty(field)
    for (const field of ['unitPrice', 'netAmount', 'grossAmount']) expect(noPrice.body.invoice.lines[0]).not.toHaveProperty(field)
    const list = await wall('noPrice', 'GET', '/invoicing/invoices')
    expect(list.body.invoices.length).toBeGreaterThan(0)
    expect(list.body.invoices[0]).not.toHaveProperty('grossTotal')
    const payments = await wall('noPrice', 'GET', '/payments')
    expect(payments.body.payments[0]).not.toHaveProperty('amount')
    const sent = await wall('recorderNoPrice', 'POST', '/payments', { companyId: c1(), partyId: ids.itCustomer, amount: 100, receivedOn: '2026-10-01', externalRef: 'TRN-0200' })
    expect(sent.status).toBe(403)
  })

  it('a floor device and a portal session are refused', async () => {
    for (const session of ['floor', 'partner']) {
      expect((await wall(session, 'GET', '/invoicing/invoices')).status).toBe(403)
      expect((await wall(session, 'GET', `/invoicing/invoices/${invoiceId}`)).status).toBe(403)
      expect((await wall(session, 'GET', '/payments')).status).toBe(403)
      expect((await wall(session, 'POST', '/payments', { companyId: c1(), partyId: ids.itCustomer, receivedOn: '2026-10-01', externalRef: 'TRN-0201' })).status).toBe(403)
    }
  })

  it('another tenant and another company see nothing of it', async () => {
    expect((await wall('otherTenant', 'GET', `/invoicing/invoices/${invoiceId}`)).status).toBe(404)
    expect((await wall('otherTenant', 'GET', '/invoicing/invoices')).body.invoices).toEqual([])
    expect((await wall('otherTenant', 'GET', '/payments')).body.payments).toEqual([])
    expect((await wall('companyTwo', 'GET', `/invoicing/invoices/${invoiceId}`)).status).toBe(404)
    expect((await wall('companyTwo', 'GET', '/invoicing/invoices')).body.invoices).toEqual([])
    expect((await wall('companyTwo', 'POST', '/payments', { companyId: c1(), partyId: ids.itCustomer, amount: 100, receivedOn: '2026-10-01', externalRef: 'TRN-0202' })).status).toBe(404)
  })
})
