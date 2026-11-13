import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedBuyingDepth } from '../../../../../../packages/factory-db/seed/buying-depth'
import { seed as seedNotifyDepth } from '../../../../../../packages/factory-db/seed/notify-depth'
import { seed as seedSalesIntake } from '../../../../../../packages/factory-db/seed/sales-intake'
import { seed as seedService } from '../../../../../../packages/factory-db/seed/service'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor, COMMAND_SETTINGS } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { ensureBuiltInRules } from '../../alerts/built-in'
import { evaluateKind } from '../../alerts/engine'
import { startHarness, type Harness } from '../../auth/sessions/testing/harness'
import { useExportSources } from '../../exports/registry'
import { defineExportSource } from '../../exports/source'
import { systemContext } from '../../outbox/system'
import { fanOut } from '../fan-out'
import { createPushRuntime, FakePushService, usePush } from '../push/service'
import { testVapid } from '../push/testing'
import { localIdMemory, runViewFollows } from './evaluate'

/**
 * Following in depth and the follow-ups of B-W2b-385 (PLT-151 follow a saved view or a record; NT1:01 a request to buy
 * answered, NT1:02 an inquiry given to a person and waiting on Today, NT1:03 a product-safety report to quality, NT1:04 a late
 * return's alert) on the local stack: a throwaway PostgreSQL 17 from the migrations, the seeds of the notification, inquiry,
 * service and buying waves (made up), people with live roles, the real routes, the scheduler's count and the worker's fan-out
 * run as they would. Run with `node scripts/factory/run-pg-tests.mjs platform/notifications/view-follow`.
 */

vi.setConfig({ testTimeout: 180_000 })

const NS = 'w2b385-follow'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
let h: Harness
let app: FastifyInstance

const PEOPLE = { ada: newId(), bruno: newId(), quinn: newId(), piero: newId() } as const
type Person = keyof typeof PEOPLE
const ROLE_OF: Record<Person, string> = { ada: 'sales', bruno: 'sales', quinn: 'quality_inspector', piero: 'planner' }
type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async (sql: string, values: unknown[] = []): Promise<Json> => (await admin(sql, values))[0]!

function grantOf(key: string): Grant {
  const template = templateOf(key)!
  return { permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties: 'all' }
}
const sessions = new Map<string, SessionContext>()
let serial = 0
async function call(who: Person, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown): Promise<{ status: number; body: Json }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': who, ...(method === 'GET' ? {} : { 'idempotency-key': `w2b385f-${++serial}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
  return { status: response.statusCode, body: response.json() as Json }
}
async function ok(who: Person, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, status = 200): Promise<Json> {
  const answer = await call(who, method, url, payload)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body
}
const system = () => callerFor(h.database, systemContext(T, `test-${newId()}`))
/** An event as the worker hands it to the fan-out (made here, or read from the outbox). */
const envelope = (type: string, payload: Json, extra: Partial<Json> = {}) => ({ eventId: newId(), type, version: 1, context: 'test', tenantId: T, companyId: companyA, siteId: null, subject: newId(), correlationId: `test-${newId()}`, causationId: null, source: 'test', occurredAt: new Date().toISOString(), payload, ...extra })
async function fanOutOutbox(types: readonly string[], since: Date): Promise<number> {
  const rows = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = ANY($2) AND "occurredAt" >= $3 ORDER BY "occurredAt", id`, [T, types, since])
  let made = 0
  for (const row of rows) made += await fanOut(system(), { eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload })
  return made
}
const notesOf = (person: Person, eventType: string) => admin(`SELECT category, "messageKey", "recordType", "recordId", "recordLabel", params, "actorId" FROM "Notification" WHERE "userId" = $1 AND "eventType" = $2 ORDER BY "createdAt"`, [PEOPLE[person], eventType])

// A list of the test's own (its export source reads these rows, as the person; `q` filters them as the screen would).
let rows: { id: string; tag: string }[] = []
const testSource = defineExportSource<{ q: string | null }, { id: string; tag: string }>({
  listKey: 'test.followed',
  permission: 'home.view',
  query: (address) => ({ q: address.get('q') }),
  read: async (_caller, query, cursor, limit) => {
    const all = rows.filter((row) => query.q === null || row.tag === query.q)
    const start = cursor ? Number(cursor) : 0
    return { rows: all.slice(start, start + limit), next: start + limit < all.length ? String(start + limit) : null }
  },
  columns: { tag: { value: (row) => row.tag } },
})

beforeAll(async () => {
  h = await startHarness('notify_follow_w2b385')
  // The seeded owner's phone has push on (made-up keys that never open): the FAKE push service, never the environment's.
  usePush(createPushRuntime({ vapid: testVapid(), transport: new FakePushService() }))
  // Each seed runs the seeds it builds on first (made-up data of one tenant); the tenant and its companies first of all.
  await seedCore({ db: h.database, namespace: NS })
  await seedNotifyDepth({ db: h.database, namespace: NS })
  await seedSalesIntake({ db: h.database, namespace: NS })
  await seedService({ db: h.database, namespace: NS })
  await seedBuyingDepth({ db: h.database, namespace: NS })
  for (const [key, id] of Object.entries(PEOPLE)) {
    const roleId = (await one(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = $2`, [T, ROLE_OF[key as Person]])).id
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status, locale) VALUES ($1, $2, $3, $4, 'ACTIVE', 'en')`, [id, T, `${key}@follow-w2b385.example.com`, `Made-up ${key}`])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}'::uuid[], now() - interval '1 day')`, [newId(), T, id, roleId])
    sessions.set(key, { audience: 'office', tenantId: T, actorId: id, grants: [grantOf(ROLE_OF[key as Person])] })
  }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => sessions.get(String(request.headers['x-test-session'])) ?? null) },
  )
}, 300_000)

