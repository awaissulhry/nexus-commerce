import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore, EXAMPLE_IBAN_IT } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCompliance } from '../../../../../../packages/factory-db/seed/compliance'
import { seed as seedCosting } from '../../../../../../packages/factory-db/seed/costing'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { textOf } from '../../../adapters/ses/fake'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addTenant, addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { systemContext } from '../../../platform/outbox/system'
import { afterAcceptanceHandler } from './after-acceptance'

/**
 * Sending and accepting a quote (B-W1-24; A1 §2.5 "sending freezes a version; accept only on the latest version, through a
 * valid link, with a typed name"; SAL-157, SAL-192, SAL-194, SAL-093, SAL-195, SAL-304, FIN-066; PLAN §4.7 05-quote →
 * 06a-accept → 06b-deposit) on the local stack: a throwaway PostgreSQL 17 database from the migrations (the runtime login:
 * row-level security, the column grants and the …_sales_guards triggers are real), the real app with the real office
 * sign-in and the real one-off link authenticator (the customer's "second browser context" is a request that carries only
 * the link's token), the local file store for the PDFs, the FAKE SES mailbox (the only place a link's token exists), and a
 * second app with test sessions for the walls. The seeds' brand customer P1 (an Italian business, buyer
 * buyer.p1@example.com), its jacket in BLK and RED, sizes 50 / 52 / 54; every price, name and IBAN made up (the IBANs are
 * the IBAN registry's documented examples). Run with `node scripts/factory/run-pg-tests.mjs send`.
 */

let h: Harness
let walls: FastifyInstance
let sales: Browser
let finance: Browser
let financeSecret: string
let other: TestTenant

const NS = 'quote-send'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const companyB = seedId('company:B')
const siteA = seedId('site:A1')
const P1 = seedId('party:P1')
const P3 = seedId('party:P3')
const jacket = seedId('product:style:JKT-01')
const BLK = seedId('product:colourway:JKT-01:BLK')
const RED = seedId('product:colourway:JKT-01:RED')
const BUYER = 'buyer.p1@example.com'
const YEAR = businessDate(new Date()).slice(0, 4)
const FAKE_VAT = '12345670009'
const EXAMPLE_IBAN_DE = 'DE89370400440532013000'

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
let counter = 0
const key = (label = 'k'): string => `qs-${label}-${++counter}-${newId()}`

async function as(browser: Browser, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, body?: unknown, status = 200, headers: Record<string, string> = {}): Promise<Json> {
  const answer = await browser.send(method as 'POST', url, method === 'GET' ? undefined : (body ?? {}), { headers })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}

/** A request of the customer's browser: only the link's token, no cookie (the second browser context). */
async function link(token: string, method: 'GET' | 'POST', url: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await h.app.inject({
    method,
    url,
    headers: { 'x-factory-link': token, 'user-agent': 'Mozilla/5.0 (Customer test browser)', ...(method === 'POST' ? { 'idempotency-key': key('link') } : {}), ...headers },
    ...(body === undefined ? {} : { payload: body as object }),
  })
  return { status: response.statusCode, body: response.json() as Json }
}

const grid = (rows: [string, number][]) => rows.map(([size, quantity]) => ({ size, quantity }))
const BLK_GRID = grid([['50', 2], ['52', 4], ['54', 2]])
const RED_GRID = grid([['50', 1], ['52', 3], ['54', 2]])
const quoteUrl = (id: string) => `/sales/quotes/${id}`

/** A quote for P1 with two size-grid lines: 8 × 450 + 6 × 440 = 6240.00 net, 7612.80 gross, deposit 30 % = 2283.84. */
async function newQuote(extra: Json = {}): Promise<Json> {
  let quote = (await as(sales, 'POST', '/sales/quotes', { companyId: companyA, partyId: P1, customerRef: 'RFQ-0042', ...extra }, 201)).quote
  quote = (await as(sales, 'POST', `${quoteUrl(quote.id)}/lines`, { version: quote.version, styleId: jacket, colourwayId: BLK, sizes: BLK_GRID, unitPrice: '450' }, 201)).quote
  quote = (await as(sales, 'POST', `${quoteUrl(quote.id)}/lines`, { version: quote.version, styleId: jacket, colourwayId: RED, sizes: RED_GRID, unitPrice: '440' }, 201)).quote
  return quote
}

