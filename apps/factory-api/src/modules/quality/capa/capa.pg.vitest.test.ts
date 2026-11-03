import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayStart } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/quality/capa/rules'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCapa, type CapaSeed } from '../../../../../../packages/factory-db/seed/capa'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { escalationTaskId, reminderTaskId, runCapaReminders } from './reminders'

/**
 * Corrective actions, CAPA and 8D (B-W2b-108; QHS-087 escalate to CAPA, QHS-093 the record, QHS-094 the 8D report, QHS-096
 * actions with reminders and escalation) on the local stack: a throwaway PostgreSQL 17 database from the migrations (the
 * runtime login: row-level security and the …_quality_problems_w2b_guards triggers are real), the real app with test
 * sessions, the reminders' cron body run with a moved clock. Tenant A from the factory-db seeds up to capa (SEED-CAPA-0001
 * from SEED-NCR-0002, SEED-8D-0001 from SEED-CMP-0001 and SEED-NCR-0001, the tenant-wide overdue-action rule: OWNER_AND_ROLE
 * quality_inspector, 1440 minutes). Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/quality/capa`.
 */

let h: Harness
let app: FastifyInstance
let seeded: CapaSeed

const NS = 'w2b108-capa-a'
const idIn = (key: string) => seedUuid(NS, key)
const T = idIn('tenant')
const companyA = idIn('company:A')
const companyB = idIn('company:B')
const siteA = idIn('site:A1')
const TODAY = businessDate(new Date())
const YEAR = TODAY.slice(0, 4)
const TENANT: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'A' }, { id: companyB, code: 'B' }] }

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
let counter = 0
const key = (label = 'k'): string => `capa-${label}-${++counter}-${newId()}`

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (permissions: Permission[], companies: Grant['companies'] = 'all', actorId: () => string = () => fixedActor): (() => SessionContext) => () => ({ audience: 'office', tenantId: T, actorId: actorId(), grants: [grant(permissions, companies)] })
const fixedActor = newId()
const QUALITY: Permission[] = ['quality.capa.view', 'quality.capa.manage', 'quality.ncr.view', 'quality.ncr.raise', 'quality.ncr.manage', 'quality.complaints.view', 'threads.read', 'threads.post', 'files.read', 'files.upload']
let pmUserId = ''
let qaUserId = ''
const SESSIONS: Record<string, () => SessionContext> = {
  quality: office(QUALITY),
  viewer: office(['quality.capa.view']),
  /** May manage CAPAs, sees NCRs but may not change them: escalating an NCR is refused. */
  noNcr: office(['quality.capa.view', 'quality.capa.manage', 'quality.ncr.view', 'quality.complaints.view']),
  companyB: office(['quality.capa.view', 'quality.capa.manage', 'quality.ncr.view', 'quality.ncr.manage'], [companyB]),
  /** The production manager as a person: sees CAPAs, owns an action, records it done. */
  pm: office(['quality.capa.view'], 'all', () => pmUserId),
  /** Another person who only sees CAPAs. */
  other: office(['quality.capa.view'], 'all', () => qaUserId),
}

