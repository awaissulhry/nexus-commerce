import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { fanOut } from '../../../platform/notifications/fan-out'
import { systemContext } from '../../../platform/outbox/system'

/**
 * Home › Approvals in depth (B-W2b-307; PLT-085, follow-ups AW2:01–03) on the local stack with the app's real routes: a
 * throwaway PostgreSQL 17 from the migrations (the runtime login: row-level security is real), tenant A from EVERY seed
 * (the approval rules all OFF, SEED-ECO-0001, the SMV v2 of CUT proposed by the seed's Owner), made-up office people with
 * live role assignments and test sessions holding the same template grants. Today's approvals (`GET /home/today?category=
 * APPROVAL`, the inbox's third source) now hold every request that needs MY yes — the approval engine's requests, change
 * orders, SMV changes, submitted inspection plan versions — never one I asked, wrote, proposed or named myself for; the
 * engine's requests and SMV changes tell their deciders (the fan-out), and the decision tells who asked. Every name and
 * number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/insights/`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT'

const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'approvals-307'
const id = (key: string) => seedUuid(NS, key)
const firstId = (key: string) => `00000000${id(key).slice(8)}`
const A = { tenant: id('tenant'), companyA: id('company:A'), siteA1: id('site:A1'), owner: id('actor') }

const PEOPLE = { owner: newId(), buyer: newId(), finance: newId(), manager: newId(), quality: newId() } as const
type Person = keyof typeof PEOPLE
const ROLES: Record<Person, string> = { owner: 'owner', buyer: 'buyer', finance: 'finance', manager: 'production_manager', quality: 'quality_inspector' }

function grantsOf(role: string): Grant[] {
  const template = templateOf(role)!
  return [{ permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties: 'all' }]
}
const SESSIONS: Record<string, SessionContext> = {}

let h: Harness
let app: FastifyInstance
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(sql, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
const run = randomBytes(4).toString('hex')
let keys = 0
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': `w2b307-${run}-${++keys}` } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
/** The person's approvals in Today (the inbox's third source), every row. */
const approvals = async (session: string): Promise<Json[]> => (await ok(session, 'GET', '/home/today?category=APPROVAL&limit=200')).items as Json[]
const rowOf = (items: readonly Json[], kind: string, recordId: string) => items.find((item) => item.kind === kind && item.record.id === recordId)

