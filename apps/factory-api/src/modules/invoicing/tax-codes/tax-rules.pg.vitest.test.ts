import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { quarterEndOf, quarterStartOf } from '@nexus/factory-domain/invoicing/stamp-duty/stamp-duty'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { addTenant, addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'

/**
 * Tax rules as data (B-W2b-392; FIN-100, FIN-101, FIN-107) on the local stack: a throwaway PostgreSQL 17 database from the
 * migrations (the runtime login: row-level security, the grants and the …_tax_currency_w2b_guards are real), the real app
 * with the real office sign-in (finance signs in, sets up two-factor and steps up to switch, confirm and issue), and a
 * second app on the same database with test sessions for the walls. GATE-ACCOUNTANT: every switch starts OFF. Every
 * company, customer, VAT number, protocol and amount is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs apps/factory-api/src/modules/invoicing/tax-codes`.
 */

let h: Harness
let tenant: TestTenant
let walls: FastifyInstance
let finance: Browser
let secret: string

const TODAY = businessDate(new Date())
const YEAR = TODAY.slice(0, 4)
const NEXT_YEAR = String(Number(YEAR) + 1)
const FAKE_VAT = { company: '12345670009', customer: '76543210009' } as const
const PROTOCOL = `${YEAR.slice(2)}000000000000077-000001`
const customer = newId()
const c1 = () => tenant.companies[0]!.id
const c2 = () => tenant.companies[1]!.id

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]

async function as(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await finance.send(method as 'POST', url, method === 'GET' ? undefined : (body ?? {}))
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}
const refusal = (body: Json) => (body.error.issues as { path: string }[]).map((issue) => issue.path)

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: tenant.id, actorId: newId(), grants })
const SESSIONS: Record<string, () => SessionContext> = {
  reader: () => office([grant(['invoices.view', 'money.price'])]),
  noPrice: () => office([grant(['invoices.view'])]),
  companyTwo: () => office([grant(['invoices.view', 'invoices.manage', 'invoices.tax.manage', 'money.price'], [c2()])]),
}
async function wall(session: string, method: 'GET' | 'POST', url: string, payload?: unknown) {
  const response = await walls.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
  return { status: response.statusCode, body: response.json() as Json }
}

const switchOn = async (values: Json) => {
  await stepUp(h, finance, secret)
  return as('PUT', `/invoicing/tax/settings/${c1()}`, values)
}
const draft = (lines: unknown[]) => as('POST', '/invoicing/invoices', { companyId: c1(), buyerPartyId: customer, docType: 'TD01', payment: { method: 'MP05', dueDate: `${YEAR}-12-31` }, lines }, 201).then((body) => body.invoice)
const goods = (unitPrice: string, vat: Json = {}) => ({ description: 'Giacca moto in pelle, nero, 50', itemCode: 'JKT-1-BLK-50', quantity: '1', uom: 'PZ', unitPrice, ...vat })
const OUT_OF_SCOPE = { vatRatePct: '0', vatNature: 'N2.2', vatLegalRef: 'Art. 2 DPR 633/1972 (made-up case)' }
const issue = async (invoice: Json, status = 200) => {
  await stepUp(h, finance, secret)
  return as('POST', `/invoicing/invoices/${invoice.id}/issue`, { version: invoice.version }, status)
}

