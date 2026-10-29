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
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { startHarness, type Harness } from '../../platform/auth/sessions/testing/harness'

/**
 * Today's actions (B-W1-52 actions; design home.today "alert → Acknowledge · Assign · Resolve", "Handled today", popups
 * assign, resolve-note, arrange) on the local stack: a throwaway PostgreSQL 17 database from the migrations (the runtime
 * login: row-level security and the …_insights_attention_actions_guards triggers are real) and the real app. People are
 * real users with live role assignments (the assignee rule reads them), and each test session holds the same template's
 * grants. One made-up tenant (factory-db seeds up to inventory): SEED-SO-0001 two days late (an alert of company A), a
 * lining lot in quarantine received by the second inspector (four eyes), SEED-Q-0002 waiting for an approval (not an
 * alert). Run with `node scripts/factory/run-pg-tests.mjs insights`.
 */

let h: Harness
let app: FastifyInstance

const NS = 'insights-actions'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const companyB = idOf('company:B')
const siteA = idOf('site:A1')
const TODAY = businessDate(new Date())

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!

// ---- people: users with live roles in the database, and test sessions with the same grants ---------------------------------

const PEOPLE = {
  owner: newId(),
  sales: newId(),
  salesB: newId(),
  buyer: newId(),
  inspector: newId(),
  inspector2: newId(),
  suspended: newId(),
} as const
type Person = keyof typeof PEOPLE

const ROLES: Record<Person, { readonly role: string; readonly companies: Grant['companies']; readonly status?: 'SUSPENDED' }> = {
  owner: { role: 'owner', companies: 'all' },
  sales: { role: 'sales', companies: [companyA] },
  salesB: { role: 'sales', companies: [companyB] },
  buyer: { role: 'buyer', companies: 'all' },
  inspector: { role: 'quality_inspector', companies: 'all' },
  inspector2: { role: 'quality_inspector', companies: 'all' },
  suspended: { role: 'sales', companies: 'all', status: 'SUSPENDED' },
}

function fromTemplate(key: string, companies: Grant['companies']): Grant {
  const template = templateOf(key)!
  return { permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies, sites: 'all', parties: 'all' }
}
const office = (actorId: string, grants: Grant[]): (() => SessionContext) => () => ({ audience: 'office', tenantId: T, actorId, grants })
const SESSIONS: Record<string, () => SessionContext> = {
  ...Object.fromEntries(Object.entries(ROLES).map(([person, { role, companies }]) => [person, office(PEOPLE[person as Person], [fromTemplate(role, companies)])])),
  nobody: office(newId(), [{ permissions: ['home.view'], companies: 'all', sites: 'all', parties: 'all' }]),
  floor: () => ({ audience: 'floor', tenantId: T, actorId: newId(), siteId: siteA, deviceId: newId(), grants: [{ permissions: ['floor.work', 'home.view'], companies: [companyA], sites: [siteA], parties: 'all' }] }),
}

async function call(session: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, key?: string): Promise<{ status: number; body: Json }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
  return { status: response.statusCode, body: response.json() as Json }
}
async function ok(session: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, key?: string): Promise<Json> {
  const answer = await call(session, method, url, payload, key)
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  return answer.body
}
const today = (session: string) => ok(session, 'GET', '/home/today?limit=200')
const rowOf = async (session: string, recordId: string): Promise<Json | undefined> => ((await today(session)).items as Json[]).find((item) => item.record.id === recordId)
const rowUrl = (key: string, verb: string) => `/home/today/rows/${encodeURIComponent(key)}/${verb}`
const issuePaths = (body: Json): string[] => ((body.error?.issues ?? []) as Json[]).map((issue) => issue.path)

const ids = {} as { order: string; lot: string; quote: string }
let orderKey: string
let lotKey: string

