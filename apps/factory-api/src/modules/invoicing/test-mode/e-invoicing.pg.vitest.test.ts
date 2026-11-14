import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { validateXML } from 'xmllint-wasm'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { FakeSdi } from '../../../adapters/sdi/fake'
import { buildApp } from '../../../core/app'
import { callerFor, command } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { addTenant, addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { createGateway } from '../../../platform/gateway/gateway'
import type { EventHandler } from '../../../platform/outbox/dispatch'
import { systemContext } from '../../../platform/outbox/system'
import { readInvoices } from '../../sales/portal-documents/store'
import { sdiArchiveCopyHandler } from '../archive-copy/copy'
import { sdiArchiveHandler } from '../sdi/archive'
import { sdiCourtesyCopyHandler } from '../sdi/copy'
import { pollSend } from '../sdi/poll'
import { createSdiRuntime, useSdi, type SdiRuntime } from '../sdi/runtime'
import { sdiTestAnswerHandler } from './answer'

/**
 * E-invoicing in depth (B-W2b-401; FIN-071, FIN-073, FIN-095, FIN-096, FIN-097) on the local stack: a throwaway PostgreSQL 17
 * database from the migrations (the runtime login: row-level security, the grants and the money and …_tax_currency_w2b_guards
 * triggers are real), the real office sign-in (finance steps up), the SDI runtime with the FAKE intermediary behind the real
 * gateway, and the worker emulated by running the handlers on the outbox's new events. Company C1 sends through a FAKE
 * connection (the fake intermediary answers); company C2 has a LIVE connection whose intermediary is not chosen (Q21): in test
 * mode its sends are answered in-process and never reach it. Every company, party, VAT number, invoice and amount is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs apps/factory-api/src/modules/invoicing/test-mode`.
 */

let h: Harness
let tenant: TestTenant
let walls: FastifyInstance
let finance: Browser
let secret: string
let fake: FakeSdi
let sdi: SdiRuntime
let liveAccount: string

const YEAR = businessDate(new Date()).slice(0, 4)
const TODAY = () => businessDate(new Date())
const c1 = () => tenant.companies[0]!.id
const c2 = () => tenant.companies[1]!.id
const ids = { customer: newId(), supplierDe: newId(), supplierUs: newId() }

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]

