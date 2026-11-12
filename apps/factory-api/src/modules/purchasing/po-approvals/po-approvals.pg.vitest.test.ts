import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/planning/buy'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { textOf } from '../../../adapters/ses/fake'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant, type TestUser } from '../../../platform/auth/sessions/testing/harness'
import { systemContext } from '../../../platform/outbox/system'
import { sendApproved } from './approved-send'

/**
 * PO approvals and duplicate (B-W2b-305; SCM-078, SCM-080, SCM-057) on the local stack: a throwaway PostgreSQL 17 database
 * from the migrations (row-level security, the purchase order and approval guards are real), the real app with the real
 * office sign-in (a buyer and a finance approver, both with two-factor), the FAKE SES mailbox (the only place a confirm
 * link's token exists), the approval engine's real routes, and the worker's handler called as the worker calls it. A second
 * app with test sessions writes the rules (an owner) and tries a duplicate without the right (a planner). Every name, number
 * and price is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/purchasing/po-approvals`.
 */

let h: Harness
let walls: FastifyInstance
let buyer: Browser
let finance: Browser
let buyerUser: TestUser
let owner: TestUser

const NS = 'po-approvals'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const siteA1 = seedId('site:A1')
const P2 = seedId('party:P2')
const P2orders = seedId('party-contact:P2:orders')
const leather = seedId('product:item:leather')
const lining = seedId('product:item:lining')
const leatherBLK = seedId('product:item-colour:leather:BLK')
const liningGRY = seedId('product:item-colour:lining:GRY')
const FAKE_VAT = '12345670009'
const today = () => businessDate(new Date())

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
/** Moves test data past its own guards (the admin's session only), then back. */
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(sql, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
let counter = 0
const key = (label = 'k'): string => `poappr-${label}-${++counter}-${newId()}`

async function as(who: Browser, method: Method, url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await who.send(method as 'POST', url, method === 'GET' || method === 'DELETE' ? undefined : (body ?? {}), { headers: method === 'GET' ? {} : { 'idempotency-key': key() } })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}
const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const SESSIONS: Record<string, () => SessionContext> = {
  owner: () => ({ audience: 'office', tenantId: tenant, actorId: owner.id, grants: [grant(['approvals.view', 'approvals.rules.manage', 'money.cost'])] }),
  planner: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['purchasing.view'])] }),
}
const wall = async (session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> => {
  const answer = await walls.inject({ method, url, headers: { 'x-test-session': session, 'idempotency-key': key('wall') }, ...(payload === undefined ? {} : { payload: payload as object }) })
  expect(answer.statusCode, answer.body).toBe(status)
  return answer.json()
}

const orderUrl = (id: string) => `/purchasing/orders/${id}`
const record = async (id: string): Promise<Json> => (await as(buyer, 'GET', orderUrl(id))).order
const eventsOf = async (type: string, subject: string) => (await admin<{ payload: Json }>('SELECT payload FROM "OutboxEvent" WHERE type = $1 AND subject = $2 ORDER BY "occurredAt", id', [type, subject])).map((row) => row.payload)
const tasksOf = async (orderId: string) => admin<{ id: string; status: string }>(`SELECT id, status::text AS status FROM "ApprovalTask" WHERE "recordId" = $1 ORDER BY "requestedAt", id`, [orderId])
const system = () => callerFor(h.database, systemContext(tenant, `test-305-${newId()}`))
const tokenOf = (outboundId: string): string => {
  const mail = h.ses.mails.find((entry) => entry.outboundId === outboundId)
  return mail ? decodeURIComponent(/#token=(\S+)/.exec(textOf(mail.raw))?.[1] ?? '') : ''
}

/** A new draft to P2 at A1: leather at 2.50 a ft² (and, when asked, grey lining). */
async function draft(feet: string, withLining = false): Promise<Json> {
  let order = (await as(buyer, 'POST', '/purchasing/orders', { companyId: companyA, siteId: siteA1, partyId: P2 }, 201)).order
  order = (await as(buyer, 'POST', `${orderUrl(order.id)}/lines`, { version: order.version, itemId: leather, itemColourId: leatherBLK, quantity: feet, uom: 'FT2', needDate: addDays(today(), 40), unitPrice: '2.500000' }, 201)).order
  if (withLining) order = (await as(buyer, 'POST', `${orderUrl(order.id)}/lines`, { version: order.version, itemId: lining, itemColourId: liningGRY, quantity: '30', uom: 'M', needDate: addDays(today(), 45), unitPrice: '3.000000' }, 201)).order
  return order
}
/** A request's changes as asked (the engine's view adds each field's label). */
const askedChanges = (changes: readonly Json[]) => changes.map((change) => ({ field: change.field, from: change.from, to: change.to, grain: change.grain }))
const send = async (orderId: string, body: Json = {}, status = 200): Promise<Json> => as(buyer, 'POST', `${orderUrl(orderId)}/send`, { version: (await record(orderId)).version, ...body }, status)
const task = async (taskId: string, who: Browser = finance): Promise<Json> => (await as(who, 'GET', `/approvals/tasks/${taskId}`)).task
async function approve(taskId: string): Promise<Json> {
  const seen = await task(taskId)
  return (await as(finance, 'POST', `/approvals/tasks/${taskId}/approve`, { version: seen.version, comment: 'Within the season budget (made-up).' })).task
}
async function rule(name: string, field: string, value: string): Promise<Json> {
  const made = (await wall('owner', 'POST', '/approvals/rules', { kind: 'PURCHASE_ORDER', companyId: companyA, name, condition: { combinator: 'and', rows: [{ id: 'r1', field, operator: 'gt', value }] }, approver: { roleId: financeRoleId }, sequence: 5, dueHours: 24 }, 201)).rule
  return (await wall('owner', 'PUT', `/approvals/rules/${made.id}`, { version: made.version, active: true })).rule
}
const switchOff = async (ruleId: string) => {
  const current = (await wall('owner', 'GET', `/approvals/rules/${ruleId}`)).rule
  await wall('owner', 'PUT', `/approvals/rules/${ruleId}`, { version: current.version, active: false })
}

let financeRoleId: string
let firstOrder: Json

beforeAll(async () => {
  h = await startHarness('po_approvals')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedProduction({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  await seedReasons({ db: h.database, namespace: NS })
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId }))
  financeRoleId = (await admin<{ id: string }>(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = 'finance'`, [tenant]))[0]!.id
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), tenant])
  const ses = newId()
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'SES', 'ses', 'Mail', 'FAKE', 6000, 1000)`, [ses, tenant])
  await admin(
    `INSERT INTO "EmailIdentity" (id, "tenantId", "companyId", kind, domain, "fromAddress", "displayName", "displayNamePolicy", "replyDomain", "accountId", "verificationStatus", "dkimStatus", "isDefault")
     VALUES ($1, $2, $3, 'CONVERSATION', 'mail.seed-a.example.com', 'acquisti@mail.seed-a.example.com', 'Seed A', 'COMPANY', 'reply.seed-a.example.com', $4, 'SUCCESS', 'SUCCESS', true)`,
    [newId(), tenant, companyA, ses],
  )
  await admin(`UPDATE "Company" SET "vatNumber" = $2, "fiscalCode" = $3, "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyA, `IT${FAKE_VAT}`, FAKE_VAT])
  const seedTenant: TestTenant = { id: tenant, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  buyerUser = await addUser(h, seedTenant, { email: 'bruno.buyer@seed-a.example.com', role: 'buyer' })
  buyer = new Browser(h.app)
  expect((await buyer.signIn(NS, buyerUser.email, buyerUser.password)).status).toBe(200)
  await enrolTotp(h, buyer)
  const financeUser = await addUser(h, seedTenant, { email: 'fiona.finance@seed-a.example.com', role: 'finance' })
  finance = new Browser(h.app)
  expect((await finance.signIn(NS, financeUser.email, financeUser.password)).status).toBe(200)
  await enrolTotp(h, finance)
  owner = await addUser(h, seedTenant, { email: 'olga.owner@seed-a.example.com', role: 'owner' })
  walls = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
}, 300_000)

afterAll(async () => {
  await walls?.close()
  await h?.close()
}, 60_000)

let ruleA: Json
let waitingId = ''
let waitingTask = ''

describe('approval rules on purchase orders (SCM-078)', () => {
  it('no rule switched on: the send goes as before', async () => {
    firstOrder = await draft('100', true)
    const before = (await as(buyer, 'GET', `${orderUrl(firstOrder.id)}/approval`)).approval
    expect(before).toMatchObject({ state: 'NONE', task: null, wouldAsk: null, approvedAsItIs: false })
    const sent = await send(firstOrder.id)
    expect(sent.order.status).toBe('SENT')
    expect(sent.sent.emailId).toBeTruthy()
  })

  it('a rule over 1,000 → Finance: the send of an order above it waits for the yes (202); nothing is made or mailed', async () => {
    ruleA = await rule('Orders over 1,000 (made-up)', 'orderValue', '1000')
    const order = await draft('1000')
    waitingId = order.id
    const will = (await as(buyer, 'GET', `${orderUrl(order.id)}/approval`)).approval
    expect(will.wouldAsk).toMatchObject({ rule: { id: ruleA.id }, approver: { kind: 'ROLE', id: financeRoleId, name: expect.any(String) }, namesYou: false })
    const mails = h.ses.mails.length
    const confirmBy = new Date(Date.now() + 5 * 86_400_000).toISOString()
    const asked = await send(order.id, { message: 'For the spring run (made-up).', confirmBy }, 202)
    expect(asked.order.status).toBe('PENDING_APPROVAL')
    expect(asked.approval).toMatchObject({ approver: { kind: 'ROLE', id: financeRoleId }, dueAt: expect.any(String) })
    waitingTask = asked.approval.taskId
    expect(await admin(`SELECT status::text AS status, "approvalTaskId", "sentAt" FROM "PurchaseOrder" WHERE id = $1`, [order.id])).toEqual([{ status: 'PENDING_APPROVAL', approvalTaskId: waitingTask, sentAt: null }])
    expect(await admin(`SELECT id FROM "StoredFile" WHERE "recordId" = $1 AND kind = 'FISCAL_ARCHIVE'`, [order.id])).toEqual([])
    expect(h.ses.mails.length).toBe(mails)
    expect(await eventsOf('purchase_order.approval_asked', order.id)).toEqual([{ purchaseOrderId: order.id, number: order.number, taskId: waitingTask, revision: 1 }])
    // The request shows the change and keeps the words of the send for the yes.
    const seen = await task(waitingTask)
    expect(askedChanges(seen.changes)).toEqual([
      { field: 'status', from: 'DRAFT', to: 'SENT', grain: null },
      { field: 'confirmBy', from: null, to: new Date(confirmBy).toISOString(), grain: null },
      { field: 'mailMessage', from: null, to: 'For the spring run (made-up).', grain: null },
    ])
    expect(seen.facts).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'revision', value: 1 })]))
    expect((await as(finance, 'GET', '/approvals/tasks?tile=WAITING_FOR_ME')).rows.map((row: Json) => row.id)).toContain(waitingTask)
    expect((await as(buyer, 'GET', `${orderUrl(order.id)}/approval`)).approval).toMatchObject({ state: 'WAITING', task: { id: waitingTask, status: 'PENDING', requestedBy: { id: buyerUser.id } } })
  })

  it('REFUSED while it waits: a change, a second send, and the buyer approving their own request', async () => {
    const order = await record(waitingId)
    const edit = await as(buyer, 'PATCH', `${orderUrl(waitingId)}/lines/${order.lines[0].id}`, { version: order.version, quantity: '900' }, 409)
    expect(edit.error.message).toBe('The order waits for a yes before it is sent: take the request back to change it.')
    const again = await send(waitingId, {}, 409)
    expect(again.error.issues[0].path).toBe('refusal/WAITING_FOR_YES')
    expect(again.error.message).toMatch(/^The order waits for a yes from .+ before it is sent/)
    const own = await as(buyer, 'POST', `/approvals/tasks/${waitingTask}/approve`, { version: (await task(waitingTask, buyer)).version }, 403)
    expect(own.error.issues[0].path).toBe('refusal/OWN_REQUEST')
  })

  it('the yes sends it — by the worker, as the buyer who asked, with the words of the send', async () => {
    const approved = await approve(waitingTask)
    expect(approved.status).toBe('APPROVED')
    expect((await record(waitingId)).status).toBe('PENDING_APPROVAL')
    expect((await as(buyer, 'GET', `${orderUrl(waitingId)}/approval`)).approval.state).toBe('APPROVED')
    const [event] = await eventsOf('purchase_order.approved', waitingId)
    expect(event).toEqual({ purchaseOrderId: waitingId, number: expect.any(String), taskId: waitingTask })
    expect(await sendApproved(system(), { eventId: newId(), payload: event })).toBe('SENT')
    const sent = await admin<Json>(`SELECT status::text AS status, "sentById", "confirmBy" FROM "PurchaseOrder" WHERE id = $1`, [waitingId])
    expect(sent[0]).toMatchObject({ status: 'SENT', sentById: buyerUser.id })
    const [mail] = await eventsOf('purchase_order.sent', waitingId)
    expect(tokenOf(mail!.outboundId).length).toBeGreaterThan(20)
    expect(textOf(h.ses.mails.find((entry) => entry.outboundId === mail!.outboundId)!.raw)).toContain('For the spring run (made-up).')
    const audit = await admin<Json>(`SELECT "actorId", after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'purchasing.send'`, [waitingId])
    expect(audit).toEqual([{ actorId: buyerUser.id, after: expect.objectContaining({ approvalTaskId: waitingTask, status: 'SENT' }) }])
    // A repeated job sends nothing again.
    expect(await sendApproved(system(), { eventId: newId(), payload: event })).toBe('SETTLED')
    expect(await eventsOf('purchase_order.sent', waitingId)).toHaveLength(1)
    expect((await as(buyer, 'GET', `${orderUrl(waitingId)}/approval`)).approval.state).toBe('SENT_WITH_YES')
  })
})

describe('a change to an approved order asks again (SCM-080)', () => {
  let ruleB: Json

  it('revision 2 above the rule asks again, showing the revision and the value since the last send; a no makes it a draft', async () => {
    const changed = (await as(buyer, 'POST', `${orderUrl(waitingId)}/change`, { version: (await record(waitingId)).version, note: 'More leather (made-up).' })).order
    expect(changed).toMatchObject({ status: 'DRAFT', revision: 2 })
    await as(buyer, 'PATCH', `${orderUrl(waitingId)}/lines/${changed.lines[0].id}`, { version: changed.version, quantity: '1200' })
    const asked = await send(waitingId, { changeNote: '200 ft² more (made-up).' }, 202)
    const seen = await task(asked.approval.taskId)
    expect(askedChanges(seen.changes)).toEqual(
      expect.arrayContaining([
        { field: 'revision', from: 1, to: 2, grain: null },
        { field: 'orderValue', from: '2500', to: '3000', grain: 'cost' },
        { field: 'changeNote', from: null, to: '200 ft² more (made-up).', grain: null },
      ]),
    )
    expect(seen.facts).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'valueIncrease', value: '500', grain: 'cost' })]))
    const rejected = (await as(finance, 'POST', `/approvals/tasks/${seen.id}/reject`, { version: seen.version, reasonCode: 'OVER_BUDGET', reason: 'Not this month (made-up).' })).task
    expect(rejected.status).toBe('REJECTED')
    expect((await record(waitingId)).status).toBe('DRAFT')
    expect(await eventsOf('purchase_order.approval_ended', waitingId)).toEqual([{ purchaseOrderId: waitingId, number: expect.any(String), taskId: seen.id, outcome: 'REJECTED' }])
    expect((await as(buyer, 'GET', `${orderUrl(waitingId)}/approval`)).approval).toMatchObject({ state: 'REJECTED', task: { rejectReasonCode: 'OVER_BUDGET', decidedBy: { name: expect.any(String) } } })
  })

  it('a rule on the value added since the last send asks only when the order grows by more; the buyer takes a request back', async () => {
    await switchOff(ruleA.id)
    ruleB = await rule('Grows by more than 100 (made-up)', 'valueIncrease', '100')
    const asked = await send(waitingId, {}, 202)
    const back = (await as(buyer, 'POST', `${orderUrl(waitingId)}/approval/withdraw`, { version: asked.order.version, note: 'Less after all (made-up).' })).order
    expect(back.status).toBe('DRAFT')
    expect((await tasksOf(waitingId)).find((row) => row.id === asked.approval.taskId)?.status).toBe('WITHDRAWN')
    expect((await as(buyer, 'POST', `${orderUrl(waitingId)}/approval/withdraw`, { version: back.version }, 409)).error.message).toBe('The order waits for no yes: it is a draft already.')
    await as(buyer, 'PATCH', `${orderUrl(waitingId)}/lines/${back.lines[0].id}`, { version: back.version, quantity: '1020' })
    // 2550 now: 50 more than revision 1 sent — under the rule.
    expect((await send(waitingId, { changeNote: '20 ft² more (made-up).' })).order.status).toBe('SENT')
    // A first revision has no value added: the rule does not hold.
    const fresh = await draft('2000')
    expect((await send(fresh.id)).order.status).toBe('SENT')
    await switchOff(ruleB.id)
  })
})

describe('the yes stands until the order changes', () => {
  it('an approved order that cannot go is held in words; the buyer’s Send sends it with its yes', async () => {
    ruleA = (await wall('owner', 'PUT', `/approvals/rules/${ruleA.id}`, { version: (await wall('owner', 'GET', `/approvals/rules/${ruleA.id}`)).rule.version, active: true })).rule
    const order = await draft('1000')
    const asked = await send(order.id, {}, 202)
    await approve(asked.approval.taskId)
    await force(`UPDATE "PartyContact" SET email = NULL WHERE id = $1`, [P2orders])
    try {
      const [event] = await eventsOf('purchase_order.approved', order.id)
      expect(await sendApproved(system(), { eventId: newId(), payload: event })).toBe('HELD')
      expect((await record(order.id)).status).toBe('PENDING_APPROVAL')
      expect(await eventsOf('purchase_order.send_held', order.id)).toEqual([{ purchaseOrderId: order.id, number: order.number, taskId: asked.approval.taskId, codes: expect.any(Array) }])
      const notes = await admin<{ bodyText: string }>(`SELECT m."bodyText" FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordId" = $1 AND m.direction = 'INTERNAL_NOTE'`, [order.id])
      expect(notes.map((note) => note.bodyText)).toEqual([expect.stringMatching(/^It was approved, but it could not be sent: .+ Fix it and press Send/)])
      expect((await as(buyer, 'GET', `${orderUrl(order.id)}/send-check`)).ready).toBe(false)
    } finally {
      await force(`UPDATE "PartyContact" SET email = 'orders.p2@example.com' WHERE id = $1`, [P2orders])
    }
    expect((await as(buyer, 'GET', `${orderUrl(order.id)}/send-check`)).ready).toBe(true)
    const sent = await send(order.id)
    expect(sent.order.status).toBe('SENT')
    expect(await tasksOf(order.id)).toEqual([{ id: asked.approval.taskId, status: 'APPROVED' }])
  })

  it('a draft approved as it is from the generic request is sent without asking again', async () => {
    const order = await draft('1000')
    const asked = (await as(buyer, 'POST', '/approvals/requests', { kind: 'PURCHASE_ORDER', recordId: order.id, note: 'Before I send it (made-up).' }, 201)).task
    expect((await record(order.id)).status).toBe('DRAFT')
    await approve(asked.id)
    expect((await as(buyer, 'GET', `${orderUrl(order.id)}/approval`)).approval).toMatchObject({ state: 'APPROVED', approvedAsItIs: true })
    expect((await send(order.id)).order.status).toBe('SENT')
    expect(await tasksOf(order.id)).toEqual([{ id: asked.id, status: 'APPROVED' }])
  })

  it('cancelling a waiting order takes its request back; Send n lists an order a rule holds as WAITING', async () => {
    const order = await draft('1000')
    const asked = await send(order.id, {}, 202)
    const cancelled = await as(buyer, 'POST', `${orderUrl(order.id)}/cancel`, { version: asked.order.version, reason: 'Ordered elsewhere (made-up).' })
    expect(cancelled.order.status).toBe('CANCELLED')
    expect(await tasksOf(order.id)).toEqual([{ id: asked.approval.taskId, status: 'WITHDRAWN' }])
    const small = await draft('100')
    const big = await draft('1000')
    const many = await as(buyer, 'POST', '/purchasing/orders/send-many', { orders: [{ id: small.id, version: (await record(small.id)).version }, { id: big.id, version: (await record(big.id)).version }] })
    expect(many).toMatchObject({ sent: 1, waiting: 1, refused: 0 })
    expect(many.outcomes.map((entry: Json) => [entry.id, entry.outcome])).toEqual([
      [small.id, 'SENT'],
      [big.id, 'WAITING'],
    ])
    expect(many.outcomes[1].approval.taskId).toBeTruthy()
    await switchOff(ruleA.id)
  })
})

