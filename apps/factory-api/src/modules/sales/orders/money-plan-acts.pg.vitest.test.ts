import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { BY_HAND_NOTES, MONEY_PLAN_REFUSAL_WORDS, UNDO_HELD_WORDS } from '@nexus/factory-domain/sales/orders/money-plan'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCompliance } from '../../../../../../packages/factory-db/seed/compliance'
import { seed as seedCosting } from '../../../../../../packages/factory-db/seed/costing'
import { seed as seedPricing } from '../../../../../../packages/factory-db/seed/pricing'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { NO_PRICE_WORDS } from './money-plan'

/**
 * B-OM-010 … 018 — an order's money plan changed BY HAND (order money tab, PR S2; 13-backend §3), on the local stack: a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security and the deposit request, milestone, payment and
 * allocation guards are real), the tenant of the factory-db seeds up to pricing (P1 = Brand Alpha buys on DEP30: 30 % on the order,
 * the rest before shipping), the real app with test sessions holding the role templates' grants, and a real Owner signed in with
 * two-factor for the fresh code. Each case types its own order (as the Owner) with a deposit and a balance before shipping:
 *
 *   S2.2  replace the deposit (old request CANCELLED in plain words, a new one in its place, the old deposit page revoked, the plan
 *         read names the replacement); money placed refuses; move a due day (step and request); ask again after a waive (the gate
 *         waits again); every write sends the version; the preview writes nothing and says a refusal in words
 *   S2.3  add / change / remove / rename a step, undo an opening; a hand-moved balance survives an amendment and new terms; new
 *         terms ask a fresh code (the preview says so; a test session has no sign-in to give one: the Owner's browser gives it)
 *   S2.4  accept a short deposit within the tolerance (PAID by hand, its step PAID, a later payment refused); beyond it Finance is
 *         refused, the Owner with a fresh code accepts; undo a part payment (reversed and voided), one that pays the deposit too (only
 *         this part), a PAID deposit held in words
 *   S2.5  the walls: Sales (the real template) may not act; a money-plan holder without prices may not move an amount; a person
 *         limited to another customer gets the same words as an unknown order, on the act, the preview and the undo
 * Every name, price and number is made up. Run with `node scripts/factory/run-pg-tests.mjs sales/orders/money-plan-acts`.
 */

let h: Harness
let app: FastifyInstance

const NS = 'om-s2-money-plan'
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
type Method = 'GET' | 'POST' | 'PUT'
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
let counter = 0
const key = (label = 'k'): string => `om-s2-${label}-${++counter}-${newId()}`

const grant = (permissions: Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const templateGrant = (role: string, parties: Grant['parties'] = 'all'): Grant => {
  const template = templateOf(role)!
  return grant([...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], parties)
}
const SESSIONS: Record<string, () => SessionContext> = {
  // The real templates: Finance holds orders.moneyPlan (B-OM-010), the payments rights and the price grain; Sales neither.
  finance: () => ({ audience: 'office', tenantId: T, actorId: newId(), grants: [templateGrant('finance')] }),
  sales: () => ({ audience: 'office', tenantId: T, actorId: newId(), grants: [templateGrant('sales')] }),
  // A custom role with the money plan but no prices: no amount act.
  planNoPrice: () => ({ audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['orders.view', 'orders.moneyPlan'])] }),
  // Finance limited to another customer (a made-up one): Brand Alpha's orders are unknown to it.
  otherCustomer: () => ({ audience: 'office', tenantId: T, actorId: newId(), grants: [templateGrant('finance', [newId()])] }),
}