async function as(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await finance.send(method as 'POST', url, method === 'GET' ? undefined : (body ?? {}))
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}
const stepped = () => stepUp(h, finance, secret)

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: tenant.id, actorId: newId(), grants })
const SESSIONS: Record<string, () => SessionContext> = {
  reader: () => office([grant(['invoices.view', 'money.price'])]),
  sales: () => office([grant(['invoices.view', 'invoices.manage', 'money.price'])]),
  companyOne: () => office([grant(['invoices.view', 'invoices.manage', 'invoices.issue', 'invoices.testMode.manage', 'money.price', 'money.cost'], [tenant.companies[0]!.id])]),
  floor: () => ({ audience: 'floor', tenantId: tenant.id, actorId: newId(), siteId: newId(), deviceId: newId(), grants: [grant(['invoices.view', 'invoices.manage'])] }),
  partner: () => ({ audience: 'partner', tenantId: tenant.id, actorId: newId(), partyId: ids.supplierDe, grants: [grant(['invoices.view'])] }),
}
async function wall(session: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const response = await walls.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
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

// ---- the worker, emulated -----------------------------------------------------------------------------------------------

const seen = new Set<string>()
let handlers: EventHandler[] = []
async function drain(list: EventHandler[] = handlers): Promise<string[]> {
  const types: string[] = []
  for (let round = 0; round < 10; round++) {
    const rows = await admin<{ id: string; type: string; version: number; payload: unknown; tenantId: string; companyId: string | null }>(`SELECT id, type, version, payload, "tenantId", "companyId" FROM "OutboxEvent" ORDER BY "occurredAt", id`)
    const fresh = rows.filter((row) => !seen.has(row.id))
    if (fresh.length === 0) return types
    for (const row of fresh) {
      seen.add(row.id)
      types.push(row.type)
      for (const handler of list.filter((entry) => entry.events.includes(row.type))) {
        await handler.handle({ eventId: row.id, type: row.type, version: row.version, tenantId: row.tenantId, companyId: row.companyId, payload: row.payload } as never, { caller: callerFor(h.database, systemContext(row.tenantId, newId())), attempt: 1 })
      }
    }
  }
  return types
}
const system = () => callerFor(h.database, systemContext(tenant.id, newId()))

// ---- set-up helpers -------------------------------------------------------------------------------------------------------

async function addParty(id: string, code: string, roles: string, country: string, taxMode: string, vat: string, currency = 'EUR') {
  await admin(`INSERT INTO "Party" (id, "tenantId", "companyId", code, kind, "legalName", roles, status, country, currency) VALUES ($1, $2, NULL, $3, 'ORGANISATION', $4, $5::"PartyRole"[], 'ACTIVE', $6, $7)`, [id, tenant.id, code, `Fittizia ${code}`, roles, country, currency])
  await admin(`INSERT INTO "PartyTaxIdentity" (id, "tenantId", "partyId", country, "taxMode", "vatNumber", "sdiRecipientCode", "validFrom") VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-01-01')`, [newId(), tenant.id, id, country, taxMode, vat, country === 'IT' ? 'FAKE001' : null])
  await admin(`INSERT INTO "PartyAddress" (id, "tenantId", "partyId", kinds, line1, "postalCode", city, province, country, "isDefaultBillTo", "isDefaultShipTo") VALUES ($1, $2, $3, '{REGISTERED,BILL_TO,SHIP_TO}', 'Via delle Prove 1', $4, $5, $6, $7, true, true)`, [
    newId(),
    tenant.id,
    id,
    country === 'IT' ? '40121' : '10115',
    country === 'IT' ? 'Bologna' : 'Musterstadt',
    country === 'IT' ? 'BO' : null,
    country,
  ])
}

async function addSdiAccount(companyId: string, mode: 'FAKE' | 'LIVE'): Promise<string> {
  const id = newId()
  await command(callerFor(h.database, { audience: 'office', tenantId: tenant.id, actorId: newId(), grants: [], requestId: newId() }), { name: 'integration.createAccount', input: { id } }, async (tools) => {
    await tools.tx.integrationAccount.create({ data: { id, companyId, provider: 'SDI', code: `sdi-${id.slice(-8)}`, label: mode === 'FAKE' ? 'SDI (fake)' : 'Intermediario fittizio', mode, rateLimitPerMinute: 6000, rateLimitBurst: 1000, callTimeoutMs: 400, circuitFailureThreshold: 1000 }, select: { id: true } })
    tools.audit({ recordType: 'IntegrationAccount', recordId: id })
    return { id }
  })
  return id
}

/** A TD01 of the customer, issued (step-up), its files made. */
async function issuedInvoice(companyId: string, unitPrice = '100.00'): Promise<Json> {
  const draft = (await as('POST', '/invoicing/invoices', { companyId, buyerPartyId: ids.customer, docType: 'TD01', payment: { method: 'MP05', dueDate: '2026-12-31' }, lines: [{ description: 'Giacca moto in pelle', quantity: '1', unitPrice }] }, 201)).invoice
  await stepped()
  const answer = await as('POST', `/invoicing/invoices/${draft.id}/issue`, {})
  expect(answer).toMatchObject({ invoice: { status: 'ISSUED' }, filesPending: false })
  return answer.invoice
}
const sendIt = async (invoiceId: string, status = 200): Promise<Json> => {
  await stepped()
  return as('POST', `/invoicing/invoices/${invoiceId}/sdi/send`, {}, status)
}
const invoiceOf = async (invoiceId: string): Promise<Json> => (await as('GET', `/invoicing/invoices/${invoiceId}`)).invoice
const settingsOf = async (companyId: string): Promise<Json> => (await as('GET', '/invoicing/e-invoicing/settings')).companies.find((entry: Json) => entry.companyId === companyId)

beforeAll(async () => {
  h = await startHarness('e_invoicing')
  tenant = await addTenant(h, 'einv-a', 2)
  for (const company of tenant.companies) {
    await admin(`UPDATE "Company" SET "vatNumber" = 'IT12345670009', "fiscalCode" = '12345670009', "regimeFiscale" = 'RF01', "reaOffice" = 'MI', "reaNumber" = '0000001', address = $2::jsonb WHERE id = $1`, [
      company.id,
      JSON.stringify({ line1: 'Via dei Conciatori Finti 1', postalCode: '20121', city: 'Milano', province: 'MI', country: 'IT' }),
    ])
    await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'INVOICE', 'MAIN', $4, 'YEARLY', 'FT-{YYYY}-{N:5}', true)`, [newId(), tenant.id, company.id, YEAR])
    await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'SELF_INVOICE', 'MAIN', $4, 'YEARLY', 'AF-{YYYY}-{N:4}', true)`, [newId(), tenant.id, company.id, YEAR])
  }
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), tenant.id])
  await addParty(ids.customer, 'C-IT', '{CUSTOMER}', 'IT', 'IT_B2B', 'IT76543210009')
  await addParty(ids.supplierDe, 'S-DE', '{SUPPLIER}', 'DE', 'EU_B2B', 'DE999999999')
  await addParty(ids.supplierUs, 'S-US', '{SUPPLIER}', 'US', 'EXTRA_EU', '99-9999999', 'USD')
  await addSdiAccount(c1(), 'FAKE')
  liveAccount = await addSdiAccount(c2(), 'LIVE')

  fake = new FakeSdi({ answerAfterMs: 0 })
  const gateway = createGateway({ environment: 'test', redis: h.redis, prefix: h.redisPrefix, secrets: h.secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  sdi = createSdiRuntime({ gateway, fake })
  useSdi(sdi)
  handlers = [sdiTestAnswerHandler(() => sdi), sdiArchiveHandler(() => sdi), sdiCourtesyCopyHandler(), sdiArchiveCopyHandler()]

  const user = await addUser(h, tenant, { email: 'fiona.finance@einv-a.example.com', role: 'finance' })
  finance = new Browser(h.app)
  const signedIn = await finance.signIn('einv-a', user.email, user.password)
  expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200)
  secret = await enrolTotp(h, finance)
  walls = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null), logger: false },
  )
}, 300_000)

