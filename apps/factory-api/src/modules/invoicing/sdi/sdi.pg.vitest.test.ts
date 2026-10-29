import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { validateXML } from 'xmllint-wasm'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { resendDeadline } from '@nexus/factory-domain/invoicing/sdi/deadline'
import { FakeSdi } from '../../../adapters/sdi/fake'
import { textOf } from '../../../adapters/ses/fake'
import { buildApp } from '../../../core/app'
import { callerFor, command } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { addTenant, addUser, Browser, enrolTotp, movableClock, startHarness, stepUp, type Harness, type MovableClock, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { emailSendHandler } from '../../../platform/email-out/outbound'
import { createGateway } from '../../../platform/gateway/gateway'
import { inboundHandler } from '../../../platform/inbound/process'
import { useInbound } from '../../../platform/inbound/providers'
import { fakeSignatureHeaders } from '../../../platform/inbound/verifiers'
import type { EventHandler } from '../../../platform/outbox/dispatch'
import { systemContext } from '../../../platform/outbox/system'
import { SECRET_PURPOSES, storeSecret } from '../../../platform/secrets/store'
import { sdiArchiveHandler } from './archive'
import { sdiCourtesyCopyHandler } from './copy'
import { runSdiPoll, sdiPollHandler } from './poll'
import { createSdiRuntime, useSdi, type SdiRuntime } from './runtime'

/**
 * The SDI provider adapter (B-W1-50; FIN-084, FIN-086, FIN-087, FIN-088, FIN-092) on the local stack: a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security, the grants and the …_money_guards
 * triggers are real), the real app with the real office sign-in (finance steps up to send), the FAKE SDI intermediary
 * behind the real gateway (Redis limits, retries, timeouts, one IntegrationCall row per call), its webhooks posted to
 * the real inbound route with the fake signature, and the worker emulated by running the handlers on the outbox's new
 * events. Every company, customer, VAT number and amount is made up. Run with `node scripts/factory/run-pg-tests.mjs sdi`.
 */

let h: Harness
let tenant: TestTenant
let tenantB: TestTenant
let walls: FastifyInstance
let finance: Browser
let financeSecret: string
let fake: FakeSdi
let sdi: SdiRuntime
let sdiClock: MovableClock
let sdiAccount: string
let sdiAccountB: string

const WEBHOOK_SECRET = 'whsec-made-up-for-the-sdi-tests-0001'
const YEAR = businessDate(new Date()).slice(0, 4)
const FAKE_VAT = { company: '12345670009', customer: '76543210009', quiet: '11122230003' } as const
const ids = { customer: newId(), quietCustomer: newId(), noContactCustomer: newId() }
const c1 = () => tenant.companies[0]!.id
const c2 = () => tenant.companies[1]!.id

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]

async function as(browser: Browser, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await browser.send(method as 'POST', url, method === 'GET' ? undefined : (body ?? {}))
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants })
const READ: Permission[] = ['invoices.view', 'money.price']
const SESSIONS: Record<string, () => SessionContext> = {
  reader: () => office(tenant.id, [grant(READ)]),
  companyTwo: () => office(tenant.id, [grant([...READ, 'invoices.issue'], [c2()])]),
  otherTenant: () => office(tenantB.id, [grant([...READ, 'invoices.issue'])]),
  floor: () => ({ audience: 'floor', tenantId: tenant.id, actorId: newId(), siteId: newId(), deviceId: newId(), grants: [grant([...READ, 'invoices.issue'])] }),
  partner: () => ({ audience: 'partner', tenantId: tenant.id, actorId: newId(), partyId: ids.customer, grants: [grant(READ)] }),
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
  const presigned = await as(finance, 'GET', `/files/${fileId}/download`)
  const fetched = await h.app.inject({ method: 'GET', url: presigned.download.url })
  expect(fetched.statusCode).toBe(200)
  return fetched.rawPayload.toString('utf8')
}