async function call(session: string, method: Method, url: string, body?: unknown, idempotencyKey = key(session)) {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': idempotencyKey }) }, ...(body === undefined ? {} : { payload: body as object }) })
  return { status: response.statusCode, body: response.headers['content-type']?.toString().startsWith('application/json') ? (response.json() as Json) : ({ raw: response.rawPayload } as Json), type: response.headers['content-type']?.toString() ?? '' }
}
async function ok(session: string, method: Method, url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await call(session, method, url, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body
}
async function refused(session: string, method: Method, url: string, body: unknown, status: number): Promise<Json> {
  const answer = await call(session, method, url, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body.error
}
const events = async (type: string, subject: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = $1 AND subject = $2 ORDER BY "occurredAt", id`, [type, subject])).map((row) => row.payload)
const raiseNcr = async (title: string, severity = 'MAJOR') => (await ok('quality', 'POST', '/quality/ncr', { siteId: siteA, title, quantityAffected: '2', uom: 'PCS', severity, foundAt: 'FINAL' }, 201)).record.ncr
const capaOf = async (capaId: string, session = 'quality') => (await ok(session, 'GET', `/quality/capa/${capaId}`)).record
const log = { info() {}, warn() {}, error() {} }
const clockAt = (at: Date) => ({ now: () => at })

beforeAll(async () => {
  h = await startHarness('quality_capa')
  await seedCore({ db: h.database, namespace: NS })
  await seedFiles({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  seeded = await seedCapa({ db: h.database, namespace: NS })
  // The system roles as the templates hold them now (quality.capa.* for the quality inspector and the production manager).
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  // The letterhead the 8D report needs (c.c. art. 2250), made up.
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT00000003038', "fiscalCode" = '00000003038', "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyA])
  for (const [kind, pattern] of [['CAPA', 'CAPA-{YYYY}-{N:4}'], ['NCR', 'NCR-{YYYY}-{N:4}']] as const) {
    await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, $4, 'MAIN', $5, 'YEARLY', $6, false) ON CONFLICT DO NOTHING`, [newId(), T, companyA, kind, YEAR, pattern])
  }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
  qaUserId = (await addUser(h, TENANT, { email: 'qa.capa@example.com', role: 'quality_inspector' })).id
  pmUserId = (await addUser(h, TENANT, { email: 'pm.capa@example.com', role: 'production_manager' })).id
}, 1_500_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

let capaId = ''
let ncr1: Json
let ncr2: Json