beforeAll(async () => {
  h = await startHarness('insights_actions')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedInventory({ db: h.database, namespace: NS })

  // The people, with their roles live in the database.
  const roleIds = new Map((await admin<{ id: string; key: string }>(`SELECT id, key FROM "Role" WHERE "tenantId" = $1`, [T])).map((row) => [row.key, row.id]))
  for (const [person, { role, companies, status }] of Object.entries(ROLES)) {
    const userId = PEOPLE[person as Person]
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, $5)`, [userId, T, `today-${person}@example.com`, `Person ${person}`, status ?? 'ACTIVE'])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, $5, $6::uuid[], now() - interval '1 day')`, [
      newId(),
      T,
      userId,
      roleIds.get(role),
      companies === 'all',
      companies === 'all' ? [] : companies,
    ])
  }

  // SEED-SO-0001 two days late: an alert of company A.
  ids.order = (await one<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = 'SEED-SO-0001'`, [T])).id
  await admin(`UPDATE "SalesOrder" SET "promiseDate" = $2::date WHERE id = $1`, [ids.order, addDays(TODAY, -2)])

  // A lining lot in quarantine at A1, received by the second inspector (four eyes: never theirs to release).
  const lining = await one<{ itemId: string }>(`SELECT "itemId" FROM "Lot" WHERE "tenantId" = $1 AND code = 'SEED-LOT-LIN-01'`, [T])
  ids.lot = newId()
  await admin(`INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", code, "receivedAt", "createdById") VALUES ($1, $2, $3, $4, $5, 'ACT-LOT-Q', now() - interval '2 days', $6)`, [ids.lot, T, companyA, siteA, lining.itemId, PEOPLE.inspector2])

  // SEED-Q-0002 waits for an approval the sales person asked (an approval: decided in its review, never resolved here).
  ids.quote = (await one<{ id: string }>(`SELECT id FROM "Quote" WHERE "tenantId" = $1 AND number = 'SEED-Q-0002'`, [T])).id
  const version = await one<{ id: string; partyId: string }>(`SELECT id, "partyId" FROM "QuoteVersion" WHERE "quoteId" = $1 ORDER BY revision DESC LIMIT 1`, [ids.quote])
  await admin(`UPDATE "QuoteVersion" SET status = 'PENDING_APPROVAL' WHERE id = $1`, [version.id])
  await admin(`UPDATE "Quote" SET status = 'PENDING_APPROVAL' WHERE id = $1`, [ids.quote])
  await admin(`INSERT INTO "QuoteApproval" (id, "tenantId", "versionId", "partyId", reasons, "createdById") VALUES ($1, $2, $3, $4, ARRAY['DISCOUNT_LIMIT']::"QuoteApprovalReason"[], $5)`, [newId(), T, version.id, version.partyId, PEOPLE.sales])

  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
  orderKey = `ORDER_PROMISE:${ids.order}`
  lotKey = `LOT_HOLD:${ids.lot}`
}, 300_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('a row says what may be done to it', () => {
  it('an alert: its condition, version 0, the three verbs; an approval: none, and resolving it is refused', async () => {
    const order = await rowOf('owner', ids.order)
    expect(order).toMatchObject({ key: orderKey, kind: 'ORDER_PROMISE', condition: expect.stringMatching(/^[0-9a-f]{32}$/), actions: { version: 0, verbs: ['ASSIGN', 'RESOLVE', 'ACKNOWLEDGE'], assigned: null, acknowledged: null } })
    const quote = await rowOf('owner', ids.quote)
    expect(quote).toMatchObject({ kind: 'QUOTE_APPROVAL', actions: { version: 0, verbs: [] } })
    const refused = await call('owner', 'POST', rowUrl(quote!.key, 'resolve'), { condition: quote!.condition, version: 0, note: 'Not an alert at all' })
    expect(refused.status).toBe(409)
    expect(issuePaths(refused.body)).toEqual(['action/NOT_AN_ALERT'])
    expect((await today('owner')).handled).toEqual({ today: 0 })
  })
})