async function addCustomer(id: string, code: string, vatNumber: string, contactEmail: string | null) {
  await admin(`INSERT INTO "Party" (id, "tenantId", "companyId", code, kind, "legalName", roles, status, country) VALUES ($1, $2, $3, $4, 'ORGANISATION', $5, '{CUSTOMER}', 'ACTIVE', 'IT')`, [id, tenant.id, c1(), code, `Cliente Fittizio ${code} S.r.l.`])
  await admin(`INSERT INTO "PartyTaxIdentity" (id, "tenantId", "partyId", country, "taxMode", "vatNumber", "sdiRecipientCode", "validFrom") VALUES ($1, $2, $3, 'IT', 'IT_B2B', $4, 'FAKE001', '2026-01-01')`, [newId(), tenant.id, id, `IT${vatNumber}`])
  await admin(
    `INSERT INTO "PartyAddress" (id, "tenantId", "partyId", kinds, line1, "postalCode", city, province, country, "isDefaultBillTo", "isDefaultShipTo") VALUES ($1, $2, $3, '{REGISTERED,BILL_TO,SHIP_TO}', 'Viale delle Prove 42', '40121', 'Bologna', 'BO', 'IT', true, true)`,
    [newId(), tenant.id, id],
  )
  if (contactEmail) await admin(`INSERT INTO "PartyContact" (id, "tenantId", "partyId", name, email, roles) VALUES ($1, $2, $3, 'Ufficio Fatture Fittizio', $4, '{INVOICES}')`, [newId(), tenant.id, id, contactEmail])
}

/** An SDI account (FAKE) of a company, with the webhook secret its fake signs with. */
async function addSdiAccount(t: TestTenant, companyId: string): Promise<string> {
  const id = newId()
  await command(callerFor(h.database, { audience: 'office', tenantId: t.id, actorId: newId(), grants: [], requestId: newId() }), { name: 'integration.createAccount', input: { id } }, async (tools) => {
    const webhook = await storeSecret(tools, h.secrets, { purpose: SECRET_PURPOSES.webhook, plaintext: WEBHOOK_SECRET })
    await tools.tx.integrationAccount.create({
      data: { id, companyId, provider: 'SDI', code: `sdi-${id.slice(-8)}`, label: 'SDI (fake)', mode: 'FAKE', webhookSecretId: webhook.id, rateLimitPerMinute: 6000, rateLimitBurst: 1000, callTimeoutMs: 400, circuitFailureThreshold: 1000 },
      select: { id: true },
    })
    tools.audit({ recordType: 'IntegrationAccount', recordId: id })
    return { id }
  })
  return id
}

// ---- the worker, emulated: the handlers run on the outbox's new events, until none is left ---------------------------

const seen = new Set<string>()
let handlers: EventHandler[] = []
async function drain(): Promise<void> {
  for (let round = 0; round < 10; round++) {
    const rows = await admin<{ id: string; type: string; version: number; payload: unknown; tenantId: string; companyId: string | null }>(`SELECT id, type, version, payload, "tenantId", "companyId" FROM "OutboxEvent" ORDER BY "occurredAt", id`)
    const fresh = rows.filter((row) => !seen.has(row.id))
    if (fresh.length === 0) return
    for (const row of fresh) {
      seen.add(row.id)
      for (const handler of handlers.filter((entry) => entry.events.includes(row.type))) {
        await handler.handle({ eventId: row.id, type: row.type, version: row.version, tenantId: row.tenantId, companyId: row.companyId, payload: row.payload } as never, { caller: callerFor(h.database, systemContext(row.tenantId, newId())), attempt: 1 })
      }
    }
  }
}

/** Posts the fake intermediary's due webhooks to the inbound route (signed as it signs them), then lets the worker run. */
async function webhooks(options: { readonly all?: boolean } = {}): Promise<Json[]> {
  const answers: Json[] = []
  for (const delivery of fake.takeWebhooks(options)) answers.push(await postWebhook(delivery.body, delivery.eventId, delivery.tenantId, delivery.accountId))
  await drain()
  return answers
}
async function postWebhook(body: string, eventId: string, tenantId = tenant.id, accountId = sdiAccount): Promise<Json> {
  const response = await h.app.inject({ method: 'POST', url: `/inbound/sdi/${tenantId}/${accountId}`, payload: body, headers: { 'content-type': 'application/json', ...fakeSignatureHeaders(WEBHOOK_SECRET, body, new Date(), { id: eventId }) } })
  return { statusCode: response.statusCode, ...(response.json() as Json) }
}

// ---- invoices --------------------------------------------------------------------------------------------------------

async function issued(options: { buyer?: string; causale?: string; lines?: unknown[] } = {}): Promise<Json> {
  const draft = (
    await as(
      finance,
      'POST',
      '/invoicing/invoices',
      {
        companyId: c1(),
        buyerPartyId: options.buyer ?? ids.customer,
        docType: 'TD01',
        causale: options.causale ?? 'Campionario',
        payment: { method: 'MP05', dueDate: '2026-12-31' },
        lines: options.lines ?? [{ description: 'Giacca moto in pelle, nero, 50', itemCode: 'JKT-1-BLK-50', quantity: '2', uom: 'PZ', unitPrice: '305.00' }],
      },
      201,
    )
  ).invoice
  await stepUp(h, finance, financeSecret)
  const answer = await as(finance, 'POST', `/invoicing/invoices/${draft.id}/issue`, {})
  expect(answer.invoice.status).toBe('ISSUED')
  return answer.invoice
}

