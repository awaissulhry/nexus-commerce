import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/invoicing/from-shipment/deadlines'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../packages/factory-db/seed/auth'
import { seed as seedInventory } from '../../../../../packages/factory-db/seed/inventory'
import { seed as seedRoles } from '../../../../../packages/factory-db/seed/roles'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { callerFor } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { startHarness, type Harness } from '../../platform/auth/sessions/testing/harness'
import { fanOut } from '../../platform/notifications/fan-out'
import { systemContext } from '../../platform/outbox/system'

/**
 * Today every day, the API part (B-W2a-20; design home.today popup snooze, needs-me "tasks due or overdue · @mentions",
 * focus-strip "Due today · Overdue · Mentions", coming-up, waiting-on "Nudge"; W1 leftovers: Snooze, the assignee notice,
 * Nudge) and the approvals' notifications built per reader (PLT-152), on the local stack with the factory-db seeds (up
 * to inventory) as actions.pg does: SEED-SO-0001 two days late (an alert of company A) and SEED-Q-0002 waiting for an
 * approval the sales person asked. Run with `node scripts/factory/run-pg-tests.mjs modules/insights`.
 */

let h: Harness
let app: FastifyInstance

const NS = 'insights-w2a20'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const TODAY = businessDate(new Date())

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!

const PEOPLE = { owner: newId(), sales: newId(), finance: newId(), approver: newId() } as const
type Person = keyof typeof PEOPLE
/** `approver`: a custom role that approves quotes and holds no money grain (it must never get an amount). */
const APPROVER_PERMISSIONS = ['home.view', 'quotes.view', 'quotes.approve', 'threads.read'] as const
const ROLES: Record<Person, { readonly role: string; readonly companies: Grant['companies'] }> = {
  owner: { role: 'owner', companies: 'all' },
  sales: { role: 'sales', companies: [companyA] },
  finance: { role: 'finance', companies: 'all' },
  approver: { role: 'custom.approver', companies: 'all' },
}
function grantOf(person: Person): Grant {
  const { role, companies } = ROLES[person]
  if (role === 'custom.approver') return { permissions: [...APPROVER_PERMISSIONS], companies, sites: 'all', parties: 'all' }
  const template = templateOf(role)!
  return { permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies, sites: 'all', parties: 'all' }
}
const session = (person: Person): SessionContext => ({ audience: 'office', tenantId: T, actorId: PEOPLE[person], grants: [grantOf(person)] })

async function call(person: Person, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown): Promise<{ status: number; body: Json }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': person }, ...(payload === undefined ? {} : { payload: payload as object }) })
  return { status: response.statusCode, body: response.json() as Json }
}
async function ok(person: Person, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, status = 200): Promise<Json> {
  const answer = await call(person, method, url, payload)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body
}
const issuePaths = (body: Json): string[] => ((body.error?.issues ?? []) as Json[]).map((issue) => issue.path)
const today = (person: Person, query = '') => ok(person, 'GET', `/home/today?limit=200${query}`)
const rowUrl = (key: string, verb: string) => `/home/today/rows/${encodeURIComponent(key)}/${verb}`

