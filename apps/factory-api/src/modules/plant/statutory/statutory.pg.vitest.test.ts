import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays, addInterval } from '@nexus/factory-domain/plant/statutory/rules'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedPlantCare, type PlantCareSeed } from '../../../../../../packages/factory-db/seed/plantcare'
import { seed as seedPlant, type PlantSeed } from '../../../../../../packages/factory-db/seed/plant'
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import type { Clock } from '../../../core/time'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { runCheckReminders } from './reminders'

/**
 * Statutory periodic checks (B-W2b-124; QHS-205; D.Lgs. 81/2008 art. 71; Owner answer H1) on the local stack with the app's
 * real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime logins, row-level security, the column
 * grants and the …_plant_care_w2b_guards triggers are real), the factory-db seeds up to the plant care seed (check types
 * PRESS_GUARDS for clicking presses, EARTHING, PRESSURE_VESSEL, LIFTING retired; on the press SEED-CP-01 the guards and
 * earthing plans, August's check, its correction, November's failed check with job SEED-MJ-0002; the press locked as unsafe
 * by the seeded guard report). Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/plant/statutory`.
 */

let h: Harness
let app: FastifyInstance
let plant: PlantSeed
let care: PlantCareSeed

const ns = 'plant-statutory'
const idOf = (key: string) => seedUuid(ns, key)
const A = { tenant: idOf('tenant'), actor: idOf('actor'), companyA: idOf('company:A'), siteA1: idOf('site:A1') }
const TENANT: TestTenant = { id: A.tenant, slug: ns, companies: [{ id: A.companyA, code: 'A' }] }