const send = async (invoiceId: string, status = 200): Promise<Json> => {
  await stepUp(h, finance, financeSecret)
  return as(finance, 'POST', `/invoicing/invoices/${invoiceId}/sdi/send`, {}, status)
}
const sdiOf = async (invoiceId: string): Promise<Json> => (await as(finance, 'GET', `/invoicing/invoices/${invoiceId}/sdi`)).sdi
/** A clock `minutes` after the fake intermediary's (its times are the sends' times). */
const later = (minutes: number) => ({ now: () => new Date(Math.max(Date.now(), sdiClock.now().getTime()) + minutes * 60_000) })
/** SDI's answer comes `answerAfterMs` after the send: move the fake's clock past it. */
const sdiAnswers = () => sdiClock.advance(61_000)

beforeAll(async () => {
  h = await startHarness('sdi')
  tenant = await addTenant(h, 'sdi-a', 2)
  tenantB = await addTenant(h, 'sdi-b')
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
  // The company's conversation address (the courtesy copy goes out from it), on the tenant's FAKE SES account.
  await h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: newId() }, async (client) => {
    const ses = await client.integrationAccount.findFirstOrThrow({ where: { provider: 'SES' }, select: { id: true } })
    await client.emailIdentity.create({
      data: { id: newId(), companyId: c1(), kind: 'CONVERSATION', domain: 'post.sdi-a.example.com', fromAddress: 'ufficio@post.sdi-a.example.com', displayName: 'Test company C1', replyDomain: 'reply.sdi-a.example.com', accountId: ses.id, verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS', isDefault: true },
    })
  })
  sdiAccount = await addSdiAccount(tenant, c1())
  sdiAccountB = await addSdiAccount(tenantB, tenantB.companies[0]!.id)
  await addCustomer(ids.customer, 'C-IT', FAKE_VAT.customer, 'fatture@cliente-fittizio.example.com')
  await addCustomer(ids.noContactCustomer, 'C-NC', FAKE_VAT.quiet, null)

  sdiClock = movableClock(new Date())
  fake = new FakeSdi({ clock: sdiClock, answerAfterMs: 60_000 })
  const gateway = createGateway({ environment: 'test', redis: h.redis, prefix: h.redisPrefix, secrets: h.secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  sdi = createSdiRuntime({ gateway, fake })
  useSdi(sdi)
  useInbound({ environment: 'test', secrets: h.secrets })
  handlers = [inboundHandler(), sdiPollHandler(() => sdi), sdiArchiveHandler(() => sdi), sdiCourtesyCopyHandler(), emailSendHandler(() => h.email)]

  const user = await addUser(h, tenant, { email: 'fiona.finance@sdi-a.example.com', role: 'finance' })
  finance = new Browser(h.app)
  await finance.signIn('sdi-a', user.email, user.password)
  financeSecret = await enrolTotp(h, finance)

  walls = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
}, 180_000)

afterAll(async () => {
  useSdi(undefined)
  useInbound(undefined)
  await walls?.close()
  await h?.close()
}, 60_000)

beforeEach(async () => {
  // Events of the set-up and of earlier tests are not the worker's business here.
  for (const row of await admin<{ id: string }>('SELECT id FROM "OutboxEvent"')) seen.add(row.id)
})

describe('send → RC → DELIVERED, archived (FIN-084, FIN-086, FIN-092; D.Lgs. 127/2015)', () => {
  it('needs a fresh step-up and the invoice issued; sends the issued XML once, SENT with the provider’s id', async () => {
    const draft = (await as(finance, 'POST', '/invoicing/invoices', { companyId: c1(), buyerPartyId: ids.customer, docType: 'TD01', lines: [{ description: 'Giacca', quantity: '1', unitPrice: '100' }] }, 201)).invoice
    await stepUp(h, finance, financeSecret)
    const refused = await finance.post(`/invoicing/invoices/${draft.id}/sdi/send`, {})
    expect(refused.status).toBe(409)
    expect(refused.body.error.message).toContain('draft')

    const invoice = await issued()
    h.clock.advance(6 * 60_000)
    const noStepUp = await finance.post(`/invoicing/invoices/${invoice.id}/sdi/send`, {})
    expect(noStepUp.status).toBe(403)
    expect(noStepUp.body.error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])
    expect(await admin('SELECT id FROM "SdiSubmission" WHERE "invoiceId" = $1', [invoice.id])).toEqual([])

    const { sdi: status } = await send(invoice.id)
    const [xml] = await admin<{ originalName: string }>('SELECT "originalName" FROM "StoredFile" WHERE id = $1', [invoice.xmlFileId])
    expect(status).toMatchObject({ invoiceStatus: 'SENT', state: { code: 'AT_SDI', next: { action: 'WAIT' } }, canSend: false })
    expect(status.sends).toMatchObject([{ attempt: 1, status: 'SENT', fileName: xml!.originalName, sentAt: expect.any(String), notifications: [] }])
    const [row] = await admin('SELECT status, "providerRef", "xmlFileId", "integrationAccountId" FROM "SdiSubmission" WHERE "invoiceId" = $1', [invoice.id])
    expect(row).toMatchObject({ status: 'SENT', providerRef: expect.stringMatching(/^fake-sdi-/), xmlFileId: invoice.xmlFileId, integrationAccountId: sdiAccount })
    const calls = await admin('SELECT operation, status, attempts, "idempotencyKey" FROM "IntegrationCall" WHERE "accountId" = $1 AND operation = $2', [sdiAccount, 'sdi.send_invoice'])
    expect(calls).toEqual([{ operation: 'sdi.send_invoice', status: 'SUCCEEDED', attempts: 1, idempotencyKey: status.sends[0].id }])
  })

  it('SDI’s RC by webhook makes it DELIVERED; the worker archives the delivered file once (conservazione)', async () => {
    const invoice = await issued()
    await send(invoice.id)
    expect(await webhooks()).toEqual([]) // SDI has not answered yet
    sdiAnswers()
    const posted = await webhooks()
    expect(posted.length).toBeGreaterThanOrEqual(1)
    expect(posted.every((answer) => answer.statusCode === 200 && answer.status === 'received')).toBe(true)
    const status = await sdiOf(invoice.id)
    expect(status).toMatchObject({ invoiceStatus: 'DELIVERED', state: { code: 'DELIVERED', next: { action: 'NONE' } } })
    expect(status.sends[0]).toMatchObject({ status: 'DELIVERED', sdiIdentifier: expect.any(String), outcomeAt: expect.any(String), notifications: [{ type: 'RC', source: 'webhook' }] })
    expect(status.archive).toMatchObject({ submissionId: status.sends[0].id, archiveRef: expect.stringMatching(/^fake-archive-/) })
    expect(fake.archives.filter((entry) => entry.fileName === status.sends[0].fileName)).toHaveLength(1)
    const receipts = await admin(`SELECT status FROM "InboundWebhook" WHERE "accountId" = $1 AND status <> 'PROCESSED'`, [sdiAccount])
    expect(receipts).toEqual([])
    expect((await admin<{ status: string }>('SELECT status FROM "Invoice" WHERE id = $1', [invoice.id]))[0]!.status).toBe('DELIVERED')
  })
})

