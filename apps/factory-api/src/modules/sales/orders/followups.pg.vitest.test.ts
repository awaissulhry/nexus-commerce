import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCompliance } from '../../../../../../packages/factory-db/seed/compliance'
import { seed as seedCosting } from '../../../../../../packages/factory-db/seed/costing'
import { seed as seedPricing } from '../../../../../../packages/factory-db/seed/pricing'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { textOf } from '../../../adapters/ses/fake'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'

/**
 * Orders follow-ups (B-W2b-16) on the local stack: a throwaway PostgreSQL 17 database from the migrations (the runtime
 * login: row-level security and the …_sales_w2a_guards / …_followups_platform_w2b_guards triggers are real), the real app
 * with test sessions, and a real owner signed in with two-factor for the step-up. The tenant of the factory-db seeds up to
 * pricing and the reason lists: P1 buys on DEP30 (30 % on the order, the rest before shipping), its INVOICES contact has an
 * address. Covered: a typed order's deposit requests get their event (deposit_request.created_for_order) and its deposit
 * page goes to the customer's invoices contact on the order's thread; the owner waives a step before shipping (its request
 * too) with a reason and a fresh step-up; a closed-short line keeps its CANCEL reason code and the reopen clears it (also a
 * code planted before: B-W2b-03's note — a DB 500 before this step); raising a quote approval limit asks for step-up. Every
 * name, price and number is made up. Run with `node scripts/factory/run-pg-tests.mjs sales/orders/followups`.
 */

let h: Harness
let app: FastifyInstance

const NS = 'w2b16-orders-a'
const idIn = (key: string) => seedUuid(NS, key)
const T = idIn('tenant')
const companyA = idIn('company:A')
const P1 = idIn('party:P1')
const JKT01 = idIn('product:style:JKT-01')
const JKT01_BLK = idIn('product:colourway:JKT-01:BLK')
const JKT02 = idIn('production:style:JKT-02')
const JKT02_RED = idIn('production:colourway:JKT-02:RED')
const TODAY = businessDate(new Date())
const PROMISE = addDays(TODAY, 40)
const TENANT: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'A' }] }

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
let counter = 0
const key = (label = 'k'): string => `followups-${label}-${++counter}-${newId()}`

const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (permissions: Permission[], actorId = newId()): (() => SessionContext) => () => ({ audience: 'office', tenantId: T, actorId, grants: [grant(permissions)] })
const SALES: Permission[] = ['orders.view', 'orders.manage', 'quotes.view', 'quotes.manage', 'paymentterms.view', 'money.price', 'money.cost', 'money.margin', 'sales.settings.manage']
const SESSIONS: Record<string, () => SessionContext> = {
  sales: office(SALES),
  // Holds the waive right (a test session has no office sign-in: refusals before the step-up only).
  waiverNoStepUp: office([...SALES, 'orders.waive']),
  viewer: office(['orders.view']),
}

