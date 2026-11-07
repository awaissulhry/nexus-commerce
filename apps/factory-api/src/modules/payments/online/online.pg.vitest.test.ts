import { createHash, randomUUID } from 'node:crypto'
import type { FactoryClient } from '@nexus/factory-db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedEmail } from '../../../../../../packages/factory-db/seed/email'
import { seed as seedReceivables } from '../../../../../../packages/factory-db/seed/receivables'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { FakePaymentProvider } from '../../../adapters/payment-fake/fake'
import { textOf } from '../../../adapters/ses/fake'
import { callerFor, command } from '../../../core/command'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { freshGuard, mailedCode, portalBrowser } from '../../../platform/auth/portal/testing/portal'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { createGateway } from '../../../platform/gateway/gateway'
import { inboundRuntime, useInbound } from '../../../platform/inbound/providers'
import { processReceipt } from '../../../platform/inbound/process'
import { LINK_HEADER } from '../../../platform/links/authenticator'
import { systemContext } from '../../../platform/outbox/system'
import { SECRET_PURPOSES, storeSecret } from '../../../platform/secrets/store'
import { afterIntentFinished, syncPayTask } from './follow-up'
import { createPaymentsRuntime, usePayments, type PaymentsRuntime } from './runtime'
import { applyIntentEvent } from './webhook'

/**
 * B-W2b-185 — paying online on the FAKE provider, on the local stack through the app's real routes and sign-ins: a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security, the money guards and PaymentIntent's
 * guard are real), the factory-db seeds of one tenant (P1's FT-2026-00001, issued, part paid; SEED-SO-0002), the tenant's
 * partner roles synced, P1's portal switched on with made-up terms, a FAKE payment account with its webhook secret, the
 * gateway on the harness's Redis, the fake provider in memory, the inbound ledger's real route.
 *   - the office sends the page to pay FT-2026-00001 (a PAYMENT link); its holder sees the amount, the bank transfer and
 *     card; a card declined (FAILED in our words, cancelled at the provider), tried again (one intent per payer, taken up
 *     again on a reload), paid: the webhook records ONE CARD payment allocated to the invoice, a repeated webhook changes
 *     nothing, the request to pay is DONE, the receipt is queued; a success after we failed an intent is still recorded once
 *   - the customer's Finance sees what is open and the statement, pays a deposit by SEPA (processing, then settled: the
 *     request PAID); a Buyer sees none of it; another payer's payment under way holds a second one; a paused account offers
 *     bank transfer only
 * Every name, number and amount is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/payments/online`.
 */

let h: Harness
let tenant: TestTenant
let fake: FakePaymentProvider
let runtime: PaymentsRuntime
let office: Browser
let accountId: string
let clerkId: string

const NS = 'w2b185-pay-online'
const id = (name: string) => seedUuid(NS, name)
const A = { tenant: id('tenant'), company: id('company:A'), P1: id('party:P1'), SO2: id('production:sales-order:SO-0002'), FT1: id('invoice:A:1') }
const SECRET = 'made-up-hook-secret-fake_w2b185_made_up'
const people = { finance: 'fiona.finance@brand-one.example', buyer: 'bruno.buyer@brand-one.example' }
const ids: Record<keyof typeof people, string> = { finance: '', buyer: '' }

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const system = () => callerFor(h.database, systemContext(A.tenant, `test-${newId()}`))
const inTenant = <T>(work: (client: FactoryClient) => Promise<T>): Promise<T> => h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, work)
let keys = 0
const key = () => `w2b185-${++keys}-${newId()}`

/** What the worker does: every webhook stored so far, processed once. */
async function processWebhooks(): Promise<number> {
  const rows = await admin<{ id: string }>(`SELECT id FROM "InboundWebhook" WHERE "tenantId" = $1 AND provider = 'PAYMENT_FAKE' AND status = 'RECEIVED' ORDER BY "receivedAt", id`, [A.tenant])
  for (const row of rows) await processReceipt(system(), row.id, newId(), inboundRuntime())
  return rows.length
}

