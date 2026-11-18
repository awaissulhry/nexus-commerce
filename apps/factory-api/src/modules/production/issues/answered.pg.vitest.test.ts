import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Actor, Permission } from '@nexus/factory-domain/core/permissions'
import { EVENT_CATALOGUE } from '@nexus/factory-domain/events/catalogue'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { liveMessageFor, liveViewFor } from '@nexus/factory-domain/events/live'
import { PARTNER_LIVE_EVENTS, partnerLiveViewFor } from '@nexus/factory-domain/portal/notifications/live'
import { answeredAtOf, answersBrandIssue, ISSUE_DUE_TIME, ISSUE_WORDS, issueAfterTask, issueTaskWords, officeIssueNote } from '@nexus/factory-domain/production-brand/issues'
import { DESCRIPTION_MAX, TITLE_MAX } from '@nexus/factory-domain/tasks/rules'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor, command, type CommandCaller, type CommandTx } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { systemContext } from '../../../platform/outbox/system'
import { ensureThread, writeMessage } from '../../../platform/threads/threads'
import { readProblems } from '../brand-portal/access'
import { findMarkers, markersOf, productionTwoBrands, supervisorPeople, supervisorPeopleIds, twoBrandIds, twoBrandSessions, type ProductionTwoBrands } from '../testing/two-brands'
import { issueAnswered, issueAnsweredHandler, ISSUE_ANSWERED_EVENTS, ISSUE_ANSWERED_HANDLER } from './answered'
import { issueDueOn, issueEscalationTaskId } from './raise'

/**
 * B-PR-43b — needs an answer (production plan §1 "'Needs an answer' makes it a task; no answer in 1 working day → the backup",
 * §3 "Issues"; lead pick L24; review fixes R-42, R-43, R-44, R-48, R-54; the Owner's point N4: "mention him to address a specific
 * issue … for that order or multiple orders at once"), and its wall tests PW-17 (office part: an office-raised issue never reaches
 * the brand; its task goes only to a person who reads the record) and PW-15 (production_issue.* has no partner live entry; a
 * party-limited office viewer gets it only for its own party). The Owner rule 2026-11-16: "One brand must not be able to see
 * anything related to any other brand. But we, as the production unit, should be able to see it all. And manage it all as well."
 *
 * On a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and the ProductionIssue and
 * Task guards are real), the core, files, production and numbering seeds, the production two-brand harness (brand A = the seeds'
 * P1 with its new order, SEED-SO-0002 and its work order; brand B = the threads' second brand with SEED-SO-B001, its work order
 * and its open BRAND issue; a work order of no customer) and its supervisor people (REAL users: supervisorA limited to A,
 * backupA over every customer, officeB limited to B), each given a made-up "tasks" role (home.view, tasks.manage) over the
 * customers they read, so platform/tasks' assignee rule lets them hold a task. A's default supervisor is supervisorA (backup
 * backupA), B's officeB (B-PR-42a's route). The worker's handler runs in-process on the events the routes wrote (the outbox).
 *
 *   - "Needs an answer" on [A's order, A's work order, B's order, the mixed work order]: an OFFICE issue on each record of one
 *     customer (the mixed one named, with why), one batch per customer, ONE task per batch and supervisor on the SALES ORDER (the
 *     customer's wall), assigned to its supervisor, due at raise + 1 working day 08:00; one event per issue, one audit row per
 *     batch, each naming only its own customer;
 *   - PW-17: no portal read reaches an office-raised issue, its task or its events; a supervisor whose read of the customer was
 *     taken away is given no task (the issue is still raised, the task waits for nobody);
 *   - PW-15: every production_issue.* reaches office.p1 only for A, office.p2 only for B, the production unit for both, no partner;
 *   - answered (OFFICE): the task done answers its issues and closes every other task of them (an escalation task too); reopened
 *     → OPEN again; a late event never undoes a later move; cancelled → CANCELLED, final; a repeat changes nothing;
 *   - answered (BRAND): a ticked task alone keeps "Waiting on us" and shows the office "No reply sent yet"; an office note
 *     answers nothing; a shared office message before the raise answers nothing; one after it answers the issue; one shared
 *     message in one order's thread answers every issue of the batch (the others: "Answered in"), closing their tasks; another
 *     customer's issues are never touched.
 *
 * The tests run in order on one database. Every name is made up. Run with
 * `env -u FACTORY_REDIS_URL node scripts/factory/run-pg-tests.mjs modules/production/issues/answered`.
 */

const ns = 'pr2l-issues'
const ids = twoBrandIds(ns)
const people = supervisorPeopleIds(ns)
const actorId = seedUuid(ns, 'actor')
const PERMISSIONS: Permission[] = ['workorders.view', 'production.brand.manage', 'threads.read', 'threads.post', 'threads.manage', 'home.view', 'tasks.manage', 'workorders.manage' /* fix-pr-3: the harness makes its work orders as office.all */]
const grant = (permissions: Permission[], parties: 'all' | string[]) => ({ permissions, companies: 'all' as const, sites: 'all' as const, parties })
const SESSIONS: Record<string, SessionContext> = twoBrandSessions(ids.tenantId, ids.a, ids.b, PERMISSIONS)

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let w: ProductionTwoBrands
let system: CommandCaller
let nameA = ''