describe('escalate to CAPA and the record (QHS-087, QHS-093)', () => {
  it('the preview says why each NCR is worth a CAPA, and which open CAPAs of its company take it', async () => {
    ncr1 = await raiseNcr('Grain crack repeats on the butt', 'CRITICAL')
    ncr2 = await raiseNcr('Grain crack on a second hide')
    const preview = await ok('quality', 'GET', `/quality/capa/escalate?recordType=Nonconformance&ids=${ncr1.id},${ncr2.id},${seeded.ncrId}`)
    expect(preview.records.map((record: Json) => record.number)).toEqual([ncr1.number, ncr2.number, 'SEED-NCR-0002'])
    expect(preview.records[0].reasons).toContain('CRITICAL')
    // SEED-NCR-0002 is SEED-CAPA-0001's already: refused in words, before anything is written.
    expect(preview.records[2].problem).toMatchObject({ path: 'held/ESCALATED_ELSEWHERE' })
    expect(preview.records[2].escalatedTo).toMatchObject({ number: 'SEED-CAPA-0001' })
    expect(preview.ready).toBe(false)
    expect(preview.capas.map((capa: Json) => capa.number)).toEqual(expect.arrayContaining(['SEED-CAPA-0001', 'SEED-8D-0001']))
  })

  it('opens a CAPA from two NCRs in one command: numbered, at PLAN, the NCRs name it', async () => {
    const answer = await ok('quality', 'POST', '/quality/capa', {
      type: 'CAPA',
      title: 'Grain cracks keep coming back',
      dueOn: addDays(TODAY, 30),
      priority: 'HIGH',
      ownerId: pmUserId,
      team: [{ userId: qaUserId, role: 'Quality' }],
      problemWhat: 'Grain cracks across the butt',
      sources: [
        { recordType: 'Nonconformance', recordId: ncr1.id, note: 'Critical' },
        { recordType: 'Nonconformance', recordId: ncr2.id },
      ],
    }, 201)
    const record = answer.record
    capaId = record.capa.id
    expect(record.capa).toMatchObject({ type: 'CAPA', status: 'PLAN', priority: 'HIGH', ownerId: pmUserId, sources: { count: 2 } })
    expect(record.capa.number).toMatch(new RegExp(`^CAPA-${YEAR}-\\d{4}$`))
    expect(record.sources.map((source: Json) => source.record?.number).sort()).toEqual([ncr1.number, ncr2.number].sort())
    expect(record.sources.every((source: Json) => source.record.namesThisCapa)).toBe(true)
    expect(record.containment.map((entry: Json) => entry.number).sort()).toEqual([ncr1.number, ncr2.number].sort())
    expect(record.next).toEqual({ stage: 'ACT' })
    expect(record.closing.ready).toBe(false)
    expect(record.people.map((person: Json) => person.id)).toEqual(expect.arrayContaining([pmUserId, qaUserId]))
    expect((await admin('SELECT "capaId" FROM "Nonconformance" WHERE id = ANY($1::uuid[])', [[ncr1.id, ncr2.id]])).map((row) => row.capaId)).toEqual([capaId, capaId])
    expect(await events('capa.opened', capaId)).toEqual([expect.objectContaining({ capaId, type: 'CAPA', sources: 2 })])
    expect((await events('capa.sources_changed', capaId)).map((event) => event.change)).toEqual(['ADDED', 'ADDED'])
    expect(await events('ncr.changed', ncr1.id)).toEqual([expect.objectContaining({ fields: ['links'] })])
    // The owner and the team follow it; its thread is the company's.
    expect((await admin<{ userId: string }>('SELECT "userId" FROM "RecordFollower" WHERE "recordType" = $1 AND "recordId" = $2', ['Capa', capaId])).map((row) => row.userId).sort()).toEqual([pmUserId, qaUserId].sort())
    expect((await call('quality', 'GET', `/threads/Capa/${capaId}`)).status).toBe(200)
    // The NCR and the complaint lists find their CAPA.
    expect((await ok('viewer', 'GET', `/quality/capa?sourceType=Nonconformance&sourceId=${ncr1.id}`)).capas.map((row: Json) => row.id)).toEqual([capaId])
  })

  it('refuses in words: a record already escalated, another company, a cancelled NCR, no right on the NCR', async () => {
    expect((await refused('quality', 'POST', `/quality/capa/${seeded.capaId}/sources`, { sources: [{ recordType: 'Nonconformance', recordId: ncr1.id }] }, 409)).issues[0].path).toBe('held/ESCALATED_ELSEWHERE')
    // SEED-CMP-0001 is SEED-8D-0001's source already.
    expect((await refused('quality', 'POST', `/quality/capa/${capaId}/sources`, { sources: [{ recordType: 'Complaint', recordId: seeded.complaintId }] }, 409)).message).toMatch(/escalated to SEED-8D-0001 already/)
    const cancelled = await raiseNcr('Raised by mistake')
    await ok('quality', 'POST', `/quality/ncr/${cancelled.id}/cancel`, { version: cancelled.version, reason: 'A duplicate' })
    expect((await refused('quality', 'POST', `/quality/capa/${capaId}/sources`, { sources: [{ recordType: 'Nonconformance', recordId: cancelled.id }] }, 409)).issues[0].path).toBe('held/NCR_CANCELLED')
    const third = await raiseNcr('A third crack')
    expect((await refused('noNcr', 'POST', `/quality/capa/${capaId}/sources`, { sources: [{ recordType: 'Nonconformance', recordId: third.id }] }, 403)).message).toMatch(/needs quality.ncr.manage/)
    // Company B's people do not see company A's CAPAs.
    expect((await call('companyB', 'GET', `/quality/capa/${capaId}`)).status).toBe(404)
    expect((await ok('companyB', 'GET', '/quality/capa?view=all')).capas).toEqual([])
    // Nothing was written by the refusals.
    expect((await capaOf(capaId)).capa.sources.count).toBe(2)
    expect((await admin('SELECT "capaId" FROM "Nonconformance" WHERE id = $1', [third.id]))[0]!.capaId).toBeNull()
  })

  it('changes the team and the problem with the version read; a stale version and a person who cannot see it are refused', async () => {
    const before = await capaOf(capaId)
    const changed = await ok('quality', 'PATCH', `/quality/capa/${capaId}`, { version: before.capa.version, team: [{ userId: qaUserId, role: 'Quality lead' }], problemWhere: 'Cutting table, plant A1', problemHowMany: 'Two hides' })
    expect(changed.record.capa.team).toEqual([{ userId: qaUserId, role: 'Quality lead' }])
    expect(changed.record.capa.problem).toMatchObject({ where: 'Cutting table, plant A1', howMany: 'Two hides' })
    expect((await events('capa.changed', capaId)).at(-1)).toMatchObject({ fields: ['team', 'problemWhere', 'problemHowMany'] })
    expect((await refused('quality', 'PATCH', `/quality/capa/${capaId}`, { version: before.capa.version, title: 'Late' }, 409)).code).toBe('conflict')
    expect((await refused('quality', 'PATCH', `/quality/capa/${capaId}`, { version: changed.record.capa.version, ownerId: newId() }, 400)).issues[0].path).toBe('body/ownerId')
    expect((await refused('quality', 'PATCH', `/quality/capa/${capaId}`, { version: changed.record.capa.version, customerId: idIn('party:S1') }, 400)).issues[0].path).toBe('body/customerId')
  })

  it('moves along its own stages only', async () => {
    let record = await capaOf(capaId)
    expect((await refused('quality', 'POST', `/quality/capa/${capaId}/stage`, { version: record.capa.version, to: 'D2' }, 400)).issues[0].path).toBe('body/to')
    record = (await ok('quality', 'POST', `/quality/capa/${capaId}/stage`, { version: record.capa.version, to: 'ACT' })).record
    expect(record.capa.status).toBe('ACT')
    expect(await events('capa.stage_changed', capaId)).toEqual([expect.objectContaining({ from: 'PLAN', to: 'ACT' })])
  })
})