afterAll(async () => {
  useExportSources(undefined)
  usePush(undefined)
  await app?.close()
  await h?.close()
})

describe('follow a saved view (PLT-151)', () => {
  let viewId = ''
  const memory = localIdMemory()
  const log = { info() {}, warn() {}, error() {} }

  it('follows a view I see, counted as me; a list without an export cannot be followed; another person’s own view is not there', async () => {
    useExportSources([testSource])
    rows = [
      { id: newId(), tag: 'late' },
      { id: newId(), tag: 'late' },
      { id: newId(), tag: 'other' },
    ]
    viewId = (await ok('ada', 'POST', '/views', { listKey: 'test.followed', name: 'Late ones', state: { query: 'q=late' } }, 201)).view.id
    const followed = await ok('ada', 'PUT', `/notifications/following/views/${viewId}`)
    expect(followed.views).toEqual([expect.objectContaining({ viewId, name: 'Late ones', listKey: 'test.followed', count: 2, capped: false })])
    const row = await one(`SELECT key, "lastCount", "lastFingerprint" FROM "ViewFollower" WHERE "viewId" = $1`, [viewId])
    expect(row).toMatchObject({ key: `view:${viewId}:${PEOPLE.ada}`, lastCount: 2 })
    expect(row.lastFingerprint).toMatch(/^[0-9a-f]{64}$/)
    // Following again changes nothing.
    expect((await ok('ada', 'PUT', `/notifications/following/views/${viewId}`)).views).toHaveLength(1)
    // REFUSED: a list without an export source (said in words, 409).
    const elsewhere = (await ok('ada', 'POST', '/views', { listKey: 'test.unfollowable', name: 'Nothing to count', state: { query: '' } }, 201)).view.id
    const refused = await call('ada', 'PUT', `/notifications/following/views/${elsewhere}`)
    expect(refused.status).toBe(409)
    expect(refused.body.error.issues[0]).toEqual({ path: 'views/NOT_FOLLOWABLE', message: 'This list cannot be followed yet: a view is counted through the list’s export, and this list has none.' })
    // A view only its owner sees is not there for another person.
    expect((await call('bruno', 'PUT', `/notifications/following/views/${viewId}`)).status).toBe(404)
  })

  it('counts the followed views as their people: the same rows move the count time on; other rows tell the person what came in and left', async () => {
    // The first count after the follow keeps the ids (the same rows: nothing to tell).
    expect(await runViewFollows({ database: h.database, log, memory })).toMatchObject({ changed: 0, failed: 0 })
    const since = new Date()
    rows = [rows[1]!, { id: newId(), tag: 'late' }, { id: newId(), tag: 'late' }, rows[2]!]
    const run = await runViewFollows({ database: h.database, log, memory })
    expect(run).toMatchObject({ changed: 1, failed: 0 })
    const [changed] = await admin(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'notification.view_changed' AND "occurredAt" >= $2`, [T, since])
    expect(changed!.payload).toMatchObject({ viewId, userId: PEOPLE.ada, count: 3, previousCount: 2, entered: 2, left: 1, capped: false })
    expect(await fanOutOutbox(['notification.view_changed'], since)).toBe(1)
    expect(await notesOf('ada', 'notification.view_changed')).toEqual([
      { category: 'FOLLOWING', messageKey: 'notifications.following.view', recordType: 'SavedView', recordId: viewId, recordLabel: 'Late ones', params: { count: 3, previousCount: 2, capped: false, entered: 2, left: 1 }, actorId: null },
    ])
    const list = await ok('ada', 'GET', '/notifications?tab=ALL')
    expect(list.items[0].sentence).toBe('Late ones, a saved view you follow, changed: 2 came in, 1 left (3 now)')
    expect((await ok('ada', 'GET', '/notifications/following/views')).views[0]).toMatchObject({ count: 3 })
  })

  it('stops following: the row goes, nothing more is counted for it', async () => {
    expect((await ok('ada', 'DELETE', `/notifications/following/views/${viewId}`)).views).toEqual([])
    expect(await admin(`SELECT id FROM "ViewFollower" WHERE "viewId" = $1`, [viewId])).toEqual([])
    useExportSources(undefined)
  })
})

describe('follow a record: its status moves reach its followers (PLT-151)', () => {
  it('a followed order’s status change tells each follower who may read it, never the one who changed it', async () => {
    const order = await one(`SELECT id, number, "companyId" FROM "SalesOrder" WHERE "tenantId" = $1 ORDER BY "createdAt" LIMIT 1`, [T])
    for (const who of ['ada', 'piero'] as const) await ok(who, 'PUT', `/threads/SalesOrder/${order.id}/followers/me`, { following: true, muted: false })
    // The change was ada's request (its audit row names her): only piero is told.
    const event = envelope('sales_order.status_changed', { orderId: order.id, number: order.number, from: 'CONFIRMED', to: 'IN_PRODUCTION', by: 'person' })
    await admin(`INSERT INTO "AuditLog" (id, "tenantId", "companyId", audience, "actorId", action, "recordType", "recordId", "requestId") VALUES ($1, $2, $3, 'OFFICE', $4, 'sales.orderStatus', 'SalesOrder', $5, $6)`, [newId(), T, order.companyId, PEOPLE.ada, order.id, event.correlationId])
    expect(await fanOut(system(), event)).toBe(1)
    expect(await notesOf('piero', 'sales_order.status_changed')).toEqual([expect.objectContaining({ category: 'FOLLOWING', messageKey: 'notifications.following.changed', recordType: 'SalesOrder', recordId: order.id, recordLabel: order.number, params: { change: 'sales_order.status_changed' }, actorId: PEOPLE.ada })])
    expect(await notesOf('ada', 'sales_order.status_changed')).toEqual([])
  })
})

describe('the follow-ups (NT1:01-04)', () => {
  it('NT1:01: who asked to buy hears that the request was put on a purchase order, or refused by the buyer; never about their own act', async () => {
    const converted = await one(`SELECT r.id, r."siteId", r."requestedById", r."convertedById", l."purchaseOrderId", o.number FROM "PurchaseRequest" r JOIN "PurchaseOrderLine" l ON l.id = r."purchaseOrderLineId" JOIN "PurchaseOrder" o ON o.id = l."purchaseOrderId" WHERE r."tenantId" = $1 AND r.status = 'CONVERTED' LIMIT 1`, [T])
    // The seed's buyer converted their own request: nobody is told about what they did themselves.
    expect(converted.convertedById).toBe(converted.requestedById)
    expect(await fanOut(system(), envelope('purchase_requests.status_changed', { purchaseRequestId: converted.id, siteId: converted.siteId, from: 'OPEN', to: 'CONVERTED', purchaseOrderId: converted.purchaseOrderId, requestedById: converted.requestedById }))).toBe(0)
    // Ada asks (a made-up copy of the seeded request, OPEN); the buyer piero puts it on the seeded order, then refuses another.
    const ask = async (from: string): Promise<string> => {
      const id = newId()
      await admin(
        `INSERT INTO "PurchaseRequest" SELECT (jsonb_populate_record(NULL::"PurchaseRequest", to_jsonb(r) || jsonb_build_object('id', $2::uuid, 'requestedById', $3::uuid, 'requestedAt', now(), 'status', 'OPEN', 'approvalTaskId', NULL, 'rejectedAt', NULL, 'rejectedById', NULL, 'rejectReason', NULL, 'convertedAt', NULL, 'convertedById', NULL, 'purchaseOrderLineId', NULL, 'cancelledAt', NULL, 'version', 1, 'createdAt', now(), 'updatedAt', now()))).* FROM "PurchaseRequest" r WHERE r.id = $1`,
        [from, id, PEOPLE.ada],
      )
      return id
    }
    const refusedId = await ask(converted.id)
    await admin(`UPDATE "PurchaseRequest" SET status = 'REJECTED', "rejectedAt" = now(), "rejectedById" = $2, "rejectReason" = 'Enough on the shelf (made-up).', version = 2 WHERE id = $1`, [refusedId, PEOPLE.piero])
    expect(await fanOut(system(), envelope('purchase_requests.status_changed', { purchaseRequestId: refusedId, siteId: converted.siteId, from: 'OPEN', to: 'REJECTED', purchaseOrderId: null, requestedById: PEOPLE.ada }))).toBe(1)
    expect(await admin(`SELECT "messageKey", params, category, "actorId" FROM "Notification" WHERE "userId" = $1 AND "recordId" = $2`, [PEOPLE.ada, refusedId])).toEqual([{ messageKey: 'notifications.purchasing.requestRefused', params: { actorId: PEOPLE.piero }, category: 'APPROVAL', actorId: PEOPLE.piero }])
    // A yes or no of the request's approval is the approval engine's notice (approval.decided): not told twice here.
    expect(await fanOut(system(), envelope('purchase_requests.status_changed', { purchaseRequestId: refusedId, siteId: converted.siteId, from: 'PENDING_APPROVAL', to: 'REJECTED', purchaseOrderId: null, requestedById: PEOPLE.ada }))).toBe(0)
    const orderedId = await ask(converted.id)
    const line = (await one(`SELECT "purchaseOrderLineId" FROM "PurchaseRequest" WHERE id = $1`, [converted.id])).purchaseOrderLineId
    await admin(`UPDATE "PurchaseRequest" SET status = 'CONVERTED', "convertedAt" = now(), "convertedById" = $2, "purchaseOrderLineId" = $3, version = 2 WHERE id = $1`, [orderedId, PEOPLE.piero, line])
    expect(await fanOut(system(), envelope('purchase_requests.status_changed', { purchaseRequestId: orderedId, siteId: converted.siteId, from: 'OPEN', to: 'CONVERTED', purchaseOrderId: converted.purchaseOrderId, requestedById: PEOPLE.ada }))).toBe(1)
    expect(await admin(`SELECT "messageKey", params FROM "Notification" WHERE "userId" = $1 AND "recordId" = $2`, [PEOPLE.ada, orderedId])).toEqual([{ messageKey: 'notifications.purchasing.requestOrdered', params: { title: converted.number, purchaseOrderId: converted.purchaseOrderId } }])
  })

  it('NT1:02: an inquiry given to a person tells them; waiting over a working day it is on their Today (not on a colleague’s)', async () => {
    const inquiry = await one(`SELECT id, number, version FROM "Inquiry" WHERE "tenantId" = $1 AND number LIKE '%INQ-0001' LIMIT 1`, [T])
    const since = new Date()
    await ok('ada', 'POST', `/sales/inquiries/${inquiry.id}/assign`, { version: inquiry.version, assigneeId: PEOPLE.bruno })
    expect(await fanOutOutbox(['inquiry.changed'], since)).toBe(1)
    expect(await notesOf('bruno', 'inquiry.changed')).toEqual([expect.objectContaining({ category: 'ASSIGNMENT', messageKey: 'notifications.inquiries.assigned', recordType: 'Inquiry', recordId: inquiry.id, recordLabel: inquiry.number, actorId: PEOPLE.ada })])
    const today = await ok('bruno', 'GET', '/home/today')
    const row = today.items.find((item: Json) => item.kind === 'INQUIRY_WAITING' && item.record.id === inquiry.id)
    expect(row).toMatchObject({ state: 'ASSIGNED', record: { type: 'Inquiry', label: inquiry.number }, why: 'It was given to you.' })
    expect(row.words.sentence.key).toBe('INQUIRY_WAITING.ASSIGNED')
    expect(row.words.why.key).toBe('why.INQUIRY_WAITING.assigned')
    const theirs = await ok('ada', 'GET', '/home/today')
    expect(theirs.items.some((item: Json) => item.kind === 'INQUIRY_WAITING' && item.record.id === inquiry.id)).toBe(false)
  })

  it('NT1:03: a product-safety report tells the people who assess them at once (with an accident: said), nobody else', async () => {
    const report = await one(`SELECT id, number, "partyId", "serviceCaseId" FROM "ProductSafetyReport" WHERE "tenantId" = $1 AND number LIKE '%PSR-SEED-0002' LIMIT 1`, [T])
    await fanOut(system(), envelope('safety_report.received', { reportId: report.id, number: report.number, source: 'MAIL', partyId: report.partyId, serviceCaseId: report.serviceCaseId, garmentSerial: null, garmentBatch: null, accidentLogged: true }))
    expect(await notesOf('quinn', 'safety_report.received')).toEqual([expect.objectContaining({ category: 'ALERT', messageKey: 'notifications.safety.productAccident', recordType: 'ProductSafetyReport', recordId: report.id })])
    expect(await notesOf('piero', 'safety_report.received')).toEqual([])
  })

  it('NT1:04: a return whose goods arrived after their deadline raises its alert (built in, for sales)', async () => {
    const late = await one(`SELECT id, number, "receivedAt" FROM "ReturnAuthorisation" WHERE "tenantId" = $1 AND status IN ('RECEIVED', 'INSPECTED') AND "receivedAt" IS NOT NULL ORDER BY "receivedAt" LIMIT 1`, [T])
    await admin(`UPDATE "ReturnAuthorisation" SET "goodsDueBy" = ($2::timestamptz AT TIME ZONE 'Europe/Rome')::date - 3 WHERE id = $1`, [late.id, late.receivedAt])
    // The built-in rule of the new kind is made as for every kind (the scheduler's pass does it), then the kind is evaluated.
    await ensureBuiltInRules(system(), COMMAND_SETTINGS)
    expect((await evaluateKind(system(), 'RETURN_ARRIVED_LATE', COMMAND_SETTINGS)).raised).toBeGreaterThanOrEqual(1)
    const alert = await one(`SELECT "ruleKind", "recordLabel", facts, state FROM "Alert" WHERE "tenantId" = $1 AND "recordId" = $2`, [T, late.id])
    expect(alert).toMatchObject({ ruleKind: 'RETURN_ARRIVED_LATE', recordLabel: late.number, facts: { daysLate: 3 } })
    expect((await one(`SELECT r.key FROM "AlertRule" a JOIN "Role" r ON r.id = a."recipientRoleId" WHERE a."tenantId" = $1 AND a."ruleKind" = 'RETURN_ARRIVED_LATE' AND a."builtIn"`, [T])).key).toBe('sales')
  })
})