afterAll(async () => {
  useSdi(undefined)
  await walls?.close()
  await h?.close()
}, 60_000)

beforeEach(async () => {
  for (const row of await admin<{ id: string }>('SELECT id FROM "OutboxEvent"')) seen.add(row.id)
})

describe('e-invoice test mode (FIN-096): simulated answers, nothing reaches the intermediary', () => {
  it('shows each company in test mode with the banner, who answers, and why it cannot go live yet', async () => {
    const one = await settingsOf(c1())
    expect(one).toMatchObject({ version: null, testMode: true, simulateOutcome: 'DELIVERED', state: { code: 'TEST', banner: 'E-invoice test mode — nothing goes to SDI', simulated: false }, connection: { state: 'ACTIVE' }, goLive: { allowed: true }, rules: { selfInvoicesOn: false }, can: { manage: true, switchRules: true } })
    const two = await settingsOf(c2())
    expect(two).toMatchObject({ testMode: true, state: { code: 'TEST', simulated: true }, goLive: { allowed: false, problems: [{ code: 'PROVIDER_NOT_CHOSEN' }] } })
    expect(two.rules.words.SELF_INVOICES).toMatch(/^Waits for the accountant/)
  })

  it('answers a send on a LIVE connection in-process (DELIVERED): no gateway call, no archive, no copy', async () => {
    const invoice = await issuedInvoice(c2())
    const calls = (await admin<{ n: string }>('SELECT count(*)::text AS n FROM "IntegrationCall" WHERE "accountId" = $1', [liveAccount]))[0]!.n
    const sent = await sendIt(invoice.id)
    expect(sent.sdi.sends.at(-1)).toMatchObject({ status: 'SENT' })
    const [row] = await admin<{ providerRef: string; status: string }>('SELECT "providerRef", status FROM "SdiSubmission" WHERE "invoiceId" = $1', [invoice.id])
    expect(row!.providerRef).toMatch(/^TEST-MODE:DELIVERED:/)
    expect(await drain()).toEqual(expect.arrayContaining(['invoice.sdi_notification_received', 'invoice.sdi_status_changed']))
    expect((await invoiceOf(invoice.id)).status).toBe('DELIVERED')
    expect((await admin<{ n: string }>('SELECT count(*)::text AS n FROM "IntegrationCall" WHERE "accountId" = $1', [liveAccount]))[0]!.n).toBe(calls)
    expect(await admin('SELECT "archivedAt" FROM "SdiSubmission" WHERE "invoiceId" = $1 AND "archivedAt" IS NOT NULL', [invoice.id])).toEqual([])
    const copies = await as('GET', `/invoicing/invoices/${invoice.id}/copies`)
    expect(copies.sends).toMatchObject([{ copy: { state: 'SIMULATED' }, providerName: null, receipts: [] }])
    expect((await settingsOf(c2())).testSent).toBeGreaterThanOrEqual(1)
  })

  it('practises a rejection: the first send rejected (NS 00423, marked TEST), the corrected resend delivered', async () => {
    await stepped()
    const picked = await as('PUT', `/invoicing/e-invoicing/settings/${c2()}`, { simulateOutcome: 'REJECTED' })
    expect(picked.company).toMatchObject({ simulateOutcome: 'REJECTED', testMode: true, version: 1 })
    const invoice = await issuedInvoice(c2(), '120.00')
    await sendIt(invoice.id)
    await drain()
    const status = (await as('GET', `/invoicing/invoices/${invoice.id}/sdi`)).sdi
    expect(status.invoiceStatus).toBe('REJECTED')
    expect(JSON.stringify(status.sends.at(-1).notifications)).toContain('00423')
    await sendIt(invoice.id)
    await drain()
    expect((await invoiceOf(invoice.id)).status).toBe('DELIVERED')
    expect(await admin('SELECT attempt, status FROM "SdiSubmission" WHERE "invoiceId" = $1 ORDER BY attempt', [invoice.id])).toEqual([
      { attempt: 1, status: 'REJECTED' },
      { attempt: 2, status: 'DELIVERED' },
    ])
  })

  it('practises "not deliverable": no courtesy copy is e-mailed for a simulated send, and it says why', async () => {
    await stepped()
    await as('PUT', `/invoicing/e-invoicing/settings/${c2()}`, { simulateOutcome: 'NOT_DELIVERABLE' })
    const invoice = await issuedInvoice(c2(), '130.00')
    await sendIt(invoice.id)
    await drain()
    expect((await invoiceOf(invoice.id)).status).toBe('NOT_DELIVERABLE')
    expect(await admin('SELECT id FROM "EmailOutbound" WHERE "recordId" = $1', [invoice.id])).toEqual([])
    const [missing] = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'invoices.sdiCourtesyCopyMissing'`, [invoice.id])
    expect(missing!.after.reason).toMatch(/^Test mode/)
    await stepped()
    await as('PUT', `/invoicing/e-invoicing/settings/${c2()}`, { simulateOutcome: 'DELIVERED' })
  })

  it('refuses going live while the intermediary is not chosen (Q21), without a step-up, and for a reader or a floor session', async () => {
    h.clock.advance(6 * 60_000)
    const noStepUp = await finance.send('PUT' as 'POST', `/invoicing/e-invoicing/settings/${c2()}`, { testMode: false })
    expect(noStepUp.status).toBe(403)
    await stepped()
    const refused = await finance.send('PUT' as 'POST', `/invoicing/e-invoicing/settings/${c2()}`, { testMode: false })
    expect(refused.status).toBe(409)
    expect(refused.body.error.issues[0].path).toBe('refusal/GO_LIVE')
    expect(refused.body.error.message).toContain('Q21')
    expect((await settingsOf(c2())).testMode).toBe(true)
    expect((await wall('reader', 'PUT', `/invoicing/e-invoicing/settings/${c2()}`, { testMode: false })).status).toBe(403)
    expect((await wall('reader', 'GET', '/invoicing/e-invoicing/settings')).status).toBe(200)
    expect((await wall('floor', 'GET', '/invoicing/e-invoicing/settings')).status).toBe(403)
    expect((await wall('companyOne', 'PUT', `/invoicing/e-invoicing/settings/${c2()}`, { testMode: false })).status).toBe(404)
  })

  it('goes live on the FAKE connection (step-up; when and who, audited) and back to test mode', async () => {
    await stepped()
    const live = (await as('PUT', `/invoicing/e-invoicing/settings/${c1()}`, { testMode: false })).company
    expect(live).toMatchObject({ testMode: false, liveSince: expect.any(String), liveSetById: expect.any(String), state: { code: 'LIVE', banner: null } })
    expect(await drain()).toContain('e_invoicing.settings_changed')
    const [audit] = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordType" = 'CompanyEInvoiceSettings' AND "recordId" = $1 ORDER BY at DESC LIMIT 1`, [c1()])
    expect(audit!.after).toMatchObject({ testMode: false, action: 'WENT_LIVE' })
    await stepped()
    const back = (await as('PUT', `/invoicing/e-invoicing/settings/${c1()}`, { testMode: true, version: live.version })).company
    expect(back).toMatchObject({ testMode: true, liveSince: null, liveSetById: null })
  })
})