let correctiveId = ''
let preventiveId = ''

describe('actions with reminders and escalation (QHS-096)', () => {
  it('adds a corrective and a preventive action; the owners must see the CAPA', async () => {
    const corrective = await ok('quality', 'POST', `/quality/capa/${capaId}/actions`, { kind: 'CORRECTIVE', description: 'Check every hide under the light table', ownerId: qaUserId, dueOn: addDays(TODAY, 5) }, 201)
    correctiveId = corrective.actionId
    const preventive = await ok('quality', 'POST', `/quality/capa/${capaId}/actions`, { kind: 'PREVENTIVE', description: 'Add a grain check to the incoming plan', ownerId: pmUserId, dueOn: addDays(TODAY, 1) }, 201)
    preventiveId = preventive.actionId
    expect(preventive.record.actions.map((action: Json) => [action.seq, action.kind, action.status])).toEqual([[1, 'CORRECTIVE', 'OPEN'], [2, 'PREVENTIVE', 'OPEN']])
    expect((await refused('quality', 'POST', `/quality/capa/${capaId}/actions`, { kind: 'CORRECTIVE', description: 'x', ownerId: newId(), dueOn: TODAY }, 400)).issues[0].path).toBe('body/ownerId')
    expect((await refused('quality', 'POST', `/quality/capa/${capaId}/actions`, { kind: 'CORRECTIVE', description: 'x', dueOn: addDays(TODAY, -1) }, 400)).issues[0].path).toBe('body/dueOn')
    expect((await events('capa.action_changed', capaId)).map((event) => event.change)).toEqual(['ADDED', 'ADDED'])
  })

  it('reminds 3 days before its due day, from 07:00 Rome: a task for the owner, in their language; the same tick writes nothing', async () => {
    const due = addDays(TODAY, 5)
    const first = new Date(businessDayStart(addDays(due, -3)).getTime() + 7 * 3_600_000 + 60_000)
    await runCapaReminders({ database: h.database, log, clock: clockAt(first) })
    const task1 = reminderTaskId(correctiveId, 1)
    expect(await admin('SELECT "assigneeId", status::text AS status, "recordType", "recordLabel", "createdById" FROM "Task" WHERE id = $1', [task1])).toEqual([{ assigneeId: qaUserId, status: 'OPEN', recordType: 'Capa', recordLabel: (await capaOf(capaId)).capa.number, createdById: null }])
    expect((await admin<{ title: string }>('SELECT title FROM "Task" WHERE id = $1', [task1]))[0]!.title).toMatch(/^Promemoria: azione 1 di CAPA-/)
    expect((await admin('SELECT "remindersSent" FROM "CapaAction" WHERE id = $1', [correctiveId]))[0]!.remindersSent).toBe(1)
    expect((await events('capa.action_due', capaId)).filter((event) => event.actionId === correctiveId)).toEqual([expect.objectContaining({ reminder: 1, taskId: task1, byHand: false })])
    expect((await events('task.assigned', task1))[0]).toMatchObject({ assigneeId: qaUserId, assignedById: null })
    // The preventive action (due tomorrow) had its moment too: reminded once, to the production manager.
    expect((await admin('SELECT "assigneeId" FROM "Task" WHERE id = $1', [reminderTaskId(preventiveId, 1)]))[0]!.assigneeId).toBe(pmUserId)
    // The same tick again writes nothing.
    await runCapaReminders({ database: h.database, log, clock: clockAt(first) })
    expect((await admin('SELECT "remindersSent" FROM "CapaAction" WHERE id = ANY($1::uuid[]) ORDER BY "remindersSent"', [[correctiveId, preventiveId]])).map((row) => row.remindersSent)).toEqual([1, 1])
  })

  it('escalates an overdue action once, after the rule’s wait, to the CAPA’s owner and the rule’s role (tasks); on its day the next reminder replaces the first', async () => {
    const action = (await capaOf(capaId)).actions.find((entry: Json) => entry.id === preventiveId)
    const overdue = businessDayStart(addDays(action.dueOn, 1))
    // The tenant's rule waits 1440 minutes after the action is overdue.
    await runCapaReminders({ database: h.database, log, clock: clockAt(new Date(overdue.getTime() + 60_000)) })
    expect((await admin('SELECT "escalatedAt" FROM "CapaAction" WHERE id = $1', [preventiveId]))[0]!.escalatedAt).toBeNull()
    await runCapaReminders({ database: h.database, log, clock: clockAt(new Date(overdue.getTime() + 1440 * 60_000 + 60_000)) })
    expect((await admin('SELECT "escalatedAt" FROM "CapaAction" WHERE id = $1', [preventiveId]))[0]!.escalatedAt).not.toBeNull()
    expect((await events('capa.action_overdue', capaId)).filter((event) => event.actionId === preventiveId)).toEqual([expect.objectContaining({ seq: 2, told: 2, tasks: 2 })])
    const tasks = await admin<{ id: string; assigneeId: string }>('SELECT id, "assigneeId" FROM "Task" WHERE id = ANY($1::uuid[])', [[escalationTaskId(preventiveId, pmUserId), escalationTaskId(preventiveId, qaUserId)]])
    expect(tasks.map((task) => task.assigneeId).sort()).toEqual([pmUserId, qaUserId].sort())
    // The corrective action's day (07:00 Rome): its second reminder, the first one's task closed; no second escalation.
    const due = addDays(TODAY, 5)
    await runCapaReminders({ database: h.database, log, clock: clockAt(new Date(businessDayStart(due).getTime() + 7 * 3_600_000 + 60_000)) })
    expect(await admin('SELECT id, status::text AS status FROM "Task" WHERE id = ANY($1::uuid[]) ORDER BY status', [[reminderTaskId(correctiveId, 1), reminderTaskId(correctiveId, 2)]])).toEqual([
      { id: reminderTaskId(correctiveId, 1), status: 'CANCELLED' },
      { id: reminderTaskId(correctiveId, 2), status: 'OPEN' },
    ])
    expect((await events('capa.action_overdue', capaId)).filter((event) => event.actionId === preventiveId)).toHaveLength(1)
  })

  it('a reminder by hand; the owner records their own action done with its evidence, another viewer may not', async () => {
    let record = await capaOf(capaId)
    const preventive = record.actions.find((entry: Json) => entry.id === preventiveId)
    const reminded = await ok('quality', 'POST', `/quality/capa/${capaId}/actions/${preventiveId}/remind`, { version: preventive.version })
    expect(reminded.reminder).toMatchObject({ reminder: preventive.remindersSent + 1, assigneeId: pmUserId })
    expect((await refused('pm', 'POST', `/quality/capa/${capaId}/actions/${preventiveId}/done`, { version: preventive.version }, 400)).issues[0].path).toBe('body/evidenceNote')
    expect((await call('other', 'POST', `/quality/capa/${capaId}/actions/${preventiveId}/done`, { version: preventive.version, evidenceNote: 'x' })).status).toBe(403)
    record = (await ok('pm', 'POST', `/quality/capa/${capaId}/actions/${preventiveId}/done`, { version: preventive.version, evidenceNote: 'Grain check added to plan INC-LEATHER v2' })).record
    expect(record.actions.find((entry: Json) => entry.id === preventiveId)).toMatchObject({ status: 'DONE', doneById: pmUserId, evidenceNote: 'Grain check added to plan INC-LEATHER v2' })
    // Its open tasks are done with it (the reminder and both escalation tasks).
    expect((await admin<{ status: string }>(`SELECT status::text AS status FROM "Task" WHERE "recordId" = $1 AND "createdById" IS NULL AND id = ANY($2::uuid[])`, [capaId, [escalationTaskId(preventiveId, pmUserId), escalationTaskId(preventiveId, qaUserId), reminded.reminder.taskId]])).map((row) => row.status)).toEqual(['DONE', 'DONE', 'DONE'])
    // An ended action never changes.
    expect((await refused('quality', 'PATCH', `/quality/capa/${capaId}/actions/${preventiveId}`, { version: preventive.version + 1, description: 'Later' }, 409)).issues[0].path).toBe('held/ACTION_ENDED')
  })
})