describe('NS → REJECTED → corrected and sent again under the same number and date (FIN-087; Provv. AdE 89757/2018)', () => {
  it('shows the deadline and SDI’s error in words; the corrected file goes out with a new name; RC → DELIVERED', async () => {
    const invoice = await issued({ lines: [{ description: 'Giacca moto in pelle, nero, 50', quantity: '2', unitPrice: '305.00' }] })
    fake.scriptNext({ kind: 'NS', code: '00423' })
    await send(invoice.id)
    sdiAnswers()
    await webhooks()
    const rejected = await sdiOf(invoice.id)
    const [ns] = await admin<{ receivedAt: Date }>(`SELECT "receivedAt" FROM "SdiNotification" WHERE "invoiceId" = $1 AND type = 'NS'`, [invoice.id])
    expect(rejected).toMatchObject({
      invoiceStatus: 'REJECTED',
      canSend: true,
      state: { code: 'REJECTED', next: { action: 'FIX_AND_RESEND' } },
      deadline: { deadline: resendDeadline(ns!.receivedAt), overdue: false },
      resend: { ready: true, problems: [] },
    })
    expect(rejected.state.explanation).toContain('counts as never issued')
    expect(rejected.state.explanation).toContain(`by ${rejected.deadline.deadline}`)
    expect(rejected.sends[0].notifications[0].errors).toEqual([expect.objectContaining({ code: '00423', fix: 'lines', known: true })])

    // An issued file never changes outside REJECTED; this one is corrected: a line and the text.
    await stepUp(h, finance, financeSecret)
    const corrected = await as(finance, 'PUT', `/invoicing/invoices/${invoice.id}/sdi/correction`, { version: rejected.version, causale: 'Campionario (corretto)', lines: [{ description: 'Giacca moto in pelle, nero, 50 (corretta)', quantity: '2', unitPrice: '300.00' }] })
    expect(corrected.resend).toEqual({ ready: true, problems: [] })
    expect(corrected.invoice).toMatchObject({ status: 'REJECTED', number: invoice.number, issueDate: invoice.issueDate, netTotal: 60000, causale: 'Campionario (corretto)', lines: [{ description: 'Giacca moto in pelle, nero, 50 (corretta)' }] })

    const { sdi: resent } = await send(invoice.id)
    expect(resent).toMatchObject({ invoiceStatus: 'SENT', sends: [{ attempt: 1, status: 'REJECTED' }, { attempt: 2, status: 'SENT' }] })
    expect(resent.sends[1].fileName).not.toBe(resent.sends[0].fileName)
    const [after] = await admin<{ number: string; issueDate: string; xmlFileId: string; pdfFileId: string }>('SELECT number, "issueDate"::text AS "issueDate", "xmlFileId", "pdfFileId" FROM "Invoice" WHERE id = $1', [invoice.id])
    expect(after!.number).toBe(invoice.number)
    expect(after!.issueDate).toBe(invoice.issueDate)
    expect(after!.xmlFileId).not.toBe(invoice.xmlFileId)
    const sends = await admin<{ attempt: number; xmlFileId: string; fileName: string }>('SELECT attempt, "xmlFileId", "fileName" FROM "SdiSubmission" WHERE "invoiceId" = $1 ORDER BY attempt', [invoice.id])
    expect(sends.map((row) => row.xmlFileId)).toEqual([invoice.xmlFileId, after!.xmlFileId])
    const xml = await downloaded(after!.xmlFileId)
    expect(await xsdErrors(xml)).toEqual([])
    expect(xml).toContain(`<Numero>${invoice.number}</Numero>`)
    expect(xml).toContain(`<Data>${invoice.issueDate}</Data>`)
    expect(xml).toContain('(corretta)')
    expect(xml).toContain(`<ProgressivoInvio>${/_([A-Za-z0-9]+)\.xml$/.exec(sends[1]!.fileName)![1]}</ProgressivoInvio>`)
    // The rejected XML is kept (FISCAL_ARCHIVE, ten years) beside the corrected one.
    expect(await admin(`SELECT kind FROM "StoredFile" WHERE id = $1`, [invoice.xmlFileId])).toEqual([{ kind: 'FISCAL_ARCHIVE' }])

    sdiAnswers()
    await webhooks()
    const delivered = await sdiOf(invoice.id)
    expect(delivered).toMatchObject({ invoiceStatus: 'DELIVERED', sends: [{ status: 'REJECTED' }, { status: 'DELIVERED' }], deadline: null })
  })

  it('a correction is refused outside REJECTED, and while a send is on its way', async () => {
    const invoice = await issued()
    await stepUp(h, finance, financeSecret)
    const answer = await finance.send('PUT' as 'POST', `/invoicing/invoices/${invoice.id}/sdi/correction`, { causale: 'x' })
    expect(answer.status).toBe(409)
    expect(answer.body.error.code).toBe('invalid_state')
  })
})