describe('assign: only to someone who may act on the row', () => {
  it('the assignee list: active people who may act and reach Today, the responsible ones first; never another company’s, the buyer or a suspended person', async () => {
    const answer = await ok('owner', 'GET', rowUrl(orderKey, 'assignees'))
    const people = answer.people as Json[]
    const mine = people.filter((person) => Object.values(PEOPLE).includes(person.id))
    expect(mine.map((person) => person.id)).toEqual([PEOPLE.sales, PEOPLE.owner])
    expect(mine).toEqual([
      { id: PEOPLE.sales, name: 'Person sales', me: false, suggested: true, assigned: false },
      { id: PEOPLE.owner, name: 'Person owner', me: true, suggested: false, assigned: false },
    ])
    for (const never of [PEOPLE.salesB, PEOPLE.buyer, PEOPLE.suspended, PEOPLE.inspector]) expect(people.some((person) => person.id === never)).toBe(false)
  })

  it('refuses a person who may not act (another company, no right to act, suspended, unknown) in words, and stores nothing', async () => {
    const row = (await rowOf('owner', ids.order))!
    for (const assigneeId of [PEOPLE.salesB, PEOPLE.buyer, PEOPLE.suspended, newId()]) {
      const refused = await call('owner', 'POST', rowUrl(orderKey, 'assign'), { condition: row.condition, version: 0, assigneeId })
      expect(refused.status, assigneeId).toBe(400)
      expect(issuePaths(refused.body)).toEqual(['body/assigneeId'])
    }
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "AttentionAction" WHERE "tenantId" = $1`, [T])).n).toBe(0)
  })

  it('assigned: the row says to whom on everyone’s Today and is on the assignee’s; one history row, two audit rows, one event', async () => {
    const row = (await rowOf('owner', ids.order))!
    const answer = await ok('owner', 'POST', rowUrl(orderKey, 'assign'), { condition: row.condition, version: 0, assigneeId: PEOPLE.sales }, 'assign-order-0001')
    expect(answer).toMatchObject({ key: orderKey, condition: row.condition, resolved: false, actions: { version: 1, assigned: { to: { id: PEOPLE.sales, name: 'Person sales', me: false }, by: { id: PEOPLE.owner, me: true } } } })
    // A repeat with the same key answers the same, and writes nothing again.
    expect(await ok('owner', 'POST', rowUrl(orderKey, 'assign'), { condition: row.condition, version: 0, assigneeId: PEOPLE.sales }, 'assign-order-0001')).toEqual(answer)

    expect((await rowOf('sales', ids.order))!.actions).toMatchObject({ version: 1, assigned: { to: { id: PEOPLE.sales, me: true }, by: { id: PEOPLE.owner, name: 'Person owner', me: false } } })
    expect((await rowOf('owner', ids.order))!.actions.assigned.to).toEqual({ id: PEOPLE.sales, name: 'Person sales', me: false })
    expect((await ok('owner', 'GET', rowUrl(orderKey, 'assignees'))).people.find((person: Json) => person.id === PEOPLE.sales).assigned).toBe(true)

    const action = await one(`SELECT id, kind, "recordType", "recordId", "companyId", "assignedToId", "assignedById", version FROM "AttentionAction" WHERE "tenantId" = $1 AND "rowKey" = $2`, [T, orderKey])
    expect(action).toMatchObject({ kind: 'ORDER_PROMISE', recordType: 'SalesOrder', recordId: ids.order, companyId: companyA, assignedToId: PEOPLE.sales, assignedById: PEOPLE.owner, version: 1 })
    expect(await admin(`SELECT verb, "assigneeId", "actorId", "recordLabel", condition FROM "AttentionActionLog" WHERE "actionId" = $1`, [action.id])).toEqual([
      { verb: 'ASSIGNED', assigneeId: PEOPLE.sales, actorId: PEOPLE.owner, recordLabel: 'SEED-SO-0001', condition: row.condition },
    ])
    expect((await admin(`SELECT "recordType" FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'insights.assignRow' ORDER BY "recordType"`, [T])).map((audit) => audit.recordType)).toEqual(['AttentionAction', 'SalesOrder'])
    expect(await admin(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'attention.assigned'`, [T])).toEqual([
      { payload: { actionId: action.id, key: orderKey, kind: 'ORDER_PROMISE', recordType: 'SalesOrder', recordId: ids.order, condition: row.condition, assigneeId: PEOPLE.sales } },
    ])
  })

  it('a stale version, a changed condition and an assignment that changes nothing are 409s', async () => {
    const row = (await rowOf('owner', ids.order))!
    expect((await call('owner', 'POST', rowUrl(orderKey, 'assign'), { condition: row.condition, version: 0, assigneeId: PEOPLE.owner })).status).toBe(409)
    const changed = await call('owner', 'POST', rowUrl(orderKey, 'assign'), { condition: '0'.repeat(32), version: 1, assigneeId: PEOPLE.owner })
    expect([changed.status, issuePaths(changed.body)]).toEqual([409, ['action/CHANGED']])
    const same = await call('owner', 'POST', rowUrl(orderKey, 'assign'), { condition: row.condition, version: 1, assigneeId: PEOPLE.sales })
    expect([same.status, issuePaths(same.body)]).toEqual([409, ['action/ALREADY_ASSIGNED']])
  })
})