async function call(session: string, method: Method, url: string, body?: unknown) {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key(session) }) }, ...(body === undefined ? {} : { payload: body as object }) })
  return { status: response.statusCode, body: response.json() as Json }
}
async function ok(session: string, method: Method, url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await call(session, method, url, body)
  expect(answer.status, `${session} ${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  return answer.body
}
async function refused(session: string, method: Method, url: string, body: unknown, status: number): Promise<Json> {
  const answer = await call(session, method, url, body)
  expect(answer.status, `${session} ${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  return answer.body.error
}
let owner: { browser: Browser; secret: string }
async function as(method: Method, url: string, body?: unknown, status = 200): Promise<Json> {
  // The harness's browser types GET and POST only; the app takes PUT the same way.
  const answer = await owner.browser.send(method as 'GET' | 'POST', url, method === 'GET' ? undefined : (body ?? {}), { headers: { 'idempotency-key': key('owner') } })
  expect(answer.status, `owner ${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  return answer.body as Json
}
const events = async (type: string, subject: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = $1 AND subject = $2 ORDER BY "occurredAt", id`, [type, subject])).map((row) => row.payload)
const orderUrl = (id: string) => `/sales/orders/${id}`
const planUrl = (id: string) => `/sales/orders/${id}/money-plan`
const grid = (rows: [string, number][]) => rows.map(([size, quantity]) => ({ size, quantity }))

/** A typed order of Brand Alpha (the Owner's: its lines carry prices): its deposit 30 % and the balance before shipping. */
async function typedOrder(ref: string) {
  const order = (
    await as('POST', '/sales/orders/manual', {
      companyId: companyA,
      partyId: P1,
      customerRef: ref,
      promiseDate: PROMISE,
      lines: [
        { styleId: JKT01, colourwayId: JKT01_BLK, sizes: grid([['50', 2], ['52', 2]]) },
        { styleId: JKT02, colourwayId: JKT02_RED, sizes: grid([['52', 3]]), unitPrice: '400' },
      ],
    }, 201)
  ).order as Json
  return order
}
/** The plan read as Finance reads it (every figure, the payments). */
const planOf = (orderId: string) => ok('finance', 'GET', `${orderUrl(orderId)}/schedule`)
const stepOf = (plan: Json, kind: string) => (plan.steps as Json[]).find((step) => step.kind === kind && step.status !== 'CANCELLED')!
const requestOf = (plan: Json, id: string) => (plan.requests as Json[]).find((request) => request.id === id)!
/** A payment of Brand Alpha placed on deposit requests (Finance records it, as Payments › Record a payment does). */
async function paid(allocations: { depositRequestId: string; amount: number }[], ref: string): Promise<Json> {
  const amount = allocations.reduce((sum, entry) => sum + entry.amount, 0)
  return (await ok('finance', 'POST', '/payments', { companyId: companyA, partyId: P1, amount, receivedOn: TODAY, externalRef: ref, allocations }, 201)).payment
}

beforeAll(async () => {
  h = await startHarness('om_s2_money_plan')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedCompliance({ db: h.database, namespace: NS })
  await seedCosting({ db: h.database, namespace: NS })
  await seedPricing({ db: h.database, namespace: NS })
  await seedReasons({ db: h.database, namespace: NS })
  // The system roles as the templates hold them now (Finance holds orders.moneyPlan, the owner every permission).
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  // The seeds' FAKE mail account, with a verified conversation address (the deposit page's mail).
  const ses = idIn('integration:account:ses')
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE id = $1`, [ses])
  await admin(
    `INSERT INTO "EmailIdentity" (id, "tenantId", "companyId", kind, domain, "fromAddress", "displayName", "displayNamePolicy", "replyDomain", "accountId", "verificationStatus", "dkimStatus", "isDefault")
     VALUES ($1, $2, $3, 'CONVERSATION', 'mail.om-s2.example.com', 'sales@mail.om-s2.example.com', 'Seed A', 'COMPANY', 'reply.om-s2.example.com', $4, 'SUCCESS', 'SUCCESS', true)`,
    [newId(), T, companyA, ses],
  )
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
  const user = await addUser(h, TENANT, { email: 'owner.om-s2@example.com', role: 'owner' })
  const browser = new Browser(h.app)
  const signIn = await browser.signIn(TENANT.slug, user.email, user.password)
  if (signIn.body.status !== 'signed_in') throw new Error(`sign-in: ${signIn.status} ${JSON.stringify(signIn.body)}`)
  owner = { browser, secret: await enrolTotp(h, browser) }
  // A tenant-wide write-off tolerance of 25.00 (the accept-short case reads it).
  await stepUp(h, owner.browser, owner.secret)
  await as('PUT', '/payments/write-offs/tolerance', { companyId: null, amount: 2_500 })
}, 300_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

// ════ S2.2 — B-OM-011, 012, 013: replace the deposit, move a due day, ask again after a waive ════
describe('B-OM-011 replace the deposit', () => {
  it('the old request CANCELLED in plain words, a new one in its place, the deposit step re-pointed, the old deposit page revoked; audit, events', async () => {
    const order = await typedOrder('PO-OM-S2-01')
    const before = await planOf(order.id)
    const deposit = stepOf(before, 'DEPOSIT')
    const old = requestOf(before, deposit.depositRequestId)
    // A live deposit page of the old request (the customer's invoices contact).
    const sent = await as('POST', `/payments/deposit-requests/${old.id}/link`, {}, 201)
    const answer = await ok('finance', 'POST', planUrl(order.id), { act: 'REPLACE_DEPOSIT', requestId: old.id, version: old.version, pct: '40', reason: 'Made-up: the customer asked for 40 % now.' })
    const fresh = stepOf(answer, 'DEPOSIT')
    expect(fresh.id).toBe(deposit.id)
    expect(fresh.depositRequestId).not.toBe(old.id)
    expect(fresh.amount).toBe(Math.round(order.grossAmount * 0.4))
    expect(fresh.byHand).toMatchObject({ act: 'REPLACE_DEPOSIT', reason: 'Made-up: the customer asked for 40 % now.' })
    expect(requestOf(answer, old.id)).toMatchObject({ status: 'CANCELLED', replacedBy: fresh.depositRequestId })
    expect(requestOf(answer, fresh.depositRequestId)).toMatchObject({ status: 'OPEN', amount: fresh.amount, paid: 0, stepKind: 'DEPOSIT' })
    expect(answer.changed).toMatchObject({ act: 'REPLACE_DEPOSIT', milestoneIds: expect.arrayContaining([deposit.id]), depositRequestIds: expect.arrayContaining([old.id, fresh.depositRequestId]) })
    // The note is plain words (Sales reads it), never the reason.
    expect(await admin(`SELECT status::text AS status, "statusNote" FROM "DepositRequest" WHERE id = $1`, [old.id])).toEqual([{ status: 'CANCELLED', statusNote: BY_HAND_NOTES.REPLACED }])
    expect((await admin(`SELECT "revokedAt" FROM "OneOffLink" WHERE id = $1`, [sent.link.id]))[0]!.revokedAt).not.toBeNull()
    const [audit] = await admin(`SELECT after, reason FROM "AuditLog" WHERE action = 'orders.planByHand' AND "recordId" = $1`, [order.id])
    expect(audit).toMatchObject({ reason: 'Made-up: the customer asked for 40 % now.', after: { act: 'REPLACE_DEPOSIT', replacements: [{ from: old.id, to: fresh.depositRequestId }] } })
    expect((await events('sales_order.schedule_changed', order.id)).map((row) => row.change)).toContain('BY_HAND')
    expect(await events('deposit_request.created_for_order', fresh.depositRequestId)).toEqual([expect.objectContaining({ orderId: order.id, stepKind: 'DEPOSIT' })])
    // The order's version moved: production waits for the new deposit (the gate takes the order's live requests).
    expect((await ok('finance', 'GET', orderUrl(order.id))).order.version).toBeGreaterThan(order.version)
  })

  it('refused in words once money is placed on it; a stale version is refused; the preview writes nothing and says why', async () => {
    const order = await typedOrder('PO-OM-S2-02')
    const plan = await planOf(order.id)
    const request = requestOf(plan, stepOf(plan, 'DEPOSIT').depositRequestId)
    await paid([{ depositRequestId: request.id, amount: 10_000 }], 'OM-S2-0002')
    const again = requestOf(await planOf(order.id), request.id)
    const body = { act: 'REPLACE_DEPOSIT', requestId: request.id, version: again.version, amount: 50_000, reason: 'Made-up: a bigger deposit.' }
    const error = await refused('finance', 'POST', planUrl(order.id), body, 409)
    expect(error).toMatchObject({ message: MONEY_PLAN_REFUSAL_WORDS.MONEY_PLACED.en, issues: [{ path: 'moneyPlan/MONEY_PLACED', message: MONEY_PLAN_REFUSAL_WORDS.MONEY_PLACED.en }] })
    const preview = await ok('finance', 'POST', `${planUrl(order.id)}/preview`, body)
    expect(preview).toEqual({ act: 'REPLACE_DEPOSIT', refusal: { code: 'MONEY_PLACED', words: MONEY_PLAN_REFUSAL_WORDS.MONEY_PLACED }, preview: null })
    await refused('finance', 'POST', planUrl(order.id), { ...body, version: again.version + 5 }, 409)
    expect(await admin(`SELECT count(*)::int AS n FROM "AuditLog" WHERE action = 'orders.planByHand' AND "recordId" = $1`, [order.id])).toEqual([{ n: 0 }])
  })
})

describe('B-OM-012 move a due day; B-OM-013 ask again after a waive', () => {
  it('the balance and its open request move together; the plan read tags the step "Set by hand"', async () => {
    const order = await typedOrder('PO-OM-S2-03')
    const balance = stepOf(await planOf(order.id), 'BEFORE_SHIPPING')
    const day = addDays(PROMISE, -10)
    const preview = await ok('finance', 'POST', `${planUrl(order.id)}/preview`, { act: 'MOVE_DUE', milestoneId: balance.id, version: balance.version, dueDate: day, reason: 'Made-up: shipping comes earlier.' })
    expect(preview.preview.steps).toEqual([expect.objectContaining({ id: balance.id, before: expect.objectContaining({ dueDate: balance.dueDate }), after: expect.objectContaining({ dueDate: day }) })])
    const answer = await ok('finance', 'POST', planUrl(order.id), { act: 'MOVE_DUE', milestoneId: balance.id, version: balance.version, dueDate: day, reason: 'Made-up: shipping comes earlier.' })
    expect(stepOf(answer, 'BEFORE_SHIPPING')).toMatchObject({ id: balance.id, dueDate: day, byHand: { act: 'MOVE_DUE' } })
    expect(requestOf(answer, balance.depositRequestId)).toMatchObject({ status: 'OPEN', dueDate: day })
    expect(await refused('finance', 'POST', planUrl(order.id), { act: 'MOVE_DUE', milestoneId: balance.id, version: balance.version + 1, dueDate: addDays(TODAY, -1), reason: 'Made-up: yesterday.' }, 409)).toMatchObject({ issues: [{ path: 'moneyPlan/PAST_DAY' }] })
  })

  it('a waived deposit asked again: a new open request and step; the waived rows stay; production waits for it again', async () => {
    const order = await typedOrder('PO-OM-S2-04')
    const plan = await planOf(order.id)
    const deposit = stepOf(plan, 'DEPOSIT')
    await stepUp(h, owner.browser, owner.secret)
    await as('POST', `${orderUrl(order.id)}/schedule/${deposit.id}/waive`, { version: deposit.version, reason: 'Made-up: agreed by phone.' })
    const waived = (await planOf(order.id)).steps.find((step: Json) => step.id === deposit.id)
    expect(waived.status).toBe('WAIVED')
    const day = addDays(TODAY, 7)
    const answer = await ok('finance', 'POST', planUrl(order.id), { act: 'ASK_AGAIN', milestoneId: deposit.id, version: waived.version, dueDate: day, reason: 'Made-up: the customer will pay it after all.' })
    const deposits = (answer.steps as Json[]).filter((step) => step.kind === 'DEPOSIT')
    expect(deposits.map((step) => step.status).sort()).toEqual(['OPEN', 'WAIVED'])
    const asked = deposits.find((step) => step.status === 'OPEN')!
    expect(asked).toMatchObject({ amount: deposit.amount, dueDate: day, byHand: { act: 'ASK_AGAIN' } })
    expect(requestOf(answer, asked.depositRequestId)).toMatchObject({ status: 'OPEN', amount: deposit.amount })
    expect(requestOf(answer, deposit.depositRequestId)).toMatchObject({ status: 'WAIVED', replacedBy: asked.depositRequestId })
    // The release's deposit gate reads the live requests: one OPEN, so production waits again.
    const order2 = (await ok('finance', 'GET', orderUrl(order.id))).order
    expect(order2.depositRequired).toBe(true)
    expect((order2.chain.depositRequests as Json[]).filter((entry) => entry.status === 'OPEN').map((entry) => entry.id)).toContain(asked.depositRequestId)
  })
})

// ════ S2.3 — B-OM-014, 015: steps added, changed, removed, renamed, an opening undone; terms changed; hand steps kept ════
describe('B-OM-014 the steps by hand', () => {
  it('add a step out of the balance, change it, rename it, remove it back into the balance: the sum is kept at each act', async () => {
    const order = await typedOrder('PO-OM-S2-05')
    const sum = (plan: Json) => (plan.steps as Json[]).filter((step) => step.status !== 'CANCELLED').reduce((total, step) => total + step.amount, 0)
    let plan = await planOf(order.id)
    const total = sum(plan)
    let balance = stepOf(plan, 'BEFORE_SHIPPING')
    plan = await ok('finance', 'POST', planUrl(order.id), { act: 'ADD_STEP', from: balance.id, version: balance.version, kind: 'ON_DELIVERY', amount: 10_000, reason: 'Made-up: part on delivery.' })
    expect(sum(plan)).toBe(total)
    const delivery = stepOf(plan, 'ON_DELIVERY')
    expect(delivery).toMatchObject({ amount: 10_000, status: 'OPEN', depositRequestId: null })
    balance = stepOf(plan, 'BEFORE_SHIPPING')
    plan = await ok('finance', 'POST', planUrl(order.id), { act: 'CHANGE_STEP', milestoneId: delivery.id, version: delivery.version, amount: 15_000, restTo: balance.id, reason: 'Made-up: a bit more on delivery.' })
    expect(sum(plan)).toBe(total)
    expect(stepOf(plan, 'ON_DELIVERY').amount).toBe(15_000)
    const changed = stepOf(plan, 'ON_DELIVERY')
    plan = await ok('finance', 'POST', planUrl(order.id), { act: 'RENAME_STEP', milestoneId: changed.id, version: changed.version, label: 'Alla consegna', reason: 'Made-up: as the contract says it.' })
    expect(stepOf(plan, 'ON_DELIVERY').label).toBe('Alla consegna')
    const renamed = stepOf(plan, 'ON_DELIVERY')
    balance = stepOf(plan, 'BEFORE_SHIPPING')
    plan = await ok('finance', 'POST', planUrl(order.id), { act: 'REMOVE_STEP', milestoneId: renamed.id, version: renamed.version, restTo: balance.id, reason: 'Made-up: all before shipping again.' })
    expect(sum(plan)).toBe(total)
    expect((plan.cancelled as Json[]).find((step) => step.id === renamed.id)).toMatchObject({ status: 'CANCELLED', statusNote: BY_HAND_NOTES.REMOVED })
    // Without the other step to take the difference: refused in words.
    const last = stepOf(plan, 'BEFORE_SHIPPING')
    expect(await refused('finance', 'POST', planUrl(order.id), { act: 'CHANGE_STEP', milestoneId: last.id, version: last.version, amount: 1_000, reason: 'Made-up: no rest.' }, 409)).toMatchObject({ issues: [{ path: 'moneyPlan/TOTAL_CHANGES' }] })
  })

  it('undo "Open for payment": the balance request cancelled in plain words, the step keeps its amount with no request; then opened again', async () => {
    const order = await typedOrder('PO-OM-S2-06')
    const balance = stepOf(await planOf(order.id), 'BEFORE_SHIPPING')
    const plan = await ok('finance', 'POST', planUrl(order.id), { act: 'UNDO_OPEN', milestoneId: balance.id, version: balance.version, reason: 'Made-up: asked too early.' })
    expect(stepOf(plan, 'BEFORE_SHIPPING')).toMatchObject({ id: balance.id, amount: balance.amount, depositRequestId: null })
    expect(requestOf(plan, balance.depositRequestId)).toMatchObject({ status: 'CANCELLED' })
    // B-OM-018: Finance opens it again (orders.moneyPlan); Sales may not.
    const undone = stepOf(plan, 'BEFORE_SHIPPING')
    await refused('sales', 'POST', `${orderUrl(order.id)}/schedule/${undone.id}/request`, { version: undone.version, dueDate: addDays(TODAY, 10) }, 403)
    const opened = await ok('finance', 'POST', `${orderUrl(order.id)}/schedule/${undone.id}/request`, { version: undone.version, dueDate: addDays(TODAY, 10) }, 201)
    expect(stepOf(opened, 'BEFORE_SHIPPING').depositRequestId).toBe(opened.depositRequestId)
  })
})

describe('B-OM-015 the remake keeps the steps set by hand: an amendment, new terms (a fresh code)', () => {
  it('a hand-moved balance survives an amendment that changes the total', async () => {
    const order = await typedOrder('PO-OM-S2-07')
    const balance = stepOf(await planOf(order.id), 'BEFORE_SHIPPING')
    await ok('finance', 'POST', planUrl(order.id), { act: 'MOVE_DUE', milestoneId: balance.id, version: balance.version, dueDate: addDays(PROMISE, -5), reason: 'Made-up: the day the customer asked.' })
    const record = (await ok('finance', 'GET', orderUrl(order.id))).order
    const [blk, red] = record.lines as [Json, Json]
    await as('POST', `${orderUrl(order.id)}/amendments`, { version: record.version, reason: 'Made-up: one more 52.', lines: [{ id: blk.id, sizes: grid([['50', 2], ['52', 3]]) }, { id: red.id }] }, 201)
    const after = await planOf(order.id)
    // The balance set by hand stays as agreed (before B-OM-015 it was cancelled and shared again).
    expect(stepOf(after, 'BEFORE_SHIPPING')).toMatchObject({ id: balance.id, status: 'OPEN', amount: balance.amount, dueDate: addDays(PROMISE, -5) })
    expect((after.cancelled as Json[]).map((step) => step.id)).not.toContain(balance.id)
  })

  it('new terms ask a fresh code; the same terms are refused; the hand-set balance stays; the order names the new terms', async () => {
    const order = await typedOrder('PO-OM-S2-08')
    const balance = stepOf(await planOf(order.id), 'BEFORE_SHIPPING')
    await ok('finance', 'POST', planUrl(order.id), { act: 'MOVE_DUE', milestoneId: balance.id, version: balance.version, dueDate: addDays(PROMISE, -3), reason: 'Made-up: agreed by mail.' })
    const record = (await as('GET', orderUrl(order.id))).order
    const [terms] = await admin<{ id: string; name: string }>(`SELECT id, name FROM "PaymentTerms" WHERE "tenantId" = $1 AND status = 'ACTIVE' AND id <> $2 AND ("companyId" IS NULL OR "companyId" = $3) ORDER BY code LIMIT 1`, [T, record.paymentTermsId, companyA])
    expect(terms).toBeDefined()
    // The preview says the act asks a fresh code (the handler asks it before the command).
    const preview = await as('POST', `${planUrl(order.id)}/preview`, { act: 'CHANGE_TERMS', paymentTermsId: terms!.id, version: record.version, reason: 'Made-up: new terms agreed.' })
    expect(preview).toMatchObject({ refusal: null, preview: { needsFreshCode: true } })
    expect(preview.preview.remade.cancelled).not.toContain(balance.id)
    await stepUp(h, owner.browser, owner.secret)
    const same = await as('POST', planUrl(order.id), { act: 'CHANGE_TERMS', paymentTermsId: record.paymentTermsId, version: record.version, reason: 'Made-up: the same.' }, 409)
    expect(same.error.issues).toEqual([{ path: 'moneyPlan/TERMS_SAME', message: MONEY_PLAN_REFUSAL_WORDS.TERMS_SAME.en }])
    await stepUp(h, owner.browser, owner.secret)
    const answer = await as('POST', planUrl(order.id), { act: 'CHANGE_TERMS', paymentTermsId: terms!.id, version: record.version, reason: 'Made-up: new terms agreed.' })
    expect(stepOf(answer, 'BEFORE_SHIPPING')).toMatchObject({ id: balance.id, status: 'OPEN' })
    expect((await as('GET', orderUrl(order.id))).order).toMatchObject({ paymentTermsId: terms!.id })
    const [audit] = await admin(`SELECT after FROM "AuditLog" WHERE action = 'orders.planByHand' AND "recordId" = $1 AND after->>'act' = 'CHANGE_TERMS'`, [order.id])
    expect(audit!.after).toMatchObject({ act: 'CHANGE_TERMS', paymentTermsId: terms!.id, milestoneIds: [] })
  })
})

// ════ S2.4 — B-OM-016 accept a short deposit; B-OM-017 undo a payment ════
describe('B-OM-016 accept a deposit short (lead L1: PAID by hand, the short part stays owed)', () => {
  it('within the tolerance: PAID by hand, its step PAID, the audit says how short and why; a later payment on it is refused', async () => {
    const order = await typedOrder('PO-OM-S2-09')
    const plan = await planOf(order.id)
    const request = requestOf(plan, stepOf(plan, 'DEPOSIT').depositRequestId)
    await paid([{ depositRequestId: request.id, amount: request.amount - 2_000 }], 'OM-S2-0009')
    const before = await planOf(order.id)
    const now = requestOf(before, request.id)
    // B-OM-024: 20.00 short, within the tenant-wide tolerance of 25.00 (the plan read says it, by ACCEPT_SHORT's own rule).
    expect(before.tolerance).toBe(2_500)
    expect(now.short).toEqual({ amount: 2_000, withinTolerance: true })
    // Without the price grain: the word stays, never the amount nor the tolerance.
    const blind = await ok('planNoPrice', 'GET', `${orderUrl(order.id)}/schedule`)
    expect(blind).not.toHaveProperty('tolerance')
    expect(requestOf(blind, request.id).short).toEqual({ withinTolerance: true })
    const answer = await ok('finance', 'POST', planUrl(order.id), { act: 'ACCEPT_SHORT', requestId: request.id, version: now.version, why: 'BANK_CHARGES', reason: 'Made-up: the bank kept 20.00.' })
    expect(requestOf(answer, request.id)).toMatchObject({ status: 'PAID', paid: request.amount - 2_000, acceptedShort: { short: 2_000, why: 'BANK_CHARGES', reason: 'Made-up: the bank kept 20.00.', /* B-OM-025 */ at: expect.any(String) } })
    // B-OM-024: PAID now — nothing is short any more (the accepted short part is `acceptedShort`).
    expect(requestOf(answer, request.id).short).toBeNull()
    expect(stepOf(answer, 'DEPOSIT').status).toBe('PAID')
    const [audit] = await admin(`SELECT after FROM "AuditLog" WHERE action = 'payments.depositPaid' AND "recordId" = $1`, [request.id])
    expect(audit!.after).toMatchObject({ status: 'PAID', acceptedShort: { why: 'BANK_CHARGES', overridden: false } })
    expect(await events('payment.deposit_paid', request.id)).toEqual([expect.objectContaining({ depositRequestId: request.id, orderId: order.id })])
    // The short part stays owed: the order's still to pay counts it (billed on the goods' invoice).
    expect(answer.stillOpen).toBe(order.grossAmount - (request.amount - 2_000))
    // A later payment onto it is refused (a PAID request takes no more).
    const late = await call('finance', 'POST', '/payments', { companyId: companyA, partyId: P1, amount: 2_000, receivedOn: TODAY, externalRef: 'OM-S2-0009B', allocations: [{ depositRequestId: request.id, amount: 2_000 }] })
    expect(late.status).toBeGreaterThanOrEqual(400)
  })

  it('beyond the tolerance: Finance is refused in words; the Owner accepts with a fresh code', async () => {
    const order = await typedOrder('PO-OM-S2-10')
    const plan = await planOf(order.id)
    const request = requestOf(plan, stepOf(plan, 'DEPOSIT').depositRequestId)
    await paid([{ depositRequestId: request.id, amount: request.amount - 5_000 }], 'OM-S2-0010')
    const now = requestOf(await planOf(order.id), request.id)
    // B-OM-024: 50.00 short is over the tolerance of 25.00: a part payment, not bank charges (Accept short is the Owner's here).
    expect(now.short).toEqual({ amount: 5_000, withinTolerance: false })
    const body = { act: 'ACCEPT_SHORT', requestId: request.id, version: now.version, why: 'OTHER', reason: 'Made-up: agreed with the customer.' }
    expect(await refused('finance', 'POST', planUrl(order.id), body, 409)).toMatchObject({ issues: [{ path: 'moneyPlan/OVER_TOLERANCE', message: MONEY_PLAN_REFUSAL_WORDS.OVER_TOLERANCE.en }] })
    // The Owner (orders.waive) may: the preview says a fresh code is asked, and how short it is.
    expect(await as('POST', `${planUrl(order.id)}/preview`, body)).toMatchObject({ refusal: null, preview: { needsFreshCode: true, short: 5_000 } })
    await stepUp(h, owner.browser, owner.secret)
    const answer = await as('POST', planUrl(order.id), body)
    expect(requestOf(answer, request.id)).toMatchObject({ status: 'PAID', acceptedShort: { short: 5_000 } })
    // B-OM-025 (W-03): the accepted short says who (the office person's name), when, how much and why — read back from the audit.
    const accepted = requestOf(answer, request.id).acceptedShort
    expect(accepted).toEqual({ short: 5_000, why: 'OTHER', reason: 'Made-up: agreed with the customer.', by: 'owner om-s2', at: expect.any(String) })
    expect(Number.isNaN(Date.parse(accepted.at))).toBe(false)
    // Without the price grain the reason and the amount stay out; who, when and why stay.
    const blind = requestOf(await ok('planNoPrice', 'GET', `${orderUrl(order.id)}/schedule`), request.id).acceptedShort
    expect(blind).toEqual({ why: 'OTHER', by: 'owner om-s2', at: accepted.at })
  })
})

describe('B-OM-017 undo a payment on a deposit request', () => {
  it('a part payment of the balance: reversed and voided (it pays nothing else); the plan read lists it no more', async () => {
    const order = await typedOrder('PO-OM-S2-11')
    const plan = await planOf(order.id)
    const balance = requestOf(plan, stepOf(plan, 'BEFORE_SHIPPING').depositRequestId)
    const payment = await paid([{ depositRequestId: balance.id, amount: 10_000 }], 'OM-S2-0011')
    const listed = requestOf(await planOf(order.id), balance.id).payments as Json[]
    expect(listed).toEqual([expect.objectContaining({ paymentId: payment.id, amount: 10_000, undo: { may: true, why: null, code: null } })])
    const answer = await ok('finance', 'POST', `/payments/${payment.id}/undo`, { depositRequestId: balance.id, version: payment.version, reason: 'Made-up: typed on the wrong order.' })
    expect(answer.undone).toEqual({ depositRequestId: balance.id, reversed: [listed[0]!.allocationId], voided: true })
    expect(answer.payment).toMatchObject({ id: payment.id, status: 'VOIDED' })
    expect(requestOf(await planOf(order.id), balance.id)).toMatchObject({ status: 'OPEN', paid: 0, payments: [] })
    expect(await events('payment.voided', payment.id)).toEqual([{ paymentId: payment.id, partyId: P1 }])
  })

  it('a payment of the deposit and the balance: only the balance part is reversed, the payment stays; a PAID deposit is held in words', async () => {
    const order = await typedOrder('PO-OM-S2-12')
    const plan = await planOf(order.id)
    const deposit = requestOf(plan, stepOf(plan, 'DEPOSIT').depositRequestId)
    const balance = requestOf(plan, stepOf(plan, 'BEFORE_SHIPPING').depositRequestId)
    // The deposit paid in full by it (PAID), and 50.00 of the balance.
    const payment = await paid([{ depositRequestId: deposit.id, amount: deposit.amount }, { depositRequestId: balance.id, amount: 5_000 }], 'OM-S2-0012')
    const answer = await ok('finance', 'POST', `/payments/${payment.id}/undo`, { depositRequestId: balance.id, version: payment.version, reason: 'Made-up: the balance part was a mistake.' })
    expect(answer.undone.voided).toBe(false)
    expect(answer.payment.status).toBe('RECEIVED')
    const after = await planOf(order.id)
    expect(requestOf(after, balance.id)).toMatchObject({ paid: 0 })
    expect(requestOf(after, deposit.id)).toMatchObject({ status: 'PAID', paid: deposit.amount })
    // The deposit is PAID: its payment stays (a refund is a credit note and a refund).
    expect(requestOf(after, deposit.id).payments[0].undo).toEqual({ may: false, why: UNDO_HELD_WORDS.PAID, code: 'PAID' })
    const held = await refused('finance', 'POST', `/payments/${payment.id}/undo`, { depositRequestId: deposit.id, version: answer.payment.version, reason: 'Made-up: all of it.' }, 409)
    expect(held).toMatchObject({ message: UNDO_HELD_WORDS.PAID.en, issues: [{ path: 'undo/PAID', message: UNDO_HELD_WORDS.PAID.en }] })
  })
})

// ════ S2.5 — the walls ════
describe('the walls: the right, the money wall, the brand wall', () => {
  it('Sales (the real template) may not act or preview; a holder without prices may not move an amount, may move a day', async () => {
    const order = await typedOrder('PO-OM-S2-13')
    const plan = await planOf(order.id)
    const balance = stepOf(plan, 'BEFORE_SHIPPING')
    const deposit = requestOf(plan, stepOf(plan, 'DEPOSIT').depositRequestId)
    const move = { act: 'MOVE_DUE', milestoneId: balance.id, version: balance.version, dueDate: addDays(PROMISE, -2), reason: 'Made-up: a day.' }
    await refused('sales', 'POST', planUrl(order.id), move, 403)
    await refused('sales', 'POST', `${planUrl(order.id)}/preview`, move, 403)
    // The amount is the price grain's: the grain filter answers first (before the handler), key by key (end check 1, om-fx1s:
    // the filter's refusal is the right one).
    const replace = { act: 'REPLACE_DEPOSIT', requestId: deposit.id, version: deposit.version, pct: '20', reason: 'Made-up: less.' }
    const noPrice = await call('planNoPrice', 'POST', planUrl(order.id), replace)
    expect(noPrice.status, JSON.stringify(noPrice.body)).toBe(403)
    expect(noPrice.body.error).toMatchObject({ message: 'This request sends money fields you may not see.', issues: [{ path: 'pct', message: 'Needs the price grain.' }] })
    // The same act with no money key passes the filter: the handler says why, in words.
    const bare = { act: replace.act, requestId: replace.requestId, version: replace.version, reason: replace.reason }
    expect((await refused('planNoPrice', 'POST', planUrl(order.id), bare, 403)).message).toBe(NO_PRICE_WORDS)
    // Nothing moved: the deposit is still the one asked.
    expect(requestOf(await planOf(order.id), deposit.id)).toMatchObject({ status: 'OPEN', replacedBy: null })
    const moved = await ok('planNoPrice', 'POST', planUrl(order.id), move)
    expect(moved).not.toHaveProperty('stillOpen')
    expect(stepOf(moved, 'BEFORE_SHIPPING')).not.toHaveProperty('amount')
    expect(stepOf(moved, 'BEFORE_SHIPPING').byHand).not.toHaveProperty('reason')
  })

  it('a person limited to another customer gets the same words as an unknown order: the act, the preview, the undo', async () => {
    const order = await typedOrder('PO-OM-S2-14')
    const plan = await planOf(order.id)
    const balance = stepOf(plan, 'BEFORE_SHIPPING')
    const move = { act: 'MOVE_DUE', milestoneId: balance.id, version: balance.version, dueDate: addDays(PROMISE, -2), reason: 'Made-up: a day.' }
    const unknown = await refused('finance', 'POST', planUrl(newId()), move, 404)
    expect(await refused('otherCustomer', 'POST', planUrl(order.id), move, 404)).toMatchObject({ message: unknown.message })
    expect(await refused('otherCustomer', 'POST', `${planUrl(order.id)}/preview`, move, 404)).toMatchObject({ message: unknown.message })
    const payment = await paid([{ depositRequestId: balance.depositRequestId, amount: 1_000 }], 'OM-S2-0014')
    const hidden = await refused('otherCustomer', 'POST', `/payments/${payment.id}/undo`, { depositRequestId: balance.depositRequestId, reason: 'Made-up: not mine.' }, 404)
    const unknownPayment = await refused('finance', 'POST', `/payments/${newId()}/undo`, { depositRequestId: balance.depositRequestId, reason: 'Made-up: none.' }, 404)
    expect(hidden.message).toBe(unknownPayment.message)
    expect(JSON.stringify(hidden)).not.toContain(order.number)
  })
})