type Json = Record<string, any>
async function call(session: string, url: string, payload: unknown, method: 'POST' | 'GET' | 'PUT' = 'POST'): Promise<{ status: number; body: Json; raw: string }> {
  const headers: Record<string, string> = method === 'GET' ? { 'x-test-session': session } : { 'x-test-session': session, 'idempotency-key': newId() }
  const response = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) })
  const body = response.headers['content-type']?.toString().startsWith('application/json') ? (response.json() as Json) : {}
  return { status: response.statusCode, body, raw: response.body }
}
async function ok(session: string, url: string, payload?: unknown, method: 'POST' | 'GET' | 'PUT' = 'POST'): Promise<Json> {
  const answer = await call(session, url, payload, method)
  expect(answer.status, `${method} ${url}: ${answer.raw.slice(0, 600)}`).toBe(200)
  return answer.body
}
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T | undefined> => (await admin<T>(sql, values))[0]
const officeScope = () => ({ audience: 'office' as const, tenantId: ids.tenantId, actorId })

const SO = (id: string) => ({ type: 'SalesOrder', id })
const WO = (id: string) => ({ type: 'WorkOrder', id })
const settingsVersion = async (partyId: string) => (await one<{ version: number }>(`SELECT version FROM "PortalSettings" WHERE "partyId" = $1`, [partyId]))?.version ?? 0
const issueOf = (id: string) =>
  one<Json>(
    `SELECT id, "companyId", "siteId", "partyId", "recordType", "recordId", "salesOrderId", "taskId", "messageId", source::text AS source, "batchId", status::text AS status, "raisedAt", "dueDate"::text AS "dueDate", "answeredAt" FROM "ProductionIssue" WHERE id = $1`,
    [id],
  )
const taskOf = (id: string) =>
  one<Json>(`SELECT id, "companyId", "partyId", "recordType", "recordId", "recordLabel", "assigneeId", "dueDate"::text AS "dueDate", "dueTime", status::text AS status, title, description, "messageId", version FROM "Task" WHERE id = $1`, [id])
const setTask = async (taskId: string, status: 'DONE' | 'OPEN' | 'CANCELLED') => ok('office.all', `/tasks/${taskId}/status`, { status, version: (await taskOf(taskId))!.version })

// ---- the outbox, as the relay hands it to the worker ------------------------------------------------------------------------
const handled = new Set<string>()
async function outbox(type: string): Promise<EventEnvelope[]> {
  const rows = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [ids.tenantId, type])
  return rows.map((row) => ({ eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload }))
}
/** The events of these types not handled yet, marked handled. */
async function fresh(...types: string[]): Promise<EventEnvelope[]> {
  const out: EventEnvelope[] = []
  for (const type of types) for (const event of await outbox(type)) if (!handled.has(event.eventId)) out.push(event)
  for (const event of out) handled.add(event.eventId)
  return out.sort((x, y) => x.occurredAt.localeCompare(y.occurredAt))
}
/** The worker's handler on each event, in order (as the relay would); the sums of what it did. */
async function work(events: readonly EventEnvelope[]) {
  const sum = { answered: 0, reopened: 0, cancelled: 0, tasksClosed: 0 }
  for (const event of events) {
    const done = await issueAnswered(system, event)
    sum.answered += done.answered
    sum.reopened += done.reopened
    sum.cancelled += done.cancelled
    sum.tasksClosed += done.tasksClosed
  }
  return sum
}
/** The answering events since the last call (task moves, messages, mails). */
const answering = () => fresh(...ISSUE_ANSWERED_EVENTS)

// ---- people, messages and tasks ---------------------------------------------------------------------------------------------
const officeActor = (session: string): Actor => ({ audience: 'office', tenantId: ids.tenantId, grants: SESSIONS[session]!.grants })
const partnerOf = (partyId: string): Actor => ({ audience: 'partner', tenantId: ids.tenantId, partyId, grants: [{ permissions: ['portal.production.view'], companies: 'all', sites: 'all', parties: [partyId] }] })

/** The made-up "tasks" role (home.view, tasks.manage): supervisorA over A, officeB over B, backupA over every customer. */
async function tasksRole(): Promise<void> {
  const fixed = (key: string) => `ffffffff${seedUuid(ns, `pr43b:${key}`).slice(8)}`
  const at = new Date('2026-11-10T08:00:00.000Z')
  const roleId = fixed('role:tasks')
  await database.withScope(officeScope(), (client) =>
    client.$transaction(async (tx) => {
      const data = { key: 't-pr43b-tasks', name: 'T tasks (made up)', audience: 'OFFICE' as const, permissions: ['home.view', 'tasks.manage'], grains: [] }
      await tx.role.upsert({ where: { id: roleId }, create: { id: roleId, ...data, createdAt: at }, update: data, select: { id: true } })
      for (const [key, parties] of [['supervisorA', [ids.a]], ['officeB', [ids.b]], ['backupA', []]] as const) {
        const assignmentId = fixed(`assignment:${key}`)
        const assignment = { userId: people[key], roleId, allCompanies: true, companyIds: [], siteIds: [], partyIds: [...parties], validFrom: at, grantedById: actorId }
        await tx.roleAssignment.upsert({ where: { id: assignmentId }, create: { id: assignmentId, ...assignment, createdAt: at }, update: assignment, select: { id: true } })
      }
    }),
  )
}

/** A shared message to the customer in an order's thread, written by a person of the office through threads' own seam. */
async function shareOn(orderId: string, at?: Date): Promise<string> {
  const caller = callerFor(database, { audience: 'office', tenantId: ids.tenantId, actorId: people.backupA, grants: [grant(PERMISSIONS, 'all')], requestId: newId() })
  const { result } = await command(caller, { name: 'test.shareOnOrder', input: { orderId } }, async (tools) => {
    const { thread } = await ensureThread(tools, { type: 'SalesOrder', id: orderId }, people.backupA)
    const message = await writeMessage(tools, thread, { direction: 'OUTBOUND', channel: 'PORTAL', author: { kind: 'USER', id: people.backupA, name: 'T Backup Alpha' }, bodyText: 'Made-up answer: the lining arrives on Monday.', ...(at ? { at } : {}) })
    return message.id
  })
  return result
}