describe('the close and the 8D report (QHS-093, QHS-094)', () => {
  it('closes only from its last stage with an action done and none open; then it never changes', async () => {
    let record = await capaOf(capaId)
    const closeBody = (version: number) => ({ version, note: 'No crack in the next ten lots.' })
    const notLast = await refused('quality', 'POST', `/quality/capa/${capaId}/close`, closeBody(record.capa.version), 409)
    expect(notLast.issues.map((issue: Json) => issue.path)).toEqual(['held/NOT_LAST_STAGE', 'held/ACTIONS_OPEN'])
    record = (await ok('quality', 'POST', `/quality/capa/${capaId}/stage`, { version: record.capa.version, to: 'CHECK' })).record
    const corrective = record.actions.find((entry: Json) => entry.id === correctiveId)
    expect((await refused('quality', 'POST', `/quality/capa/${capaId}/close`, closeBody(record.capa.version), 409)).issues[0].path).toBe('held/ACTIONS_OPEN')
    record = (await ok('quality', 'POST', `/quality/capa/${capaId}/actions/${correctiveId}/cancel`, { version: corrective.version, reason: 'Replaced by the incoming check' })).record
    expect(record.closing.ready).toBe(true)
    record = (await ok('quality', 'POST', `/quality/capa/${capaId}/close`, closeBody(record.capa.version))).record
    expect(record.capa).toMatchObject({ status: 'CLOSED', closeNote: 'No crack in the next ten lots.' })
    expect(record.may).toMatchObject({ edit: false, close: false })
    expect((await refused('quality', 'PATCH', `/quality/capa/${capaId}`, { version: record.capa.version, title: 'Again' }, 409)).issues[0].path).toBe('held/FINAL')
    expect((await refused('quality', 'POST', `/quality/capa/${capaId}/actions`, { kind: 'CORRECTIVE', description: 'More', dueOn: TODAY }, 409)).issues[0].path).toBe('held/FINAL')
  })

  it('the 8D report: a preview with its banner, a version kept (GeneratedDocument EIGHT_D, no site), the same contents give it back', async () => {
    const preview = await call('viewer', 'GET', `/quality/capa/${capaId}/report?language=en`)
    expect(preview.status).toBe(200)
    expect(preview.type).toBe('application/pdf')
    expect(Buffer.from(preview.body.raw as Buffer).subarray(0, 5).toString()).toBe('%PDF-')
    const first = await ok('quality', 'POST', `/quality/capa/${capaId}/report`, { language: 'it' }, 201)
    expect(first).toMatchObject({ made: true, report: { version: 1, language: 'it' } })
    expect(await admin('SELECT kind::text AS kind, "siteId", "recordType" FROM "GeneratedDocument" WHERE id = $1', [first.report.id])).toEqual([{ kind: 'EIGHT_D', siteId: null, recordType: 'Capa' }])
    expect((await ok('quality', 'POST', `/quality/capa/${capaId}/report`, { language: 'it' }, 201))).toMatchObject({ made: false, report: { id: first.report.id } })
    expect((await ok('quality', 'POST', `/quality/capa/${capaId}/report`, { language: 'en' }, 201))).toMatchObject({ made: true, report: { version: 2, language: 'en' } })
    expect((await capaOf(capaId)).documents.map((document: Json) => document.version)).toEqual([2, 1])
    expect(await events('capa.report_made', capaId)).toHaveLength(2)
    expect((await call('viewer', 'POST', `/quality/capa/${capaId}/report`, {})).status).toBe(403)
  })
})