const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (permissions: Permission[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: A.actor, grants: [grant(permissions)] })
const MANAGE: Permission[] = ['plant.view', 'plant.report', 'plant.requests.triage', 'plant.jobs.manage', 'plant.jobs.work', 'plant.checks.manage']
const SESSIONS: Record<string, SessionContext> = {
  manager: office(MANAGE),
  checker: office(['plant.view', 'plant.checks.manage']),
  viewer: office(['plant.view']),
  // The checks of company A's site A1 only: the group's check types are out of reach.
  siteOnly: { audience: 'office', tenantId: A.tenant, actorId: A.actor, grants: [{ permissions: ['plant.view', 'plant.checks.manage'], companies: [idOf('company:A')], sites: [idOf('site:A1')], parties: 'all' }] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `s-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown, key = freshKey()) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const refusalOf = (error: Json): string => String(error.issues?.[0]?.path ?? '')
const outbox = (type: string, subject: string) => admin(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 AND subject = $3 ORDER BY "occurredAt", id`, [A.tenant, type, subject])
const at = (date: Date): Clock => ({ now: () => date }) as Clock
const quiet = { info() {}, warn() {}, error() {} } as never
const today = businessDate(new Date())

let sewMachine: string
let pressMachine: string
let tableMachine: string
let owner: string

beforeAll(async () => {
  h = await startHarness('plant_statutory')
  await seedCore({ db: h.database, namespace: ns })
  await seedPrivacy({ db: h.database, namespace: ns })
  await seedProduction({ db: h.database, namespace: ns })
  await seedNumbering({ db: h.database, namespace: ns })
  plant = await seedPlant({ db: h.database, namespace: ns })
  care = await seedPlantCare({ db: h.database, namespace: ns })
  ;[sewMachine, pressMachine, tableMachine] = plant.machineIds
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [A.tenant])
  owner = (await addUser(h, TENANT, { email: `checks-${run}@example.test`, role: 'maintenance' })).id
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

let compressor: Json
let sewPlan: Json

describe('check types: the group\'s list, with the law in words (Plant settings)', () => {
  it('lists the seeded types in order, retired ones too, with their plans and results', async () => {
    const list = await ok('viewer', 'GET', '/plant/checks/types')
    expect(list.types.map((type: Json) => type.code)).toEqual(['PRESS_GUARDS', 'EARTHING', 'PRESSURE_VESSEL', 'LIFTING'])
    expect(list.types[0]).toMatchObject({ legalBasis: 'D.Lgs. 81/2008 art. 71 c.4 and c.9', defaultInterval: 3, defaultIntervalUnit: 'MONTH', keptYears: 3, plans: 1, results: 3, machineClass: { code: 'CLICKING_PRESS' } })
    expect(list.types[2]).toMatchObject({ code: 'PRESSURE_VESSEL', retentionYears: 5, keptYears: 5 })
    expect(list).toMatchObject({ canManage: false, leastRetentionYears: 3 })
    expect((await ok('viewer', 'GET', `/plant/checks/types?active=false`)).types.map((type: Json) => type.code)).toEqual(['LIFTING'])
  })

  it('adds a type over every company; a taken code, a short retention and a role of one site are refused', async () => {
    compressor = (await ok('manager', 'POST', '/plant/checks/types', { code: 'compressor', labelIt: 'Compressore (inventato)', labelEn: 'Compressor (made-up)', legalBasis: 'Made-up basis for the test', defaultInterval: 1, defaultIntervalUnit: 'YEAR', outsideBody: true, retentionYears: 5 }, 201)).type
    expect(compressor).toMatchObject({ code: 'COMPRESSOR', machineClass: null, keptYears: 5, sortOrder: 4, active: true, version: 1 })
    expect((await outbox('machine_check_type.changed', compressor.id)).map((row) => row.payload)).toEqual([{ checkTypeId: compressor.id, code: 'COMPRESSOR', change: 'ADDED' }])
    expect(refusalOf(await no('manager', 'POST', '/plant/checks/types', { code: 'COMPRESSOR', labelIt: 'x', labelEn: 'x', legalBasis: 'x', defaultInterval: 1, defaultIntervalUnit: 'YEAR' }, 409))).toBe('refusal/TYPE_TAKEN')
    expect((await no('manager', 'POST', '/plant/checks/types', { code: 'SHORT', labelIt: 'x', labelEn: 'x', legalBasis: 'x', defaultInterval: 1, defaultIntervalUnit: 'YEAR', retentionYears: 2 }, 400)).issues[0].path).toBe('body/retentionYears')
    expect((await no('manager', 'POST', '/plant/checks/types', { code: 'LONG', labelIt: 'x', labelEn: 'x', legalBasis: 'x', defaultInterval: 11, defaultIntervalUnit: 'YEAR' }, 400)).issues[0].path).toBe('body/defaultInterval')
    expect(await no('siteOnly', 'POST', '/plant/checks/types', { code: 'SITE', labelIt: 'x', labelEn: 'x', legalBasis: 'x', defaultInterval: 1, defaultIntervalUnit: 'YEAR' }, 403)).toMatchObject({ code: 'forbidden' })
    expect(await no('viewer', 'POST', '/plant/checks/types', { code: 'VIEW', labelIt: 'x', labelEn: 'x', legalBasis: 'x', defaultInterval: 1, defaultIntervalUnit: 'YEAR' }, 403)).toMatchObject({ code: 'forbidden' })
  })

  it('changes the words, the law and the interval with the version read; retires and restores', async () => {
    compressor = (await ok('manager', 'PATCH', `/plant/checks/types/${compressor.id}`, { version: 1, legalBasis: 'Made-up basis, second wording', defaultInterval: 18, defaultIntervalUnit: 'MONTH' })).type
    expect(compressor).toMatchObject({ legalBasis: 'Made-up basis, second wording', defaultInterval: 18, defaultIntervalUnit: 'MONTH', version: 2 })
    expect((await no('manager', 'PATCH', `/plant/checks/types/${compressor.id}`, { version: 1, labelEn: 'Old' }, 409)).message).toContain('version 2')
    const lifting = (await ok('viewer', 'GET', '/plant/checks/types?active=false')).types[0]
    const restored = (await ok('manager', 'PATCH', `/plant/checks/types/${lifting.id}`, { version: lifting.version, active: true })).type
    expect(restored.active).toBe(true)
    await ok('manager', 'PATCH', `/plant/checks/types/${lifting.id}`, { version: restored.version, active: false })
    expect((await outbox('machine_check_type.changed', lifting.id)).map((row) => row.payload.change)).toEqual(['RESTORED', 'RETIRED'])
  })
})

describe('plans: one check type on one machine, one active at a time', () => {
  it('makes a plan from the type\'s default interval, with its owner, outside body and reminder', async () => {
    const created = await ok('checker', 'POST', '/plant/checks/plans', { machineId: sewMachine, checkTypeId: compressor.id, firstDueOn: addDays(today, 10), reminderDays: 14, ownerId: owner, note: 'Booked by the office (made-up).' }, 201)
    sewPlan = created.plan
    expect(created.replacedPlanId).toBeNull()
    expect(sewPlan).toMatchObject({ interval: 18, intervalUnit: 'MONTH', firstDueOn: addDays(today, 10), nextDueOn: addDays(today, 10), reminderDays: 14, reminderFrom: addDays(today, -4), owner: { id: owner }, due: { state: 'DUE_SOON', days: 10 }, status: 'ACTIVE', lastDone: null, machine: { id: sewMachine, locked: false } })
    expect((await outbox('machine_check_plan.changed', sewPlan.id)).map((row) => row.payload)).toEqual([expect.objectContaining({ change: 'CREATED', nextDueOn: addDays(today, 10), interval: 18, intervalUnit: 'MONTH', replacedPlanId: null })])
  })

  it('refuses a type of another class, a retired type, a second plan without a reason, and an owner who does not see the plant', async () => {
    expect(refusalOf(await no('checker', 'POST', '/plant/checks/plans', { machineId: sewMachine, checkTypeId: care.checkTypeIds.guards, firstDueOn: today }, 409))).toBe('refusal/TYPE_OTHER_CLASS')
    expect(refusalOf(await no('checker', 'POST', '/plant/checks/plans', { machineId: sewMachine, checkTypeId: care.checkTypeIds.lifting, firstDueOn: today }, 409))).toBe('refusal/TYPE_RETIRED')
    expect(refusalOf(await no('checker', 'POST', '/plant/checks/plans', { machineId: sewMachine, checkTypeId: compressor.id, firstDueOn: today }, 409))).toBe('refusal/PLAN_EXISTS')
    expect((await no('checker', 'POST', '/plant/checks/plans', { machineId: sewMachine, checkTypeId: care.checkTypeIds.earthing, firstDueOn: today, ownerId: newId() }, 400)).issues[0].path).toBe('body/ownerId')
    expect((await no('checker', 'POST', '/plant/checks/plans', { machineId: sewMachine, checkTypeId: care.checkTypeIds.earthing, firstDueOn: today, interval: 2 }, 400)).issues[0].path).toBe('body/interval')
    expect(await no('viewer', 'POST', '/plant/checks/plans', { machineId: sewMachine, checkTypeId: care.checkTypeIds.earthing, firstDueOn: today }, 403)).toMatchObject({ code: 'forbidden' })
  })

  it('starts a new plan in place of the active one when given why: the old one ends in the same command', async () => {
    const replaced = await ok('checker', 'POST', '/plant/checks/plans', { machineId: sewMachine, checkTypeId: compressor.id, interval: 1, intervalUnit: 'YEAR', firstDueOn: addDays(today, 10), reminderDays: 14, ownerId: owner, replaceReason: 'Yearly now (made-up).' }, 201)
    expect(replaced.replacedPlanId).toBe(sewPlan.id)
    const old = (await ok('viewer', 'GET', `/plant/checks/plans/${sewPlan.id}`)).plan
    expect(old).toMatchObject({ status: 'ENDED', endedReason: 'Yearly now (made-up).', due: { state: 'ENDED' } })
    sewPlan = replaced.plan
    expect(sewPlan).toMatchObject({ interval: 1, intervalUnit: 'YEAR', status: 'ACTIVE' })
    // An ended plan never changes.
    expect(refusalOf(await no('checker', 'PATCH', `/plant/checks/plans/${old.id}`, { version: old.version, reminderDays: 7 }, 409))).toBe('refusal/PLAN_ENDED')
  })

  it('lists the plans soonest first, by due state and machine; the tiles count them', async () => {
    const soon = await ok('viewer', 'GET', `/plant/checks/plans?siteId=${A.siteA1}&due=DUE_SOON`)
    expect(soon.plans.map((row: Json) => row.id)).toContain(sewPlan.id)
    const press = await ok('viewer', 'GET', `/plant/checks/plans?machineId=${pressMachine}`)
    expect(press.plans.map((row: Json) => row.checkType.code)).toEqual(['PRESS_GUARDS', 'EARTHING'])
    expect(press.plans[0]).toMatchObject({ lastDone: { resultId: care.resultIds.failed, outcome: 'FAILED' }, machine: { locked: true }, nextDueOn: '2027-02-20' })
    const first = await ok('viewer', 'GET', `/plant/checks/plans?limit=1`)
    expect(first.plans).toHaveLength(1)
    const second = await ok('viewer', 'GET', `/plant/checks/plans?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)
    expect(second.plans[0].id).not.toBe(first.plans[0].id)
    expect((await ok('viewer', 'GET', `/plant/checks/plans?status=ENDED&machineId=${pressMachine}`)).plans.map((row: Json) => row.id)).toEqual([care.planIds.ended])
    const counts = await ok('viewer', 'GET', `/plant/checks/counts?siteId=${A.siteA1}`)
    expect(counts.tiles.DUE_SOON).toBeGreaterThanOrEqual(1)
    expect(counts.today).toBe(today)
  })

  it('changes the interval, owner and reminder; moves a check with the reason, never before its first date', async () => {
    const changed = (await ok('checker', 'PATCH', `/plant/checks/plans/${sewPlan.id}`, { version: sewPlan.version, reminderDays: 20, ownerId: null })).plan
    expect(changed).toMatchObject({ reminderDays: 20, owner: null, version: sewPlan.version + 1 })
    expect(refusalOf(await no('checker', 'POST', `/plant/checks/plans/${sewPlan.id}/move`, { version: changed.version, nextDueOn: changed.nextDueOn, reason: 'x' }, 409))).toBe('refusal/SAME_DATE')
    expect(refusalOf(await no('checker', 'POST', `/plant/checks/plans/${sewPlan.id}/move`, { version: changed.version, nextDueOn: addDays(today, 1), reason: 'x' }, 409))).toBe('refusal/BEFORE_FIRST_DUE')
    sewPlan = (await ok('checker', 'POST', `/plant/checks/plans/${sewPlan.id}/move`, { version: changed.version, nextDueOn: addDays(today, 12), reason: 'The body comes two days later (made-up).' })).plan
    expect(sewPlan.nextDueOn).toBe(addDays(today, 12))
    const audit = await admin(`SELECT reason, before, after FROM "AuditLog" WHERE "tenantId" = $1 AND "recordId" = $2 AND action = 'plant.moveCheckPlan'`, [A.tenant, sewPlan.id])
    expect(audit).toEqual([expect.objectContaining({ reason: 'The body comes two days later (made-up).', before: { nextDueOn: addDays(today, 10) }, after: { nextDueOn: addDays(today, 12) } })])
  })
})

describe('reminders: the cron reminds each due date once, when its window opens', () => {
  it('reminds the plan whose window opened, once; moving the due date reminds it again later', async () => {
    const first = await runCheckReminders({ database: h.database, log: quiet, clock: at(new Date()) })
    expect(first.failed).toBe(0)
    const due = await outbox('machine_check.due', sewPlan.id)
    expect(due.map((row) => row.payload)).toEqual([expect.objectContaining({ planId: sewPlan.id, nextDueOn: addDays(today, 12), reminderDays: 20, overdue: false })])
    const again = await runCheckReminders({ database: h.database, log: quiet, clock: at(new Date()) })
    expect(again.reminded).toBe(0)
    let plan = (await ok('viewer', 'GET', `/plant/checks/plans/${sewPlan.id}`)).plan
    expect(plan.lastRemindedAt).not.toBeNull()
    // ---- B-W2b-F43: the earthing plan's window (seeded: 30 days before 2027-03-15) read from the plan, so the line checks something
    // on every day (from 2027-02-13 it was `expect.any(Array)`): no reminder while its window is shut; once it opened, the one
    // reminder of that due date (overdue after the day).
    const earthing = (await ok('viewer', 'GET', `/plant/checks/plans/${care.planIds.earthing}`)).plan
    const earthingDue = (await outbox('machine_check.due', care.planIds.earthing)).map((row) => row.payload)
    if (today < earthing.reminderFrom) expect(earthingDue).toEqual([])
    else expect(earthingDue).toEqual([expect.objectContaining({ planId: care.planIds.earthing, nextDueOn: earthing.nextDueOn, reminderDays: earthing.reminderDays, overdue: earthing.nextDueOn < today })])
    // ---- end B-W2b-F43
    plan = (await ok('checker', 'POST', `/plant/checks/plans/${sewPlan.id}/move`, { version: plan.version, nextDueOn: addDays(today, 60), reason: 'Later (made-up).' })).plan
    expect(plan.lastRemindedAt).toBeNull()
    expect((await runCheckReminders({ database: h.database, log: quiet, clock: at(new Date()) })).reminded).toBe(0)
    // 41 days on, the window of the new date (60 - 20) opens.
    await runCheckReminders({ database: h.database, log: quiet, clock: at(new Date(Date.now() + 41 * 86_400_000)) })
    expect((await outbox('machine_check.due', sewPlan.id)).map((row) => row.payload.nextDueOn)).toEqual([addDays(today, 12), addDays(today, 60)])
    sewPlan = (await ok('viewer', 'GET', `/plant/checks/plans/${sewPlan.id}`)).plan
  })
})

let passed: Json

describe('the register: a result moves its plan; a correction names what it corrects', () => {
  it('records a passed check: the plan moves to the day plus its interval, kept five years by its type', async () => {
    const step = await ok('checker', 'POST', '/plant/checks/results', { planId: sewPlan.id, performedOn: addDays(today, -1), outcome: 'PASSED', performedBy: 'Made-up Inspections S.r.l.' }, 201)
    passed = step.result
    expect(passed).toMatchObject({ planId: sewPlan.id, outcome: 'PASSED', keptUntil: addInterval(addDays(today, -1), 5, 'YEAR'), inForce: true, reports: [], reportOnFile: false, jobs: [], corrects: null })
    expect(step.plan).toMatchObject({ nextDueOn: addInterval(addDays(today, -1), 1, 'YEAR'), lastRemindedAt: null, lastDone: { resultId: passed.id } })
    expect(step.job).toBeNull()
    expect(step.lock).toBeNull()
    expect((await outbox('machine_check.recorded', passed.id)).map((row) => row.payload)).toEqual([expect.objectContaining({ outcome: 'PASSED', planNextDueOn: addInterval(addDays(today, -1), 1, 'YEAR'), jobId: null, lockRequestId: null })])
  })

  it('refuses a day to come, missing words, a job of a passed check, a lock without a failure, and a reader', async () => {
    expect((await no('checker', 'POST', '/plant/checks/results', { planId: sewPlan.id, performedOn: addDays(today, 1), outcome: 'PASSED', performedBy: 'x' }, 400)).issues[0].path).toBe('body/performedOn')
    expect((await no('checker', 'POST', '/plant/checks/results', { planId: sewPlan.id, performedOn: today, outcome: 'FAILED', performedBy: 'x' }, 400)).issues[0].path).toBe('body/remarks')
    expect(refusalOf(await no('manager', 'POST', '/plant/checks/results', { planId: sewPlan.id, performedOn: today, outcome: 'PASSED', performedBy: 'x', job: {} }, 409))).toBe('refusal/NO_JOB_FOR_PASSED')
    expect(refusalOf(await no('manager', 'POST', '/plant/checks/results', { planId: sewPlan.id, performedOn: today, outcome: 'PASSED_WITH_REMARKS', remarks: 'Worn label', performedBy: 'x', lock: {} }, 409))).toBe('refusal/LOCK_NEEDS_FAILED')
    expect(refusalOf(await no('checker', 'POST', '/plant/checks/results', { planId: sewPlan.id, machineId: pressMachine, performedOn: today, outcome: 'PASSED', performedBy: 'x' }, 409))).toBe('refusal/PLAN_OTHER')
    expect(await no('viewer', 'POST', '/plant/checks/results', { planId: sewPlan.id, performedOn: today, outcome: 'PASSED', performedBy: 'x' }, 403)).toMatchObject({ code: 'forbidden' })
    // The job asks plant.jobs.manage too: a role that only keeps the checks is refused before anything is written.
    expect(await no('checker', 'POST', '/plant/checks/results', { planId: sewPlan.id, performedOn: today, outcome: 'FAILED', remarks: 'x', performedBy: 'x', job: {} }, 403)).toMatchObject({ code: 'forbidden' })
  })

  it('corrects a result once, with why; the correction moves the plan as its last check', async () => {
    const step = await ok('checker', 'POST', '/plant/checks/results', { machineId: sewMachine, checkTypeId: compressor.id, performedOn: addDays(today, -2), outcome: 'PASSED', performedBy: 'Made-up Inspections S.r.l.', correctsId: passed.id, correctionReason: 'The day was typed wrong (made-up).' }, 201)
    expect(step.result).toMatchObject({ planId: sewPlan.id, corrects: { id: passed.id }, correctionReason: 'The day was typed wrong (made-up).', inForce: true })
    expect(step.plan.nextDueOn).toBe(addInterval(addDays(today, -2), 1, 'YEAR'))
    const record = await ok('viewer', 'GET', `/plant/checks/results/${passed.id}`)
    expect(record.result).toMatchObject({ inForce: false, correctedBy: { id: step.result.id } })
    expect(record.corrections.map((row: Json) => row.id)).toEqual([step.result.id])
    expect(refusalOf(await no('checker', 'POST', '/plant/checks/results', { planId: sewPlan.id, performedOn: today, outcome: 'PASSED', performedBy: 'x', correctsId: passed.id, correctionReason: 'again' }, 409))).toBe('refusal/CORRECTED_ALREADY')
    expect(refusalOf(await no('checker', 'POST', '/plant/checks/results', { planId: sewPlan.id, performedOn: today, outcome: 'PASSED', performedBy: 'x', correctsId: care.resultIds.failed, correctionReason: 'other' }, 409))).toBe('refusal/CORRECTS_OTHER')
    // An older check typed in later leaves the plan where it is.
    const older = await ok('checker', 'POST', '/plant/checks/results', { planId: sewPlan.id, performedOn: addDays(today, -400), outcome: 'PASSED', performedBy: 'Made-up Inspections S.r.l.' }, 201)
    expect(older.plan.nextDueOn).toBe(addInterval(addDays(today, -2), 1, 'YEAR'))
    expect((await outbox('machine_check.recorded', older.result.id))[0]!.payload.planNextDueOn).toBeNull()
  })
})

describe('a failed check makes a job and can lock the machine in the same step (Owner answer H1)', () => {
  let tablePlan: Json

  it('records the failure, makes the job naming the result and locks the machine in ONE command', async () => {
    tablePlan = (await ok('checker', 'POST', '/plant/checks/plans', { machineId: tableMachine, checkTypeId: compressor.id, firstDueOn: addDays(today, -30) }, 201)).plan
    const before = (await admin(`SELECT status::text AS status FROM "Machine" WHERE id = $1`, [tableMachine]))[0]!
    expect(before.status).not.toBe('DO_NOT_USE')
    const step = await ok('manager', 'POST', '/plant/checks/results', { planId: tablePlan.id, performedOn: today, outcome: 'FAILED', remarks: 'Safety valve stuck (made-up).', performedBy: 'Made-up Inspections S.r.l.', job: {}, lock: { note: 'Tag hung on the machine' } }, 201)
    expect(step.result).toMatchObject({ outcome: 'FAILED', jobs: [{ id: step.job.id, status: 'NEW' }] })
    expect(step.job).toMatchObject({ source: 'STATUTORY_CHECK', type: 'SAFETY', priority: 'P1', problem: `Failed check "Compressor (made-up)" of ${today}: Safety valve stuck (made-up).` })
    expect(step.lock).toMatchObject({ unsafe: true, status: 'JOB_MADE', job: { id: step.job.id }, description: `Locked as unsafe after the failed check "Compressor (made-up)" of ${today}: Safety valve stuck (made-up). (Tag hung on the machine)` })
    expect(step.machine).toMatchObject({ status: 'DO_NOT_USE', locked: true })
    expect(step.plan.nextDueOn).toBe(addInterval(today, 18, 'MONTH'))
    const job = (await admin(`SELECT "checkResultId", source::text AS source FROM "MaintenanceJob" WHERE id = $1`, [step.job.id]))[0]!
    expect(job).toEqual({ checkResultId: step.result.id, source: 'STATUTORY_CHECK' })
    expect((await outbox('machine_check.recorded', step.result.id))[0]!.payload).toMatchObject({ jobId: step.job.id, lockRequestId: step.lock.id })
    expect((await outbox('maintenance_request.locked', step.lock.id)).map((row) => row.payload)).toEqual([expect.objectContaining({ hazardReport: true, by: 'OFFICE' })])
    expect((await outbox('maintenance_job.created', step.job.id))[0]!.payload).toMatchObject({ source: 'STATUTORY_CHECK', requestIds: [step.lock.id] })
    // Only a technician's sign-safe frees it (H1): the request waits for it.
    expect((await ok('manager', 'GET', `/plant/requests/${step.lock.id}`)).canSignSafe).toBe(false)
    // Afterwards: no second open job of the result, no second lock of a locked machine.
    expect(refusalOf(await no('manager', 'POST', `/plant/checks/results/${step.result.id}/job`, {}, 409))).toBe('refusal/JOB_EXISTS')
    expect(refusalOf(await no('manager', 'POST', `/plant/checks/results/${step.result.id}/lock`, {}, 409))).toBe('refusal/LOCKED_ALREADY')
  })

  it("makes the job of a seeded failed check afterwards only when it has none open, and never locks a machine locked already", async () => {
    expect(refusalOf(await no('manager', 'POST', `/plant/checks/results/${care.resultIds.failed}/job`, {}, 409))).toBe('refusal/JOB_EXISTS')
    expect(refusalOf(await no('manager', 'POST', `/plant/checks/results/${care.resultIds.failed}/lock`, {}, 409))).toBe('refusal/LOCKED_ALREADY')
    expect(refusalOf(await no('manager', 'POST', `/plant/checks/results/${passed.id}/job`, {}, 409))).toBe('refusal/NO_JOB_FOR_PASSED')
    const record = await ok('manager', 'GET', `/plant/checks/results/${care.resultIds.failed}`)
    expect(record).toMatchObject({ canMakeJob: false, canLock: false, machine: { locked: true }, result: { jobs: [{ id: care.jobIds.fromCheck }] } })
    // A remarked check on the sewing machine: the job afterwards, CORRECTIVE · P2, no lock.
    const remarked = (await ok('checker', 'POST', '/plant/checks/results', { planId: sewPlan.id, performedOn: today, outcome: 'PASSED_WITH_REMARKS', remarks: 'Label worn (made-up).', performedBy: 'Made-up Inspections S.r.l.' }, 201)).result
    const step = await ok('manager', 'POST', `/plant/checks/results/${remarked.id}/job`, { priority: 'P3' }, 201)
    expect(step.job).toMatchObject({ type: 'CORRECTIVE', priority: 'P3', source: 'STATUTORY_CHECK' })
    expect(step.lock).toBeNull()
    expect(refusalOf(await no('manager', 'POST', `/plant/checks/results/${remarked.id}/lock`, {}, 409))).toBe('refusal/LOCK_NEEDS_FAILED')
  })
})

describe('the report: a file of the result, and the check report PDF', () => {
  it('uploads the body\'s report as a CHECK_REPORT kept until the result is; the register finds it', async () => {
    const missingBefore = (await ok('viewer', 'GET', `/plant/checks/counts`)).tiles.REPORTS_MISSING
    const bytes = Buffer.from(`%PDF-1.4 made-up report ${run}`)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const corrected = (await ok('viewer', 'GET', `/plant/checks/results/${passed.id}`)).result.correctedBy.id
    expect(await no('viewer', 'POST', `/plant/checks/results/${corrected}/reports`, { kind: 'DOCUMENT', originalName: 'report.pdf', contentType: 'application/pdf', sizeBytes: bytes.length, sha256 }, 403)).toMatchObject({ code: 'forbidden' })
    const announced = await ok('checker', 'POST', `/plant/checks/results/${corrected}/reports`, { kind: 'DOCUMENT', originalName: 'report.pdf', contentType: 'application/pdf', sizeBytes: bytes.length, sha256 }, 201)
    expect((await app.inject({ method: 'PUT', url: announced.upload.url, headers: announced.upload.headers, payload: bytes })).statusCode).toBe(200)
    const file = (await ok('checker', 'POST', `/plant/checks/results/${corrected}/reports/${announced.file.id}/complete`)).file
    expect(file).toMatchObject({ status: 'AVAILABLE', kind: 'DOCUMENT', visibility: ['OFFICE'], recordType: 'MachineCheckResult', recordId: corrected })
    const row = (await admin(`SELECT category::text AS category, "retainUntil" FROM "StoredFile" WHERE id = $1`, [file.id]))[0]!
    expect(row.category).toBe('CHECK_REPORT')
    expect(row.retainUntil).not.toBeNull()
    const result = (await ok('viewer', 'GET', `/plant/checks/results/${corrected}`)).result
    expect(result).toMatchObject({ reportOnFile: true, reports: [{ id: file.id, originalName: 'report.pdf' }] })
    expect((await ok('viewer', 'GET', `/plant/checks/counts`)).tiles.REPORTS_MISSING).toBe(missingBefore - 1)
    const missing = await ok('viewer', 'GET', `/plant/checks/results?reportMissing=true&machineId=${sewMachine}`)
    expect(missing.results.map((entry: Json) => entry.id)).not.toContain(corrected)
    expect((await ok('viewer', 'GET', `/plant/checks/results/${corrected}/reports/${file.id}/download`)).download.method).toBe('GET')
    // A seeded correction keeps the report of the result it corrects.
    expect((await ok('viewer', 'GET', `/plant/checks/results/${care.resultIds.correction}`)).result).toMatchObject({ reports: [], reportOnFile: true })
  })

  it('previews the check report and keeps it as a version: the same contents give it back unchanged', async () => {
    const preview = await call('viewer', 'GET', `/plant/checks/results/${care.resultIds.failed}/pdf?language=en`)
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.headers['content-type']).toContain('application/pdf')
    expect(preview.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
    const kept = await ok('checker', 'POST', `/plant/checks/results/${care.resultIds.failed}/pdf`, { language: 'en' }, 201)
    expect(kept).toMatchObject({ made: true, document: { version: 1, language: 'en' } })
    const again = await ok('checker', 'POST', `/plant/checks/results/${care.resultIds.failed}/pdf`, { language: 'en' }, 201)
    expect(again).toMatchObject({ made: false, document: { id: kept.document.id, version: 1 } })
    const documents = await admin(`SELECT kind::text AS kind, "recordType", "fileId" FROM "GeneratedDocument" WHERE "tenantId" = $1 AND "recordId" = $2`, [A.tenant, care.resultIds.failed])
    expect(documents).toEqual([{ kind: 'CHECK_REPORT', recordType: 'MachineCheckResult', fileId: kept.document.fileId }])
    expect(await no('viewer', 'POST', `/plant/checks/results/${care.resultIds.failed}/pdf`, {}, 403)).toMatchObject({ code: 'forbidden' })
  })
})

describe('the page\'s reads', () => {
  it('reads the register newest first with a cursor, by outcome and period', async () => {
    const page = await ok('viewer', 'GET', `/plant/checks/results?machineId=${pressMachine}&limit=2`)
    expect(page.results.map((row: Json) => row.performedOn)).toEqual(['2026-11-20', '2026-08-21'])
    const rest = await ok('viewer', 'GET', `/plant/checks/results?machineId=${pressMachine}&limit=2&cursor=${encodeURIComponent(page.nextCursor)}`)
    expect(rest.results.map((row: Json) => row.id)).toEqual([care.resultIds.passed])
    expect((await ok('viewer', 'GET', `/plant/checks/results?machineId=${pressMachine}&inForce=true`)).results.map((row: Json) => row.id)).toEqual([care.resultIds.failed, care.resultIds.correction])
    expect((await ok('viewer', 'GET', `/plant/checks/results?outcome=FAILED&from=2026-11-01&to=2026-11-30&machineId=${pressMachine}`)).results.map((row: Json) => row.id)).toEqual([care.resultIds.failed])
    expect((await no('viewer', 'GET', `/plant/checks/results?from=2026-11-30&to=2026-11-01`, undefined, 400)).issues[0].path).toBe('query/to')
  })

  it('draws the calendar: next due dates, later checks by the interval, checks done', async () => {
    const calendar = await ok('viewer', 'GET', `/plant/checks/calendar?from=2026-08-01&to=2027-08-31&siteId=${A.siteA1}`)
    const press = calendar.chips.filter((chip: Json) => chip.machine.id === pressMachine)
    expect(press.filter((chip: Json) => chip.kind === 'DONE').map((chip: Json) => [chip.date, chip.outcome])).toEqual([
      ['2026-08-21', 'PASSED'],
      ['2026-11-20', 'FAILED'],
    ])
    expect(press.find((chip: Json) => chip.kind === 'DUE' && chip.checkType.code === 'PRESS_GUARDS')).toMatchObject({ date: '2027-02-20', planId: care.planIds.guards })
    expect(press.filter((chip: Json) => chip.kind === 'PROJECTED' && chip.checkType.code === 'PRESS_GUARDS').map((chip: Json) => chip.date)).toEqual(['2027-05-20', '2027-08-20'])
    expect(press.find((chip: Json) => chip.checkType.code === 'EARTHING')).toMatchObject({ kind: 'DUE', date: '2027-03-15', outsideBody: null })
    expect((await no('viewer', 'GET', `/plant/checks/calendar?from=2026-01-01&to=2027-06-01`, undefined, 400)).issues[0].path).toBe('query/to')
  })

  it('ends a plan with the reason: its results stay, it takes no more', async () => {
    const plan = (await ok('viewer', 'GET', `/plant/checks/plans/${sewPlan.id}`)).plan
    const ended = (await ok('checker', 'POST', `/plant/checks/plans/${sewPlan.id}/end`, { version: plan.version, reason: 'Machine sold (made-up).' })).plan
    expect(ended).toMatchObject({ status: 'ENDED', endedReason: 'Machine sold (made-up).' })
    const record = await ok('viewer', 'GET', `/plant/checks/plans/${sewPlan.id}`)
    expect(record).toMatchObject({ canManage: false, canRecord: false })
    expect(record.results.length).toBeGreaterThanOrEqual(3)
    expect(refusalOf(await no('checker', 'POST', '/plant/checks/results', { planId: sewPlan.id, performedOn: today, outcome: 'PASSED', performedBy: 'x' }, 409))).toBe('refusal/PLAN_ENDED')
  })
})