describe('our own copy of every send (FIN-097): swap the intermediary without losing data', () => {
  it('copies a FAKE send with its XML and each notification as our own fiscal-archive file', async () => {
    const invoice = await issuedInvoice(c1(), '140.00')
    const sent = await sendIt(invoice.id)
    const submissionId = sent.sdi.sends.at(-1).id ?? (await admin<{ id: string }>('SELECT id FROM "SdiSubmission" WHERE "invoiceId" = $1', [invoice.id]))[0]!.id
    await drain()
    await pollSend(sdi, system(), submissionId)
    expect(await drain()).toEqual(expect.arrayContaining(['sdi_archive_copy.changed']))
    expect((await invoiceOf(invoice.id)).status).toBe('DELIVERED')
    const { sends } = await as('GET', `/invoicing/invoices/${invoice.id}/copies`)
    expect(sends).toMatchObject([{ copy: { state: 'COMPLETE' }, providerName: 'FAKE', xmlFileId: invoice.xmlFileId, notifications: 1, receipts: [{ type: 'RC' }] }])
    const receipt = await downloaded(sends[0].receipts[0].fileId)
    expect(receipt).toContain('<NotificaSdiRegistrata tipo="RC" fonte="FAKE">')
    const [file] = await admin<{ kind: string; recordType: string }>('SELECT kind::text, "recordType" FROM "StoredFile" WHERE id = $1', [sends[0].receipts[0].fileId])
    expect(file).toEqual({ kind: 'FISCAL_ARCHIVE', recordType: 'SdiNotification' })
  })

  it('says when a copy is missing, makes the missing ones, then the company may swap', async () => {
    const invoice = await issuedInvoice(c1(), '150.00')
    await sendIt(invoice.id)
    const [send] = await admin<{ id: string }>('SELECT id FROM "SdiSubmission" WHERE "invoiceId" = $1', [invoice.id])
    // The worker's copy handler is lost here: only the SDI handlers run.
    await drain([sdiArchiveHandler(() => sdi), sdiCourtesyCopyHandler()])
    await pollSend(sdi, system(), send!.id)
    await drain([sdiArchiveHandler(() => sdi), sdiCourtesyCopyHandler()])
    const before = await as('GET', `/invoicing/e-invoicing/copies?companyId=${c1()}`)
    expect(before.readiness).toMatchObject({ ready: false, missing: 1, open: 0 })
    expect(before.readiness.words).toContain('make the copies first')
    expect((await wall('reader', 'POST', `/invoicing/e-invoicing/copies/${c1()}/make`)).status).toBe(403)
    const made = await as('POST', `/invoicing/e-invoicing/copies/${c1()}/make`)
    expect(made).toMatchObject({ made: 1, remaining: 0, readiness: { ready: true, providers: ['FAKE'] } })
    const again = await as('POST', `/invoicing/e-invoicing/copies/${c1()}/make`)
    expect(again).toMatchObject({ made: 0, completed: 0 })
    expect((await admin<{ n: string }>(`SELECT count(*)::text AS n FROM "SdiArchiveCopy" WHERE "invoiceId" = $1`, [invoice.id]))[0]!.n).toBe('1')
  })
})