/** An open task of an issue's step as B-PR-45 writes one (made by the system, on the batch task's record, for one person). */
async function escalationTask(batchTask: Json, step: 1 | 2, userId: string): Promise<string> {
  const id = issueEscalationTaskId(batchTask.id, step, userId)
  await admin(
    `INSERT INTO "Task" (id, "tenantId", "companyId", "partyId", title, "recordType", "recordId", "recordLabel", "assigneeId", "assignedById", "assignedAt", "dueDate", checklist, status, "createdAt", "updatedAt", "createdById")
     VALUES ($1, $2, $3, $4, 'Made-up: the note still waits for an answer', $5, $6, $7, $8, $8, now(), current_date + 1, '[]'::jsonb, 'OPEN', now(), now(), NULL)`,
    [id, ids.tenantId, batchTask.companyId ?? w.companyId, batchTask.partyId, batchTask.recordType, batchTask.recordId, batchTask.recordLabel, userId],
  )
  return id
}

/** What a portal session of a customer reads of these rows: nothing (no grant: refused) — never a row. */
async function partnerReads(partyId: string, issueIds: readonly string[]): Promise<number> {
  try {
    const rows = await database.withScope({ audience: 'partner', tenantId: ids.tenantId, actorId: newId(), partyId }, (client) => client.productionIssue.findMany({ where: { id: { in: [...issueIds] } }, select: { id: true } }))
    return rows.length
  } catch {
    return 0
  }
}