describe('the walls: nobody acts on a row they could not see', () => {
  it('another company’s person, a person with Today and nothing else, an unknown or malformed key: one 404', async () => {
    const row = (await rowOf('owner', ids.order))!
    for (const session of ['salesB', 'nobody', 'buyer']) {
      expect((await call(session, 'POST', rowUrl(orderKey, 'acknowledge'), { condition: row.condition, version: 1 })).status, session).toBe(404)
      expect((await call(session, 'GET', rowUrl(orderKey, 'assignees'))).status, session).toBe(404)
    }
    expect((await rowOf('salesB', ids.order))).toBeUndefined()
    expect((await call('owner', 'POST', rowUrl(`ORDER_PROMISE:${newId()}`, 'acknowledge'), { condition: row.condition, version: 0 })).status).toBe(404)
    expect((await call('owner', 'POST', rowUrl('ORDER_PROMISE:nonsense', 'acknowledge'), { condition: row.condition, version: 0 })).status).toBe(404)
    expect((await call('floor', 'POST', rowUrl(orderKey, 'acknowledge'), { condition: row.condition, version: 1 })).status).toBe(403)
  })

  it('four eyes: the lot’s receiver never sees it to act on, and it is never assigned to them', async () => {
    const lot = (await rowOf('inspector', ids.lot))!
    expect(lot).toMatchObject({ key: lotKey, kind: 'LOT_HOLD', state: 'QUARANTINE' })
    expect(await rowOf('inspector2', ids.lot)).toBeUndefined()
    const people = (await ok('inspector', 'GET', rowUrl(lotKey, 'assignees'))).people as Json[]
    expect(people.map((person) => person.id)).toContain(PEOPLE.inspector)
    expect(people.map((person) => person.id)).not.toContain(PEOPLE.inspector2)
    const refused = await call('inspector', 'POST', rowUrl(lotKey, 'assign'), { condition: lot.condition, version: 0, assigneeId: PEOPLE.inspector2 })
    expect([refused.status, issuePaths(refused.body)]).toEqual([400, ['body/assigneeId']])
    expect((await call('inspector2', 'POST', rowUrl(lotKey, 'acknowledge'), { condition: lot.condition, version: 0 })).status).toBe(404)
  })
})

