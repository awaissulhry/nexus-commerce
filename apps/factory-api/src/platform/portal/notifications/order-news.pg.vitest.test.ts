import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { textOf } from '../../../adapters/ses/fake'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../abuse/guard'
import { usePortalOptions } from '../../auth/portal/service'
import { freshGuard, mailedCode, portalBrowser } from '../../auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../auth/roles/system-roles'
import { startHarness, type Browser, type Harness } from '../../auth/sessions/testing/harness'
import { systemContext } from '../../outbox/system'
import { partnerFanOut, partnerFanOutEvents } from './fan-out'
import { unsubscribeKeyOf } from './mail'
// th3b follow-up 5: a task opened as the office's ask opens it, and the office's own view of it.
import { command } from '../../../core/command'
import { openTaskInCommand, taskById } from '../tasks/store'
import { taskView } from '../tasks/views'

/**
 * T06 (B-TH-006, research.md §8 bug L2-G06; wall surface W06) on the local stack with EVERY factory-db seed and the app's real
 * routes: the portal says "confirmed" only for a confirmed order. Customer A (the seed's SEED-C1, over its credit limit while
 * company A's "Orders over the credit limit" rule holds) and customer B (another customer of the seed, its portal on too)
 * each have portal people. An order of A made waiting for Finance's yes tells A's people "received, waiting for our approval"
 * (bell and mail), never "confirmed"; the yes (sales_order.status_changed PENDING_APPROVAL → CONFIRMED) tells them it is
 * confirmed, once — also when the yes came before the worker handled the order's making; an order made confirmed says so at
 * once; an order cancelled while it waited is never news of a confirmation. Every notice names the order's own party: B's
 * people get none of A's. The portal's own record agrees: its Confirmed step is done only once confirmed, on the day of the yes,
 * and skipped for an order cancelled while waiting. Mail goes to the FAKE mailbox only; every name and number is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs platform/portal/notifications`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT'

const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'order-news-th006'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')

const PEOPLE = { sales: newId(), finance: newId(), owner: newId() } as const
type Person = keyof typeof PEOPLE
const SESSIONS: Record<string, SessionContext> = {}
function grantsOf(role: string): Grant[] {
  const template = templateOf(role)!
  return [{ permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties: 'all' }]
}

let h: Harness
let app: FastifyInstance
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
const run = randomBytes(4).toString('hex')
let keys = 0
const call = (person: Person, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': person, ...(method !== 'GET' ? { 'idempotency-key': `th006-${run}-${++keys}` } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(person: Person, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(person, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}

const brandA = { buyer: `bea.buyer.${run}@brand-alpha.example`, viewer: `vic.viewer.${run}@brand-alpha.example` }
const brandB = { buyer: `bo.buyer.${run}@brand-beta.example` }
const ids = { aBuyer: '', aViewer: '', bBuyer: '' }
let partyA: string
let partyB: string
let ruleId: string
let line: { styleId: string; colourwayId: string; sizes: { size: string; quantity: number }[] }

/** A partner person of a party with template roles over every company (as an accepted invitation gives). */
async function partnerPerson(email: string, partyId: string, roleKeys: string[]): Promise<string> {
  const id = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => {
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!, locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'CUSTOMER' }, select: { id: true } })
    for (const key of roleKeys) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key } }, select: { id: true } })
      // th3b fix: started by BOTH clocks — the portal reads roles on the harness clock (which each sign-in moves 61 s on), the
      // worker's fan-out on the server clock: a person made after the sign-ins (follow-up 5's uploader) must be a reader to both.
      const started = Math.min(h.clock.now().getTime(), Date.now()) - 60_000
      await client.roleAssignment.create({ data: { id: newId(), userId: id, roleId: role.id, allCompanies: true, partyIds: [partyId], validFrom: new Date(started) }, select: { id: true } })
    }
  })
  return id
}

const outbox = (type: string) => admin<{ id: string; type: string; payload: Json; companyId: string | null }>('SELECT id, type, payload, "companyId" FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id', [T, type])
const system = () => callerFor(h.database, systemContext(T, `test-${newId()}`))