beforeAll(async () => {
  db = await migratedDatabase('pr2l_issues')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: ns })
  await seedFiles({ db: database, namespace: ns })
  await seedProduction({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  w = await productionTwoBrands({ db, database, app, namespace: ns })
  expect(await supervisorPeople({ database, namespace: ns }, w)).toEqual(people)
  await tasksRole()
  await ok('office.all', `/production/brands/${ids.a}/supervisor`, { supervisorId: people.supervisorA, backupId: people.backupA, version: await settingsVersion(ids.a) }, 'PUT')
  await ok('office.all', `/production/brands/${ids.b}/supervisor`, { supervisorId: people.officeB, backupId: null, version: await settingsVersion(ids.b) }, 'PUT')
  nameA = (await one<{ name: string }>(`SELECT coalesce("tradeName", "legalName") AS name FROM "Party" WHERE id = $1`, [ids.a]))!.name
  system = callerFor(database, systemContext(ids.tenantId, newId()))
  // Whatever the harness wrote before is not this suite's to answer.
  await answering()
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('B-PR-43b the rules', () => {
  it('an OFFICE issue follows its task (done, reopened, cancelled — final); a BRAND issue never does; the office reads "No reply sent yet" beside a ticked task', () => {
    expect(issueAfterTask({ source: 'OFFICE', status: 'OPEN' }, 'DONE')).toBe('ANSWERED')
    expect(issueAfterTask({ source: 'OFFICE', status: 'ANSWERED' }, 'OPEN')).toBe('OPEN')
    expect(issueAfterTask({ source: 'OFFICE', status: 'OPEN' }, 'CANCELLED')).toBe('CANCELLED')
    expect(issueAfterTask({ source: 'OFFICE', status: 'OPEN' }, 'OPEN')).toBeNull()
    expect(issueAfterTask({ source: 'OFFICE', status: 'ANSWERED' }, 'DONE')).toBeNull()
    expect(issueAfterTask({ source: 'OFFICE', status: 'CANCELLED' }, 'OPEN')).toBeNull()
    for (const move of ['DONE', 'OPEN', 'CANCELLED'] as const) expect(issueAfterTask({ source: 'BRAND', status: 'OPEN' }, move)).toBeNull()
    expect(officeIssueNote({ source: 'BRAND', status: 'OPEN' }, 'DONE')).toBe('NO_REPLY_YET')
    expect(officeIssueNote({ source: 'BRAND', status: 'OPEN' }, 'OPEN')).toBeNull()
    expect(officeIssueNote({ source: 'BRAND', status: 'ANSWERED' }, 'DONE')).toBeNull()
    expect(officeIssueNote({ source: 'OFFICE', status: 'OPEN' }, 'DONE')).toBeNull()
  })

  it('a BRAND issue is answered only by a shared message a person of the office wrote, that the customer reads, at or after the raise', () => {
    const raisedAt = new Date('2026-11-16T09:00:00.000Z')
    const issue = { source: 'BRAND' as const, status: 'OPEN' as const, raisedAt }
    const message = { direction: 'OUTBOUND', audience: 'PARTNER', authorKind: 'USER', held: false, at: new Date('2026-11-16T10:00:00.000Z') }
    expect(answersBrandIssue(issue, message)).toBe(true)
    expect(answersBrandIssue(issue, { ...message, at: raisedAt })).toBe(true)
    expect(answersBrandIssue(issue, { ...message, at: new Date('2026-11-16T08:59:59.000Z') })).toBe(false)
    expect(answersBrandIssue(issue, { ...message, direction: 'INTERNAL_NOTE', audience: 'OFFICE' })).toBe(false)
    expect(answersBrandIssue(issue, { ...message, direction: 'INBOUND' })).toBe(false)
    expect(answersBrandIssue(issue, { ...message, authorKind: 'SYSTEM' })).toBe(false)
    expect(answersBrandIssue(issue, { ...message, held: true })).toBe(false)
    expect(answersBrandIssue({ ...issue, status: 'ANSWERED' }, message)).toBe(false)
    expect(answersBrandIssue({ ...issue, source: 'OFFICE' }, message)).toBe(false)
    expect(answeredAtOf({ raisedAt }, new Date('2026-11-16T08:00:00.000Z'))).toEqual(raisedAt)
  })

  it('the task’s words in its assignee’s language, within the task’s limits; every word in both languages; the escalation task ids are stable', () => {
    expect(issueTaskWords({ locale: 'en', labels: ['SO-1'], customer: 'Brand Alpha', excerpt: 'Made-up.' })).toEqual({ title: 'Answer the note on SO-1', description: 'Made-up.\n\nRecords: SO-1' })
    expect(issueTaskWords({ locale: null, labels: ['SO-1', 'WO-2'], customer: 'Brand Alpha', excerpt: 'Made-up.' }).title).toBe('Rispondi alla nota su 2 record di Brand Alpha')
    const long = issueTaskWords({ locale: 'en', labels: Array.from({ length: 100 }, (_, index) => `SO-${String(index).padStart(60, '0')}`), customer: 'x'.repeat(300), excerpt: 'y'.repeat(5000) })
    expect(long.title.length).toBeLessThanOrEqual(TITLE_MAX)
    expect(long.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX)
    for (const words of Object.values(ISSUE_WORDS)) {
      expect(words.en).toBeTruthy()
      expect(words.it).toBeTruthy()
    }
    expect(ISSUE_DUE_TIME).toBe('08:00')
    const task = newId()
    const person = newId()
    expect(issueEscalationTaskId(task, 1, person)).toBe(issueEscalationTaskId(task, 1, person))
    expect(issueEscalationTaskId(task, 1, person)).not.toBe(issueEscalationTaskId(task, 2, person))
    expect(issueAnsweredHandler().name).toBe(ISSUE_ANSWERED_HANDLER)
    expect([...issueAnsweredHandler().events].sort()).toEqual([...ISSUE_ANSWERED_EVENTS].sort())
  })
})

describe('B-PR-43b needs an answer', { timeout: 120_000 }, () => {
  let batch: Json
  let taskA: Json
  let taskB: Json
  const issueIds: Record<string, string> = {}
  const body = 'Made-up: is the lining for this order cut yet? Please answer by tomorrow.'

  it('the check names the records that raise no issue (a work order of no customer); nothing is written', async () => {
    const before = await one<{ n: number }>(`SELECT count(*)::int AS n FROM "ProductionIssue" WHERE "tenantId" = $1`, [ids.tenantId])
    const check = await ok('office.all', '/production/notes/check', { records: [SO(w.a.salesOrderId), WO(w.a.workOrderId), SO(w.b.salesOrderId), WO(w.mixed.workOrderId)], body, needsAnswer: true })
    expect(check.noIssue).toEqual([{ type: 'WorkOrder', id: w.mixed.workOrderId, label: w.mixed.number, why: ISSUE_WORDS.NO_CUSTOMER.en }])
    expect(check.held).toBe(false)
    // Without "Needs an answer" nothing is said about issues.
    expect((await ok('office.all', '/production/notes/check', { records: [SO(w.a.salesOrderId), WO(w.mixed.workOrderId)], body })).noIssue).toEqual([])
    expect(await one(`SELECT count(*)::int AS n FROM "ProductionIssue" WHERE "tenantId" = $1`, [ids.tenantId])).toEqual(before)
  })

  it('the write: an OFFICE issue per record of one customer, one batch per customer, ONE task per batch on the SALES ORDER for its supervisor, due raise + 1 working day 08:00; one event per issue, one audit row per batch', async () => {
    batch = await ok('office.all', '/production/notes', { records: [SO(w.a.salesOrderId), WO(w.a.workOrderId), SO(w.b.salesOrderId), WO(w.mixed.workOrderId)], body, needsAnswer: true })
    expect(batch.written).toHaveLength(4)
    const of = (id: string) => batch.written.find((entry: Json) => entry.id === id)
    for (const id of [w.a.salesOrderId, w.a.workOrderId, w.b.salesOrderId]) {
      expect(of(id).issueId, id).toBeTruthy()
      issueIds[id] = of(id).issueId
    }
    expect(of(w.mixed.workOrderId).issueId).toBeNull()
    expect(batch.issues.notRaised).toEqual([{ type: 'WorkOrder', id: w.mixed.workOrderId, label: w.mixed.number, why: ISSUE_WORDS.NO_CUSTOMER.en }])
    expect(batch.issues.tasks.map((task: Json) => [task.type, task.id, task.assigned, task.records]).sort()).toEqual(
      [
        ['SalesOrder', w.a.salesOrderId, true, 2],
        ['SalesOrder', w.b.salesOrderId, true, 1],
      ].sort(),
    )

    // The issues: of the record's own company, site and customer, its order, the note it was raised with, one batch per customer.
    const aOrder = (await issueOf(issueIds[w.a.salesOrderId]!))!
    const aWork = (await issueOf(issueIds[w.a.workOrderId]!))!
    const bOrder = (await issueOf(issueIds[w.b.salesOrderId]!))!
    expect(aOrder).toMatchObject({ partyId: ids.a, recordType: 'SalesOrder', recordId: w.a.salesOrderId, salesOrderId: w.a.salesOrderId, siteId: null, source: 'OFFICE', status: 'OPEN', answeredAt: null, messageId: of(w.a.salesOrderId).messageId })
    expect(aWork).toMatchObject({ partyId: ids.a, recordType: 'WorkOrder', recordId: w.a.workOrderId, salesOrderId: w.a.salesOrderId, siteId: w.siteId, source: 'OFFICE', status: 'OPEN', messageId: of(w.a.workOrderId).messageId })
    expect(bOrder).toMatchObject({ partyId: ids.b, recordType: 'SalesOrder', recordId: w.b.salesOrderId, salesOrderId: w.b.salesOrderId, source: 'OFFICE', status: 'OPEN' })
    expect(aWork.batchId).toBe(aOrder.batchId)
    expect(aWork.taskId).toBe(aOrder.taskId)
    expect(bOrder.batchId).not.toBe(aOrder.batchId)
    expect(bOrder.taskId).not.toBe(aOrder.taskId)

    // The due day: raise + 1 working day on the company's calendar (the escalation clock), at 08:00.
    const dueOn = await database.withScope(officeScope(), (client) => issueDueOn({ tx: client as unknown as CommandTx, now: new Date(aOrder.raisedAt) }, aOrder.companyId))
    expect(aOrder.dueDate).toBe(dueOn)
    expect(dueOn > new Date(aOrder.raisedAt).toISOString().slice(0, 10)).toBe(true)

    // ONE task per batch and supervisor, on the SALES ORDER (it carries the customer: the wall), for the record's supervisor.
    taskA = (await taskOf(aOrder.taskId))!
    taskB = (await taskOf(bOrder.taskId))!
    const labelOfWork = (await one<{ number: string }>(`SELECT number FROM "WorkOrder" WHERE id = $1`, [w.a.workOrderId]))!.number
    const labelOfOrder = (await one<{ number: string }>(`SELECT number FROM "SalesOrder" WHERE id = $1`, [w.a.salesOrderId]))!.number
    expect(taskA).toMatchObject({ partyId: ids.a, recordType: 'SalesOrder', recordId: w.a.salesOrderId, recordLabel: labelOfOrder, assigneeId: people.supervisorA, dueDate: dueOn, dueTime: '08:00', status: 'OPEN', messageId: of(w.a.salesOrderId).messageId })
    expect(taskA.title).toBe(`Rispondi alla nota su 2 record di ${nameA}`)
    expect(taskA.description).toContain(labelOfOrder)
    expect(taskA.description).toContain(labelOfWork)
    expect(taskB).toMatchObject({ partyId: ids.b, recordType: 'SalesOrder', recordId: w.b.salesOrderId, recordLabel: 'SEED-SO-B001', assigneeId: people.officeB, dueDate: dueOn, dueTime: '08:00', status: 'OPEN', title: 'Rispondi alla nota su SEED-SO-B001' })
    // Nothing of B in A's task, nothing of A in B's.
    expect(JSON.stringify(taskA)).not.toContain('SEED-SO-B001')
    expect(findMarkers(JSON.stringify(taskB), await markersOf(db, ids.a))).toEqual([])

    // The events: one production_issue.raised per issue (its own customer), the tasks made and given (the assignee's bell).
    const raised = (await outbox('production_issue.raised')).filter((event) => Object.values(issueIds).includes((event.payload as Json).issueId))
    expect(raised.map((event) => [(event.payload as Json).issueId, (event.payload as Json).partyId, (event.payload as Json).source]).sort()).toEqual(
      [
        [issueIds[w.a.salesOrderId], ids.a, 'OFFICE'],
        [issueIds[w.a.workOrderId], ids.a, 'OFFICE'],
        [issueIds[w.b.salesOrderId], ids.b, 'OFFICE'],
      ].sort(),
    )
    const assigned = (await outbox('task.assigned')).filter((event) => [taskA.id, taskB.id].includes((event.payload as Json).taskId))
    expect(assigned.map((event) => [(event.payload as Json).taskId, (event.payload as Json).assigneeId]).sort()).toEqual([[taskA.id, people.supervisorA], [taskB.id, people.officeB]].sort())
    // R-48: one production.issuesRaised row per batch, each naming only its own customer's records.
    const rows = await admin<{ recordId: string; after: Json }>(`SELECT "recordId", after FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'production.issuesRaised' AND after->>'batchId' = ANY($2::text[])`, [ids.tenantId, [aOrder.batchId, bOrder.batchId]])
    expect(rows.map((row) => row.recordId).sort()).toEqual([ids.a, ids.b].sort())
    expect(JSON.stringify(rows.find((row) => row.recordId === ids.a))).not.toContain(w.b.salesOrderId)
    expect(JSON.stringify(rows.find((row) => row.recordId === ids.b))).not.toContain(w.a.salesOrderId)
    // The assignee follows the task's record (ASSIGNEE, or the follow he had).
    expect(await one(`SELECT 1 AS n FROM "RecordFollower" WHERE "recordType" = 'SalesOrder' AND "recordId" = $1 AND "userId" = $2`, [w.a.salesOrderId, people.supervisorA])).toEqual({ n: 1 })
    await answering()
  })

  it('PW-17 (office part): an office-raised issue never reaches the brand — no portal read of it, of its task or of its events; the customer’s own "problems" read none', async () => {
    for (const partyId of [ids.a, ids.b]) expect(await partnerReads(partyId, Object.values(issueIds))).toBe(0)
    // The customer's production page reads only its own BRAND issues (B-PR-18): none of these.
    const problems = await database.withScope(officeScope(), (client) => readProblems(client as never, ids.a, [w.a.salesOrderId]))
    expect(problems).toEqual([])
    const events = [...(await outbox('production_issue.raised')), ...(await outbox('task.created')), ...(await outbox('task.assigned'))]
    for (const event of events) {
      const message = liveMessageFor(event, EVENT_CATALOGUE.get(event.type, event.version))
      if (!message) continue
      for (const partyId of [ids.a, ids.b]) expect(partnerLiveViewFor(message, partnerOf(partyId), EVENT_CATALOGUE), `${event.type} → partner`).toBeNull()
    }
    expect(Object.keys(PARTNER_LIVE_EVENTS).filter((type) => type.startsWith('production_issue.') || type.startsWith('task.'))).toEqual([])
  })

  it('PW-17: a supervisor whose read of the customer was taken away is given no task — the issue is raised, its task waits for nobody', async () => {
    const assignment = `ffffffff${seedUuid(ns, 'two-brands:supervisor-people:assignment:backupA').slice(8)}`
    await ok('office.all', '/production/orders/supervisor', { orderIds: [w.a.salesOrderId], supervisorId: people.backupA })
    await admin(`UPDATE "RoleAssignment" SET "partyIds" = $2::uuid[] WHERE id = $1`, [assignment, [ids.b]])
    try {
      const answer = await ok('office.all', '/production/notes', { records: [SO(w.a.salesOrderId)], body: 'Made-up: the trims, please.', needsAnswer: true })
      expect(answer.issues.tasks).toEqual([{ taskId: expect.any(String), type: 'SalesOrder', id: w.a.salesOrderId, label: expect.any(String), assigned: false, records: 1 }])
      const task = (await taskOf(answer.issues.tasks[0].taskId))!
      expect(task.assigneeId).toBeNull()
      expect((await outbox('task.assigned')).filter((event) => (event.payload as Json).taskId === task.id)).toEqual([])
      expect(await issueOf(answer.written[0].issueId)).toMatchObject({ source: 'OFFICE', status: 'OPEN', taskId: task.id })
    } finally {
      await admin(`UPDATE "RoleAssignment" SET "partyIds" = '{}'::uuid[] WHERE id = $1`, [assignment])
      await ok('office.all', '/production/orders/supervisor', { orderIds: [w.a.salesOrderId], supervisorId: null })
    }
    await answering()
  })

  it('PW-15: every production_issue.* reaches office.p1 only for A, office.p2 only for B, the production unit for both — never a partner', async () => {
    const events = (await outbox('production_issue.raised')).filter((event) => Object.values(issueIds).includes((event.payload as Json).issueId))
    expect(events).toHaveLength(3)
    for (const event of events) {
      const party = (event.payload as Json).partyId
      const message = liveMessageFor(event, EVENT_CATALOGUE.get(event.type, event.version))!
      expect(message, 'production_issue.raised shows on an office live screen').not.toBeNull()
      expect(liveViewFor(message, officeActor('office.all'), EVENT_CATALOGUE)).not.toBeNull()
      expect(liveViewFor(message, officeActor('office.p1'), EVENT_CATALOGUE) !== null).toBe(party === ids.a)
      expect(liveViewFor(message, officeActor('office.p2'), EVENT_CATALOGUE) !== null).toBe(party === ids.b)
      for (const partyId of [ids.a, ids.b]) expect(partnerLiveViewFor(message, partnerOf(partyId), EVENT_CATALOGUE)).toBeNull()
      // Ids and states only: no name, no text.
      expect(JSON.stringify(event.payload)).not.toContain(nameA)
      expect(JSON.stringify(event.payload)).not.toContain('lining')
    }
  })

  it('answered (OFFICE): the task done answers its issues and closes every other task of them; reopened → OPEN again; a late event never undoes it; a repeat changes nothing', async () => {
    const escalation = await escalationTask(taskA, 1, people.backupA)
    await setTask(taskA.id, 'DONE')
    const done = await answering()
    expect(await work(done)).toEqual({ answered: 2, reopened: 0, cancelled: 0, tasksClosed: 1 })
    for (const id of [w.a.salesOrderId, w.a.workOrderId]) {
      const issue = (await issueOf(issueIds[id]!))!
      expect(issue.status, id).toBe('ANSWERED')
      expect(issue.answeredAt, id).not.toBeNull()
    }
    expect((await taskOf(escalation))!.status).toBe('DONE')
    // B's issue is another task's: untouched.
    expect((await issueOf(issueIds[w.b.salesOrderId]!))!.status).toBe('OPEN')
    // One production_issue.answered per issue, of A only; one audit row of A.
    const answered = (await outbox('production_issue.answered')).filter((event) => [issueIds[w.a.salesOrderId], issueIds[w.a.workOrderId]].includes((event.payload as Json).issueId))
    expect(answered.map((event) => event.payload as Json).map((payload) => [payload.partyId, payload.source, payload.answeredInOrderId])).toEqual([
      [ids.a, 'OFFICE', null],
      [ids.a, 'OFFICE', null],
    ])
    for (const event of answered) {
      const message = liveMessageFor(event, EVENT_CATALOGUE.get(event.type, event.version))!
      expect(liveViewFor(message, officeActor('office.p2'), EVENT_CATALOGUE)).toBeNull()
      expect(liveViewFor(message, officeActor('office.p1'), EVENT_CATALOGUE)).not.toBeNull()
      for (const partyId of [ids.a, ids.b]) expect(partnerLiveViewFor(message, partnerOf(partyId), EVENT_CATALOGUE)).toBeNull()
    }
    const audit = await admin<{ recordId: string }>(`SELECT "recordId" FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'production.issuesAnswered' AND after->>'taskId' = $2`, [ids.tenantId, taskA.id])
    expect(audit.map((row) => row.recordId)).toEqual([ids.a])
    // The same job again (or the escalation task's own task.completed): nothing left to change.
    expect(await work(done)).toEqual({ answered: 0, reopened: 0, cancelled: 0, tasksClosed: 0 })
    expect(await work(await answering())).toEqual({ answered: 0, reopened: 0, cancelled: 0, tasksClosed: 0 })

    // Reopened: OPEN again, unanswered.
    await setTask(taskA.id, 'OPEN')
    expect(await work(await answering())).toEqual({ answered: 0, reopened: 2, cancelled: 0, tasksClosed: 0 })
    expect(await issueOf(issueIds[w.a.salesOrderId]!)).toMatchObject({ status: 'OPEN', answeredAt: null })
    // The old "done" arriving late reads the task as it is now (open): nothing moves.
    expect(await work(done)).toEqual({ answered: 0, reopened: 0, cancelled: 0, tasksClosed: 0 })
    expect((await issueOf(issueIds[w.a.salesOrderId]!))!.status).toBe('OPEN')
    // A change of the task's words, due day or snooze is no move.
    expect(await issueAnswered(system, { eventId: newId(), type: 'task.changed', payload: { taskId: taskA.id, recordType: 'SalesOrder', recordId: w.a.salesOrderId, status: 'OPEN', fields: ['dueDate'] } })).toEqual({ answered: 0, reopened: 0, cancelled: 0, tasksClosed: 0 })
    // Done again: answered again.
    await setTask(taskA.id, 'DONE')
    expect(await work(await answering())).toEqual({ answered: 2, reopened: 0, cancelled: 0, tasksClosed: 0 })
  })

  it('answered (OFFICE): the task cancelled → the issue CANCELLED (nobody is asked any more); a task reopened after that asks nothing again', async () => {
    await setTask(taskB.id, 'CANCELLED')
    expect(await work(await answering())).toEqual({ answered: 0, reopened: 0, cancelled: 1, tasksClosed: 0 })
    expect(await issueOf(issueIds[w.b.salesOrderId]!)).toMatchObject({ status: 'CANCELLED', answeredAt: null })
    await setTask(taskB.id, 'OPEN')
    expect(await work(await answering())).toEqual({ answered: 0, reopened: 0, cancelled: 0, tasksClosed: 0 })
    expect((await issueOf(issueIds[w.b.salesOrderId]!))!.status).toBe('CANCELLED')
    // No production_issue.answered for a cancelled issue.
    expect((await outbox('production_issue.answered')).filter((event) => (event.payload as Json).issueId === issueIds[w.b.salesOrderId])).toEqual([])
  })
})

describe('B-PR-43b a customer’s issue is answered by our reply', { timeout: 120_000 }, () => {
  it('a ticked task alone keeps "Waiting on us" and shows the office "No reply sent yet"; an office note answers nothing; our shared reply answers it', async () => {
    const issue = w.production.issue
    await setTask(issue.taskId, 'DONE')
    expect(await work(await answering())).toEqual({ answered: 0, reopened: 0, cancelled: 0, tasksClosed: 0 })
    const row = (await issueOf(issue.id))!
    expect(row).toMatchObject({ source: 'BRAND', status: 'OPEN', answeredAt: null })
    expect(officeIssueNote({ source: 'BRAND', status: row.status }, (await taskOf(issue.taskId))!.status)).toBe('NO_REPLY_YET')
    const waiting = await database.withScope(officeScope(), (client) => readProblems(client as never, ids.b, [w.b.salesOrderId]))
    expect(waiting.map((problem) => [problem.orderId, problem.status])).toEqual([[w.b.salesOrderId, 'OPEN']])

    // An internal office note on the order: the customer never reads it — no answer.
    await ok('office.all', '/production/notes', { records: [SO(w.b.salesOrderId)], body: 'Made-up: we look into it.' })
    expect(await work(await answering())).toEqual({ answered: 0, reopened: 0, cancelled: 0, tasksClosed: 0 })
    expect((await issueOf(issue.id))!.status).toBe('OPEN')

    // Our shared reply in the order's thread: answered at the reply's time, in that order.
    const messageId = await shareOn(w.b.salesOrderId)
    expect(await work(await answering())).toEqual({ answered: 1, reopened: 0, cancelled: 0, tasksClosed: 0 })
    const at = (await one<{ at: Date }>(`SELECT at FROM "Message" WHERE id = $1`, [messageId]))!.at
    expect(await issueOf(issue.id)).toMatchObject({ status: 'ANSWERED', answeredAt: at })
    const answered = (await outbox('production_issue.answered')).filter((event) => (event.payload as Json).issueId === issue.id)
    expect(answered.map((event) => event.payload)).toEqual([{ issueId: issue.id, partyId: ids.b, source: 'BRAND', salesOrderId: w.b.salesOrderId, batchId: null, answeredInOrderId: w.b.salesOrderId }])
    const message = liveMessageFor(answered[0]!, EVENT_CATALOGUE.get(answered[0]!.type, answered[0]!.version))!
    expect(liveViewFor(message, officeActor('office.p1'), EVENT_CATALOGUE)).toBeNull()
    expect(liveViewFor(message, officeActor('office.p2'), EVENT_CATALOGUE)).not.toBeNull()
    for (const partyId of [ids.a, ids.b]) expect(partnerLiveViewFor(message, partnerOf(partyId), EVENT_CATALOGUE)).toBeNull()
    const read = await database.withScope(officeScope(), (client) => readProblems(client as never, ids.b, [w.b.salesOrderId]))
    expect(read.map((problem) => problem.status)).toEqual(['ANSWERED'])
  })

  it('a batch: our reply before the raise answers nothing; one after it, in ONE order’s thread, answers every issue of the batch and closes its tasks; another customer’s issues are untouched', async () => {
    const so2 = w.production.urgent[0]
    // A note on each of A's two orders gives each issue a message of its own record's thread (as the customer's report would).
    const notes = await ok('office.all', '/production/notes', { records: [SO(w.a.salesOrderId), SO(so2)], body: 'Made-up: the customer reported a problem here.' })
    await answering()
    const messageOf = (orderId: string) => notes.written.find((entry: Json) => entry.id === orderId).messageId as string
    const batchId = newId()
    const taskId = newId()
    const orderRow = async (orderId: string) => (await one<{ number: string; companyId: string }>(`SELECT number, "companyId" FROM "SalesOrder" WHERE id = $1`, [orderId]))!
    const label = (await orderRow(w.a.salesOrderId)).number
    await admin(
      `INSERT INTO "Task" (id, "tenantId", "companyId", "partyId", title, "recordType", "recordId", "recordLabel", "assigneeId", "assignedById", "assignedAt", "dueDate", checklist, status, "createdAt", "updatedAt", "createdById")
       VALUES ($1, $2, $3, $4, 'Made-up: answer the problem the customer reported', 'SalesOrder', $5, $6, $7, $7, now(), current_date + 1, '[]'::jsonb, 'OPEN', now(), now(), $8)`,
      [taskId, ids.tenantId, (await orderRow(w.a.salesOrderId)).companyId, ids.a, w.a.salesOrderId, label, people.supervisorA, actorId],
    )
    const raisedAt = new Date(Date.now() - 5 * 60_000)
    const issueIdsOf = { [w.a.salesOrderId]: newId(), [so2]: newId() }
    for (const orderId of [w.a.salesOrderId, so2]) {
      await admin(
        `INSERT INTO "ProductionIssue" (id, "tenantId", "companyId", "partyId", "recordType", "recordId", "salesOrderId", "taskId", "messageId", source, "batchId", status, "raisedAt", "dueDate", version, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, 'SalesOrder', $5, $5, $6, $7, 'BRAND', $8, 'OPEN', $9, current_date + 1, 1, now(), now())`,
        [issueIdsOf[orderId], ids.tenantId, (await orderRow(orderId)).companyId, ids.a, orderId, taskId, messageOf(orderId), batchId, raisedAt],
      )
    }
    const escalation = await escalationTask({ id: taskId, companyId: (await orderRow(w.a.salesOrderId)).companyId, partyId: ids.a, recordType: 'SalesOrder', recordId: w.a.salesOrderId, recordLabel: label }, 2, people.backupA)

    // A reply dated before the raise answers nothing.
    await shareOn(so2, new Date(raisedAt.getTime() - 60_000))
    expect(await work(await answering())).toEqual({ answered: 0, reopened: 0, cancelled: 0, tasksClosed: 0 })
    // One reply in SEED-SO-0002's thread answers both, in that order; the batch task and its escalation task are closed.
    const bBefore = (await issueOf(w.production.issue.id))!
    await shareOn(so2)
    expect(await work(await answering())).toEqual({ answered: 2, reopened: 0, cancelled: 0, tasksClosed: 2 })
    for (const orderId of [w.a.salesOrderId, so2]) expect((await issueOf(issueIdsOf[orderId]!))!.status, orderId).toBe('ANSWERED')
    expect((await taskOf(taskId))!.status).toBe('DONE')
    expect((await taskOf(escalation))!.status).toBe('DONE')
    const answered = (await outbox('production_issue.answered')).filter((event) => Object.values(issueIdsOf).includes((event.payload as Json).issueId))
    expect(answered.map((event) => [(event.payload as Json).salesOrderId, (event.payload as Json).answeredInOrderId, (event.payload as Json).partyId]).sort()).toEqual(
      [
        [w.a.salesOrderId, so2, ids.a],
        [so2, so2, ids.a],
      ].sort(),
    )
    // R-48: one audit row, of A.
    const audit = await admin<{ recordId: string }>(`SELECT "recordId" FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'production.issuesAnswered' AND after->>'answeredInOrderId' = $2`, [ids.tenantId, so2])
    expect(audit.map((row) => row.recordId)).toEqual([ids.a])
    // B's issue never moved; another reply changes nothing more.
    expect(await issueOf(w.production.issue.id)).toEqual(bBefore)
    await shareOn(w.a.salesOrderId)
    expect(await work(await answering())).toEqual({ answered: 0, reopened: 0, cancelled: 0, tasksClosed: 0 })
  })

  it('a mail leaving its window answers through email.status_changed only when it is sent or failed, on a sales order’s thread; anything else is skipped on its payload', async () => {
    const event = (payload: Json) => ({ eventId: newId(), type: 'email.status_changed', payload })
    const nothing = { answered: 0, reopened: 0, cancelled: 0, tasksClosed: 0 }
    expect(await issueAnswered(system, event({ outboundId: newId(), threadId: newId(), recordType: 'SalesOrder', recordId: w.b.salesOrderId, status: 'QUEUED' }))).toEqual(nothing)
    expect(await issueAnswered(system, event({ outboundId: newId(), threadId: newId(), recordType: 'Inquiry', recordId: newId(), status: 'SENT' }))).toEqual(nothing)
    // An unknown mail on an order with no open customer issue: nothing read beyond the issues.
    expect(await issueAnswered(system, event({ outboundId: newId(), threadId: newId(), recordType: 'SalesOrder', recordId: w.b.salesOrderId, status: 'SENT' }))).toEqual(nothing)
    // A message on another kind of record, or not shared, is skipped on its payload.
    expect(await issueAnswered(system, { eventId: newId(), type: 'thread.message_posted', payload: { threadId: newId(), messageId: newId(), recordType: 'WorkOrder', recordId: w.a.workOrderId, direction: 'OUTBOUND', audience: 'PARTNER' } })).toEqual(nothing)
    expect(await issueAnswered(system, { eventId: newId(), type: 'thread.message_posted', payload: { threadId: newId(), messageId: newId(), recordType: 'SalesOrder', recordId: w.a.salesOrderId, direction: 'INTERNAL_NOTE', audience: 'OFFICE' } })).toEqual(nothing)
  })
})