/** Sends a quote; returns the answer and the token the mail carried (read from the fake mailbox only). */
async function send(quote: Json, body: Json = {}, idempotencyKey = key('send')): Promise<{ answer: Json; token: string }> {
  const before = h.ses.mails.length
  const answer = await as(sales, 'POST', `${quoteUrl(quote.id)}/send`, { version: quote.version, ...body }, 200, { 'idempotency-key': idempotencyKey })
  const mail = h.ses.mails.slice(before).find((entry) => entry.outboundId === answer.sent?.emailId)
  const token = mail ? decodeURIComponent(/#token=(\S+)/.exec(textOf(mail.raw))?.[1] ?? '') : ''
  return { answer, token }
}

const tokens: string[] = []
const eventsOf = async (subject: string) => admin<{ type: string; payload: Json }>('SELECT type, payload FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [subject])
const versionsOf = async (quoteId: string) => admin('SELECT id, revision, status, "sentAt", "closedAt", "documentSha256", "termsVersion", "billTo", "shipTo", "sentById" FROM "QuoteVersion" WHERE "quoteId" = $1 ORDER BY revision', [quoteId])

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const SESSIONS: Record<string, () => SessionContext> = {
  floor: () => ({ audience: 'floor', tenantId: tenant, actorId: newId(), siteId: siteA, deviceId: newId(), grants: [{ permissions: ['quotes.view', 'quotes.send', 'floor.work'], companies: [companyA], sites: [siteA], parties: 'all' }] }),
  partner: () => ({ audience: 'partner', tenantId: tenant, actorId: newId(), partyId: P1, grants: [{ permissions: ['quotes.view', 'quotes.send', 'money.price'], companies: 'all', sites: 'all', parties: [P1] }] }),
  companyB: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['quotes.view', 'quotes.send', 'quotes.manage', 'money.price', 'companies.bank.view'], [companyB])] }),
  otherTenant: () => ({ audience: 'office', tenantId: other.id, actorId: newId(), grants: [grant(['quotes.view', 'quotes.send', 'money.price', 'companies.bank.view'])] }),
  viewer: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['quotes.view', 'money.price'])] }),
}