async function fanOutSince(types: readonly string[], since: Date): Promise<number> {
  const rows = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = ANY($2) AND "occurredAt" >= $3 ORDER BY "occurredAt", id`, [T, types, since])
  let made = 0
  for (const row of rows) {
    const envelope = { eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload }
    made += await fanOut(callerFor(h.database, systemContext(T, `test-${row.id}`)), envelope)
  }
  return made
}

const ids = {} as { order: string; quote: string; version: string; approval: string; party: string }
let orderKey: string

beforeAll(async () => {
  h = await startHarness('insights_w2a20')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedInventory({ db: h.database, namespace: NS })
  await admin(`INSERT INTO "Role" (id, "tenantId", key, name, permissions, grains) VALUES ($1, $2, 'custom.approver', 'Approver without money', $3::text[], ARRAY[]::text[])`, [newId(), T, [...APPROVER_PERMISSIONS]])
  const roleIds = new Map((await admin<{ id: string; key: string }>(`SELECT id, key FROM "Role" WHERE "tenantId" = $1`, [T])).map((row) => [row.key, row.id]))
  for (const [person, { role, companies }] of Object.entries(ROLES)) {
    const userId = PEOPLE[person as Person]
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [userId, T, `w2a20-${person}@example.com`, `Person ${person}`])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, $5, $6::uuid[], now() - interval '1 day')`, [
      newId(),
      T,
      userId,
      roleIds.get(role),
      companies === 'all',
      companies === 'all' ? [] : companies,
    ])
  }
  ids.order = (await one<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = 'SEED-SO-0001'`, [T])).id
  await admin(`UPDATE "SalesOrder" SET "promiseDate" = $2::date WHERE id = $1`, [ids.order, addDays(TODAY, -2)])
  orderKey = `ORDER_PROMISE:${ids.order}`
  ids.quote = (await one<{ id: string }>(`SELECT id FROM "Quote" WHERE "tenantId" = $1 AND number = 'SEED-Q-0002'`, [T])).id
  const version = await one<{ id: string; partyId: string }>(`SELECT id, "partyId" FROM "QuoteVersion" WHERE "quoteId" = $1 ORDER BY revision DESC LIMIT 1`, [ids.quote])
  ids.version = version.id
  ids.party = version.partyId
  await admin(`UPDATE "QuoteVersion" SET status = 'PENDING_APPROVAL' WHERE id = $1`, [version.id])
  await admin(`UPDATE "Quote" SET status = 'PENDING_APPROVAL' WHERE id = $1`, [ids.quote])
  ids.approval = newId()
  await admin(`INSERT INTO "QuoteApproval" (id, "tenantId", "versionId", "partyId", reasons, "createdById", "createdAt") VALUES ($1, $2, $3, $4, ARRAY['DISCOUNT_LIMIT']::"QuoteApprovalReason"[], $5, now() - interval '2 days')`, [ids.approval, T, version.id, version.partyId, PEOPLE.sales])

  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => (String(request.headers['x-test-session']) in PEOPLE ? session(String(request.headers['x-test-session']) as Person) : null)) },
  )
}, 300_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('the assignee notice (W1 leftover: attention.assigned waits for notifications)', () => {
  it('assigning an alert tells the assignee and makes them follow its record; taking it back tells nobody', async () => {
    const since = new Date()
    const row = ((await today('owner')).items as Json[]).find((item) => item.key === orderKey)!
    await ok('owner', 'POST', rowUrl(orderKey, 'assign'), { condition: row.condition, version: 0, assigneeId: PEOPLE.sales })
    expect(await admin(`SELECT "userId", reason FROM "RecordFollower" WHERE "tenantId" = $1 AND "recordId" = $2`, [T, ids.order])).toEqual([{ userId: PEOPLE.sales, reason: 'ASSIGNEE' }])
    expect(await fanOutSince(['attention.assigned'], since)).toBe(1)
    const told = ((await ok('sales', 'GET', '/notifications?tab=ASSIGNMENT')).items as Json[])[0]!
    expect(told).toMatchObject({ category: 'ASSIGNMENT', record: { type: 'SalesOrder', id: ids.order, label: 'SEED-SO-0001' }, anchor: `today:${orderKey}`, actor: { id: PEOPLE.owner } })
    expect(told.sentence).toBe('Person owner assigned you SEED-SO-0001 on Today (Orders late or due in 3 days and not ready)')
    // Passed on to the owner: the owner is told. Taken back: nobody is told.
    const again = ((await today('sales')).items as Json[]).find((item) => item.key === orderKey)!
    const later = new Date()
    await ok('sales', 'POST', rowUrl(orderKey, 'assign'), { condition: again.condition, version: again.actions.version, assigneeId: PEOPLE.owner })
    expect(await fanOutSince(['attention.assigned'], later)).toBe(1)
    const last = new Date()
    await ok('owner', 'POST', rowUrl(orderKey, 'assign'), { condition: again.condition, version: again.actions.version + 1, assigneeId: null })
    expect(await fanOutSince(['attention.assigned'], last)).toBe(0)
  })
})

describe("Today's Snooze (W1 leftover: no column, no route)", () => {
  it('snoozes an alert for everyone until a time, in one command with its history; not a decision of Handled today', async () => {
    const row = ((await today('owner')).items as Json[]).find((item) => item.key === orderKey)!
    expect(row.actions.snoozable).toBe(true)
    const stale = await call('owner', 'POST', rowUrl(orderKey, 'snooze'), { condition: '0'.repeat(32), version: row.actions.version, until: null })
    expect([stale.status, issuePaths(stale.body)]).toEqual([409, ['action/CHANGED']])
    const past = await call('owner', 'POST', rowUrl(orderKey, 'snooze'), { condition: row.condition, version: row.actions.version, until: new Date(Date.now() - 60_000).toISOString() })
    expect(past.status).toBe(400)
    const handledBefore = (await today('owner')).handled.today
    const until = new Date(Date.now() + 3_600_000).toISOString()
    const snoozed = await ok('owner', 'POST', rowUrl(orderKey, 'snooze'), { condition: row.condition, version: row.actions.version, until })
    expect(snoozed).toMatchObject({ key: orderKey, condition: row.condition, snoozed: { until } })
    for (const person of ['owner', 'sales'] as const) expect(((await today(person)).items as Json[]).some((item) => item.key === orderKey), person).toBe(false)
    const action = await one(`SELECT id, "snoozedCondition", "snoozedById", "snoozedUntil" FROM "AttentionAction" WHERE "tenantId" = $1 AND "rowKey" = $2`, [T, orderKey])
    expect(action).toMatchObject({ snoozedCondition: row.condition, snoozedById: PEOPLE.owner })
    expect(await admin(`SELECT verb, "snoozedUntil" IS NOT NULL AS timed FROM "AttentionActionLog" WHERE "actionId" = $1 AND verb = 'SNOOZED'`, [action.id])).toEqual([{ verb: 'SNOOZED', timed: true }])
    expect((await today('owner')).handled.today).toBe(handledBefore)
    expect((await admin(`SELECT type FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'attention.snoozed'`, [T])).length).toBe(1)
  })

  it('until something changes on the record: the row comes back when its condition changes; an approval is never snoozed here', async () => {
    const action = await one<{ version: number; snoozedCondition: string }>(`SELECT version, "snoozedCondition" FROM "AttentionAction" WHERE "tenantId" = $1 AND "rowKey" = $2`, [T, orderKey])
    await ok('owner', 'POST', rowUrl(orderKey, 'snooze'), { condition: action.snoozedCondition, version: action.version, until: null })
    expect(((await today('owner')).items as Json[]).some((item) => item.key === orderKey)).toBe(false)
    await admin(`UPDATE "SalesOrder" SET "promiseDate" = $2::date WHERE id = $1`, [ids.order, addDays(TODAY, -3)])
    const back = ((await today('owner')).items as Json[]).find((item) => item.key === orderKey)
    expect(back?.condition).not.toBe(action.snoozedCondition)
    const quote = ((await today('owner')).items as Json[]).find((item) => item.kind === 'QUOTE_APPROVAL')!
    expect(quote.actions.snoozable).toBe(false)
    const refused = await call('owner', 'POST', rowUrl(quote.key, 'snooze'), { condition: quote.condition, version: 0, until: null })
    expect([refused.status, issuePaths(refused.body)]).toEqual([409, ['action/NOT_AN_ALERT']])
  })
})

describe('approvals built per reader (PLT-152) and Nudge (W1 leftover)', () => {
  it('tells each person who may decide, with the value and margin only for a reader holding their grain; never the asker', async () => {
    const envelope = { eventId: newId(), type: 'quote.approval_requested', version: 1, context: 'sales', tenantId: T, companyId: companyA, siteId: null, subject: ids.quote, correlationId: 'test', causationId: null, source: 'test', occurredAt: new Date().toISOString(), payload: { quoteId: ids.quote, versionId: ids.version, approvalId: ids.approval, reasons: ['DISCOUNT_LIMIT'] } }
    expect(await fanOut(callerFor(h.database, systemContext(T, 'test-approval')), envelope)).toBeGreaterThanOrEqual(3)
    const rows = await admin<{ userId: string; params: Json }>(`SELECT "userId", params FROM "Notification" WHERE "tenantId" = $1 AND "eventId" = $2`, [T, envelope.eventId])
    const of = (person: Person) => rows.find((row) => row.userId === PEOPLE[person])
    expect(of('sales')).toBeUndefined()
    expect(of('owner')!.params.netAmount).toMatchObject({ $money: 'price' })
    expect(of('finance')!.params).toHaveProperty('netAmount')
    expect(of('approver')!.params).not.toHaveProperty('netAmount')
    expect(of('approver')!.params).not.toHaveProperty('marginPct')
    const seen = ((await ok('approver', 'GET', '/notifications?tab=APPROVAL')).items as Json[])[0]!
    expect(seen.sentence).toBe('Person sales asks you to approve quote SEED-Q-0002')
    expect(JSON.stringify(seen)).not.toMatch(/EUR|\$money|minor/)
    const priced = ((await ok('owner', 'GET', '/notifications?tab=APPROVAL')).items as Json[])[0]!
    expect(priced.sentence).toMatch(/^Person sales asks you to approve quote SEED-Q-0002 \(EUR [0-9.]+/)
  })

  it('the asker nudges once a day: a reminder note on the quote and a notice to who may decide; again today is refused', async () => {
    const waiting = await ok('sales', 'GET', '/home/waiting-on-others')
    const row = (waiting.items as Json[]).find((item) => item.kind === 'APPROVAL_REQUEST')!
    expect(row.nudge).toEqual({ allowed: true, refusal: null })
    const since = new Date()
    const nudged = await ok('sales', 'POST', `/home/waiting-on-others/${encodeURIComponent(row.key)}/nudge`)
    expect(nudged.told).toBeGreaterThanOrEqual(3)
    expect(await one(`SELECT "authorKind", "bodyText" FROM "Message" WHERE id = $1`, [nudged.messageId])).toMatchObject({ authorKind: 'SYSTEM', bodyText: expect.stringMatching(/^Reminder from Person sales: SEED-Q-0002 still waits for an approval/) })
    expect(await fanOutSince(['attention.nudged'], since)).toBe(nudged.told)
    expect(((await ok('approver', 'GET', '/notifications?tab=APPROVAL')).items as Json[]).some((item) => item.messageKey === 'notifications.approval.nudged')).toBe(true)
    const again = await call('sales', 'POST', `/home/waiting-on-others/${encodeURIComponent(row.key)}/nudge`)
    expect([again.status, issuePaths(again.body)]).toEqual([409, ['nudge/TODAY_ALREADY']])
    expect(((await ok('sales', 'GET', '/home/waiting-on-others')).items as Json[]).find((item) => item.key === row.key)!.nudge).toEqual({ allowed: false, refusal: 'TODAY_ALREADY' })
    expect((await call('owner', 'POST', `/home/waiting-on-others/${encodeURIComponent(row.key)}/nudge`)).status).toBe(404)
  })
})

describe("Today's own rows and Coming up (for B-W2a-40)", () => {
  it('lists my tasks due and my mentions only when asked, with the W2a tiles; W1’s answer is unchanged without it', async () => {
    const yesterday = businessDate(new Date(Date.now() - 86_400_000))
    const task = await ok('sales', 'POST', '/tasks', { title: 'Call the customer back', record: { type: 'SalesOrder', id: ids.order }, dueDate: yesterday }, 201)
    const since = new Date()
    await ok('owner', 'POST', `/threads/SalesOrder/${ids.order}/notes`, { body: 'Please look at this one.', mentions: [PEOPLE.sales] }, 201)
    expect(await fanOutSince(['thread.user_mentioned'], since)).toBe(1)

    const w1 = await today('sales')
    expect((w1.items as Json[]).some((item) => item.kind === 'TASK_DUE' || item.kind === 'MENTION')).toBe(false)
    expect((w1.counts.tiles as Json[]).map((tile) => tile.tile)).toEqual(['ALL', 'APPROVAL', 'ALERT'])

    const w2a = await today('sales', '&include=TASKS,MENTIONS')
    const own = (w2a.items as Json[]).filter((item) => item.kind === 'TASK_DUE' || item.kind === 'MENTION')
    expect(own.map((item) => [item.kind, item.category])).toEqual(
      expect.arrayContaining([
        ['TASK_DUE', 'TASK'],
        ['MENTION', 'MENTION'],
      ]),
    )
    const taskRow = own.find((item) => item.kind === 'TASK_DUE')!
    expect(taskRow).toMatchObject({ key: `TASK_DUE:${task.task.id}`, record: { type: 'Task', id: task.task.id }, due: { word: 'OVERDUE' }, group: 'NOW', why: 'It is assigned to you.' })
    expect((w2a.counts.tiles as Json[]).map((tile) => tile.tile)).toEqual(['ALL', 'APPROVAL', 'ALERT', 'DUE_TODAY', 'OVERDUE', 'MENTION'])
    expect((w2a.counts.tiles as Json[]).find((tile) => tile.tile === 'MENTION')!.count).toBe(1)
    const overdue = await today('sales', '&include=TASKS,MENTIONS&due=OVERDUE')
    expect((overdue.items as Json[]).every((item) => item.due?.word === 'OVERDUE')).toBe(true)
    expect((await call('sales', 'GET', '/home/today?include=NOPE')).status).toBe(400)

    // Snoozed from Today (the task's own snooze): off the list until then.
    await ok('sales', 'POST', `/tasks/${task.task.id}/snooze`, { version: task.task.version, until: new Date(Date.now() + 3_600_000).toISOString() })
    expect(((await today('sales', '&include=TASKS')).items as Json[]).some((item) => item.kind === 'TASK_DUE')).toBe(false)
  })

  it('Coming up: my next five working days by day, with my tasks and the promise dates I act on', async () => {
    const soon = await ok('sales', 'POST', '/tasks', { title: 'Send the samples', dueDate: addDays(TODAY, 1) }, 201)
    const answer = await ok('sales', 'GET', `/home/coming-up?companyId=${companyA}`)
    expect(answer.kinds).toEqual(['TASK', 'ORDER'])
    expect(answer.calendar).toEqual({ scope: 'COMPANY', id: companyA })
    expect((answer.days as Json[]).filter((day) => day.working)).toHaveLength(5)
    const items = (answer.days as Json[]).flatMap((day) => day.items as Json[])
    if ((answer.days as Json[]).some((day) => day.date === addDays(TODAY, 1))) expect(items.some((item) => item.record.id === soon.task.id)).toBe(true)
    expect(JSON.stringify(answer)).not.toMatch(/EUR/)
    const approver = await ok('approver', 'GET', '/home/coming-up')
    // Home alone: only my own tasks (none), and Monday to Friday without a calendar asked.
    expect(approver.kinds).toEqual(['TASK'])
    expect(approver.calendar).toBeNull()
    expect((approver.days as Json[]).flatMap((day) => day.items)).toEqual([])
  })
})