describe('acknowledge, then resolve with a note', () => {
  it('acknowledged: the row stays on Today, marked for everyone; a second acknowledgement is refused', async () => {
    const row = (await rowOf('sales', ids.order))!
    const answer = await ok('sales', 'POST', rowUrl(orderKey, 'acknowledge'), { condition: row.condition, version: 1 })
    expect(answer.actions).toMatchObject({ version: 2, verbs: ['ASSIGN', 'RESOLVE'], acknowledged: { by: { id: PEOPLE.sales, me: true } }, assigned: { to: { id: PEOPLE.sales } } })
    expect((await rowOf('owner', ids.order))!.actions.acknowledged).toMatchObject({ by: { id: PEOPLE.sales, name: 'Person sales', me: false } })
    const again = await call('owner', 'POST', rowUrl(orderKey, 'acknowledge'), { condition: row.condition, version: 2 })
    expect([again.status, issuePaths(again.body)]).toEqual([409, ['action/ALREADY_ACKNOWLEDGED']])
  })

  it('a resolution needs a note saying what was done', async () => {
    const row = (await rowOf('sales', ids.order))!
    for (const note of ['', '  ', 'ok']) {
      const refused = await call('sales', 'POST', rowUrl(orderKey, 'resolve'), { condition: row.condition, version: 2, note })
      expect([refused.status, issuePaths(refused.body)], JSON.stringify(note)).toEqual([400, ['body/note']])
    }
    expect((await call('sales', 'POST', rowUrl(orderKey, 'resolve'), { condition: row.condition, version: 2 })).status).toBe(400)
  })

  it('resolved: off everyone’s Today and its counts; the note in the history, on the order’s audit trail and in Handled today', async () => {
    const before = await today('owner')
    const row = (await rowOf('sales', ids.order))!
    const answer = await ok('sales', 'POST', rowUrl(orderKey, 'resolve'), { condition: row.condition, version: 2, note: '  Called the customer: delivery agreed for next week.  ' })
    expect(answer).toMatchObject({ resolved: true, actions: { version: 3, assigned: null } })
    for (const session of ['owner', 'sales']) expect(await rowOf(session, ids.order), session).toBeUndefined()
    const after = await today('owner')
    expect(after.counts.tiles[0].count).toBe(before.counts.tiles[0].count - 1)
    expect(after.total).toBe(before.total - 1)

    const action = await one(`SELECT id, "resolveNote", "resolvedById", "resolvedCondition", "assignedToId" FROM "AttentionAction" WHERE "tenantId" = $1 AND "rowKey" = $2`, [T, orderKey])
    expect(action).toMatchObject({ resolveNote: 'Called the customer: delivery agreed for next week.', resolvedById: PEOPLE.sales, resolvedCondition: row.condition, assignedToId: null })
    expect((await admin(`SELECT verb FROM "AttentionActionLog" WHERE "actionId" = $1 ORDER BY at, verb`, [action.id])).map((entry) => entry.verb)).toEqual(['ASSIGNED', 'ACKNOWLEDGED', 'RESOLVED'])
    expect(await one(`SELECT reason FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'insights.resolveRow' AND "recordType" = 'SalesOrder' AND "recordId" = $2`, [T, ids.order])).toEqual({ reason: 'Called the customer: delivery agreed for next week.' })
    expect((await admin(`SELECT type FROM "OutboxEvent" WHERE "tenantId" = $1 AND type LIKE 'attention.%' ORDER BY "occurredAt", id`, [T])).map((event) => event.type)).toEqual(['attention.assigned', 'attention.acknowledged', 'attention.resolved'])

    // A second resolve (someone who read the row before) is told it was resolved meanwhile.
    const twice = await call('owner', 'POST', rowUrl(orderKey, 'resolve'), { condition: row.condition, version: 3, note: 'Done twice?' })
    expect([twice.status, issuePaths(twice.body)]).toEqual([409, ['action/ALREADY_RESOLVED']])

    expect((await today('sales')).handled).toEqual({ today: 2 })
    expect((await today('owner')).handled).toEqual({ today: 1 })
    const handled = await ok('sales', 'GET', '/home/today/handled')
    expect(handled).toMatchObject({ today: TODAY, count: 2 })
    expect(handled.items.map((item: Json) => [item.verb, item.kind, item.record.label, item.note])).toEqual([
      ['RESOLVED', 'ORDER_PROMISE', 'SEED-SO-0001', 'Called the customer: delivery agreed for next week.'],
      ['ACKNOWLEDGED', 'ORDER_PROMISE', 'SEED-SO-0001', null],
    ])
    expect((await ok('owner', 'GET', '/home/today/handled')).items).toMatchObject([{ verb: 'ASSIGNED', key: orderKey, assignee: { id: PEOPLE.sales, name: 'Person sales' } }])
  })

  it('it comes back, unassigned and not acknowledged, when its condition changes (the promise moved), and can be resolved again', async () => {
    await admin(`UPDATE "SalesOrder" SET "promiseDate" = $2::date WHERE id = $1`, [ids.order, addDays(TODAY, -1)])
    const back = (await rowOf('owner', ids.order))!
    expect(back).toMatchObject({ key: orderKey, actions: { version: 3, verbs: ['ASSIGN', 'RESOLVE', 'ACKNOWLEDGE'], assigned: null, acknowledged: null } })
    expect(await rowOf('sales', ids.order)).toBeDefined()
    const action = await one<{ resolvedCondition: string }>(`SELECT "resolvedCondition" FROM "AttentionAction" WHERE "tenantId" = $1 AND "rowKey" = $2`, [T, orderKey])
    expect(back.condition).not.toBe(action.resolvedCondition)
    await ok('owner', 'POST', rowUrl(orderKey, 'resolve'), { condition: back.condition, version: 3, note: 'New date confirmed by mail.' })
    expect(await rowOf('owner', ids.order)).toBeUndefined()
  })
})