describe('self-invoices TD17-TD19 (FIN-095): listed with their deadline, issued only with the accountant’s switch', () => {
  const S: Json = {}

  it('registers the foreign suppliers’ invoices; lists them as candidates with the kind they suggest', async () => {
    const today = TODAY()
    S.de = (await as('POST', '/payables/invoices', { companyId: c1(), partyId: ids.supplierDe, source: 'MANUAL', number: 'R-2026-117', issueDate: today, currency: 'EUR', lines: [{ kind: 'SERVICE', description: 'Technische Beratung (fittizia)', netAmount: 80000, vatRatePct: '0', vatNature: 'N2.1' }, { kind: 'SERVICE', description: 'Reisekosten (fittizie)', netAmount: 20000, vatRatePct: '0', vatNature: 'N2.1' }] }, 201)).invoice
    S.us = (await as('POST', '/payables/invoices', { companyId: c1(), partyId: ids.supplierUs, source: 'MANUAL', number: 'INV-9001', issueDate: today, currency: 'USD', lines: [{ kind: 'SERVICE', description: 'Design consulting (made up)', netAmount: 50000, vatRatePct: '0', vatNature: 'N2.2' }] }, 201)).invoice
    const { candidates, waits } = await as('GET', `/invoicing/self-invoices/candidates?companyId=${c1()}`)
    expect(waits).toMatch(/^Waits for the accountant/)
    expect(candidates.find((row: Json) => row.supplierInvoiceId === S.de.id)).toMatchObject({ supplier: { country: 'DE' }, suggestion: { kind: 'TD17' }, deadlineState: { state: expect.stringMatching(/OPEN|DUE_SOON/) } })
  })

  it('makes a TD17 with its draft in euro at 22 %; refuses one without a euro rate, twice, or TD18 from outside the EU', async () => {
    const made = await as('POST', '/invoicing/self-invoices', { supplierInvoiceId: S.de.id, kind: 'TD17' }, 201)
    S.self = made.selfInvoice
    expect(S.self).toMatchObject({ status: 'PENDING', kind: 'TD17', kindWords: 'TD17 services from abroad', supplierInvoice: { number: 'R-2026-117' }, invoice: { docType: 'TD17', status: 'DRAFT' }, can: { cancel: true, issue: false } })
    expect(S.self.waits).toMatch(/^Waits for the accountant/)
    const draft = await invoiceOf(S.self.invoice.id)
    expect(draft).toMatchObject({ docType: 'TD17', currency: 'EUR', buyerPartyId: ids.supplierDe, netTotal: 100000, vatTotal: 22000 })
    expect(draft.lines.map((line: Json) => line.vatRatePct)).toEqual(['22.00', '22.00'])
    expect(await drain()).toEqual(expect.arrayContaining(['self_invoice.changed', 'invoice.draft_saved']))
    const noRate = await finance.post('/invoicing/self-invoices', { supplierInvoiceId: S.us.id, kind: 'TD17' })
    expect(noRate.status).toBe(409)
    expect(noRate.body.error.issues[0].path).toBe('refusal/NO_RATE')
    const twice = await finance.post('/invoicing/self-invoices', { supplierInvoiceId: S.de.id, kind: 'TD17' })
    expect(twice.status).toBe(409)
    expect(twice.body.error.message).toContain('has its self-invoice already')
    const notEu = await finance.post('/invoicing/self-invoices', { supplierInvoiceId: S.us.id, kind: 'TD18' })
    expect(notEu.status).toBe(409)
    expect(notEu.body.error.message).toContain('TD18 is for goods from another EU state')
  })

  it('keeps its draft from a plain delete; its issue waits for the switch (409 in words, no number)', async () => {
    const deleted = await finance.send('DELETE' as 'POST', `/invoicing/invoices/${S.self.invoice.id}`)
    expect(deleted.status).toBe(409)
    expect(deleted.body.error.message).toContain('cancel the self-invoice instead')
    const checks = await as('GET', `/invoicing/invoices/${S.self.invoice.id}/checks`)
    expect(checks.problems.map((problem: Json) => problem.code)).toContain('SELF_INVOICE_OFF')
    await stepped()
    const refused = await finance.post(`/invoicing/invoices/${S.self.invoice.id}/issue`, {})
    expect(refused.status).toBe(409)
    expect(refused.body.error.message).toMatch(/Waits for the accountant/)
    expect(await admin(`SELECT id FROM "NumberAllocation" WHERE "recordId" = $1`, [S.self.invoice.id])).toEqual([])
  })

  it('with the switch on (step-up): issued from the self-invoice series, the self-invoice ISSUED, the XML a valid TD17 with the supplier as cedente', async () => {
    await stepped()
    const on = (await as('PUT', `/invoicing/e-invoicing/settings/${c1()}/rules`, { selfInvoicesOn: true })).company
    expect(on.rules).toMatchObject({ selfInvoicesOn: true })
    await stepped()
    const issued = await as('POST', `/invoicing/invoices/${S.self.invoice.id}/issue`, {})
    expect(issued).toMatchObject({ invoice: { docType: 'TD17', status: 'ISSUED', number: expect.stringMatching(/^AF-\d{4}-\d{4}$/) }, filesPending: false })
    const self = (await as('GET', `/invoicing/self-invoices/${S.self.id}`)).selfInvoice
    expect(self).toMatchObject({ status: 'ISSUED', deadlineState: { state: 'DONE' }, can: { cancel: false } })
    expect(await drain()).toContain('self_invoice.changed')
    const xml = await downloaded(issued.invoice.xmlFileId)
    expect(xml).toContain('<TipoDocumento>TD17</TipoDocumento>')
    expect(xml).toMatch(/<CedentePrestatore>[\s\S]*<IdPaese>DE<\/IdPaese>[\s\S]*<RegimeFiscale>RF18<\/RegimeFiscale>[\s\S]*<\/CedentePrestatore>/)
    expect(xml).toMatch(/<DatiFattureCollegate>\s*<IdDocumento>R-2026-117<\/IdDocumento>/)
    expect(await xsdErrors(xml)).toEqual([])
    const cancelIssued = await finance.post(`/invoicing/self-invoices/${S.self.id}/cancel`, { version: self.version, reason: 'Errore di prova' })
    expect(cancelIssued.status).toBe(409)
    expect(cancelIssued.body.error.issues[0].path).toBe('refusal/SELF_INVOICE_ISSUED')
  })

  it('hides a self-invoice from a person without costs and from the supplier’s portal; it asks the supplier for no payment', async () => {
    const list = await wall('sales', 'GET', `/invoicing/invoices?docType=TD17&limit=50`)
    expect(list.status).toBe(200)
    expect(list.body.invoices).toEqual([])
    expect((await wall('sales', 'GET', `/invoicing/invoices/${S.self.invoice.id}`)).status).toBe(404)
    expect((await as('GET', `/invoicing/invoices?docType=TD17&limit=50`)).invoices.map((row: Json) => row.id)).toContain(S.self.invoice.id)
    expect((await invoiceOf(S.self.invoice.id)).openAmount).toBe(0)
    const portal = await h.database.withScope({ audience: 'partner', tenantId: tenant.id, actorId: newId(), partyId: ids.supplierDe }, (client) => readInvoices(client, c1()))
    expect(portal.map((row) => row.id)).not.toContain(S.self.invoice.id)
    expect((await wall('partner', 'GET', `/invoicing/self-invoices?companyId=${c1()}`)).status).toBe(403)
  })

  it('cancels a pending self-invoice with its draft (why, step by step), and lists the company’s self-invoices', async () => {
    const usd = await admin<{ id: string }>(`SELECT id FROM "ExchangeRate" WHERE base = 'EUR' AND quote = 'USD'`)
    if (usd.length === 0) {
      await admin(`INSERT INTO "ExchangeRate" (id, "tenantId", base, quote, "rateDate", rate, source, "overriddenById", key) VALUES ($1, $2, 'EUR', 'USD', $3::date, 1.25, 'MANUAL', $4, $5)`, [newId(), tenant.id, TODAY(), newId(), `EUR:USD:${TODAY()}:MANUAL`])
    }
    const usSelf = (await as('POST', '/invoicing/self-invoices', { supplierInvoiceId: S.us.id, kind: 'TD17', vatRatePct: '22' }, 201)).selfInvoice
    expect((await invoiceOf(usSelf.invoice.id))).toMatchObject({ currency: 'EUR', netTotal: 40000 })
    const short = await finance.post(`/invoicing/self-invoices/${usSelf.id}/cancel`, { version: usSelf.version, reason: 'x' })
    expect(short.status).toBe(400)
    const cancelled = (await as('POST', `/invoicing/self-invoices/${usSelf.id}/cancel`, { version: usSelf.version, reason: 'Fattura registrata due volte (prova)' })).selfInvoice
    expect(cancelled).toMatchObject({ status: 'CANCELLED', invoice: null, cancelReason: 'Fattura registrata due volte (prova)' })
    expect(await admin('SELECT id FROM "Invoice" WHERE id = $1', [usSelf.invoice.id])).toEqual([])
    const { selfInvoices } = await as('GET', `/invoicing/self-invoices?companyId=${c1()}`)
    expect(selfInvoices.map((row: Json) => row.status).sort()).toEqual(['CANCELLED', 'ISSUED'])
    expect((await as('GET', `/invoicing/self-invoices/candidates?companyId=${c1()}`)).candidates.map((row: Json) => row.supplierInvoiceId)).toEqual([S.us.id])
  })
})