/** The worker's fan-out over the outbox rows of these types since the mark; the notifications made. */
let mark = new Date(0)
async function fanOutSince(types: readonly string[]): Promise<number> {
  const rows = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = ANY($2) AND "occurredAt" >= $3 ORDER BY "occurredAt", id`, [A.tenant, types, mark])
  let made = 0
  for (const row of rows) {
    const envelope = { eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload }
    made += await fanOut(callerFor(h.database, systemContext(A.tenant, `test-${row.id}`)), envelope)
  }
  mark = new Date()
  return made
}
const noticesOf = async (userId: string, key: string): Promise<Json[]> => admin(`SELECT "messageKey", category, "recordType", "recordId", params FROM "Notification" WHERE "userId" = $1 AND "messageKey" = $2 ORDER BY "createdAt", id`, [userId, key])

let supplierId: string
let itemId: string
let financeRoleId: string
const need = businessDate(new Date(Date.now() + 40 * 86_400_000))

beforeAll(async () => {
  h = await startHarness('approvals_w2b307')
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  const roleIds = new Map((await admin<{ id: string; key: string }>(`SELECT id, key FROM "Role" WHERE "tenantId" = $1`, [A.tenant])).map((row) => [row.key, row.id]))
  financeRoleId = roleIds.get('finance')!
  for (const [person, role] of Object.entries(ROLES) as Array<[Person, string]>) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [PEOPLE[person], A.tenant, `w2b307-${person}-${run}@example.com`, `Made-up ${person}`])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}'::uuid[], now() - interval '30 days')`, [newId(), A.tenant, PEOPLE[person], roleIds.get(role)])
    SESSIONS[person] = { audience: 'office', tenantId: A.tenant, actorId: PEOPLE[person], grants: grantsOf(role) }
  }
  // The seed's Owner: author of SEED-ECO-0001 and proposer of CUT v2.
  SESSIONS.seedOwner = { audience: 'office', tenantId: A.tenant, actorId: A.owner, grants: grantsOf('owner') }
  supplierId = (await one<{ partyId: string }>(`SELECT "partyId" FROM "PurchaseOrder" WHERE "tenantId" = $1 AND number = 'SEED-PO-0001'`, [A.tenant])).partyId
  itemId = (await one<{ itemId: string }>(`SELECT l."itemId" FROM "PurchaseOrderLine" l JOIN "PurchaseOrder" o ON o.id = l."purchaseOrderId" WHERE o."tenantId" = $1 AND o.number = 'SEED-PO-0002'`, [A.tenant])).itemId
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  mark = new Date()
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('the approval engine’s requests in the inbox (B-W2b-282’s gap: no Today or bell row, nobody told)', () => {
  it('a request waits in its approver’s approvals, never in the asker’s; the approver is told, then the asker', async () => {
    const created = (await ok('owner', 'POST', '/approvals/rules', { kind: 'PURCHASE_ORDER', companyId: A.companyA, name: 'Orders over 5,000 (made-up)', condition: { combinator: 'and', rows: [{ field: 'orderValue', operator: 'gt', value: '5000' }] }, approver: { roleId: financeRoleId }, sequence: 5 }, 201)).rule
    await ok('owner', 'PUT', `/approvals/rules/${created.id}`, { version: created.version, active: true })
    const made = (await ok('buyer', 'POST', '/purchasing/orders', { companyId: A.companyA, siteId: A.siteA1, partyId: supplierId }, 201)).order
    const order = (await ok('buyer', 'POST', `/purchasing/orders/${made.id}/lines`, { version: made.version, itemId, quantity: '10', needDate: need, unitPrice: '600' }, 201)).order
    const task = (await ok('buyer', 'POST', '/approvals/requests', { kind: 'PURCHASE_ORDER', recordId: order.id, note: 'Spring leather (made-up).' }, 201)).task

    const finance = rowOf(await approvals('finance'), 'APPROVAL_TASK', task.id)
    expect(finance).toMatchObject({ category: 'APPROVAL', decide: 'REVIEW', state: 'PURCHASE_ORDER', record: { type: 'ApprovalTask', id: task.id }, companyId: A.companyA })
    expect(finance!.words.sentence).toMatchObject({ key: 'APPROVAL_TASK.PENDING', params: { taskKind: ['PURCHASE_ORDER'] } })
    expect(finance!.sentence).toMatch(/^Waiting for your yes \(purchase order\): .+ to .+: 1 line, to be sent\.$/)
    expect(finance!.why).toBe('Its approval rule names you or your role here, and someone else asked for it.')
    // Who asked holds approvals.decide too, and never sees their own request to decide; the Owner is not in the rule's role.
    expect(rowOf(await approvals('buyer'), 'APPROVAL_TASK', task.id)).toBeUndefined()
    expect(rowOf(await approvals('owner'), 'APPROVAL_TASK', task.id)).toBeUndefined()

    expect(await fanOutSince(['approval.requested'])).toBeGreaterThan(0)
    expect(await noticesOf(PEOPLE.finance, 'notifications.approval.taskAsked')).toMatchObject([{ category: 'APPROVAL', recordType: 'ApprovalTask', recordId: task.id, params: { taskId: task.id, kind: 'PURCHASE_ORDER' } }])
    expect(await noticesOf(PEOPLE.buyer, 'notifications.approval.taskAsked')).toEqual([])

    await ok('finance', 'POST', `/approvals/tasks/${task.id}/approve`, { version: task.version, comment: 'Ok (made-up).' })
    expect(rowOf(await approvals('finance'), 'APPROVAL_TASK', task.id)).toBeUndefined()
    expect(await fanOutSince(['approval.decided'])).toBeGreaterThan(0)
    expect(await noticesOf(PEOPLE.buyer, 'notifications.approval.taskDecided')).toMatchObject([{ category: 'APPROVAL', recordType: 'ApprovalTask', recordId: task.id, params: { status: 'APPROVED' } }])
    expect(await noticesOf(PEOPLE.finance, 'notifications.approval.taskDecided')).toEqual([])
    await ok('owner', 'PUT', `/approvals/rules/${created.id}`, { version: created.version + 1, active: false })
  })
})