describe('MC → NOT_DELIVERABLE: the customer gets a copy and is told (FIN-088; Provv. AdE 89757/2018)', () => {
  it('records the MC, shares the PDF with the customer and e-mails the copy once', async () => {
    const invoice = await issued()
    fake.scriptNext({ kind: 'MC' })
    await send(invoice.id)
    sdiAnswers()
    await webhooks()
    const status = await sdiOf(invoice.id)
    expect(status).toMatchObject({ invoiceStatus: 'NOT_DELIVERABLE', state: { code: 'NOT_DELIVERED', next: { action: 'NONE' } }, courtesyCopies: { queued: [{ status: expect.any(String) }], missing: null } })
    expect(status.state.explanation).toContain('tax drawer')
    const mails = await admin<{ id: string; to: string[]; subject: string; status: string }>(`SELECT id, "to", subject, status FROM "EmailOutbound" WHERE "recordType" = 'Invoice' AND "recordId" = $1`, [invoice.id])
    expect(mails).toEqual([{ id: status.courtesyCopies.queued[0].emailId, to: ['fatture@cliente-fittizio.example.com'], subject: expect.stringContaining(invoice.number), status: 'SENT' }])
    const sent = h.ses.mails.find((mail) => mail.outboundId === mails[0]!.id)!
    expect(textOf(sent.raw)).toContain('Fatture e Corrispettivi')
    expect(sent.raw).toContain('application/pdf')
    const [pdf] = await admin<{ visibility: string[]; partyId: string }>('SELECT visibility::text[] AS visibility, "partyId" FROM "StoredFile" WHERE id = $1', [invoice.pdfFileId])
    expect(pdf).toMatchObject({ visibility: expect.arrayContaining(['OFFICE', 'PARTNER']), partyId: ids.customer })
    // The worker handling the same event again sends nothing twice.
    const event = (await admin<{ id: string; payload: Json }>(`SELECT id, payload FROM "OutboxEvent" WHERE type = 'invoice.sdi_status_changed' AND payload->>'invoiceId' = $1 AND payload->>'invoiceStatus' = 'NOT_DELIVERABLE'`, [invoice.id]))[0]!
    await sdiCourtesyCopyHandler().handle({ eventId: event.id, type: 'invoice.sdi_status_changed', version: 1, tenantId: tenant.id, payload: event.payload } as never, { caller: callerFor(h.database, systemContext(tenant.id, newId())), attempt: 2 })
    expect(await admin(`SELECT id FROM "EmailOutbound" WHERE "recordType" = 'Invoice' AND "recordId" = $1`, [invoice.id])).toHaveLength(1)
  })

  it('a customer without an invoices contact: the copy is missing, said, and a person sends it', async () => {
    const invoice = await issued({ buyer: ids.noContactCustomer })
    fake.scriptNext({ kind: 'MC' })
    await send(invoice.id)
    sdiAnswers()
    await webhooks()
    const status = await sdiOf(invoice.id)
    expect(status).toMatchObject({ invoiceStatus: 'NOT_DELIVERABLE', state: { next: { action: 'CHECK_COPY' } }, courtesyCopies: { queued: [], missing: expect.stringContaining('no active contact') } })
    expect(await admin(`SELECT type FROM "OutboxEvent" WHERE type = 'invoice.courtesy_copy_missing' AND subject = $1`, [invoice.id])).toHaveLength(1)
  })
})