/** What the worker does: every partner-relevant event made so far through the fan-out (a replay makes nothing). */
async function fanOutAll(): Promise<number> {
  let made = 0
  for (const type of partnerFanOutEvents()) {
    for (const row of await outbox(type)) made += await partnerFanOut(system(), { eventId: row.id, type: row.type, tenantId: T, companyId: row.companyId, siteId: null, payload: row.payload } as never, { clock: h.clock, unsubscribeKey: unsubscribeKeyOf(h.auth.secrets) })
  }
  return made
}

const newsOf = (userId: string, orderId: string) => admin<{ messageKey: string; partyId: string; eventType: string; recordLabel: string }>('SELECT "messageKey", "partyId", "eventType", "recordLabel" FROM "Notification" WHERE "userId" = $1 AND "recordType" = \'SalesOrder\' AND "recordId" = $2 ORDER BY "createdAt", id', [userId, orderId])
const newsAbout = (orderId: string) => admin<{ userId: string; partyId: string; messageKey: string }>('SELECT "userId", "partyId", "messageKey" FROM "Notification" WHERE "recordType" = \'SalesOrder\' AND "recordId" = $1 ORDER BY "createdAt", id', [orderId])
const statusOf = async (orderId: string) => (await one<{ status: string }>('SELECT status::text FROM "SalesOrder" WHERE id = $1', [orderId])).status

const typedOrder = (customerRef: string) => ({ companyId: companyA, partyId: partyA, customerRef, lines: [{ styleId: line.styleId, colourwayId: line.colourwayId, sizes: line.sizes, unitPrice: '100' }] })
const madeOrder = async (customerRef: string) => (await ok('sales', 'POST', '/sales/orders/manual', typedOrder(customerRef), 201)).order as Json
/** Finance's yes on the order's credit request. */
async function approve(orderId: string): Promise<void> {
  const check = await one<{ id: string }>('SELECT id FROM "CreditCheck" WHERE "recordId" = $1 AND result = \'HOLD\' ORDER BY "checkedAt" DESC, id DESC LIMIT 1', [orderId])
  const task = await one<{ id: string; version: number }>('SELECT id, version FROM "ApprovalTask" WHERE kind = \'CREDIT_OVERRIDE\' AND "recordId" = $1 AND status = \'PENDING\'', [check.id])
  await ok('finance', 'POST', `/approvals/tasks/${task.id}/approve`, { version: task.version, comment: 'A good payer (made-up).' })
}
async function switchRule(active: boolean): Promise<void> {
  const rule = await one<{ version: number }>('SELECT version FROM "ApprovalRule" WHERE id = $1', [ruleId])
  await ok('owner', 'PUT', `/approvals/rules/${ruleId}`, { version: rule.version, active })
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
  h = await startHarness('order_news_th006')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId }))
  const roleIds = new Map((await admin<{ id: string; key: string }>('SELECT id, key FROM "Role" WHERE "tenantId" = $1', [T])).map((row) => [row.key, row.id]))
  for (const person of Object.keys(PEOPLE) as Person[]) {
    await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, \'ACTIVE\')', [PEOPLE[person], T, `th006-${person}-${run}@example.com`, `Made-up ${person}`])
    await admin('INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, true, \'{}\'::uuid[], now() - interval \'30 days\')', [newId(), T, PEOPLE[person], roleIds.get(person)])
    SESSIONS[person] = { audience: 'office', tenantId: T, actorId: PEOPLE[person], grants: grantsOf(person) }
  }
  partyA = (await one<{ id: string }>('SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = \'SEED-C1\'', [T])).id
  partyB = (await one<{ id: string }>('SELECT id FROM "Party" WHERE "tenantId" = $1 AND \'CUSTOMER\' = ANY(roles::text[]) AND status = \'ACTIVE\' AND id <> $2 AND ("companyId" IS NULL OR "companyId" = $3) ORDER BY code LIMIT 1', [T, partyA, companyA])).id
  // Both portals on (every party ships OFF: Owner answer C1).
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    for (const party of [partyA, partyB]) await client.portalSettings.upsert({ where: { id: party }, create: { id: party, partyId: party, portalOn: true }, update: { portalOn: true }, select: { id: true } })
  })
  ids.aBuyer = await partnerPerson(brandA.buyer, partyA, ['customer-buyer'])
  ids.aViewer = await partnerPerson(brandA.viewer, partyA, ['customer-viewer'])
  ids.bBuyer = await partnerPerson(brandB.buyer, partyB, ['customer-buyer'])
  ruleId = (await one<{ id: string }>('SELECT id FROM "ApprovalRule" WHERE "tenantId" = $1 AND kind = \'CREDIT_OVERRIDE\' ORDER BY "createdAt", id LIMIT 1', [T])).id
  line = await one<typeof line>(
    `SELECT l."styleId", l."colourwayId", (SELECT json_agg(json_build_object('size', s.size, 'quantity', 1)) FROM (SELECT size FROM "SalesOrderLineSize" WHERE "lineId" = l.id ORDER BY size LIMIT 1) s) AS sizes
       FROM "SalesOrderLine" l JOIN "SalesOrder" o ON o.id = l."orderId" WHERE o."tenantId" = $1 AND o.number = 'SEED-SO-0001' AND l."styleId" IS NOT NULL ORDER BY l.seq LIMIT 1`,
    [T],
  )
  // Many mails and files in a few seconds: the seeded accounts' rate limits are a person's, not a test's.
  await admin('UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1', [T])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  // Customer A over its limit (1.00 EUR with company A), set by Finance; company A holds orders over it (its CREDIT_OVERRIDE rule).
  const terms = await one<{ version: number }>('SELECT version FROM "PartyCompanyTerms" WHERE "partyId" = $1 AND "companyId" = $2 AND "endedAt" IS NULL', [partyA, companyA])
  await ok('finance', 'PUT', `/sales/credit/limits/${partyA}/${companyA}`, { version: terms.version, amount: 100, currency: 'EUR', reason: 'Down to 1.00 for the test (made-up).' })
  // The seeds' own events are not this test's: they are handled first (their notices are counted out below by record).
  await fanOutAll()
}, 900_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await app?.close()
  await h?.close()
}, 60_000)