describe('an 8D for a customer, sources taken off, a cancel; the list and its tiles', () => {
  it('opens an 8D for the customer; an NCR taken off while open is no longer escalated; a cancel closes its tasks', async () => {
    const ncr = await raiseNcr('Pocket seam opened at the elbow')
    const opened = (await ok('quality', 'POST', '/quality/capa', { type: 'EIGHT_D', title: 'Pocket seam opened', dueOn: addDays(TODAY, 20), customerId: seeded.customerId, sources: [{ recordType: 'Nonconformance', recordId: ncr.id }] }, 201)).record
    expect(opened.capa).toMatchObject({ type: 'EIGHT_D', status: 'D1', customer: { id: seeded.customerId } })
    const source = opened.sources[0]
    const off = (await ok('quality', 'DELETE', `/quality/capa/${opened.capa.id}/sources/${source.id}?version=${opened.capa.version}`)).record
    expect(off.sources).toEqual([])
    expect((await admin('SELECT "capaId" FROM "Nonconformance" WHERE id = $1', [ncr.id]))[0]!.capaId).toBeNull()
    expect((await events('capa.sources_changed', opened.capa.id)).map((event) => event.change)).toEqual(['ADDED', 'REMOVED'])
    const added = (await ok('quality', 'POST', `/quality/capa/${opened.capa.id}/actions`, { kind: 'CORRECTIVE', description: 'Re-sew the batch', ownerId: qaUserId, dueOn: TODAY }, 201)).record
    const action = added.actions[0]
    const reminded = await ok('quality', 'POST', `/quality/capa/${opened.capa.id}/actions/${action.id}/remind`, { version: action.version })
    const cancelled = (await ok('quality', 'POST', `/quality/capa/${opened.capa.id}/cancel`, { version: reminded.record.capa.version, reason: 'Raised on the wrong customer' })).record
    expect(cancelled.capa).toMatchObject({ status: 'CANCELLED', cancelReason: 'Raised on the wrong customer' })
    expect((await admin('SELECT status::text AS status FROM "Task" WHERE id = $1', [reminded.reminder.taskId]))[0]!.status).toBe('CANCELLED')
    // The NCR may go to another CAPA now.
    const preview = await ok('quality', 'GET', `/quality/capa/escalate?recordType=Nonconformance&ids=${ncr.id}`)
    expect(preview.records[0].problem).toBeNull()
  })

  it('the list rows, the tiles, the views and the people', async () => {
    const list = await ok('viewer', 'GET', '/quality/capa?view=all')
    const row = list.capas.find((entry: Json) => entry.id === capaId)
    expect(row).toMatchObject({ status: 'CLOSED', sources: { count: 2 }, actions: { count: 2, open: 0, done: 1 } })
    expect(list.people.map((person: Json) => person.id)).toEqual(expect.arrayContaining([pmUserId, qaUserId]))
    expect((await ok('viewer', 'GET', '/quality/capa')).capas.map((entry: Json) => entry.id)).not.toContain(capaId)
    expect((await ok('viewer', 'GET', '/quality/capa?view=closed')).capas.map((entry: Json) => entry.id)).toContain(capaId)
    expect((await ok('viewer', 'GET', `/quality/capa?q=${encodeURIComponent(row.number)}&view=all`)).capas.map((entry: Json) => entry.id)).toEqual([capaId])
    const counts = await ok('viewer', 'GET', '/quality/capa/counts')
    expect(counts.tiles.open).toBeGreaterThanOrEqual(2)
    const people = await ok('viewer', 'GET', `/quality/capa/people?companyId=${companyA}`)
    expect(people.people.find((person: Json) => person.id === qaUserId)).toMatchObject({ manages: true, remindable: true })
    expect(people.people.find((person: Json) => person.id === pmUserId)).toMatchObject({ manages: true })
    expect((await call('companyB', 'GET', `/quality/capa/people?companyId=${companyA}`)).status).toBe(404)
  })
})