beforeAll(async () => {
  h = await startHarness('quote_send')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedCompliance({ db: h.database, namespace: NS }) // the product and parties seeds come with it
  await seedCosting({ db: h.database, namespace: NS })
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId }))
  // Company A's letterhead (c.c. art. 2250), its quote series, a FAKE file store and a FAKE mail account with a verified
  // conversation address.
  await admin(`UPDATE "Company" SET "vatNumber" = $2, "fiscalCode" = $3, "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyA, `IT${FAKE_VAT}`, FAKE_VAT])
  await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'QUOTE', 'MAIN', $4, 'YEARLY', 'Q-{YYYY}-{N:4}', false)`, [newId(), tenant, companyA, YEAR])
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), tenant])
  const ses = newId()
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'SES', 'ses', 'Mail', 'FAKE', 6000, 1000)`, [ses, tenant])
  await admin(
    `INSERT INTO "EmailIdentity" (id, "tenantId", "companyId", kind, domain, "fromAddress", "displayName", "displayNamePolicy", "replyDomain", "accountId", "verificationStatus", "dkimStatus", "isDefault")
     VALUES ($1, $2, $3, 'CONVERSATION', 'mail.seed-a.example.com', 'sales@mail.seed-a.example.com', 'Seed A', 'COMPANY', 'reply.seed-a.example.com', $4, 'SUCCESS', 'SUCCESS', true)`,
    [newId(), tenant, companyA, ses],
  )
  const seedTenant: TestTenant = { id: tenant, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  const salesUser = await addUser(h, seedTenant, { email: 'sara.sales@seed-a.example.com', role: 'sales' })
  const financeUser = await addUser(h, seedTenant, { email: 'fabio.finance@seed-a.example.com', role: 'finance' })
  other = await addTenant(h, 'quote-send-other')
  sales = new Browser(h.app)
  expect((await sales.signIn(NS, salesUser.email, salesUser.password)).status).toBe(200)
  await enrolTotp(h, sales)
  finance = new Browser(h.app)
  expect((await finance.signIn(NS, financeUser.email, financeUser.password)).status).toBe(200)
  financeSecret = await enrolTotp(h, finance)
  walls = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
}, 180_000)

afterAll(async () => {
  await walls?.close()
  await h?.close()
}, 60_000)

const FIRST_MESSAGE = 'Gentile cliente, ecco la nostra offerta come concordato.'
let first: Json
let firstToken: string
let firstSent: Json

describe('send: the version frozen, its PDF, the accept link, the mail (SAL-157, SAL-192, SAL-093)', () => {
  it('the send check lists what stops the send, then nothing once the quote is complete', async () => {
    const empty = (await as(sales, 'POST', '/sales/quotes', { companyId: companyA, partyId: P1 }, 201)).quote
    const check = await as(sales, 'GET', `${quoteUrl(empty.id)}/send-check`)
    expect(check).toMatchObject({ ready: false, recipient: { name: 'Seed Buyer One', email: BUYER }, language: 'it' })
    expect(check.checks.map((entry: Json) => [entry.code, entry.severity])).toContainEqual(['NO_LINES', 'BLOCKS'])
    first = await newQuote()
    const ready = await as(sales, 'GET', `${quoteUrl(first.id)}/send-check`)
    expect(ready).toMatchObject({ ready: true, checks: [], documentNumber: `${first.number} v1`, subject: `Offerta ${first.number} v1` })
    expect(ready.message).not.toContain('token')
  })

  it('freezes the version with its buyer, delivery address, PDF hash and terms; the link is made; the mail leaves with the link', async () => {
    const { answer, token } = await send(first, { message: FIRST_MESSAGE }, 'qs-first-send-0001')
    firstSent = answer
    firstToken = token
    tokens.push(token)
    expect(token).toMatch(/^[0-9a-f-]{36}\.[0-9a-f-]{36}\.[0-9a-f-]{36}\./)
    expect(answer).toMatchObject({ delivery: 'sent', quote: { status: 'SENT', current: { status: 'SENT', revision: 1 } }, sent: { revision: 1, to: BUYER, termsVersion: 'default-business-1', supersededVersionIds: [] } })
    const version = (await versionsOf(first.id))[0]!
    expect(version).toMatchObject({ status: 'SENT', termsVersion: 'default-business-1', documentSha256: answer.sent.documentSha256 })
    expect(version.sentById).not.toBeNull()
    expect(version.billTo).toMatchObject({ legalName: expect.any(String), taxMode: 'IT_B2B', vatNumber: 'IT00000001016', sdiRecipientCode: 'SEEDC01', address: { country: 'IT' } })
    expect(version.shipTo).toMatchObject({ line1: expect.any(String), country: 'IT' })
    const file = await one('SELECT kind, "partyId", visibility::text[] AS visibility, sha256, "contentType", "originalName" FROM "StoredFile" WHERE id = $1', [answer.sent.documentFileId])
    expect(file).toMatchObject({ kind: 'FISCAL_ARCHIVE', partyId: P1, visibility: ['OFFICE', 'PARTNER', 'LINK'], sha256: version.documentSha256, contentType: 'application/pdf', originalName: `Offerta ${first.number} v1.pdf` })
    const row = await one('SELECT purpose, "recordType", "recordId", email, "maxUses", uses, "revokedAt", "tokenHash" FROM "OneOffLink" WHERE id = $1', [answer.sent.link.id])
    expect(row).toMatchObject({ purpose: 'QUOTE_ACCEPT', recordType: 'Quote', recordId: first.id, email: BUYER, maxUses: 1, uses: 0, revokedAt: null })
    // The mail: the thread keeps it without the link; it left (in this process) with the link and the PDF.
    const mail = await one('SELECT o.status, o.to, o.subject, m."bodyText", m."attachmentFileIds" FROM "EmailOutbound" o JOIN "Message" m ON m.id = o."messageId" WHERE o.id = $1', [answer.sent.emailId])
    expect(mail).toMatchObject({ status: 'SENT', to: [BUYER], subject: `Offerta ${first.number} v1`, attachmentFileIds: [answer.sent.documentFileId] })
    expect(mail.bodyText).toContain("usi il link personale contenuto nell'e-mail inviata")
    expect(mail.bodyText).not.toContain('#token=')
    const sent = h.ses.mails.find((entry) => entry.outboundId === answer.sent.emailId)!
    expect(textOf(sent.raw)).toContain(`Gentile cliente, ecco la nostra offerta come concordato.`)
    expect(sent.raw).toContain(`filename="Offerta ${first.number} v1.pdf"`)
    expect((await eventsOf(first.id)).map((event) => event.type)).toContain('quote.sent')
    expect((await admin(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'email.queued' AND payload->>'outboundId' = $1`, [answer.sent.emailId]))[0]!.n).toBe(0)
  })

  it('is idempotent: the same key answers the first send, nothing is made or mailed again', async () => {
    const mails = h.ses.mails.length
    const again = await as(sales, 'POST', `${quoteUrl(first.id)}/send`, { version: first.version, message: FIRST_MESSAGE }, 200, { 'idempotency-key': 'qs-first-send-0001' })
    expect(again.sent).toEqual(firstSent.sent)
    expect(again.delivery).toBeNull()
    expect(h.ses.mails.length).toBe(mails)
    expect((await admin('SELECT count(*)::int AS n FROM "OneOffLink" WHERE "recordId" = $1', [first.id]))[0]!.n).toBe(1)
    // A new key on the version read before: the version changed (409 naming the current one).
    const stale = await sales.send('POST', `${quoteUrl(first.id)}/send`, { version: first.version }, { headers: { 'idempotency-key': key() } })
    expect(stale.status).toBe(409)
  })
})