describe('webhooks in any order and any number of times; the poll catches a lost one (FIN-086)', () => {
  it('a webhook delivered twice, and the provider’s retry under a new delivery id, leave ONE notification', async () => {
    const invoice = await issued()
    const { sdi: sent } = await send(invoice.id)
    sdiAnswers()
    const [delivery] = fake.takeWebhooks()
    expect((await postWebhook(delivery!.body, delivery!.eventId)).status).toBe('received')
    expect((await postWebhook(delivery!.body, delivery!.eventId)).status).toBe('duplicate')
    expect((await postWebhook(delivery!.body, `${delivery!.eventId}-provider-retry`)).status).toBe('received')
    await drain()
    expect(await admin('SELECT type FROM "SdiNotification" WHERE "submissionId" = $1', [sent.sends[0].id])).toEqual([{ type: 'RC' }])
    const receipts = await admin<{ status: string }>(`SELECT status FROM "InboundWebhook" WHERE "accountId" = $1 AND "dedupeKey" LIKE $2`, [sdiAccount, `${delivery!.eventId}%`])
    expect(receipts.map((row) => row.status)).toEqual(['PROCESSED', 'PROCESSED'])
    expect((await sdiOf(invoice.id)).invoiceStatus).toBe('DELIVERED')
  })

  it('a lost webhook: the scheduler’s poll asks the provider and records SDI’s answer; the late webhook adds nothing', async () => {
    const invoice = await issued()
    const { sdi: sent } = await send(invoice.id)
    sdiAnswers()
    expect(await runSdiPoll({ database: h.database, log: { info() {}, warn() {}, error() {} } })).toMatchObject({ due: 0 }) // too early: 15 minutes
    const run = await runSdiPoll({ database: h.database, log: { info() {}, warn() {}, error() {} }, clock: later(20) })
    expect(run.due).toBeGreaterThanOrEqual(1)
    expect(await admin(`SELECT id FROM "OutboxEvent" WHERE type = 'invoice.sdi_poll_due' AND payload->>'submissionId' = $1`, [sent.sends[0].id])).toHaveLength(1)
    await drain()
    const polled = await sdiOf(invoice.id)
    expect(polled).toMatchObject({ invoiceStatus: 'DELIVERED', sends: [{ status: 'DELIVERED', notifications: [{ type: 'RC', source: 'poll' }] }] })
    await webhooks()
    expect(await admin('SELECT id FROM "SdiNotification" WHERE "submissionId" = $1', [sent.sends[0].id])).toHaveLength(1)
  })

  it('a notification that contradicts the recorded outcome is kept and reported, never applied', async () => {
    const invoice = await issued()
    const { sdi: sent } = await send(invoice.id)
    sdiAnswers()
    await webhooks()
    const [row] = await admin<{ providerRef: string }>('SELECT "providerRef" FROM "SdiSubmission" WHERE id = $1', [sent.sends[0].id])
    fake.addMessage(row!.providerRef, 'NS', { code: '00404' })
    await webhooks()
    const status = await sdiOf(invoice.id)
    expect(status).toMatchObject({ invoiceStatus: 'DELIVERED', sends: [{ status: 'DELIVERED', notifications: [{ type: 'RC' }, { type: 'NS' }] }] })
    const reported = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = 'invoice.sdi_notification_received' AND subject = $1 ORDER BY "occurredAt"`, [invoice.id])
    expect(reported.map((event) => [event.payload.type, event.payload.conflict])).toEqual([
      ['RC', false],
      ['NS', true],
    ])
  })

  it('a webhook signed for another tenant’s URL is not stored; a FAKE delivery with a bad signature is REJECTED', async () => {
    const body = JSON.stringify({ fake: 'sdi', messages: [] })
    const crossed = await h.app.inject({ method: 'POST', url: `/inbound/sdi/${tenantB.id}/${sdiAccount}`, payload: body, headers: { 'content-type': 'application/json', ...fakeSignatureHeaders(WEBHOOK_SECRET, body, new Date(), { id: `evt-${newId()}` }) } })
    expect(crossed.statusCode).toBe(404)
    const forged = await h.app.inject({ method: 'POST', url: `/inbound/sdi/${tenantB.id}/${sdiAccountB}`, payload: body, headers: { 'content-type': 'application/json', ...fakeSignatureHeaders('not-the-secret', body, new Date(), { id: `evt-${newId()}` }) } })
    expect(forged.statusCode).toBe(401)
  })
})

describe('send errors retry; no answer is ERROR "it may have reached SDI" (A1 §4)', () => {
  it('an intermediary that keeps failing: three tries, FAILED with why, the invoice in ERROR; sent again once it answers', async () => {
    const invoice = await issued()
    fake.scriptNext({ kind: 'SEND_ERROR' })
    const { sdi: failed } = await send(invoice.id)
    expect(failed).toMatchObject({ invoiceStatus: 'ERROR', canSend: true, sends: [{ status: 'FAILED', failure: { code: 'NO_ANSWER', uncertain: true } }] })
    expect(failed.sends[0].failure.words).toContain('may have reached SDI')
    expect(failed.sends[0].failure.words).toContain('503')
    expect(fake.attempts.filter((attempt) => attempt.idempotencyKey === failed.sends[0].id).map((attempt) => attempt.attempt)).toEqual([1, 2, 3])
    expect(await admin('SELECT status, attempts FROM "IntegrationCall" WHERE "idempotencyKey" = $1', [failed.sends[0].id])).toEqual([{ status: 'FAILED', attempts: 3 }])

    // Sent again: the intermediary is asked first (it never got the file), then a new send with its own name.
    const { sdi: again } = await send(invoice.id)
    expect(again).toMatchObject({ invoiceStatus: 'SENT', sends: [{ attempt: 1, status: 'FAILED' }, { attempt: 2, status: 'SENT' }] })
    expect(again.sends[1].fileName).not.toBe(again.sends[0].fileName)
    expect(await admin('SELECT operation FROM "IntegrationCall" WHERE "idempotencyKey" = $1 AND operation = $2', [failed.sends[0].id, 'sdi.get_status'])).toHaveLength(1)
    sdiAnswers()
    await webhooks()
    expect((await sdiOf(invoice.id)).invoiceStatus).toBe('DELIVERED')
  })

  it('a timeout: ERROR, the file may have reached SDI; a resend is refused while the intermediary has it; the poll records the outcome', async () => {
    const invoice = await issued()
    fake.scriptNext({ kind: 'TIMEOUT' })
    const { sdi: timedOut } = await send(invoice.id)
    expect(timedOut).toMatchObject({ invoiceStatus: 'ERROR', state: { title: 'No answer from the intermediary' }, sends: [{ status: 'FAILED', failure: { code: 'NO_ANSWER', uncertain: true } }] })
    const refused = await (async () => {
      await stepUp(h, finance, financeSecret)
      return finance.post(`/invoicing/invoices/${invoice.id}/sdi/send`, {})
    })()
    expect(refused.status).toBe(409)
    expect(refused.body.error.message).toContain('not sent twice')
    expect(await admin('SELECT attempt FROM "SdiSubmission" WHERE "invoiceId" = $1', [invoice.id])).toEqual([{ attempt: 1 }])
    sdiAnswers()
    await runSdiPoll({ database: h.database, log: { info() {}, warn() {}, error() {} }, clock: later(20) })
    await drain()
    const status = await sdiOf(invoice.id)
    expect(status).toMatchObject({ invoiceStatus: 'DELIVERED', sends: [{ attempt: 1, status: 'DELIVERED', notifications: [{ type: 'RC', source: 'poll' }] }] })
  })

  it('a file the intermediary refuses (a 4xx) is FAILED as REFUSED: it never reached SDI', async () => {
    const invoice = await issued()
    fake.scriptNext({ kind: 'REFUSE' })
    const { sdi: refused } = await send(invoice.id)
    expect(refused).toMatchObject({ invoiceStatus: 'ERROR', state: { title: 'Not sent', next: { action: 'SEND_AGAIN' } }, sends: [{ status: 'FAILED', failure: { code: 'REFUSED', uncertain: false } }] })
    expect(fake.attempts.filter((attempt) => attempt.idempotencyKey === refused.sends[0].id)).toHaveLength(1)
  })
})

describe('the database refuses what the API never sends (the …_money_guards triggers)', () => {
  it('a send of an invoice without its XML, of a draft, or of another file', async () => {
    const draft = (await as(finance, 'POST', '/invoicing/invoices', { companyId: c1(), buyerPartyId: ids.customer, docType: 'TD01', lines: [{ description: 'Giacca', quantity: '1', unitPrice: '100' }] }, 201)).invoice
    await admin(`UPDATE "IntegrationAccount" SET status = 'PAUSED' WHERE "tenantId" = $1 AND provider = 'R2'`, [tenant.id])
    let noFiles: Json
    try {
      await stepUp(h, finance, financeSecret)
      noFiles = (await as(finance, 'POST', `/invoicing/invoices/${draft.id}/issue`, {})).invoice
    } finally {
      await admin(`UPDATE "IntegrationAccount" SET status = 'ACTIVE' WHERE "tenantId" = $1 AND provider = 'R2'`, [tenant.id])
    }
    expect(noFiles).toMatchObject({ status: 'ISSUED', xmlFileId: null })
    const other = await issued()
    const insert = (invoiceId: string, xmlFileId: string) =>
      h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: newId() }, (client) =>
        client.sdiSubmission.create({ data: { id: newId(), partyId: ids.customer, invoiceId, attempt: 1, integrationAccountId: sdiAccount, fileName: `IT${FAKE_VAT.company}_${newId().slice(0, 5)}.xml`, xmlFileId, status: 'SENDING' }, select: { id: true } }),
      )
    await expect(insert(noFiles.id, other.xmlFileId)).rejects.toThrow(/not the invoice's XML/)
    const otherDraft = (await as(finance, 'POST', '/invoicing/invoices', { companyId: c1(), buyerPartyId: ids.customer, docType: 'TD01', lines: [{ description: 'Giacca', quantity: '1', unitPrice: '100' }] }, 201)).invoice
    await expect(insert(otherDraft.id, other.xmlFileId)).rejects.toThrow(/is a DRAFT/)
    await expect(h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: newId() }, (client) => client.sdiNotification.deleteMany({}))).rejects.toThrow()
  })
})

describe('the walls', () => {
  let invoiceId: string
  beforeAll(async () => {
    invoiceId = (await admin<{ invoiceId: string }>('SELECT "invoiceId" FROM "SdiSubmission" WHERE "integrationAccountId" = $1 LIMIT 1', [sdiAccount]))[0]!.invoiceId
  })

  it('a floor device and a portal session are refused; staff without invoices.issue read the status but cannot send', async () => {
    for (const session of ['floor', 'partner']) {
      expect((await wall(session, 'GET', `/invoicing/invoices/${invoiceId}/sdi`)).status).toBe(403)
      expect((await wall(session, 'POST', `/invoicing/invoices/${invoiceId}/sdi/send`, {})).status).toBe(403)
      expect((await wall(session, 'PUT', `/invoicing/invoices/${invoiceId}/sdi/correction`, {})).status).toBe(403)
    }
    expect((await wall('reader', 'GET', `/invoicing/invoices/${invoiceId}/sdi`)).status).toBe(200)
    expect((await wall('reader', 'POST', `/invoicing/invoices/${invoiceId}/sdi/send`, {})).status).toBe(403)
  })

  it('another tenant and another company see nothing of it', async () => {
    expect((await wall('otherTenant', 'GET', `/invoicing/invoices/${invoiceId}/sdi`)).status).toBe(404)
    expect((await wall('otherTenant', 'POST', `/invoicing/invoices/${invoiceId}/sdi/send`, {})).status).toBe(404)
    expect((await wall('companyTwo', 'GET', `/invoicing/invoices/${invoiceId}/sdi`)).status).toBe(404)
    expect((await wall('companyTwo', 'POST', `/invoicing/invoices/${invoiceId}/sdi/send`, {})).status).toBe(404)
  })
})