let waiting: Json

describe('T06: the portal says "confirmed" only for a confirmed order (B-TH-006, L2-G06)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('an order made waiting for our yes is "received, waiting for our approval" to its own customer only — never "confirmed"', async () => {
    await switchRule(true)
    waiting = await madeOrder('PO-TH006-WAIT')
    expect(waiting.status).toBe('PENDING_APPROVAL')
    const before = h.ses.mails.length
    await fanOutAll()
    expect((await newsOf(ids.aBuyer, waiting.id)).map((row) => row.messageKey)).toEqual(['portal.order.received'])
    expect((await newsOf(ids.aViewer, waiting.id)).map((row) => row.messageKey)).toEqual(['portal.order.received'])
    // W06: the notice names the order's own party; customer B's people get nothing of A's order.
    expect((await newsAbout(waiting.id)).every((row) => row.partyId === partyA)).toBe(true)
    expect(await newsOf(ids.bBuyer, waiting.id)).toEqual([])
    // Order news is transactional: mailed at once, in the person's language, with the words of the wait.
    const mails = h.ses.mails.slice(before).filter((mail) => mail.templateKey === 'portal.notification' && mail.to[0] === brandA.buyer)
    expect(mails).toHaveLength(1)
    // th2-backend step 7 (§0.5): the customer's own order number ("your order 3"), never the office's SO-… series.
    const seq = (await one<{ customerSeq: number }>('SELECT "customerSeq" FROM "SalesOrder" WHERE id = $1', [waiting.id])).customerSeq
    expect(textOf(mails[0]!.raw)).toContain(`We received your order ${seq}: it is waiting for our approval`)
    expect(textOf(mails[0]!.raw)).not.toContain(waiting.number)
    expect((await newsOf(ids.aBuyer, waiting.id)).map((row) => row.recordLabel)).toEqual([`#${seq}`])
    expect(textOf(mails[0]!.raw)).not.toMatch(/is confirmed/)
    expect(h.ses.mails.slice(before).some((mail) => mail.to[0] === brandB.buyer)).toBe(false)
  })

  it('the yes is the confirmed news, once, to the same people; a replay tells nobody again', async () => {
    await approve(waiting.id)
    expect(await statusOf(waiting.id)).toBe('CONFIRMED')
    const before = h.ses.mails.length
    await fanOutAll()
    expect((await newsOf(ids.aBuyer, waiting.id)).map((row) => [row.messageKey, row.eventType])).toEqual([
      ['portal.order.received', 'sales_order.created'],
      ['portal.order.confirmed', 'sales_order.status_changed'],
    ])
    expect(await newsOf(ids.bBuyer, waiting.id)).toEqual([])
    const mails = h.ses.mails.slice(before).filter((mail) => mail.templateKey === 'portal.notification' && mail.to[0] === brandA.buyer)
    const seq = (await one<{ customerSeq: number }>('SELECT "customerSeq" FROM "SalesOrder" WHERE id = $1', [waiting.id])).customerSeq
    expect(mails.map((mail) => textOf(mail.raw).includes(`Your order ${seq} is confirmed`))).toEqual([true])
    expect(await fanOutAll()).toBe(0)
  })

  it('a yes given before the worker handled the making: received, then confirmed — never "confirmed" twice', async () => {
    const quick = await madeOrder('PO-TH006-QUICK')
    expect(quick.status).toBe('PENDING_APPROVAL')
    await approve(quick.id)
    expect(await statusOf(quick.id)).toBe('CONFIRMED')
    await fanOutAll()
    expect((await newsOf(ids.aBuyer, quick.id)).map((row) => row.messageKey)).toEqual(['portal.order.received', 'portal.order.confirmed'])
    expect(await newsOf(ids.bBuyer, quick.id)).toEqual([])
  })

  it('an order cancelled while it waited is never news of a confirmation (nor of a wait that is over)', async () => {
    const dropped = await madeOrder('PO-TH006-CANCEL')
    await ok('owner', 'POST', `/sales/orders/${dropped.id}/cancel`, { version: dropped.version, reason: 'The customer withdrew it (made-up).' })
    expect(await statusOf(dropped.id)).toBe('CANCELLED')
    await fanOutAll()
    expect(await newsAbout(dropped.id)).toEqual([])
  })

  it('an order made confirmed says so at once (as before)', async () => {
    await switchRule(false)
    const confirmed = await madeOrder('PO-TH006-OK')
    expect(confirmed.status).toBe('CONFIRMED')
    await fanOutAll()
    expect((await newsOf(ids.aBuyer, confirmed.id)).map((row) => row.messageKey)).toEqual(['portal.order.confirmed'])
    expect((await newsAbout(confirmed.id)).every((row) => row.partyId === partyA)).toBe(true)
    expect(await newsOf(ids.bBuyer, confirmed.id)).toEqual([])
  })

  it('the portal record agrees: Confirmed is done only once confirmed, on the day of the yes; skipped when cancelled waiting', async () => {
    const buyer = await signedIn(brandA.buyer)
    await switchRule(true)
    const pending = await madeOrder('PO-TH006-PORTAL')
    const stepOf = async (orderId: string) => ((await buyer.get(`/portal/sales-orders/${orderId}`)).body.milestones as Json[]).find((step) => step.key === 'CONFIRMED')!
    const read = await buyer.get(`/portal/sales-orders/${pending.id}`)
    expect(read.status, JSON.stringify(read.body)).toBe(200)
    expect(read.body.order.status).toBe('REQUESTED')
    expect(await stepOf(pending.id)).toMatchObject({ state: 'TODO', date: null })
    await approve(pending.id)
    const yes = await one<{ day: string }>('SELECT (at AT TIME ZONE \'Europe/Rome\')::date::text AS day FROM "AuditLog" WHERE "recordType" = \'SalesOrder\' AND "recordId" = $1 AND after->>\'status\' = \'CONFIRMED\' ORDER BY at LIMIT 1', [pending.id])
    expect(await stepOf(pending.id)).toMatchObject({ state: 'DONE', date: yes.day })
    const dropped = await madeOrder('PO-TH006-PORTAL-CANCEL')
    await ok('owner', 'POST', `/sales/orders/${dropped.id}/cancel`, { version: dropped.version, reason: 'Withdrawn while waiting (made-up).' })
    expect(await stepOf(dropped.id)).toMatchObject({ state: 'SKIPPED', date: null })
    // Customer B's portal finds none of A's orders.
    const other = await signedIn(brandB.buyer)
    expect([403, 404]).toContain((await other.get(`/portal/sales-orders/${pending.id}`)).status)
    await switchRule(false)
  })
})