/** A link holder: the token in the header, an Idempotency-Key on every write. */
const linkGet = (token: string, url: string) => h.app.inject({ method: 'GET', url, headers: { [LINK_HEADER]: token } })
const linkPost = (token: string, url: string, payload: object) => h.app.inject({ method: 'POST', url, headers: { [LINK_HEADER]: token, 'idempotency-key': key() }, payload })
const confirm = (clientSecret: string, scenario: string) => h.app.inject({ method: 'POST', url: '/payment-fake/confirm', payload: { clientSecret, scenario } })

async function partnerPerson(email: string, roleKey: string): Promise<string> {
  const userId = newId()
  await inTenant(async (client) => {
    await client.user.create({ data: { id: userId, email, displayName: email.split('@')[0]!.replace('.', ' '), locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId: A.P1, partnerKind: 'CUSTOMER' }, select: { id: true } })
    const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: A.tenant, key: roleKey } }, select: { id: true } })
    await client.roleAssignment.create({ data: { id: newId(), userId, roleId: role.id, allCompanies: true, partyIds: [A.P1], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
  })
  return userId
}

async function signedIn(email: string): Promise<Browser> {
  const browser = await portalBrowser(h)
  h.clock.advance(61_000)
  expect((await browser.post('/portal/signin/start', { tenant: NS, company: 'SCA', email })).status).toBe(200)
  await h.auth.settled()
  const answer = await browser.post('/portal/signin/code', { tenant: NS, company: 'SCA', email, code: mailedCode(h, email)!.code })
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  const terms = await browser.get('/portal/terms?locale=en')
  expect((await browser.post('/portal/first-visit', { noticeId: terms.body.notice.id, noticeLocale: terms.body.notice.locale, sha256: terms.body.notice.sha256 })).status).toBe(200)
  return browser
}

beforeAll(async () => {
  h = await startHarness('payments_online')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  await seedEmail({ db: h.database, namespace: NS })
  await seedReceivables({ db: h.database, namespace: NS })
  tenant = { id: A.tenant, slug: NS, companies: [{ id: A.company, code: 'SCA' }] }
  const now = h.clock.now()
  await inTenant(async (client) => {
    // The partner roles (the template sync a worker start runs), P1's portal on, the company's portal terms (made up).
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now, actorId: newId() })
    // The company's legal data its documents print (made up): the statement's PDF needs them.
    await client.company.update({ where: { id: A.company }, data: { vatNumber: 'IT00000003038', fiscalCode: '00000003038', reaOffice: 'MI', reaNumber: '0000001', address: { line1: 'Via Esempio 1', postalCode: '20100', city: 'Milano', country: 'IT' } }, select: { id: true } })
    if (!(await client.portalSettings.findUnique({ where: { id: A.P1 }, select: { id: true } }))) await client.portalSettings.create({ data: { id: A.P1, partyId: A.P1, portalOn: true }, select: { id: true } })
    else await client.portalSettings.update({ where: { id: A.P1 }, data: { portalOn: true }, select: { id: true } })
    const noticeId = newId()
    await client.privacyNotice.create({ data: { id: noticeId, companyId: A.company, kind: 'PORTAL_TERMS', versionNo: 1, label: '2026-11-w2b185', createdAt: now, updatedAt: now }, select: { id: true } })
    for (const [locale, body] of Object.entries({ it: 'ESEMPIO - termini del portale per i test dei pagamenti.', en: 'SAMPLE - portal terms for the payment tests.' })) {
      await client.privacyNoticeText.create({ data: { id: newId(), noticeId, locale, body, sha256: createHash('sha256').update(body, 'utf8').digest('hex'), createdAt: now, updatedAt: now }, select: { id: true } })
    }
    await client.privacyNotice.update({ where: { id: noticeId }, data: { status: 'PUBLISHED', publishedAt: now, publishedById: newId(), version: 2, updatedAt: now }, select: { id: true } })
  })
  // The FAKE payment account of company A, with its webhook secret (sealed).
  accountId = newId()
  await command(system(), { name: 'integration.testAccount', input: {} }, async (tools) => {
    const webhook = await storeSecret(tools, h.secrets, { purpose: SECRET_PURPOSES.webhook, plaintext: SECRET })
    await tools.tx.integrationAccount.create({ data: { id: accountId, companyId: A.company, provider: 'PAYMENT_FAKE', code: 'pay-fake-w2b185', label: 'Card payments (fake)', mode: 'FAKE', webhookSecretId: webhook.id, rateLimitPerMinute: 6000, rateLimitBurst: 1000 }, select: { id: true } })
    tools.audit({ recordType: 'IntegrationAccount', recordId: accountId, after: { provider: 'PAYMENT_FAKE' } })
    return {}
  })
  useInbound({ environment: 'test', secrets: h.secrets, clock: h.clock })
  fake = new FakePaymentProvider(h.clock)
  runtime = createPaymentsRuntime({ gateway: createGateway({ environment: 'test', redis: h.redis, prefix: h.redisPrefix, secrets: h.secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } }), environment: 'test', fake })
  usePayments(runtime)
  ids.finance = await partnerPerson(people.finance, 'customer-finance')
  ids.buyer = await partnerPerson(people.buyer, 'customer-buyer')
  const clerk = await addUser(h, tenant, { email: 'fred.finance@w2b185.example', role: 'finance' })
  clerkId = clerk.id
  office = new Browser(h.app)
  await office.signIn(NS, clerk.email, clerk.password)
  await enrolTotp(h, office)
}, 240_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  usePayments(undefined)
  useInbound(undefined)
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
})