describe('the database’s last word (runtime login, row-level security)', () => {
  const asOffice = <R>(work: (client: any) => Promise<R>) => h.database.withScope({ audience: 'office', tenantId: T, actorId: PEOPLE.owner }, (client) => client.$transaction(work))

  it('the history is append-only and a resolution keeps its note; an action is never deleted', async () => {
    const action = await one<{ id: string }>(`SELECT id FROM "AttentionAction" WHERE "tenantId" = $1 AND "rowKey" = $2`, [T, orderKey])
    const log = { tenantId: T, actionId: action.id, rowKey: orderKey, kind: 'ORDER_PROMISE', recordType: 'SalesOrder', recordId: ids.order, recordLabel: 'SEED-SO-0001', condition: 'a'.repeat(32), actorId: PEOPLE.owner, at: new Date(), requestId: 'test' }
    await expect(asOffice((tx) => tx.attentionActionLog.create({ data: { id: newId(), ...log, verb: 'RESOLVED', note: '   ' } }))).rejects.toThrow(/keeps a note/)
    await expect(asOffice((tx) => tx.attentionActionLog.create({ data: { id: newId(), ...log, verb: 'ASSIGNED' } }))).rejects.toThrow(/names its person/)
    await expect(asOffice((tx) => tx.attentionActionLog.create({ data: { id: newId(), ...log, rowKey: `ORDER_PROMISE:${newId()}`, verb: 'ACKNOWLEDGED' } }))).rejects.toThrow(/row key, kind and record/)
    await expect(admin(`UPDATE "AttentionActionLog" SET note = 'changed' WHERE "actionId" = $1`, [action.id])).rejects.toThrow(/never changed/)
    await expect(admin(`DELETE FROM "AttentionActionLog" WHERE "actionId" = $1`, [action.id])).rejects.toThrow(/never changed/)
    await expect(admin(`DELETE FROM "AttentionAction" WHERE id = $1`, [action.id])).rejects.toThrow(/never deleted/)
    await expect(admin(`UPDATE "AttentionAction" SET "resolveNote" = ' ' WHERE id = $1`, [action.id])).rejects.toThrow(/with a note/)
    await expect(admin(`UPDATE "AttentionAction" SET "rowKey" = 'ORDER_PROMISE:' || "recordId"::text || ':x' WHERE id = $1`, [action.id])).rejects.toThrow(/keeps its row key/)
  })

  it('an assignment, a resolution or an acknowledgement not in the history is refused at commit', async () => {
    const action = await one<{ id: string }>(`SELECT id FROM "AttentionAction" WHERE "tenantId" = $1 AND "rowKey" = $2`, [T, orderKey])
    await expect(asOffice((tx) => tx.attentionAction.update({ where: { id: action.id }, data: { acknowledgedCondition: 'b'.repeat(32), acknowledgedById: PEOPLE.owner, acknowledgedAt: new Date() } }))).rejects.toThrow(/not in its history/)
    await expect(asOffice((tx) => tx.attentionAction.update({ where: { id: action.id }, data: { assignedToId: PEOPLE.sales, assignedById: PEOPLE.owner, assignedAt: new Date() } }))).rejects.toThrow(/not in its history/)
    await expect(asOffice((tx) => tx.attentionAction.update({ where: { id: action.id }, data: { resolvedCondition: 'c'.repeat(32), resolveNote: 'quietly', resolvedById: PEOPLE.owner, resolvedAt: new Date() } }))).rejects.toThrow(/not in its history/)
  })
})