// ── th3b follow-up 5 (threads plan §0.5, "counts do not leak"): a shipment notice and a customer's task list ─────────────────
/** A copy of a seed row with some columns changed (test data past the guards: replica mode, one connection). */
async function copyRow(table: string, sourceId: string, changes: Record<string, unknown>): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(`CREATE TEMP TABLE _copy AS SELECT * FROM "${table}" WHERE id = $1`, [sourceId])
    const keys = Object.keys(changes)
    await admin(`UPDATE _copy SET ${keys.map((key, index) => `"${key}" = $${index + 1}`).join(', ')}`, Object.values(changes))
    await admin(`INSERT INTO "${table}" SELECT * FROM _copy`)
  } finally {
    await admin('DROP TABLE IF EXISTS _copy')
    await admin('SET session_replication_role = DEFAULT')
  }
}

describe('th3b follow-up 5: the customer reads its own order number in shipment news and in its tasks — never SH- or SO-', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const SHIP_NO = `SH-TH3B-${run}`
  const uploader = `uma.uploader.${run}@brand-alpha.example`
  let order: Json
  let seq = 0
  let uploaderId = ''
  let taskId = ''

  it('a delivery that shipped: "A delivery of your order N has shipped" to A’s people only, chip "#N", never the shipment or order series', async () => {
    // Its own start, whatever T06 left: company A's credit rule off, so the order is made CONFIRMED.
    if ((await one<{ active: boolean }>('SELECT active FROM "ApprovalRule" WHERE id = $1', [ruleId])).active) await switchRule(false)
    order = await madeOrder('PO-TH3B-SHIP')
    expect(order.status).toBe('CONFIRMED')
    seq = (await one<{ customerSeq: number }>('SELECT "customerSeq" FROM "SalesOrder" WHERE id = $1', [order.id])).customerSeq
    expect(seq).toBeGreaterThan(0)
    const source = await one<{ id: string }>('SELECT id FROM "Shipment" WHERE "tenantId" = $1 AND "companyId" = $2 ORDER BY number LIMIT 1', [T, companyA])
    const shipmentId = newId()
    await copyRow('Shipment', source.id, { id: shipmentId, number: SHIP_NO, companyId: companyA, partyId: partyA, salesOrderId: order.id, status: 'SHIPPED', shippedAt: h.clock.now() })
    const before = h.ses.mails.length
    const event = { eventId: newId(), type: 'shipment.status_changed', tenantId: T, companyId: companyA, siteId: null, payload: { shipmentId, number: SHIP_NO, from: 'PACKED', to: 'SHIPPED' } }
    await partnerFanOut(system(), event as never, { clock: h.clock, unsubscribeKey: unsubscribeKeyOf(h.auth.secrets) })
    const news = await admin<{ userId: string; partyId: string; messageKey: string; recordLabel: string }>('SELECT "userId", "partyId", "messageKey", "recordLabel" FROM "Notification" WHERE "recordType" = \'Shipment\' AND "recordId" = $1', [shipmentId])
    expect(news.map((row) => row.userId)).toContain(ids.aBuyer)
    expect(news.map((row) => row.userId)).not.toContain(ids.bBuyer)
    for (const row of news) expect(row).toMatchObject({ partyId: partyA, messageKey: 'portal.shipment.shipped', recordLabel: `#${seq}` })
    const mails = h.ses.mails.slice(before).filter((mail) => mail.templateKey === 'portal.notification' && mail.to[0] === brandA.buyer)
    expect(mails).toHaveLength(1)
    const text = textOf(mails[0]!.raw)
    expect(text).toContain(`A delivery of your order ${seq} has shipped`)
    expect(text).not.toContain(SHIP_NO)
    expect(text).not.toContain(order.number)
    expect(h.ses.mails.slice(before).some((mail) => mail.to[0] === brandB.buyer)).toBe(false)
  })

  it('a task on A’s order: the office reads its own number; A’s task list, its notice and mail read "#N", never SO-', async () => {
    uploaderId = await partnerPerson(uploader, partyA, ['customer-buyer', 'partner-upload', 'partner-approve'])
    // The office's "Ask the customer for…" on its order, as POST /partners/:partyId/tasks opens it (its label: the office's own
    // number, recordLabelOf). This test's app has no office sign-in (the route runs on the app's clock), so the task opens here.
    const opened = await command(system(), { name: 'partnerTasks.open', input: { orderId: order.id } }, async (tools) => ({
      taskId: (await openTaskInCommand(tools, { companyId: companyA, partyId: partyA, kind: 'UPLOAD_DOCUMENT', record: { type: 'SalesOrder', id: order.id, label: order.number }, sourceKey: `Ask:${newId()}`, dueAt: new Date(h.clock.now().getTime() + 3 * 86_400_000), askedBy: { id: PEOPLE.sales, name: 'Made-up sales' } })).task.id,
    }))
    taskId = opened.result.taskId
    // The office keeps reading its own number (its view of the task, as the office's list and answer give it).
    const row = await h.database.withScope({ audience: 'office', tenantId: T, actorId: PEOPLE.sales }, (client) => taskById(client, taskId))
    expect(taskView(row!, h.clock.now()).record).toMatchObject({ type: 'SalesOrder', id: order.id, label: order.number })
    const before = h.ses.mails.length
    await fanOutAll()
    const news = await admin<{ userId: string; partyId: string; recordLabel: string }>('SELECT "userId", "partyId", "recordLabel" FROM "Notification" WHERE "recordType" = \'SalesOrder\' AND "recordId" = $1 AND "messageKey" = \'portal.task.opened\'', [order.id])
    expect(news.map((row) => row.userId)).toContain(uploaderId)
    for (const row of news) expect(row).toMatchObject({ partyId: partyA, recordLabel: `#${seq}` })
    for (const mail of h.ses.mails.slice(before).filter((one) => one.to[0] === uploader)) expect(textOf(mail.raw)).not.toContain(order.number)
    // The portal: the list, Home's waiting items, the notifications.
    const portal = await signedIn(uploader)
    const list = await portal.get('/portal/tasks')
    expect(list.status, JSON.stringify(list.body)).toBe(200)
    const item = (list.body.items as Json[]).find((entry) => entry.id === taskId)!
    expect(item.record).toMatchObject({ type: 'SalesOrder', id: order.id, label: `#${seq}` })
    expect(item.words.en).toContain(`#${seq}`)
    for (const url of ['/portal/tasks', '/portal/home', '/portal/notifications']) {
      const answer = await portal.get(url)
      expect(answer.status, url).toBe(200)
      expect(JSON.stringify(answer.body), url).not.toContain(order.number)
    }
  })

  it('an approval asked on A’s order (approvals-out’s task: "<kind> · <record>") reads the kind and "#N" on the portal; B reads none', async () => {
    const requestId = newId()
    const approvalTaskId = newId()
    await admin('SET session_replication_role = replica')
    try {
      await admin(
        `INSERT INTO "ApprovalRequest" (id, "tenantId", "companyId", "recordType", "recordId", "partyId", kind, question, "dueAt", "createdAt", "updatedAt") VALUES ($1, $2, $3, 'SalesOrder', $4, $5, 'SAMPLE', 'Made-up: is the sample right?', now() + interval '5 days', now(), now())`,
        [requestId, T, companyA, order.id, partyA],
      )
      await admin(
        `INSERT INTO "PartnerTask" (id, "tenantId", "companyId", "partyId", kind, "recordType", "recordId", "recordLabel", "sourceKey", "dueAt", status, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, 'APPROVE', 'ApprovalRequest', $5, $6, $7, now() + interval '5 days', 'OPEN', now(), now())`,
        [approvalTaskId, T, companyA, partyA, requestId, `Sample · ${order.number}`, `ApprovalRequest:${requestId}`],
      )
    } finally {
      await admin('SET session_replication_role = DEFAULT')
    }
    const portal = await signedIn(uploader)
    const list = await portal.get('/portal/tasks')
    expect(list.status, JSON.stringify(list.body)).toBe(200)
    const item = (list.body.items as Json[]).find((entry) => entry.id === approvalTaskId)!
    expect(item.record.label).toBe(`Sample · #${seq}`)
    expect(item.words.en).toBe(`Approve Sample · #${seq}`)
    expect(JSON.stringify(list.body)).not.toContain(order.number)
    // Customer B's list holds none of A's requests.
    const other = await signedIn(brandB.buyer)
    const theirs = JSON.stringify((await other.get('/portal/tasks')).body)
    expect(taskId).not.toBe('')
    expect(theirs).not.toContain(approvalTaskId)
    expect(theirs).not.toContain(taskId)
  })
})
// ── end th3b follow-up 5