describe('duplicate or reorder (SCM-057)', () => {
  it('a new draft from a sent order: same supplier and site, every line, need dates ahead', async () => {
    const copy = await as(buyer, 'POST', `${orderUrl(firstOrder.id)}/duplicate`, {}, 201)
    expect(copy.order).toMatchObject({ status: 'DRAFT', revision: 1 })
    expect(copy.order.id).not.toBe(firstOrder.id)
    expect(copy.copiedFrom).toEqual({ id: firstOrder.id, number: firstOrder.number })
    expect(copy.lines).toHaveLength(2)
    for (const line of copy.lines) {
      expect(line.needDate >= today()).toBe(true)
      expect(['SOURCE', 'COPIED']).toContain(line.priceFrom)
    }
    expect(copy.order.lines.map((line: Json) => [line.seq, line.quantity])).toEqual([
      [10, '100.0000'],
      [20, '30.0000'],
    ])
    expect(await eventsOf('purchase_order.copied', copy.order.id)).toEqual([{ purchaseOrderId: copy.order.id, number: copy.order.number, fromPurchaseOrderId: firstOrder.id, fromNumber: firstOrder.number, lines: 2 }])
    // The original is untouched.
    expect((await record(firstOrder.id)).status).toBe('SENT')
  })

  it('reorders one line on a day given; REFUSED: a line of another order, a day in the past, a reader without the right', async () => {
    const sentLines = (await record(firstOrder.id)).lines
    const day = addDays(today(), 20)
    const copy = await as(buyer, 'POST', `${orderUrl(firstOrder.id)}/duplicate`, { lineIds: [sentLines[1].id], needDate: day }, 201)
    expect(copy.lines).toEqual([{ fromLineId: sentLines[1].id, lineId: expect.any(String), seq: 10, needDate: day, priceFrom: expect.any(String) }])
    const other = (await record(waitingId)).lines[0].id
    expect((await as(buyer, 'POST', `${orderUrl(firstOrder.id)}/duplicate`, { lineIds: [other] }, 400)).error.issues).toEqual([{ path: 'body/lineIds/0', message: 'Not a line of this order.' }])
    expect((await as(buyer, 'POST', `${orderUrl(firstOrder.id)}/duplicate`, { needDate: addDays(today(), -1) }, 400)).error.issues[0].path).toBe('body/needDate')
    await wall('planner', 'POST', `${orderUrl(firstOrder.id)}/duplicate`, {}, 403)
  })
})