describe('Arrange Today: one layout per person', () => {
  const arranged = { sections: [{ id: 'role-panels', hidden: false }, { id: 'needs-me', hidden: false }, { id: 'flow', hidden: true }], panels: [{ id: 'lateOrders', hidden: false, width: 'FULL' }, { id: 'quotesToApprove', hidden: true, width: 'HALF' }], mainLens: 'ORDERS' }

  it('nothing saved: the design’s order at version 0', async () => {
    expect(await ok('owner', 'GET', '/home/today/layout')).toEqual({
      layout: { sections: ['focus-strip', 'needs-me', 'flow', 'role-panels'].map((id) => ({ id, hidden: false })), panels: [], mainLens: null },
      version: 0,
      updatedAt: null,
    })
  })

  it('saved for the person who saves it, never for another; refused in words when it hides Needs me now or names an unknown section', async () => {
    const saved = await ok('owner', 'PUT', '/home/today/layout', { ...arranged, version: 0 })
    expect(saved).toMatchObject({ version: 1, layout: { sections: [{ id: 'role-panels' }, { id: 'needs-me' }, { id: 'flow', hidden: true }, { id: 'focus-strip', hidden: false }], panels: arranged.panels, mainLens: 'ORDERS' } })
    expect(await ok('owner', 'GET', '/home/today/layout')).toEqual(saved)
    expect((await ok('sales', 'GET', '/home/today/layout')).version).toBe(0)
    expect((await call('owner', 'PUT', '/home/today/layout', { ...arranged, version: 0 })).status).toBe(409)
    const hidden = await call('owner', 'PUT', '/home/today/layout', { ...arranged, sections: [{ id: 'needs-me', hidden: true }, { id: 'charts', hidden: false }], version: 1 })
    expect([hidden.status, issuePaths(hidden.body)]).toEqual([400, ['body/sections/0/hidden', 'body/sections/1/id']])
    const again = await ok('owner', 'PUT', '/home/today/layout', { ...arranged, mainLens: null, version: 1 })
    expect(again).toMatchObject({ version: 2, layout: { mainLens: null } })
    expect(await admin(`SELECT "userId", version FROM "TodayLayout" WHERE "tenantId" = $1`, [T])).toEqual([{ userId: PEOPLE.owner, version: 2 }])
    expect((await admin(`SELECT action FROM "AuditLog" WHERE "tenantId" = $1 AND "recordType" = 'TodayLayout'`, [T])).length).toBe(2)
    await expect(admin(`UPDATE "TodayLayout" SET sections = '{}'::jsonb WHERE "tenantId" = $1`, [T])).rejects.toThrow(/as lists/)
  })
})