beforeAll(async () => {
  h = await startHarness('tax_rules')
  tenant = await addTenant(h, 'tax-a', 2)
  for (const company of tenant.companies) {
    await admin(
      `UPDATE "Company" SET "vatNumber" = $2, "fiscalCode" = $3, "regimeFiscale" = 'RF01', "reaOffice" = 'MI', "reaNumber" = '0000001', address = $4::jsonb WHERE id = $1`,
      [company.id, `IT${FAKE_VAT.company}`, FAKE_VAT.company, JSON.stringify({ line1: 'Via dei Conciatori Finti 1', postalCode: '20121', city: 'Milano', province: 'MI', country: 'IT' })],
    )
    await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'INVOICE', 'MAIN', $4, 'YEARLY', 'FT-{YYYY}-{N:5}', true)`, [newId(), tenant.id, company.id, YEAR])
  }
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), tenant.id])
  await admin(`INSERT INTO "Party" (id, "tenantId", "companyId", code, kind, "legalName", roles, status, country) VALUES ($1, $2, $3, 'C-ESP', 'ORGANISATION', 'Esportatore Fittizio S.r.l.', '{CUSTOMER}', 'ACTIVE', 'IT')`, [customer, tenant.id, c1()])
  await admin(`INSERT INTO "PartyTaxIdentity" (id, "tenantId", "partyId", country, "taxMode", "vatNumber", "sdiRecipientCode", "validFrom") VALUES ($1, $2, $3, 'IT', 'IT_B2B', $4, 'FAKE001', '2026-01-01')`, [newId(), tenant.id, customer, `IT${FAKE_VAT.customer}`])
  await admin(
    `INSERT INTO "PartyAddress" (id, "tenantId", "partyId", kinds, line1, "postalCode", city, province, country, "isDefaultBillTo", "isDefaultShipTo") VALUES ($1, $2, $3, '{REGISTERED,BILL_TO,SHIP_TO}', 'Viale delle Prove 42', '40121', 'Bologna', 'BO', 'IT', true, true)`,
    [newId(), tenant.id, customer],
  )
  const user = await addUser(h, tenant, { email: 'fiona.finance@tax-a.example.com', role: 'finance' })
  finance = new Browser(h.app)
  await finance.signIn('tax-a', user.email, user.password)
  secret = await enrolTotp(h, finance)
  walls = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
}, 180_000)

afterAll(async () => {
  await walls?.close()
  await h?.close()
}, 60_000)

describe('the switches (GATE-ACCOUNTANT): all off, each says what waits; switching asks a step-up', () => {
  it('starts with every switch off and the words of what waits', async () => {
    const { companies } = await as('GET', '/invoicing/tax/settings')
    const one = companies.find((company: Json) => company.companyId === c1())
    expect(one).toMatchObject({ version: null, switches: { taxCodesOn: false, stampDutyOn: false, declarationsOfIntentOn: false }, selfInvoicesOn: false })
    expect(Object.values(one.words).every((words) => String(words).startsWith('Waits for the accountant'))).toBe(true)
  })

  it('refuses a switch without a fresh step-up; nothing is stored', async () => {
    const answer = await finance.send('PUT' as 'POST', `/invoicing/tax/settings/${c1()}`, { stampDutyOn: true })
    expect(answer.status).toBe(403)
    expect((answer.body as Json).error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])
    expect(await admin('SELECT id FROM "CompanyEInvoiceSettings"')).toEqual([])
  })

  it('a reader cannot switch; another company is out of reach', async () => {
    expect((await wall('reader', 'POST', '/invoicing/tax-codes', { companyId: c1(), code: '22', label: 'x', ratePct: '22', validFrom: '2026-01-01' })).status).toBe(403)
    expect((await wall('companyTwo', 'GET', `/invoicing/tax-codes?companyId=${c1()}`)).status).toBe(404)
  })
})

describe('tax codes as data (FIN-107)', () => {
  let ordinary: Json
  let planned: Json

  it('keeps codes per company and country with dates; versions of a code never overlap (409 in words)', async () => {
    ordinary = (await as('POST', '/invoicing/tax-codes', { companyId: c1(), code: '22', label: 'Ordinary rate 22%', ratePct: '22', accountCodeKey: 'VAT_SALES_22', ruleId: 'IT_DOMESTIC_SUPPLY', validFrom: '2026-01-01' }, 201)).taxCode
    expect(ordinary).toMatchObject({ country: 'IT', code: '22', ratePct: '22.00', state: 'IN_FORCE', verification: 'UNVERIFIED', can: { edit: false, end: true, newVersion: true, delete: false, confirm: true } })
    expect(ordinary.words).toContain('IT 22: 22 %, in force from 2026-01-01, waiting for the accountant.')
    const clash = await finance.post('/invoicing/tax-codes', { companyId: c1(), code: '22', label: 'Again', ratePct: '22', validFrom: '2026-06-01' })
    expect(clash.status).toBe(409)
    expect(refusal(clash.body as Json)).toEqual(['refusal/OVERLAP'])
    const bad = await finance.post('/invoicing/tax-codes', { companyId: c1(), code: 'N3.1', label: 'Export', ratePct: '0', validFrom: '2026-01-01' })
    expect(bad.status).toBe(400)
    expect((bad.body as Json).error.issues.map((issue: Json) => issue.path)).toEqual(['body/natura'])
    await as('POST', '/invoicing/tax-codes', { companyId: c1(), code: 'N2.2', label: 'Out of scope (made up)', ratePct: '0', natura: 'N2.2', legalRef: 'Art. 2 DPR 633/1972 (as per the code)', validFrom: '2026-01-01' }, 201)
    await as('POST', '/invoicing/tax-codes', { companyId: c1(), code: 'N3.5', label: "Customer's declaration of intent", ratePct: '0', natura: 'N3.5', legalRef: 'Art. 8 c.1 lett. c) DPR 633/1972', validFrom: '2026-01-01' }, 201)
    await as('POST', '/invoicing/tax-codes', { companyId: c1(), code: 'N1-BOLLO', label: 'Stamp duty charged to the customer', ratePct: '0', natura: 'N1', legalRef: 'Art. 15 DPR 633/1972 (bollo)', ruleId: 'STAMP_DUTY', validFrom: '2026-01-01' }, 201)
  })

  it('a code in force is never edited: its label and end change, anything else is a new version from today', async () => {
    const edited = await finance.send('PATCH' as 'POST', `/invoicing/tax-codes/${ordinary.id}`, { version: ordinary.version, ratePct: '10' })
    expect(edited.status).toBe(409)
    expect(refusal(edited.body as Json)).toEqual(['refusal/IN_FORCE'])
    ordinary = (await as('PATCH', `/invoicing/tax-codes/${ordinary.id}`, { version: ordinary.version, label: 'Ordinary rate' })).taxCode
    const versioned = await as('POST', `/invoicing/tax-codes/${ordinary.id}/versions`, { version: ordinary.version, validFrom: TODAY, accountCodeKey: 'VAT_SALES_22_NEW' }, 201)
    expect(versioned.ended).toMatchObject({ id: ordinary.id, validTo: versioned.ended.validTo })
    expect(versioned.ended.validTo < TODAY).toBe(true)
    expect(versioned.taxCode).toMatchObject({ code: '22', validFrom: TODAY, validTo: null, accountCodeKey: 'VAT_SALES_22_NEW', state: 'IN_FORCE' })
    ordinary = versioned.taxCode
  })

  it('a version not yet in force changes freely and is deleted; from its first day it is archived instead', async () => {
    planned = (await as('POST', '/invoicing/tax-codes', { companyId: c1(), code: '10', label: 'Reduced rate', ratePct: '10', validFrom: `${NEXT_YEAR}-01-01` }, 201)).taxCode
    expect(planned).toMatchObject({ state: 'PLANNED', can: { edit: true, delete: true } })
    planned = (await as('PATCH', `/invoicing/tax-codes/${planned.id}`, { version: planned.version, ratePct: '5' })).taxCode
    expect(planned.ratePct).toBe('5.00')
    expect(await as('DELETE', `/invoicing/tax-codes/${planned.id}?version=${planned.version}`)).toEqual({ deleted: true, id: planned.id })
    const inForce = await finance.send('DELETE' as 'POST', `/invoicing/tax-codes/${ordinary.id}?version=${ordinary.version}`)
    expect(inForce.status).toBe(409)
    expect(refusal(inForce.body as Json)).toEqual(['refusal/NOT_PLANNED'])
  })

  it("records the accountant's confirmation with a step-up, once; the catalogue's rules read from the codes", async () => {
    expect((await finance.post(`/invoicing/tax-codes/${ordinary.id}/confirm`, { version: ordinary.version })).status).toBe(403)
    await stepUp(h, finance, secret)
    ordinary = (await as('POST', `/invoicing/tax-codes/${ordinary.id}/confirm`, { version: ordinary.version })).taxCode
    expect(ordinary).toMatchObject({ verification: 'VERIFIED', can: { confirm: false } })
    await stepUp(h, finance, secret)
    const again = await finance.post(`/invoicing/tax-codes/${ordinary.id}/confirm`, { version: ordinary.version })
    expect(refusal(again.body as Json)).toEqual(['refusal/CONFIRMED'])
    const list = await as('GET', `/invoicing/tax-codes?companyId=${c1()}`)
    expect(list.waits).toContain('Waits for the accountant')
    expect(list.rules.find((rule: Json) => rule.id === 'STAMP_DUTY')).toMatchObject({ catalogueStatus: 'UNVERIFIED', status: 'UNVERIFIED', taxCodeIds: [expect.any(String)] })
    expect(list.rules.find((rule: Json) => rule.id === 'IT_DOMESTIC_SUPPLY')).toMatchObject({ status: 'VERIFIED', taxCodeIds: [ordinary.id] })
    expect(list.codes.map((code: Json) => `${code.code}:${code.state}`)).toEqual(['22:ENDED', '22:IN_FORCE', 'N1-BOLLO:IN_FORCE', 'N2.2:IN_FORCE', 'N3.5:IN_FORCE'])
  })

  it('with the tax-codes switch on, a line whose VAT is no code in force stops the issue, and the code prints its law', async () => {
    const on = await switchOn({ taxCodesOn: true })
    expect(on.company).toMatchObject({ version: 1, switches: { taxCodesOn: true, stampDutyOn: false } })
    const reduced = await draft([goods('50.00', { vatRatePct: '10' })])
    const checks = await as('GET', `/invoicing/invoices/${reduced.id}/checks`)
    expect(checks.problems).toEqual([expect.objectContaining({ code: 'TAX_CODE', path: 'lines/0/vat', message: expect.stringContaining('Line 1 carries VAT 10 %, which is not a tax code of the company in force on') })])
    const worded = await draft([goods('50.00', OUT_OF_SCOPE)])
    expect(worded.lines[0]).toMatchObject({ vatNature: 'N2.2', vatLegalRef: 'Art. 2 DPR 633/1972 (as per the code)' })
    await as('DELETE', `/invoicing/invoices/${reduced.id}?version=${reduced.version}`)
    await as('DELETE', `/invoicing/invoices/${worded.id}?version=${worded.version}`)
  })
})

describe('stamp duty on VAT-free invoices charged to the customer, and the quarter (FIN-101; Owner 11-13)', () => {
  it('with the switch off nothing is charged: the e-invoice prints the stamp duty as W1 does', async () => {
    const off = await draft([goods('100.00', OUT_OF_SCOPE)])
    expect(off).toMatchObject({ netTotal: 10000, grossTotal: 10000, stampDutyAmount: 200 })
    expect(off.lines.map((line: Json) => line.chargeKind)).toEqual([null])
    const tax = await as('GET', `/invoicing/invoices/${off.id}/tax`)
    expect(tax.stampDuty).toMatchObject({ amount: 200, charge: false, reason: 'SWITCH_OFF', chargedAmount: null })
    expect(tax.stampDuty.words).toContain('waits for the accountant')
    await as('DELETE', `/invoicing/invoices/${off.id}?version=${off.version}`)
  })

  it('with the switch on a draft above 77.47 EUR without VAT gets the line (N1, the code law); below, the line goes', async () => {
    await switchOn({ stampDutyOn: true })
    let invoice = await draft([goods('100.00', OUT_OF_SCOPE)])
    expect(invoice).toMatchObject({ netTotal: 10200, vatTotal: 0, grossTotal: 10200, stampDutyAmount: 200 })
    expect(invoice.lines[1]).toMatchObject({ kind: 'CHARGE', chargeKind: 'STAMP_DUTY', quantity: '1.0000', netAmount: 200, vatRatePct: '0.00', vatNature: 'N1', vatLegalRef: 'Art. 15 DPR 633/1972 (bollo)' })
    invoice = (await as('PUT', `/invoicing/invoices/${invoice.id}/lines`, { version: invoice.version, lines: [goods('70.00', OUT_OF_SCOPE)] })).invoice
    expect(invoice).toMatchObject({ grossTotal: 7000, stampDutyAmount: null })
    expect(invoice.lines).toHaveLength(1)
    const typed = await finance.send('PUT' as 'POST', `/invoicing/invoices/${invoice.id}/lines`, { version: invoice.version, lines: [{ ...goods('2.00'), kind: 'CHARGE', chargeKind: 'STAMP_DUTY' }] })
    expect(typed.status).toBe(400)
    await as('DELETE', `/invoicing/invoices/${invoice.id}?version=${invoice.version}`)
  })

  it('a draft whose line the switch no longer allows is refused at the check, then saved again without it', async () => {
    let invoice = await draft([goods('100.00', OUT_OF_SCOPE)])
    await switchOn({ stampDutyOn: false })
    const checks = await as('GET', `/invoicing/invoices/${invoice.id}/checks`)
    expect(checks.problems).toEqual([expect.objectContaining({ code: 'STAMP_DUTY', message: expect.stringContaining('no longer charges') })])
    invoice = (await as('PATCH', `/invoicing/invoices/${invoice.id}`, { version: invoice.version })).invoice
    expect(invoice.lines).toHaveLength(1)
    expect((await as('GET', `/invoicing/invoices/${invoice.id}/checks`)).problems).toEqual([])
    await as('DELETE', `/invoicing/invoices/${invoice.id}?version=${invoice.version}`)
    await switchOn({ stampDutyOn: true })
  })

  it('the issue counts the quarter in its command; the XML carries DatiBollo and the charged line', async () => {
    const invoice = await draft([goods('100.00', OUT_OF_SCOPE)])
    const issued = await issue(invoice)
    expect(issued.invoice).toMatchObject({ status: 'ISSUED', grossTotal: 10200, stampDutyAmount: 200 })
    const quarters = await as('GET', `/invoicing/stamp-duty/quarters?companyId=${c1()}`)
    const now = quarters.quarters.find((quarter: Json) => quarter.quarterStart === quarterStartOf(TODAY))
    expect(now).toMatchObject({ invoiceCount: 1, total: 200, liveCount: 1, liveTotal: 200, stale: false, state: 'OPEN' })
    expect(quarters).toMatchObject({ stampDutyOn: true, waits: null })
    const [row] = await admin(`SELECT "invoiceCount", total FROM "StampDutyQuarter" WHERE "companyId" = $1`, [c1()])
    expect(row).toEqual({ invoiceCount: 1, total: 200 })
    const xml = await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "StoredFile" WHERE "recordId" = $1 AND "contentType" = 'application/xml'`, [invoice.id])
    expect(xml[0]!.n).toBe(1)
    const paid = await finance.post(`/invoicing/stamp-duty/quarters/${now.id}/paid`, { version: now.version })
    expect(paid.status).toBe(409)
    expect(refusal(paid.body as Json)).toEqual(['refusal/QUARTER_OPEN'])
  })

  it('an ended quarter is paid once (then frozen); the amounts need the price grain', async () => {
    const start = quarterStartOf(`${YEAR}-01-15`) === quarterStartOf(TODAY) ? null : `${YEAR}-01-01`
    if (start === null) return
    const quarterId = newId()
    await admin(`INSERT INTO "StampDutyQuarter" (id, "tenantId", "companyId", "quarterStart", "invoiceCount", total) VALUES ($1, $2, $3, $4, 0, 0)`, [quarterId, tenant.id, c1(), start])
    const paidOn = `${YEAR}-${quarterEndOf(start).slice(5, 7) === '03' ? '04' : '12'}-15`
    const paid = await as('POST', `/invoicing/stamp-duty/quarters/${quarterId}/paid`, { version: 1, paidOn })
    expect(paid.quarter).toMatchObject({ id: quarterId, state: 'PAID', invoiceCount: 0 })
    const again = await finance.post(`/invoicing/stamp-duty/quarters/${quarterId}/paid`, { version: paid.quarter.version })
    expect(again.status).toBe(409)
    const noPrice = await wall('noPrice', 'GET', `/invoicing/stamp-duty/quarters?companyId=${c1()}`)
    expect(noPrice.status).toBe(200)
    expect(noPrice.body.quarters[0]).not.toHaveProperty('total')
  })
})