describe('the link: open, accept with a typed name, the evidence, the deposit (SAL-093, SAL-195, FIN-066)', () => {
  it('opening it, even twice, uses nothing up (mail scanners); the customer sees its prices and never a cost', async () => {
    for (let index = 0; index < 2; index++) {
      expect((await link(firstToken, 'POST', '/link/open', {})).status).toBe(200)
      const view = await link(firstToken, 'GET', '/link/quote')
      expect(view.status).toBe(200)
      expect(view.body).toMatchObject({ state: 'OPEN', quote: { number: `${first.number} v1`, versionId: first.current.id, priceBasis: 'NET', totals: { net: 624000, gross: 761280 }, deposit: { pct: '30', kind: 'ACCONTO', amount: 228384 } } })
      expect(view.body.answers).toEqual([
        { action: 'accept', typedName: 'required', email: true, noWithdrawal: false },
        { action: 'decline', typedName: 'optional', email: false, noWithdrawal: false },
      ])
      expect(view.body.quote.lines.map((line: Json) => [line.code, line.quantity, line.unitPrice, line.sizesText])).toEqual([
        ['SEED-JKT-01 BLK', 8, '450', '50×2 · 52×4 · 54×2'],
        ['SEED-JKT-01 RED', 6, '440', '50×1 · 52×3 · 54×2'],
      ])
      expect(view.body.privacy.url).toBe(`http://localhost:3200/privacy/${companyA}`)
      const keys = JSON.stringify(view.body)
      for (const word of ['unitCost', 'costAmount', 'margin', 'internalNote', 'token']) expect(keys).not.toContain(word)
    }
    expect((await admin('SELECT uses FROM "OneOffLink" WHERE id = $1', [firstSent.sent.link.id]))[0]).toEqual({ uses: 0 })
  })

  it('the link page reads the PDF it accepts, as sent (its SHA-256 is the version\'s), through the link only (B-W1-21 part 2)', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/link/quote/document', headers: { 'x-factory-link': firstToken } })
    expect(response.statusCode, response.body.slice(0, 200)).toBe(200)
    expect(response.headers['content-type']).toBe('application/pdf')
    expect(String(response.headers['content-disposition'])).toMatch(/^inline; filename=/)
    const sha = createHash('sha256').update(response.rawPayload).digest('hex')
    expect(sha).toBe(firstSent.sent.documentSha256)
    // A link of another quote, or none at all, reads nothing.
    expect((await h.app.inject({ method: 'GET', url: '/link/quote/document' })).statusCode).toBe(401)
    expect((await admin('SELECT uses FROM "OneOffLink" WHERE id = $1', [firstSent.sent.link.id]))[0]).toEqual({ uses: 0 })
  })

  it('an accept without the typed name, with another address, or for another version is refused and uses nothing', async () => {
    const versionId = first.current.id
    const noName = await link(firstToken, 'POST', '/link/quote/accept', { versionId, email: BUYER })
    expect(noName.status).toBe(400)
    expect(noName.body.error.issues).toEqual([{ path: 'typedName', message: 'Type your full name to confirm.' }])
    const wrongMail = await link(firstToken, 'POST', '/link/quote/accept', { versionId, typedName: 'Anna Finta', email: 'someone@example.com' })
    expect(wrongMail.status).toBe(400)
    expect(wrongMail.body.error.issues[0].path).toBe('email')
    const wrongVersion = await link(firstToken, 'POST', '/link/quote/accept', { versionId: newId(), typedName: 'Anna Finta', email: BUYER })
    expect(wrongVersion.status).toBe(400)
    expect(wrongVersion.body.error.issues[0].path).toBe('body/versionId')
    expect((await admin('SELECT uses FROM "OneOffLink" WHERE id = $1', [firstSent.sent.link.id]))[0]).toEqual({ uses: 0 })
    expect((await admin(`SELECT count(*)::int AS n FROM "LinkEvidence" WHERE "linkId" = $1 AND action = 'ACCEPTED'`, [firstSent.sent.link.id]))[0]!.n).toBe(0)
  })

  it('accepts: version and quote ACCEPTED, the evidence pack, the deposit request OPEN with the bank details, the confirmation mail', async () => {
    const accepted = await link(firstToken, 'POST', '/link/quote/accept', { versionId: first.current.id, typedName: '  Anna   Finta ', email: ' Buyer.P1@example.com ', note: 'Va bene così.' })
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)
    const today = businessDate(new Date())
    expect(accepted.body).toMatchObject({
      state: 'ACCEPTED',
      acceptance: { signerName: 'Anna Finta', documentSha256: firstSent.sent.documentSha256, termsVersion: 'default-business-1' },
      deposit: {
        kind: 'ACCONTO',
        amount: 228384,
        dueDate: addDays(today, 7),
        fiscalDocument: 'TD02',
        status: 'OPEN',
        instructions: { method: 'BANK_TRANSFER', amount: 228384, reference: `Acconto offerta ${first.number} v1`, bank: { accountHolder: 'Seed Company A', iban: EXAMPLE_IBAN_IT, bic: null, bankName: 'Seed example bank' } },
      },
    })
    const version = (await versionsOf(first.id))[0]!
    expect(version).toMatchObject({ status: 'ACCEPTED' })
    expect(version.closedAt).not.toBeNull()
    expect((await admin('SELECT status FROM "Quote" WHERE id = $1', [first.id]))[0]).toEqual({ status: 'ACCEPTED' })
    const acceptance = await one('SELECT channel, "linkId", "signerName", "emailCheck", "documentSha256", "termsVersion", "noWithdrawalAccepted", "requestId" FROM "QuoteAcceptance" WHERE "versionId" = $1', [first.current.id])
    expect(acceptance).toMatchObject({ channel: 'LINK', linkId: firstSent.sent.link.id, signerName: 'Anna Finta', emailCheck: 'MATCHED', documentSha256: firstSent.sent.documentSha256, termsVersion: 'default-business-1', noWithdrawalAccepted: false })
    const evidence = await one(`SELECT action, "useNumber", "typedName", "emailCheck", "ipHash", "userAgent" FROM "LinkEvidence" WHERE "requestId" = $1`, [acceptance.requestId])
    expect(evidence).toMatchObject({ action: 'ACCEPTED', useNumber: 1, typedName: 'Anna Finta', emailCheck: 'MATCHED', userAgent: 'Mozilla/5.0 (Customer test browser)' })
    expect(evidence.ipHash).toMatch(/\S/)
    const deposit = await one('SELECT status, amount, kind, "fiscalDocument", "fiscalRule", "quoteVersionId", "partyId", "companyId" FROM "DepositRequest" WHERE "quoteVersionId" = $1', [first.current.id])
    expect(deposit).toEqual({ status: 'OPEN', amount: 228384, kind: 'ACCONTO', fiscalDocument: 'TD02', fiscalRule: 'DEPOSIT_INVOICE_IT', quoteVersionId: first.current.id, partyId: P1, companyId: companyA })
    const events = await eventsOf(first.id)
    const acceptedEvent = events.find((event) => event.type === 'quote.accepted')!
    expect(acceptedEvent.payload).toMatchObject({ quoteId: first.id, versionId: first.current.id, revision: 1, number: first.number, companyId: companyA, partyId: P1, channel: 'LINK', taxMode: 'IT_B2B', currency: 'EUR', depositAsked: true, noWithdrawal: false })
    expect((await admin(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'deposit_request.created' AND payload->>'versionId' = $1`, [first.current.id]))[0]!.n).toBe(1)
    // The confirmation: a record mail (no link) the worker sends, with the PDF and the deposit's instructions.
    const confirmation = await one(`SELECT o.status, o.subject, m."bodyText", m."attachmentFileIds" FROM "EmailOutbound" o JOIN "Message" m ON m.id = o."messageId" WHERE o."recordId" = $1 AND o.subject LIKE 'Conferma%'`, [first.id])
    expect(confirmation).toMatchObject({ status: 'QUEUED', subject: `Conferma di accettazione dell'offerta ${first.number} v1`, attachmentFileIds: [firstSent.sent.documentFileId] })
    expect(confirmation.bodyText).toContain(`IBAN ${EXAMPLE_IBAN_IT}`)
  })

  it('a second accept is refused cleanly: the link is used up (the uniform 404)', async () => {
    const again = await link(firstToken, 'POST', '/link/quote/accept', { versionId: first.current.id, typedName: 'Anna Finta', email: BUYER })
    expect(again.status).toBe(404)
    expect((await admin('SELECT count(*)::int AS n FROM "QuoteAcceptance" WHERE "versionId" = $1', [first.current.id]))[0]!.n).toBe(1)
  })

  it('the worker backstop runs the same steps once: no second deposit request, no second confirmation', async () => {
    const caller = callerFor(h.database, systemContext(tenant, newId()))
    const event = (await eventsOf(first.id)).find((entry) => entry.type === 'quote.accepted')!
    await afterAcceptanceHandler().handle({ eventId: newId(), type: 'quote.accepted', version: 1, tenantId: tenant, payload: event.payload } as never, { caller, attempt: 1 })
    expect((await admin('SELECT count(*)::int AS n FROM "DepositRequest" WHERE "quoteVersionId" = $1', [first.current.id]))[0]!.n).toBe(1)
    expect((await admin(`SELECT count(*)::int AS n FROM "EmailOutbound" WHERE "recordId" = $1 AND subject LIKE 'Conferma%'`, [first.id]))[0]!.n).toBe(1)
  })

  it('the office reads every version with its PDF, its links and the evidence pack', async () => {
    const { versions } = await as(sales, 'GET', `${quoteUrl(first.id)}/versions`)
    expect(versions).toHaveLength(1)
    expect(versions[0]).toMatchObject({
      revision: 1,
      status: 'ACCEPTED',
      document: { fileId: firstSent.sent.documentFileId, sha256: firstSent.sent.documentSha256 },
      links: [{ id: firstSent.sent.link.id, state: 'USED_UP', email: BUYER, uses: 1 }],
      acceptance: { signerName: 'Anna Finta', emailCheck: 'MATCHED', documentMatches: true, termsVersion: 'default-business-1', evidence: { action: 'ACCEPTED', userAgent: 'Mozilla/5.0 (Customer test browser)' } },
      deposit: { status: 'OPEN', amount: 228384 },
    })
  })

  it('a deposit received through payments still marks the request PAID (markDepositPaid moved to sales)', async () => {
    const deposit = await one<{ id: string }>('SELECT id FROM "DepositRequest" WHERE "quoteVersionId" = $1', [first.current.id])
    const paid = await as(finance, 'POST', '/payments/deposit-received', { depositRequestId: deposit!.id, amount: 228384, receivedOn: businessDate(new Date()), externalRef: 'CRO-0000001', issueDepositInvoice: false }, 201)
    expect(paid.depositRequest).toEqual({ id: deposit!.id, status: 'PAID' })
    expect((await admin('SELECT status FROM "DepositRequest" WHERE id = $1', [deposit!.id]))[0]).toEqual({ status: 'PAID' })
  })
})

describe('a new version: the old link waits, then says it was replaced; only the latest SENT version is accepted', () => {
  let quote: Json
  let v1Token: string
  let v1: string

  it('revise copies the lines, sizes and costs into a DRAFT version 2; the sent version 1 waits (REVISING)', async () => {
    quote = await newQuote()
    v1 = quote.current.id
    const sent = await send(quote)
    v1Token = sent.token
    tokens.push(v1Token)
    quote = sent.answer.quote
    quote = (await as(sales, 'POST', `${quoteUrl(quote.id)}/revise`, { version: quote.version, changeNote: 'Prezzo rivisto' })).quote
    expect(quote).toMatchObject({ status: 'DRAFT', currentRevision: 2, current: { revision: 2, status: 'DRAFT', changeNote: 'Prezzo rivisto', netAmount: 624000 } })
    expect(quote.lines.map((line: Json) => [line.colourway.code, line.quantity, line.sizes.length])).toEqual([
      ['BLK', 8, 3],
      ['RED', 6, 3],
    ])
    const copied = await one('SELECT "costSnapshot" IS NOT NULL AS has FROM "QuoteLine" WHERE "versionId" = $1 ORDER BY seq LIMIT 1', [quote.current.id])
    expect(copied).toEqual({ has: true })
    expect((await versionsOf(quote.id)).map((row) => [row.revision, row.status])).toEqual([
      [1, 'SENT'],
      [2, 'DRAFT'],
    ])
    const view = await link(v1Token, 'GET', '/link/quote')
    expect(view.body).toMatchObject({ state: 'REVISING', answers: [] })
    const refused = await link(v1Token, 'POST', '/link/quote/accept', { versionId: v1, typedName: 'Anna Finta', email: BUYER })
    expect(refused.status).toBe(409)
    expect(refused.body.error.message).toMatch(/^The sender is preparing a new version of this quote \(version 2\)/)
  })

  it('sending version 2 supersedes version 1: its link says so, and version 1 is never accepted', async () => {
    quote = (await as(sales, 'PATCH', quoteUrl(quote.id), { version: quote.version, paymentTerms: 'Saldo a 30 giorni' })).quote
    const sent = await send(quote)
    tokens.push(sent.token)
    expect(sent.answer.sent).toMatchObject({ revision: 2, supersededVersionIds: [v1] })
    expect((await versionsOf(quote.id)).map((row) => [row.revision, row.status])).toEqual([
      [1, 'SUPERSEDED'],
      [2, 'SENT'],
    ])
    expect((await link(v1Token, 'GET', '/link/quote')).body).toMatchObject({ state: 'SUPERSEDED', quote: { revision: 1 } })
    // Accept only the latest SENT version (A1 §2.5): the old link answers its own version 1, replaced.
    const old = await link(v1Token, 'POST', '/link/quote/accept', { versionId: v1, typedName: 'Anna Finta', email: BUYER })
    expect(old.status).toBe(409)
    expect(old.body.error.message).toMatch(/^This is version 1: version 2 replaced it and was sent to you\./)
    // The new link answers version 2 only.
    const wrong = await link(sent.token, 'POST', '/link/quote/accept', { versionId: v1, typedName: 'Anna Finta', email: BUYER })
    expect(wrong.status).toBe(400)
    expect((await admin('SELECT count(*)::int AS n FROM "QuoteAcceptance" a JOIN "QuoteVersion" v ON v.id = a."versionId" WHERE v."quoteId" = $1', [quote.id]))[0]!.n).toBe(0)
    const accepted = await link(sent.token, 'POST', '/link/quote/accept', { versionId: sent.answer.sent.versionId, typedName: 'Anna Finta', email: BUYER })
    expect(accepted.status).toBe(200)
    expect(accepted.body.quote).toMatchObject({ revision: 2, paymentTerms: 'Saldo a 30 giorni' })
  })
})

describe('the office withdraws, sends a new link; the customer declines, asks for a new link', () => {
  it('cancel after send needs a reason and voids the link (the uniform 404)', async () => {
    let quote = await newQuote()
    const sent = await send(quote)
    tokens.push(sent.token)
    quote = sent.answer.quote
    const noReason = await sales.send('POST', `${quoteUrl(quote.id)}/cancel`, { version: quote.version })
    expect(noReason.status).toBe(400)
    quote = (await as(sales, 'POST', `${quoteUrl(quote.id)}/cancel`, { version: quote.version, reason: 'Il cliente ha cambiato fornitore' })).quote
    expect(quote).toMatchObject({ status: 'CANCELLED', current: { status: 'CANCELLED' } })
    expect((await admin('SELECT "revokedAt" IS NOT NULL AS revoked FROM "OneOffLink" WHERE id = $1', [sent.answer.sent.link.id]))[0]).toEqual({ revoked: true })
    expect((await link(sent.token, 'GET', '/link/quote')).status).toBe(404)
  })

  it('a new link revokes the live one and is mailed with the PDF', async () => {
    let quote = await newQuote()
    const sent = await send(quote)
    tokens.push(sent.token)
    quote = sent.answer.quote
    const before = h.ses.mails.length
    const renewed = await as(sales, 'POST', `${quoteUrl(quote.id)}/send-link`, { version: quote.version }, 200, { 'idempotency-key': key('link') })
    expect(renewed).toMatchObject({ delivery: 'sent', link: { revokedLinkIds: [sent.answer.sent.link.id], to: BUYER } })
    const mail = h.ses.mails.slice(before).find((entry) => entry.outboundId === renewed.link.emailId)!
    const token = decodeURIComponent(/#token=(\S+)/.exec(textOf(mail.raw))![1]!)
    tokens.push(token)
    expect(mail.raw).toContain(`filename="Offerta ${quote.number} v1.pdf"`)
    expect((await link(sent.token, 'GET', '/link/quote')).status).toBe(404)
    expect((await link(token, 'GET', '/link/quote')).body.state).toBe('OPEN')
    // The customer declines it, with a reason: the version and the quote DECLINED.
    const declined = await link(token, 'POST', '/link/quote/decline', { versionId: quote.current.id, note: 'Troppo caro' })
    expect(declined.status).toBe(200)
    expect(declined.body.state).toBe('DECLINED')
    expect((await admin('SELECT status, "decisionNote" FROM "QuoteVersion" WHERE id = $1', [quote.current.id]))[0]).toEqual({ status: 'DECLINED', decisionNote: 'Troppo caro' })
    expect((await eventsOf(quote.id)).map((event) => event.type)).toContain('quote.declined')
  })

  it('after the offer’s last day the link says it ended (no expiry job) and lets the customer ask for a new one', async () => {
    const tomorrow = addDays(businessDate(new Date()), 1)
    let quote = await newQuote({ validUntil: tomorrow })
    const sent = await send(quote)
    tokens.push(sent.token)
    quote = sent.answer.quote
    const now = h.clock.now()
    h.clock.set(new Date(`${addDays(tomorrow, 2)}T10:00:00.000Z`))
    try {
      const view = await link(sent.token, 'GET', '/link/quote')
      expect(view.body).toMatchObject({ state: 'EXPIRED', message: `The offer ended on ${tomorrow}. Ask for a new one.`, answers: [] })
      const refused = await link(sent.token, 'POST', '/link/quote/accept', { versionId: quote.current.id, typedName: 'Anna Finta', email: BUYER })
      expect(refused.status).toBe(409)
      const asked = await link(sent.token, 'POST', '/link/quote/new-link', { note: 'Possiamo avere un nuovo link?' })
      expect(asked).toMatchObject({ status: 200, body: { asked: true } })
      expect((await eventsOf(quote.id)).find((event) => event.type === 'quote.link_requested')?.payload).toMatchObject({ quoteId: quote.id, state: 'EXPIRED' })
      expect((await admin('SELECT uses FROM "OneOffLink" WHERE id = $1', [sent.answer.sent.link.id]))[0]).toEqual({ uses: 0 })
    } finally {
      h.clock.set(now)
    }
  })
})

describe('walls (A1 §2.2, §2.6)', () => {
  it('a link session sees only its own quote: another party is behind the wall, another purpose opens no quote', async () => {
    const quote = (await as(sales, 'POST', '/sales/quotes', { companyId: companyA, partyId: P3 }, 201)).quote
    const row = await one<{ id: string }>('SELECT id FROM "OneOffLink" WHERE "recordId" = $1 LIMIT 1', [first.id])
    const seen = await h.database.withScope({ audience: 'partner', tenantId: tenant, actorId: row!.id, partyId: P1 }, async (client) => ({
      own: await client.quote.findUnique({ where: { id: first.id }, select: { id: true } }),
      other: await client.quote.findUnique({ where: { id: quote.id }, select: { id: true } }),
      deposit: await client.depositRequest.findFirst({ where: { quoteVersionId: first.current.id }, select: { id: true } }),
    }))
    expect(seen.own).toEqual({ id: first.id })
    expect(seen.other).toBeNull()
    expect(seen.deposit).not.toBeNull()
    // A token whose party part was changed finds nothing: the uniform 404.
    const [tenantPart, , linkPart, secret] = tokens[1]!.split('.')
    expect((await link([tenantPart, P3, linkPart, secret].join('.'), 'GET', '/link/quote')).status).toBe(404)
  })

  it('floor and portal sessions are refused; another tenant and another company see nothing', async () => {
    const call = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown) => walls.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
    expect((await call('floor', 'POST', `${quoteUrl(first.id)}/send`, { version: 1 })).statusCode).toBe(403)
    expect((await call('partner', 'POST', `${quoteUrl(first.id)}/send`, { version: 1 })).statusCode).toBe(403)
    expect((await call('companyB', 'GET', `${quoteUrl(first.id)}/versions`)).statusCode).toBe(404)
    expect((await call('otherTenant', 'GET', `${quoteUrl(first.id)}/versions`)).statusCode).toBe(404)
    expect((await call('viewer', 'POST', `${quoteUrl(first.id)}/send`, { version: 1 })).statusCode).toBe(403)
    expect((await call('viewer', 'GET', `/link/quote`)).statusCode).toBe(403)
  })

  it('the token is in no answer, row, audit entry, event or receipt: only in the mail', async () => {
    expect(tokens.length).toBeGreaterThanOrEqual(5)
    const secrets = tokens.map((token) => token.split('.')[3]!)
    const dump = JSON.stringify([
      await admin('SELECT before, after, reason FROM "AuditLog"'),
      await admin('SELECT payload FROM "OutboxEvent"'),
      await admin('SELECT response FROM "IdempotencyReceipt"'),
      await admin('SELECT "bodyText" FROM "Message"'),
      await admin('SELECT * FROM "EmailOutbound"'),
      await admin('SELECT * FROM "LinkEvidence"'),
      await admin('SELECT "requestSummary", "responseSummary" FROM "IntegrationCall"'),
      firstSent,
    ])
    for (const secret of secrets) expect(dump).not.toContain(secret)
  })
})

describe("the company's bank account (Q12; a step-up to change it)", () => {
  const url = `/companies/${companyA}/bank-details`

  it('finance reads it; a change without a fresh step-up is refused; sales may not change it', async () => {
    const read = await as(finance, 'GET', url)
    expect(read).toMatchObject({ companyId: companyA, bank: { accountHolder: 'Seed Company A', iban: EXAMPLE_IBAN_IT, bic: null } })
    const refused = await finance.send('PUT' as 'POST', url, { version: read.version, accountHolder: 'Seed Company A', iban: EXAMPLE_IBAN_DE, bic: null, bankName: null })
    expect(refused.status).toBe(403)
    expect(refused.body.error.issues).toEqual([expect.objectContaining({ path: 'stepUp' })])
    expect((await sales.send('PUT' as 'POST', url, { version: read.version, accountHolder: 'X', iban: EXAMPLE_IBAN_DE, bic: null, bankName: null })).status).toBe(403)
  })

  it('with a step-up: a bad IBAN is refused; a good one is saved, audited from → to, and the owners are told (masked)', async () => {
    await stepUp(h, finance, financeSecret)
    const read = await as(finance, 'GET', url)
    const bad = await finance.send('PUT' as 'POST', url, { version: read.version, accountHolder: 'Seed Company A', iban: 'DE89370400440532013001', bic: null, bankName: null })
    expect(bad.status).toBe(400)
    expect(bad.body.error.issues[0]).toMatchObject({ path: 'body/iban' })
    const saved = await as(finance, 'PUT', url, { version: read.version, accountHolder: 'Seed Company A', iban: 'de89 3704 0044 0532 0130 00', bic: 'EXMPDEFFXXX', bankName: 'Banca Esempio' })
    expect(saved.bank).toEqual({ accountHolder: 'Seed Company A', iban: EXAMPLE_IBAN_DE, bic: 'EXMPDEFFXXX', bankName: 'Banca Esempio' })
    const audit = await one(`SELECT before, after FROM "AuditLog" WHERE action = 'companies.bank.save' AND "recordId" = $1`, [companyA])
    expect(audit).toEqual({ before: { accountHolder: 'Seed Company A', iban: EXAMPLE_IBAN_IT, bic: null, bankName: 'Seed example bank' }, after: { accountHolder: 'Seed Company A', iban: EXAMPLE_IBAN_DE, bic: 'EXMPDEFFXXX', bankName: 'Banca Esempio' } })
    const event = await one(`SELECT payload FROM "OutboxEvent" WHERE type = 'company.bank_details_changed'`)
    expect(event!.payload).toEqual({ companyId: companyA, fields: ['iban', 'bic', 'bankName'], ibanBefore: 'IT60…3456', ibanAfter: 'DE89…3000' })
  })

  it('the floor role cannot read the columns; the database refuses a bad IBAN for every login', async () => {
    await expect(h.database.withScope({ audience: 'floor', tenantId: tenant, actorId: newId(), siteId: siteA }, (client) => client.company.findUnique({ where: { id: companyA }, select: { iban: true } }))).rejects.toThrow(/permission denied/)
    expect(await h.database.withScope({ audience: 'floor', tenantId: tenant, actorId: newId(), siteId: siteA }, (client) => client.company.findUnique({ where: { id: companyA }, select: { legalName: true } }))).toEqual({ legalName: 'Seed Company A' })
    await expect(admin(`UPDATE "Company" SET iban = 'IT60 X054' WHERE id = $1`, [companyB])).rejects.toThrow(/company: the IBAN of .* is not an IBAN/)
    await expect(admin(`UPDATE "Company" SET "bankName" = 'Banca' WHERE id = $1`, [companyB])).rejects.toThrow(/bank details without an IBAN/)
  })
})