describe('paying an invoice by link, on the FAKE provider (FIN-123)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  let token = ''
  let failedIntent = ''
  let paidIntent = ''
  let open = 0

  it('the office sends the page to pay FT-2026-00001; the mail holds the link, the thread keeps none', async () => {
    const sent = await office.post(`/payments/invoices/${A.FT1}/link`, {}, { headers: { 'idempotency-key': key() } })
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    expect(sent.body).toMatchObject({ delivery: 'sent', link: { revokedLinkIds: [] } })
    const mail = h.ses.mails.filter((entry) => entry.to[0] === sent.body.link.to).at(-1)!
    const link = /https?:\/\/\S+#token=(\S+)/.exec(textOf(mail.raw))
    expect(link).not.toBeNull()
    token = decodeURIComponent(link![1]!)
    const [stored] = await admin<{ body: string }>(`SELECT m."bodyText" AS body FROM "Message" m JOIN "EmailOutbound" o ON o."messageId" = m.id WHERE o.id = $1`, [sent.body.emailId])
    expect(stored!.body).not.toContain('#token=')
    expect(await admin(`SELECT purpose, "recordType" FROM "OneOffLink" WHERE id = $1`, [sent.body.link.id])).toEqual([{ purpose: 'PAYMENT', recordType: 'Invoice' }])
  })

  it('the request to pay opens for the customer’s Finance (not its Buyer), due with the invoice', async () => {
    expect(await syncPayTask(system(), A.FT1)).toBe('open')
    expect(await syncPayTask(system(), A.FT1)).toBe(null)
    const finance = await signedIn(people.finance)
    const tasks = await finance.get('/portal/tasks')
    expect(tasks.status, JSON.stringify(tasks.body)).toBe(200)
    expect(tasks.body.items.map((item: Json) => [item.kind, item.record.id, item.canMarkDone])).toEqual([['PAY_INVOICE', A.FT1, false]])
    const buyer = await signedIn(people.buyer)
    expect((await buyer.get('/portal/tasks')).body.items).toEqual([])
  })

  it('the page: what you pay, the bank transfer always, card and SEPA offered', async () => {
    const page = await linkGet(token, '/payments/link/pay')
    expect(page.statusCode, page.body).toBe(200)
    const body = page.json()
    open = body.what.open
    expect(open).toBeGreaterThan(0)
    expect(body).toMatchObject({ status: 'TO_PAY', what: { target: 'INVOICE', id: A.FT1, number: 'FT-2026-00001' }, bank: { method: 'BANK_TRANSFER', amount: open }, card: { available: true, methods: ['CARD', 'SEPA_DEBIT'], provider: 'PAYMENT_FAKE', mode: 'FAKE' }, intent: null })
    expect(body.bank.reference).toContain('FT-2026-00001')
  })

  it('a declined card: FAILED in our words, cancelled at the provider; a reload takes a live payment up again', async () => {
    const started = await linkPost(token, '/payments/link/pay/intents', { method: 'CARD' })
    expect(started.statusCode, started.body).toBe(201)
    const first = started.json()
    expect(first).toMatchObject({ resumed: false, intent: { status: 'WAITING', method: 'CARD', amount: open, target: 'INVOICE' }, provider: { name: 'PAYMENT_FAKE', mode: 'FAKE' } })
    failedIntent = first.intent.id
    const again = (await linkPost(token, '/payments/link/pay/intents', { method: 'CARD' })).json()
    expect(again).toMatchObject({ resumed: true, intent: { id: failedIntent } })
    // Nothing secret is kept: the row holds the provider's id and no client secret anywhere.
    const [row] = await admin<Json>(`SELECT "providerRef", "linkId", "createdById" FROM "PaymentIntent" WHERE id = $1`, [failedIntent])
    expect(row!.providerRef).toMatch(/^pi_fake_[a-p]{32}$/)
    expect(JSON.stringify(await admin(`SELECT after FROM "AuditLog" WHERE "recordId" = $1`, [failedIntent]))).not.toContain('_secret_')
    const declined = await confirm(first.provider.clientSecret, 'decline')
    expect(declined.json()).toMatchObject({ state: 'requires_payment_method', error: { code: 'card_declined' }, webhooks: [{ type: 'payment_intent.payment_failed', status: 200 }] })
    expect(await processWebhooks()).toBe(1)
    const read = (await linkGet(token, `/payments/link/pay/intents/${failedIntent}`)).json()
    expect(read.intent).toMatchObject({ status: 'FAILED', failureCode: 'card_declined' })
    expect(read.intent.failure).toMatch(/declined the card|rifiutato la carta/)
    expect(await afterIntentFinished(system(), failedIntent, newId(), runtime)).toMatchObject({ cancelledAtProvider: true })
    expect(fake.cancelled).toContain(row!.providerRef)
    // The fake provider refuses a finished payment.
    expect((await confirm(first.provider.clientSecret, 'succeed')).statusCode).toBe(409)
  })

  it('another payer’s payment under way holds a second one (the portal’s Finance waits)', async () => {
    const second = (await linkPost(token, '/payments/link/pay/intents', { method: 'CARD' })).json()
    expect(second).toMatchObject({ resumed: false, intent: { status: 'WAITING' } })
    paidIntent = second.intent.id
    const finance = await signedIn(people.finance)
    const held = await finance.post('/portal/payments/intents', { invoiceId: A.FT1, method: 'CARD' })
    expect(held.status, JSON.stringify(held.body)).toBe(409)
    expect(held.body.error.issues[0].path).toBe('payment/IN_PROGRESS')
    // Paid: the webhook records ONE CARD payment, allocated to the invoice; nothing is open; the request to pay is DONE.
    const paid = await confirm(second.provider.clientSecret, 'succeed')
    expect(paid.json()).toMatchObject({ state: 'succeeded', error: null, webhooks: [{ type: 'payment_intent.succeeded', status: 200 }] })
    expect(await processWebhooks()).toBe(1)
    const [intent] = await admin<Json>(`SELECT status, "paymentId", "providerRef", "finishedAt" FROM "PaymentIntent" WHERE id = $1`, [paidIntent])
    expect(intent).toMatchObject({ status: 'SUCCEEDED' })
    const payments = await admin<Json>(`SELECT id, method, amount, "externalRef", status FROM "Payment" WHERE "externalRef" = $1`, [intent!.providerRef])
    expect(payments).toEqual([{ id: intent!.paymentId, method: 'CARD', amount: open, externalRef: intent!.providerRef, status: 'RECEIVED' }])
    expect(await admin(`SELECT amount FROM "PaymentAllocation" WHERE "paymentId" = $1 AND "invoiceId" = $2`, [intent!.paymentId, A.FT1])).toEqual([{ amount: open }])
    expect(await admin(`SELECT status FROM "PartnerTask" WHERE "recordId" = $1 AND kind = 'PAY_INVOICE'`, [A.FT1])).toEqual([{ status: 'DONE' }])
    const events = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = 'payment_intent.finished' AND subject = $1`, [paidIntent])
    expect(events.map((row) => row.payload)).toEqual([{ intentId: paidIntent, partyId: A.P1, target: 'INVOICE', targetId: A.FT1, method: 'CARD', status: 'SUCCEEDED', paymentId: intent!.paymentId }])
  })

  it('a repeated webhook changes nothing: the same delivery is a duplicate, the same success again records nothing', async () => {
    const [receipt] = await admin<{ id: string; body: string }>(`SELECT id, body FROM "InboundWebhook" WHERE "tenantId" = $1 AND "eventType" = 'payment_intent.succeeded' ORDER BY "receivedAt" DESC LIMIT 1`, [A.tenant])
    expect(await processReceipt(system(), receipt!.id, newId(), inboundRuntime())).toBe('settled')
    const [intent] = await admin<Json>(`SELECT "providerRef" FROM "PaymentIntent" WHERE id = $1`, [paidIntent])
    const outcome = await command(system(), { name: 'payments.testReplay', input: {} }, async (tools) => {
      const applied = await applyIntentEvent(tools, accountId, { eventId: `evt_${randomUUID()}`, type: 'payment_intent.succeeded', providerRef: intent!.providerRef, intentId: paidIntent, state: 'succeeded', amount: open, currency: 'EUR', failureCode: null })
      tools.audit({ recordType: 'PaymentIntent', recordId: paidIntent, after: { applied } })
      return { applied }
    })
    expect(outcome.result.applied).toBe('nothing')
    expect(await admin(`SELECT count(*)::int AS n FROM "Payment" WHERE "externalRef" = $1`, [intent!.providerRef])).toEqual([{ n: 1 }])
  })

  it('the receipt goes to the link’s address on the invoice’s thread; the page says Paid', async () => {
    const after = await afterIntentFinished(system(), paidIntent, newId(), runtime)
    expect(after).toEqual({ cancelledAtProvider: false, depositInvoice: null, receipt: 'queued' })
    const outbound = await admin<Json>(`SELECT "recordType", "recordId", "to", subject FROM "EmailOutbound" WHERE "recordType" = 'Invoice' AND "recordId" = $1 AND subject LIKE $2`, [A.FT1, '%FT-2026-00001%'])
    expect(outbound.some((row) => /Pagamento ricevuto|Payment received/.test(row.subject))).toBe(true)
    const page = (await linkGet(token, '/payments/link/pay')).json()
    expect(page).toMatchObject({ status: 'PAID', bank: null, intent: { id: paidIntent, status: 'SUCCEEDED' }, what: { open: 0 } })
    const list = await office.get(`/payments/intents?invoiceId=${A.FT1}`)
    expect(list.status, JSON.stringify(list.body)).toBe(200)
    expect(list.body.intents.map((row: Json) => row.status)).toEqual(['SUCCEEDED', 'FAILED'])
  })

  it('a success after we failed an intent (the money taken all the same) is recorded once, unplaced; never lost', async () => {
    const [intent] = await admin<Json>(`SELECT "providerRef", amount FROM "PaymentIntent" WHERE id = $1`, [failedIntent])
    const apply = () =>
      command(system(), { name: 'payments.testLate', input: {} }, async (tools) => {
        const applied = await applyIntentEvent(tools, accountId, { eventId: `evt_${randomUUID()}`, type: 'payment_intent.succeeded', providerRef: intent!.providerRef, intentId: failedIntent, state: 'succeeded', amount: intent!.amount, currency: 'EUR', failureCode: null })
        tools.audit({ recordType: 'PaymentIntent', recordId: failedIntent, after: { applied } })
        return { applied }
      })
    expect((await apply()).result.applied).toBe('late_success')
    expect((await apply()).result.applied).toBe('nothing')
    const payments = await admin<Json>(`SELECT id, method FROM "Payment" WHERE "externalRef" = $1`, [intent!.providerRef])
    expect(payments).toHaveLength(1)
    expect(await admin(`SELECT id FROM "PaymentAllocation" WHERE "paymentId" = $1`, [payments[0]!.id])).toEqual([])
    expect(await admin(`SELECT status FROM "PaymentIntent" WHERE id = $1`, [failedIntent])).toEqual([{ status: 'FAILED' }])
  })
})

describe('the customer portal’s Finance: what is open, the statement, a deposit by SEPA (FIN-118)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const request = randomUUID()
  let finance: Browser

  beforeAll(async () => {
    // Asked by the office person (the receipt is sent as them).
    await admin(`INSERT INTO "DepositRequest" (id, "tenantId", "companyId", "partyId", "orderId", kind, currency, amount, "dueDate", "fiscalDocument", "fiscalRule", "createdById") VALUES ($1, $2, $3, $4, $5, 'ACCONTO', 'EUR', 30000, $6, 'NONE', 'test.deposit.EU_B2B_VIES', $7)`, [request, A.tenant, A.company, A.P1, A.SO2, businessDate(h.clock.now()), clerkId])
  })

  it('Finance sees the open deposit with card and SEPA; a Buyer is not let in; Home counts it', async () => {
    finance = await signedIn(people.finance)
    const items = await finance.get('/portal/payments/open-items')
    expect(items.status, JSON.stringify(items.body)).toBe(200)
    const deposit = items.body.deposits.find((row: Json) => row.depositRequestId === request)
    expect(deposit).toMatchObject({ open: 30_000, total: 30_000, currency: 'EUR', canPay: true, payment: null })
    expect(items.body).toMatchObject({ mayPay: true, card: { available: true } })
    const home = await finance.get('/portal/home')
    expect(home.status, JSON.stringify(home.body)).toBe(200)
    expect(home.body.counts.find((row: Json) => row.key === 'invoices.to_pay')?.value).toBe(items.body.invoices.length)
    const buyer = await signedIn(people.buyer)
    expect((await buyer.get('/portal/payments/open-items')).status).toBe(403)
    expect((await buyer.post('/portal/payments/intents', { depositRequestId: request, method: 'CARD' })).status).toBe(403)
    expect((await buyer.get('/portal/home')).body.counts.find((row: Json) => row.key === 'invoices.to_pay')?.value).toBe(null)
  })

  it('pays the deposit by SEPA: processing (WAITING), then settled: ONE SEPA_DEBIT payment, the request PAID, the receipt to the person', async () => {
    const started = await finance.post('/portal/payments/intents', { depositRequestId: request, method: 'SEPA_DEBIT' })
    expect(started.status, JSON.stringify(started.body)).toBe(201)
    const intentId = started.body.intent.id
    expect(started.body.intent).toMatchObject({ target: 'DEPOSIT_REQUEST', targetId: request, method: 'SEPA_DEBIT', amount: 30_000, status: 'WAITING' })
    expect(await admin(`SELECT "createdById", "linkId" FROM "PaymentIntent" WHERE id = $1`, [intentId])).toEqual([{ createdById: ids.finance, linkId: null }])
    expect((await confirm(started.body.provider.clientSecret, 'succeed')).json()).toMatchObject({ state: 'processing' })
    await processWebhooks()
    expect((await finance.get(`/portal/payments/intents/${intentId}`)).body.intent).toMatchObject({ status: 'WAITING' })
    expect((await confirm(started.body.provider.clientSecret, 'settle')).json()).toMatchObject({ state: 'succeeded' })
    await processWebhooks()
    const [intent] = await admin<Json>(`SELECT status, "paymentId" FROM "PaymentIntent" WHERE id = $1`, [intentId])
    expect(intent!.status).toBe('SUCCEEDED')
    expect(await admin(`SELECT method, amount FROM "Payment" WHERE id = $1`, [intent!.paymentId])).toEqual([{ method: 'SEPA_DEBIT', amount: 30_000 }])
    expect(await admin(`SELECT status FROM "DepositRequest" WHERE id = $1`, [request])).toEqual([{ status: 'PAID' }])
    expect(await afterIntentFinished(system(), intentId, newId(), runtime)).toEqual({ cancelledAtProvider: false, depositInvoice: 'not_required', receipt: 'queued' })
    const receipts = await admin<Json>(`SELECT "to" FROM "EmailOutbound" WHERE "recordType" = 'SalesOrder' AND "recordId" = $1 AND subject LIKE 'Payment received%'`, [A.SO2])
    expect(receipts.map((row) => row.to)).toEqual([[people.finance]])
    // Another party's payment, or an unknown one, is as unknown as a wrong id.
    expect((await finance.get(`/portal/payments/intents/${randomUUID()}`)).status).toBe(404)
    expect((await finance.post('/portal/payments/intents', { depositRequestId: randomUUID(), method: 'CARD' })).status).toBe(404)
    // Nothing left to pay: refused in words.
    const again = await finance.post('/portal/payments/intents', { depositRequestId: request, method: 'CARD' })
    expect(again.status).toBe(409)
    expect(again.body.error.issues[0].path).toBe('payment/NOT_OPEN')
  })

  it('the statement of account, with the payments, and its PDF', async () => {
    const statement = await finance.get('/portal/payments/statement?from=2026-01-01')
    expect(statement.status, JSON.stringify(statement.body)).toBe(200)
    expect(statement.body.currency).toBe('EUR')
    expect(statement.body.lines.some((line: Json) => line.kind === 'PAYMENT')).toBe(true)
    expect(statement.body).not.toHaveProperty('recipients')
    const pdf = await finance.get('/portal/payments/statement/pdf?from=2026-01-01')
    expect(pdf.status, JSON.stringify(pdf.body).slice(0, 400)).toBe(200)
    expect(pdf.response.headers['content-type']).toContain('application/pdf')
  })

  it('a paused payment account: bank transfer only, a card payment refused in words', async () => {
    await inTenant((client) => client.integrationAccount.update({ where: { id: accountId }, data: { status: 'PAUSED' }, select: { id: true } }))
    try {
      const other = randomUUID()
      await admin(`INSERT INTO "DepositRequest" (id, "tenantId", "companyId", "partyId", "orderId", kind, currency, amount, "dueDate", "fiscalDocument", "fiscalRule") VALUES ($1, $2, $3, $4, $5, 'ACCONTO', 'EUR', 10000, $6, 'NONE', 'test.deposit.EU_B2B_VIES')`, [other, A.tenant, A.company, A.P1, A.SO2, businessDate(h.clock.now())])
      const items = await finance.get('/portal/payments/open-items')
      expect(items.body.card).toMatchObject({ available: false, reason: 'NOT_ACTIVE' })
      const refused = await finance.post('/portal/payments/intents', { depositRequestId: other, method: 'CARD' })
      expect(refused.status).toBe(409)
      expect(refused.body.error.issues[0].path).toBe('payment/NO_PROVIDER')
    } finally {
      await inTenant((client) => client.integrationAccount.update({ where: { id: accountId }, data: { status: 'ACTIVE' }, select: { id: true } }))
    }
  })
})