describe('change orders, SMV changes and inspection plan versions in the inbox (AW2:01–03)', () => {
  it('AW2:01 a submitted change order waits for its named approver — never its author, never an approver who named themselves', async () => {
    const orderId = firstId('changes:order:JKT-02:1')
    await force(`UPDATE "ChangeOrder" SET status = 'SUBMITTED', "submittedAt" = now() WHERE id = $1`, [orderId])
    await force(`UPDATE "ChangeApproval" SET "approverId" = $2, "createdById" = $3 WHERE "changeOrderId" = $1`, [orderId, PEOPLE.manager, A.owner])
    const row = rowOf(await approvals('manager'), 'CHANGE_ORDER', orderId)
    expect(row).toMatchObject({ category: 'APPROVAL', decide: 'OPEN', state: 'SUBMITTED', record: { type: 'ChangeOrder', id: orderId, label: 'SEED-ECO-0001' } })
    expect(row!.sentence).toMatch(/^Change order SEED-ECO-0001 for .+ waits for your approval: More leather for the longer back panel\.$/)
    // The author (the seed's Owner, who may approve change orders) never; another approver of change orders not asked, neither.
    expect(rowOf(await approvals('seedOwner'), 'CHANGE_ORDER', orderId)).toBeUndefined()
    expect(rowOf(await approvals('quality'), 'CHANGE_ORDER', orderId)).toBeUndefined()
    // B-W2b-F24: an approver who named themselves is refused by the module, so it is not theirs here either.
    await force(`UPDATE "ChangeApproval" SET "createdById" = $2 WHERE "changeOrderId" = $1`, [orderId, PEOPLE.manager])
    expect(rowOf(await approvals('manager'), 'CHANGE_ORDER', orderId)).toBeUndefined()
    await force(`UPDATE "ChangeApproval" SET "createdById" = $2 WHERE "changeOrderId" = $1`, [orderId, A.owner])
    // A request it carries raised by the approver: OWN_REQUEST, not theirs.
    await force(`UPDATE "ChangeRequest" SET "createdById" = $2 WHERE "changeOrderId" = $1`, [orderId, PEOPLE.manager])
    expect(rowOf(await approvals('manager'), 'CHANGE_ORDER', orderId)).toBeUndefined()
    await force(`UPDATE "ChangeRequest" SET "createdById" = $2 WHERE "changeOrderId" = $1`, [orderId, A.owner])
    expect(rowOf(await approvals('manager'), 'CHANGE_ORDER', orderId)).toBeDefined()
  })

  it('AW2:02 a waiting SMV change is in the inbox of whoever approves SMV changes — not its proposer — and its approvers are told', async () => {
    const cut = await one<{ id: string; operationId: string; proposedById: string }>(`SELECT id, "operationId", "proposedById" FROM "OperationTimeVersion" WHERE id = $1`, [firstId('instructions:smv:CUT:2')])
    expect(cut.proposedById).toBe(A.owner)
    expect(rowOf(await approvals('manager'), 'SMV_CHANGE', cut.id)).toMatchObject({ category: 'APPROVAL', decide: 'OPEN', state: 'PROPOSED', record: { type: 'OperationTimeVersion', id: cut.id } })
    expect(rowOf(await approvals('owner'), 'SMV_CHANGE', cut.id)).toBeDefined()
    expect(rowOf(await approvals('seedOwner'), 'SMV_CHANGE', cut.id)).toBeUndefined()
    // A buyer does not approve SMV changes.
    expect(rowOf(await approvals('buyer'), 'SMV_CHANGE', cut.id)).toBeUndefined()

    // The manager proposes on an operation with nothing waiting: its approvers are told, never the proposer.
    const free = await one<{ id: string }>(`SELECT o.id FROM "Operation" o WHERE o."tenantId" = $1 AND o.status = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM "OperationTimeVersion" v WHERE v."operationId" = o.id AND v.status = 'PROPOSED') ORDER BY o.code, o.id LIMIT 1`, [A.tenant])
    const proposed = await ok('manager', 'POST', `/product/operations/${free.id}/minutes/proposals`, { basicMinutes: '3.5', personalPct: '5', fatiguePct: '4', delayPct: '2', source: 'ESTIMATE', effectiveFrom: need, reason: 'New presser foot (made-up).' }, 201)
    expect(rowOf(await approvals('manager'), 'SMV_CHANGE', proposed.versionId)).toBeUndefined()
    expect(rowOf(await approvals('owner'), 'SMV_CHANGE', proposed.versionId)).toBeDefined()
    expect(await fanOutSince(['smv_version.changed'])).toBeGreaterThan(0)
    expect(await noticesOf(PEOPLE.owner, 'notifications.approval.smvAsked')).toMatchObject([{ category: 'APPROVAL', recordType: 'Operation', recordId: free.id, params: { versionId: proposed.versionId } }])
    expect(await noticesOf(PEOPLE.manager, 'notifications.approval.smvAsked')).toEqual([])
    expect(await noticesOf(PEOPLE.buyer, 'notifications.approval.smvAsked')).toEqual([])
  })

  it('AW2:03 a submitted inspection plan version reaches the people who approve plans — never its author', async () => {
    const made = await ok('owner', 'POST', '/quality/plans', { companyId: A.companyA, code: `W2B307-${run}`.toUpperCase().slice(0, 20), stage: 'CUTTING', name: 'Cutting (made-up)', startFrom: { kind: 'STARTER', code: 'CUT-PANELS' } }, 201)
    const { version } = await ok('owner', 'GET', `/quality/plans/${made.plan.id}/versions/${made.current.id}`)
    expect(rowOf(await approvals('quality'), 'PLAN_VERSION', made.plan.id)).toBeUndefined()
    await ok('owner', 'POST', `/quality/plans/${made.plan.id}/versions/${made.current.id}/submit`, { version: version.version, note: 'Ready (made-up).' })
    const row = rowOf(await approvals('quality'), 'PLAN_VERSION', made.plan.id)
    expect(row).toMatchObject({ category: 'APPROVAL', decide: 'OPEN', state: 'SUBMITTED', record: { type: 'InspectionPlan', id: made.plan.id } })
    expect(row!.sentence).toMatch(/version 1 waits for your approval\.$/)
    expect(rowOf(await approvals('owner'), 'PLAN_VERSION', made.plan.id)).toBeUndefined()
  })
})