async function call(session: string, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown) {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key(session) }) }, ...(body === undefined ? {} : { payload: body as object }) })
  return { status: response.statusCode, body: response.json() as Json }
}
async function ok(session: string, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await call(session, method, url, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body
}
async function refused(session: string, method: 'GET' | 'POST' | 'PUT', url: string, body: unknown, status: number): Promise<Json> {
  const answer = await call(session, method, url, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body.error
}
async function as(browser: Browser, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, status = 200): Promise<Json> {
  // The harness's browser types GET and POST only; the app takes PUT the same way (the settings' save).
  const answer = await browser.send(method as 'GET' | 'POST', url, method === 'GET' ? undefined : (body ?? {}), { headers: { 'idempotency-key': key('owner') } })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}
const events = async (type: string, subject: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = $1 AND subject = $2 ORDER BY "occurredAt", id`, [type, subject])).map((row) => row.payload)
const orderUrl = (id: string) => `/sales/orders/${id}`
const grid = (rows: [string, number][]) => rows.map(([size, quantity]) => ({ size, quantity }))
const MANUAL = {
  companyId: companyA,
  partyId: P1,
  customerRef: 'PO-FOLLOW-16',
  promiseDate: PROMISE,
  lines: [
    { styleId: JKT01, colourwayId: JKT01_BLK, sizes: grid([['50', 2], ['52', 2]]) },
    { styleId: JKT02, colourwayId: JKT02_RED, sizes: grid([['52', 3]]), unitPrice: '400' },
  ],
}

let owner: { browser: Browser; secret: string }

beforeAll(async () => {
  h = await startHarness('orders_followups')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedCompliance({ db: h.database, namespace: NS })
  await seedCosting({ db: h.database, namespace: NS })
  await seedPricing({ db: h.database, namespace: NS })
  await seedReasons({ db: h.database, namespace: NS })
  // The system roles as the templates hold them now (the owner holds orders.waive).
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  // The seeds' FAKE mail account, with a verified conversation address (the deposit page's mail).
  const ses = idIn('integration:account:ses')
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE id = $1`, [ses])
  await admin(
    `INSERT INTO "EmailIdentity" (id, "tenantId", "companyId", kind, domain, "fromAddress", "displayName", "displayNamePolicy", "replyDomain", "accountId", "verificationStatus", "dkimStatus", "isDefault")
     VALUES ($1, $2, $3, 'CONVERSATION', 'mail.w2b16.example.com', 'sales@mail.w2b16.example.com', 'Seed A', 'COMPANY', 'reply.w2b16.example.com', $4, 'SUCCESS', 'SUCCESS', true)`,
    [newId(), T, companyA, ses],
  )
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
  const user = await addUser(h, TENANT, { email: 'owner.followups@example.com', role: 'owner' })
  const browser = new Browser(h.app)
  const signIn = await browser.signIn(TENANT.slug, user.email, user.password)
  if (signIn.body.status !== 'signed_in') throw new Error(`sign-in: ${signIn.status} ${JSON.stringify(signIn.body)}`)
  owner = { browser, secret: await enrolTotp(h, browser) }
}, 300_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

let typed: Json

describe("a typed order's deposit: its event and its page (Z4:06)", () => {
  it('each deposit request made on the order has deposit_request.created_for_order (the deposit, the balance before shipping)', async () => {
    typed = (await ok('sales', 'POST', '/sales/orders/manual', MANUAL, 201)).order
    const [deposit, balance] = typed.chain.depositRequests as [Json, Json]
    expect([deposit.stepKind, balance.stepKind]).toEqual(['DEPOSIT', 'BEFORE_SHIPPING'])
    expect(await events('deposit_request.created_for_order', deposit.id)).toEqual([{ depositRequestId: deposit.id, orderId: typed.id, number: typed.number, partyId: P1, stepKind: 'DEPOSIT', fiscalDocument: 'TD02', dueDate: deposit.dueDate }])
    expect(await events('deposit_request.created_for_order', balance.id)).toEqual([{ depositRequestId: balance.id, orderId: typed.id, number: typed.number, partyId: P1, stepKind: 'BEFORE_SHIPPING', fiscalDocument: 'TD02', dueDate: PROMISE }])
    // No amount travels in the event.
    expect(JSON.stringify(await events('deposit_request.created_for_order', deposit.id))).not.toMatch(/amount/i)
  })

  it("the deposit page goes to the customer's invoices contact on the order's thread; the page names the order, no quote", async () => {
    const deposit = typed.chain.depositRequests[0]
    const before = h.ses.mails.length
    const sent = await as(owner.browser, 'POST', `/payments/deposit-requests/${deposit.id}/link`, {}, 201)
    expect(sent.link.to).toBe('accounts.p1@example.com')
    const mail = h.ses.mails.slice(before).find((entry) => entry.outboundId === sent.emailId)!
    const text = textOf(mail.raw)
    expect(text).toContain(`ordine ${typed.number}`)
    const [thread] = await admin(`SELECT t."recordType", t."recordId" FROM "EmailOutbound" o JOIN "Thread" t ON t.id = o."threadId" WHERE o.id = $1`, [sent.emailId])
    expect(thread).toEqual({ recordType: 'SalesOrder', recordId: typed.id })
    expect(await events('deposit_request.link_sent', deposit.id)).toEqual([{ depositRequestId: deposit.id, quoteId: null, orderId: typed.id, partyId: P1, linkId: sent.link.id }])
    const token = decodeURIComponent(/#token=(\S+)/.exec(text)?.[1] ?? '')
    const page = await h.app.inject({ method: 'GET', url: '/payments/link/deposit', headers: { 'x-factory-link': token } })
    expect(page.statusCode, page.body).toBe(200)
    expect(page.json()).toMatchObject({ quote: null, order: { number: typed.number }, deposit: { depositPct: '30', paid: false } })
    expect(page.json().instructions.reference).toContain(typed.number)
    // A contact of another customer is refused in words.
    const foreign = idIn('party-contact:P3:buyer')
    const other = await owner.browser.send('POST', `/payments/deposit-requests/${deposit.id}/link`, { contactId: foreign }, { headers: { 'idempotency-key': key('link') } })
    expect(other.status, JSON.stringify(other.body)).toBe(409)
  })
})

describe('the owner waives a step before shipping (Z4:07)', () => {
  it('refuses without the waive right, without a fresh step-up, a stale version and no reason', async () => {
    const schedule = await ok('sales', 'GET', `${orderUrl(typed.id)}/schedule`)
    const balance = schedule.steps.find((step: Json) => step.kind === 'BEFORE_SHIPPING')
    const url = `${orderUrl(typed.id)}/schedule/${balance.id}/waive`
    expect((await refused('sales', 'POST', url, { version: balance.version, reason: 'Long-standing customer.' }, 403)).code).toBe('forbidden')
    expect((await refused('waiverNoStepUp', 'POST', url, { version: balance.version, reason: 'x' }, 400)).issues[0].path).toBe('body/reason')
    // The owner's last step-up (at the two-factor set-up) is more than five minutes old.
    h.clock.advance(6 * 60_000)
    expect((await as(owner.browser, 'POST', url, { version: balance.version, reason: 'Long-standing customer.' }, 403)).error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])
    await stepUp(h, owner.browser, owner.secret)
    expect((await as(owner.browser, 'POST', url, { version: balance.version + 5, reason: 'Long-standing customer.' }, 409)).error.code).toBe('conflict')
  })

  it('waives the balance before shipping and its deposit request (nothing paid), with the reason; then nothing is left to waive', async () => {
    const schedule = await ok('sales', 'GET', `${orderUrl(typed.id)}/schedule`)
    const balance = schedule.steps.find((step: Json) => step.kind === 'BEFORE_SHIPPING')
    await stepUp(h, owner.browser, owner.secret)
    const waived = await as(owner.browser, 'POST', `${orderUrl(typed.id)}/schedule/${balance.id}/waive`, { version: balance.version, reason: 'Long-standing customer: the balance is billed with the goods.' })
    expect(waived.waived).toEqual({ milestoneIds: [balance.id], depositRequestId: balance.depositRequestId })
    expect(waived.steps.map((step: Json) => [step.kind, step.status])).toEqual([['DEPOSIT', 'OPEN'], ['BEFORE_SHIPPING', 'WAIVED']])
    expect(waived.steps[1].statusNote).toBe('Waived: Long-standing customer: the balance is billed with the goods.')
    expect(await admin('SELECT status::text AS status, "statusNote" FROM "DepositRequest" WHERE id = $1', [balance.depositRequestId])).toEqual([{ status: 'WAIVED', statusNote: 'Waived: Long-standing customer: the balance is billed with the goods.' }])
    expect((await events('sales_order.schedule_changed', typed.id)).map((payload) => payload.change)).toEqual(['MADE', 'WAIVED'])
    expect(await events('deposit_request.waived', balance.depositRequestId)).toEqual([{ depositRequestId: balance.depositRequestId, orderId: typed.id, number: typed.number, partyId: P1, milestoneIds: [balance.id] }])
    const [audit] = await admin(`SELECT reason FROM "AuditLog" WHERE action = 'orders.waiveStep' AND "recordId" = $1`, [typed.id])
    expect(audit).toEqual({ reason: 'Long-standing customer: the balance is billed with the goods.' })
    // Again: the step is waived.
    await stepUp(h, owner.browser, owner.secret)
    const again = await as(owner.browser, 'POST', `${orderUrl(typed.id)}/schedule/${balance.id}/waive`, { version: waived.steps[1].version, reason: 'Twice.' }, 409)
    expect(again.error.message).toBe(`This step of order ${typed.number} is waived: there is nothing to waive.`)
  })

  it('a deposit request is waived by its id too (its step with it); the order list then says the deposit is waived', async () => {
    const second = (await ok('sales', 'POST', '/sales/orders/manual', { ...MANUAL, customerRef: 'PO-FOLLOW-17', lines: [MANUAL.lines[0]] }, 201)).order
    const deposit = second.chain.depositRequests[0]
    const request = (await admin<{ version: number }>('SELECT version FROM "DepositRequest" WHERE id = $1', [deposit.id]))[0]!
    await stepUp(h, owner.browser, owner.secret)
    const waived = await as(owner.browser, 'POST', `${orderUrl(second.id)}/deposit-requests/${deposit.id}/waive`, { version: request.version, reason: 'Agreed by phone: production starts now.' })
    expect(waived.steps.map((step: Json) => [step.kind, step.status])).toEqual([['DEPOSIT', 'WAIVED'], ['BEFORE_SHIPPING', 'OPEN']])
    expect((await ok('sales', 'GET', `/sales/orders?q=${second.number}`)).orders[0].deposit.state).toBe('WAIVED')
  })
})

describe('closed-short reason codes (Z4:09)', () => {
  it('a close keeps the CANCEL reason code with the words; an unknown code is refused; the reopen clears it', async () => {
    const order = (await ok('sales', 'GET', orderUrl(typed.id))).order
    const line = order.lines[1]
    expect((await refused('sales', 'POST', `${orderUrl(typed.id)}/close-lines`, { version: order.version, reason: 'Red sold out.', reasonCode: 'NO_SUCH_CODE', lineIds: [line.id] }, 400)).issues).toEqual([{ path: 'body/reasonCode', message: 'Pick an active reason of the cancel list.' }])
    const closed = await ok('sales', 'POST', `${orderUrl(typed.id)}/close-lines`, { version: order.version, reason: 'The customer cancelled the red ones.', reasonCode: 'CUSTOMER_REQUEST', lineIds: [line.id] })
    expect(closed.order.lines[1].closedShort).toMatchObject({ quantity: 3, reason: 'The customer cancelled the red ones.', reasonCode: 'CUSTOMER_REQUEST' })
    expect(await admin('SELECT "closedShortReasonCode" AS code FROM "SalesOrderLine" WHERE id = $1', [line.id])).toEqual([{ code: 'CUSTOMER_REQUEST' }])
    const reopened = await ok('sales', 'POST', `${orderUrl(typed.id)}/reopen-lines`, { version: closed.order.version, reason: 'They want them after all.', lineIds: [line.id] })
    expect(reopened.order.lines[1].closedShort).toBeNull()
    expect(await admin('SELECT "closedShortReasonCode" AS code FROM "SalesOrderLine" WHERE id = $1', [line.id])).toEqual([{ code: null }])
  })

  it('a code planted on a line closed without one (a W2a client) no longer makes the reopen fail (B-W2b-03)', async () => {
    const order = (await ok('sales', 'GET', orderUrl(typed.id))).order
    const line = order.lines[1]
    const closed = await ok('sales', 'POST', `${orderUrl(typed.id)}/close-lines`, { version: order.version, reason: 'Closed by an older screen.', lineIds: [line.id] })
    expect(closed.order.lines[1].closedShort.reasonCode).toBeNull()
    await admin(`UPDATE "SalesOrderLine" SET "closedShortReasonCode" = 'PRICE' WHERE id = $1`, [line.id])
    expect((await ok('sales', 'GET', orderUrl(typed.id))).order.lines[1].closedShort.reasonCode).toBe('PRICE')
    const reopened = await ok('sales', 'POST', `${orderUrl(typed.id)}/reopen-lines`, { version: closed.order.version, reason: 'Back.', lineIds: [line.id] })
    expect(reopened.reopened).toEqual([line.id])
    expect(await admin('SELECT "closedShortReasonCode" AS code, "closedShortQuantity" AS quantity FROM "SalesOrderLine" WHERE id = $1', [line.id])).toEqual([{ code: null, quantity: null }])
  })
})

describe('raising a quote approval limit asks for step-up (Z4:08)', () => {
  it('a lower discount limit or a higher margin floor saves at once; a raised limit needs a fresh step-up', async () => {
    const first = (await ok('sales', 'PUT', '/sales/settings', { companyId: companyA, marginFloorPct: '25', discountLimitPct: '10', defaultValidityDays: 30, defaultDepositPct: '30' })).settings
    expect(first).toMatchObject({ marginFloorPct: '25', discountLimitPct: '10' })
    // Raising the discount limit, or lowering the margin floor, lets more quotes through without an approver: the owner's
    // last step-up is more than five minutes old.
    h.clock.advance(6 * 60_000)
    expect((await as(owner.browser, 'PUT', '/sales/settings', { companyId: companyA, version: first.version, marginFloorPct: '25', discountLimitPct: '18', defaultValidityDays: 30, defaultDepositPct: '30' }, 403)).error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])
    expect((await as(owner.browser, 'PUT', '/sales/settings', { companyId: companyA, version: first.version, marginFloorPct: '20', discountLimitPct: '10', defaultValidityDays: 30, defaultDepositPct: '30' }, 403)).error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])
    // Other fields, and tightening, need none.
    const tighter = (await ok('sales', 'PUT', '/sales/settings', { companyId: companyA, version: first.version, marginFloorPct: '26', discountLimitPct: '9', defaultValidityDays: 45, defaultDepositPct: '30' })).settings
    expect(tighter).toMatchObject({ marginFloorPct: '26', discountLimitPct: '9', defaultValidityDays: 45 })
    await stepUp(h, owner.browser, owner.secret)
    const raised = (await as(owner.browser, 'PUT', '/sales/settings', { companyId: companyA, version: tighter.version, marginFloorPct: '20', discountLimitPct: '18', defaultValidityDays: 45, defaultDepositPct: '30' })).settings
    expect(raised).toMatchObject({ marginFloorPct: '20', discountLimitPct: '18' })
  })
})