describe('declarations of intent checked and used up (FIN-100)', () => {
  let declaration: Json
  let first: Json

  it('records the declaration while the switch is off, but no invoice names it yet', async () => {
    declaration = (await as('POST', '/invoicing/declarations-of-intent', { companyId: c1(), partyId: customer, protocolNumber: PROTOCOL, protocolDate: `${YEAR}-01-10`, amount: 100000 }, 201)).declaration
    expect(declaration).toMatchObject({ state: 'UNCHECKED', amount: 100000, usedAmount: 0, leftAmount: 100000, year: Number(YEAR), waits: expect.stringContaining('Waits for the accountant') })
    const twice = await finance.post('/invoicing/declarations-of-intent', { companyId: c1(), partyId: customer, protocolNumber: PROTOCOL, protocolDate: `${YEAR}-01-10`, amount: 5 })
    expect(twice.status).toBe(409)
    expect(refusal(twice.body as Json)).toEqual(['refusal/PROTOCOL_LIVE'])
    const invoice = await draft([goods('500.00')])
    const named = await finance.send('PUT' as 'POST', `/invoicing/invoices/${invoice.id}/declaration-of-intent`, { version: invoice.version, declarationOfIntentId: declaration.id })
    expect(named.status).toBe(409)
    expect(refusal(named.body as Json)).toEqual(['refusal/SWITCH_OFF'])
    first = invoice
  })

  it('named while on: the taxable lines become N3.5 (the code law), the stamp duty follows; unchecked stops the issue', async () => {
    await switchOn({ declarationsOfIntentOn: true })
    const named = await as('PUT', `/invoicing/invoices/${first.id}/declaration-of-intent`, { version: first.version, declarationOfIntentId: declaration.id })
    first = named.invoice
    expect(named.declarationOfIntentId).toBe(declaration.id)
    expect(first).toMatchObject({ netTotal: 50200, vatTotal: 0, grossTotal: 50200, stampDutyAmount: 200 })
    expect(first.lines.map((line: Json) => [line.vatNature, line.vatLegalRef, line.chargeKind])).toEqual([
      ['N3.5', 'Art. 8 c.1 lett. c) DPR 633/1972', null],
      ['N1', 'Art. 15 DPR 633/1972 (bollo)', 'STAMP_DUTY'],
    ])
    const checks = await as('GET', `/invoicing/invoices/${first.id}/checks`)
    expect(checks.problems.map((problem: Json) => problem.code)).toEqual(['INTENT_UNCHECKED'])
    const answer = await issue(first, 409)
    expect(answer.error.message).toContain("is not checked on the tax agency's site yet")
  })

  it("is checked with the receipt the tax agency's site printed (a file of the declaration)", async () => {
    const store = (await admin<{ id: string }>(`SELECT id FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2'`, [tenant.id]))[0]!.id
    const file = async (recordId: string) => {
      const id = newId()
      await admin(
        `INSERT INTO "StoredFile" (id, "tenantId", "companyId", "recordType", "recordId", kind, "originalName", "contentType", "sizeBytes", sha256, "storeAccountId", "storageKey", status, "availableAt", visibility)
         VALUES ($1, $2, $3, 'DeclarationOfIntent', $4, 'DOCUMENT', 'made-up-receipt.pdf', 'application/pdf', 1024, $5, $6, $7, 'AVAILABLE', now(), '{OFFICE}')`,
        [id, tenant.id, c1(), recordId, 'a'.repeat(64), store, `t/${tenant.id}/c/${c1()}/${YEAR}/${newId()}`],
      )
      return id
    }
    const wrong = await finance.post(`/invoicing/declarations-of-intent/${declaration.id}/check`, { version: declaration.version, receiptFileId: await file(newId()) })
    expect(refusal(wrong.body as Json)).toEqual(['refusal/RECEIPT'])
    declaration = (await as('POST', `/invoicing/declarations-of-intent/${declaration.id}/check`, { version: declaration.version, receiptFileId: await file(declaration.id) })).declaration
    expect(declaration).toMatchObject({ state: 'CHECKED', checkedById: expect.any(String) })
  })

  it('issued: what it uses is added under its lock, and the XML names the protocol (AltriDatiGestionali INTENTO)', async () => {
    const issued = await issue(first)
    expect(issued.invoice).toMatchObject({ status: 'ISSUED', grossTotal: 50200 })
    declaration = (await as('GET', `/invoicing/declarations-of-intent/${declaration.id}`)).declaration
    expect(declaration).toMatchObject({ usedAmount: 50000, leftAmount: 50000, invoices: [{ id: first.id, intentAmount: 50000 }] })
    const presigned = await as('GET', `/files/${issued.invoice.xmlFileId}/download`)
    const xml = (await h.app.inject({ method: 'GET', url: presigned.download.url })).body
    expect(xml).toMatch(new RegExp(`<TipoDato>INTENTO</TipoDato>\\s*<RiferimentoTesto>${PROTOCOL}</RiferimentoTesto>\\s*<RiferimentoData>${YEAR}-01-10</RiferimentoData>`))
    expect(xml).toContain('<ImportoBollo>2.00</ImportoBollo>')
  })

  it('a VAT-free invoice beyond what is left is refused in words; no number is taken', async () => {
    let second = await draft([goods('600.00')])
    second = (await as('PUT', `/invoicing/invoices/${second.id}/declaration-of-intent`, { version: second.version, declarationOfIntentId: declaration.id })).invoice
    const before = await admin<{ nextValue: number }>(`SELECT "nextValue" FROM "NumberSeries" WHERE "companyId" = $1`, [c1()])
    const answer = await issue(second, 409)
    expect(answer.error.message).toContain('this invoice needs 600.00 EUR, only 500.00 EUR is left')
    expect(await admin(`SELECT "nextValue" FROM "NumberSeries" WHERE "companyId" = $1`, [c1()])).toEqual(before)
    second = (await as('PUT', `/invoicing/invoices/${second.id}/declaration-of-intent`, { version: second.version, declarationOfIntentId: null })).invoice
    expect(second.lines.map((line: Json) => line.vatRatePct)).toEqual(['22.00'])
    expect(second).toMatchObject({ vatTotal: 13200, stampDutyAmount: null })
    await as('DELETE', `/invoicing/invoices/${second.id}?version=${second.version}`)
  })

  it('a credit note gives back what it credits; a revoked declaration takes no invoice', async () => {
    const note = (await as('POST', `/invoicing/invoices/${first.id}/credit-note`, { full: true, reason: 'RETURN' }, 201)).invoice
    await issue(note)
    declaration = (await as('GET', `/invoicing/declarations-of-intent/${declaration.id}`)).declaration
    expect(declaration.usedAmount).toBe(0)
    declaration = (await as('POST', `/invoicing/declarations-of-intent/${declaration.id}/revoke`, { version: declaration.version, reason: 'The customer withdrew it (made up)' })).declaration
    expect(declaration.state).toBe('REVOKED')
    const third = await draft([goods('100.00')])
    const named = await finance.send('PUT' as 'POST', `/invoicing/invoices/${third.id}/declaration-of-intent`, { version: third.version, declarationOfIntentId: declaration.id })
    expect(refusal(named.body as Json)).toEqual(['refusal/REVOKED'])
    const audit = await admin<{ action: string }>(`SELECT action FROM "AuditLog" WHERE "recordId" = $1 ORDER BY at, id`, [declaration.id])
    expect(audit.map((row) => row.action)).toEqual(['invoices.createDeclarationOfIntent', 'invoices.checkDeclarationOfIntent', 'invoices.useDeclarationOfIntent', 'invoices.returnDeclarationOfIntent', 'invoices.revokeDeclarationOfIntent'])
    const events = await admin<{ type: string }>(`SELECT payload->>'action' AS type FROM "OutboxEvent" WHERE type = 'declaration_of_intent.changed' AND subject = $1 ORDER BY "occurredAt", id`, [declaration.id])
    expect(events.map((row) => row.type)).toEqual(['CREATED', 'CHECKED', 'USED', 'RETURNED', 'REVOKED'])
  })
})