describe('the debit note TD05 (FIN-071) and the VAT time limit on decreases (FIN-073)', () => {
  const D: Json = {}

  it('drafts a debit note of an issued invoice; refuses one on a draft or a credit note', async () => {
    D.invoice = await issuedInvoice(c2(), '200.00')
    const note = (await as('POST', `/invoicing/invoices/${D.invoice.id}/debit-note`, { causale: 'trasporto concordato dopo', lines: [{ kind: 'CHARGE', chargeKind: 'FREIGHT', description: 'Trasporto aggiuntivo', quantity: '1', unitPrice: '40.00' }] }, 201)).invoice
    expect(note).toMatchObject({ docType: 'TD05', status: 'DRAFT', buyerPartyId: ids.customer, netTotal: 4000 })
    expect(note.causale).toContain(`integrazione della fattura n. ${D.invoice.number}`)
    D.note = note
    const listed = await as('GET', `/invoicing/invoices/${D.invoice.id}/debit-notes`)
    expect(listed).toMatchObject({ debitable: { ok: true }, debitNotes: [{ id: note.id, status: 'DRAFT' }] })
    expect(listed.waits).toMatch(/^Waits for the accountant/)
    const onDraft = await finance.post(`/invoicing/invoices/${note.id}/debit-note`, { lines: [{ description: 'x', quantity: '1', unitPrice: '1.00' }] })
    expect(onDraft.status).toBe(409)
    expect(onDraft.body.error.issues[0].path).toBe('refusal/DEBIT_NOTE')
  })

  it('waits for the switch at the issue; issued with it on, its XML a valid TD05 naming the invoice', async () => {
    const checks = await as('GET', `/invoicing/invoices/${D.note.id}/checks`)
    expect(checks.problems.map((problem: Json) => problem.code)).toEqual(['DEBIT_NOTE_OFF'])
    await stepped()
    const refused = await finance.post(`/invoicing/invoices/${D.note.id}/issue`, {})
    expect(refused.status).toBe(409)
    await stepped()
    await as('PUT', `/invoicing/e-invoicing/settings/${c2()}/rules`, { selfInvoicesOn: true })
    await stepped()
    const issued = await as('POST', `/invoicing/invoices/${D.note.id}/issue`, {})
    expect(issued.invoice).toMatchObject({ docType: 'TD05', status: 'ISSUED', number: expect.stringMatching(/^FT-/) })
    const xml = await downloaded(issued.invoice.xmlFileId)
    expect(xml).toContain('<TipoDocumento>TD05</TipoDocumento>')
    expect(xml).toContain(`<IdDocumento>${D.invoice.number}</IdDocumento>`)
    expect(await xsdErrors(xml)).toEqual([])
    // A debit note goes to SDI as any invoice (C2 in test mode: simulated, delivered).
    await sendIt(issued.invoice.id)
    await drain()
    expect((await invoiceOf(issued.invoice.id)).status).toBe('DELIVERED')
  })

  it('judges the VAT time limit of a decrease: within the year for an agreed one, none for a return, waits while the switch is off', async () => {
    const within = await as('GET', `/invoicing/invoices/${D.invoice.id}/vat-time-limit?reason=PRICE_REDUCTION`)
    expect(within).toMatchObject({ operationDate: TODAY(), verdict: { state: 'WITHIN', limitDate: `${Number(TODAY().slice(0, 4)) + 1}${TODAY().slice(4)}`.replace(/-02-29$/, '-02-28') }, rule: { status: 'UNVERIFIED' } })
    expect((await as('GET', `/invoicing/invoices/${D.invoice.id}/vat-time-limit?reason=RETURN`)).verdict.state).toBe('NO_LIMIT')
    await stepped()
    await as('PUT', `/invoicing/e-invoicing/settings/${c2()}/rules`, { selfInvoicesOn: false })
    const off = await as('GET', `/invoicing/invoices/${D.invoice.id}/vat-time-limit?reason=PRICE_REDUCTION`)
    expect(off.verdict).toMatchObject({ state: 'WAITS', limitDate: null, words: expect.stringMatching(/^Waits for the accountant/) })
    expect((await finance.get(`/invoicing/invoices/${D.invoice.id}/vat-time-limit?reason=NOPE`)).status).toBe(400)
  })
})
