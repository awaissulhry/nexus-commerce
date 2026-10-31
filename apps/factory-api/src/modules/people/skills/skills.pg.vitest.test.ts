import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SkillKind, SkillLevel } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { addDays } from '@nexus/factory-domain/people/employees/rules'
import { SKILL_KINDS, SKILL_LEVELS } from '@nexus/factory-domain/people/skills/rules'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedProduction, type ProductionSeed } from '../../../../../../packages/factory-db/seed/production'
import { seed as seedSkills, type SkillsSeed } from '../../../../../../packages/factory-db/seed/skills'
import { seed as seedPeople, type PeopleSeed } from '../../../../../../packages/factory-db/seed/people'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, withContextClient, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { assertAssignable, qualificationCheck, qualificationGuard } from './check'

/**
 * Skills and machine authorisations (B-W2b-39; MES-241, MES-244, MES-246, MES-024; MES-281 a person decides) on the local
 * stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level
 * security, the floor's column grants and the …_people_w2b_guards triggers are real), the factory-db seeds of one tenant
 * up to the skills (E1 can sew, is an expert on the post-bed and was a cutting trainee signed off with E2 as the trainer;
 * E2 trains sewing; E3 (agency) is a sewing trainee; E5 left; EB1 on plant B1; authorisations E1 post-bed, E2
 * walking-foot until 2027-02-01, EB1 lockstitch; the cutting station CUT-01 of A1 has a clicking press and a cutting
 * table, the sewing station SEW-01 a lockstitch), the real office sign-in with two-factor for the sign-off, and test
 * sessions for the walls. Every person is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/people/skills`.
 */

let h: Harness
let app: FastifyInstance
let people: PeopleSeed
let skills: SkillsSeed
let production: ProductionSeed

const NS = 'w2b39-skills'
const idOf = (key: string): string => seedUuid(NS, key)
const T = {
  tenant: idOf('tenant'),
  companyA: idOf('company:A'),
  companyB: idOf('company:B'),
  siteA1: idOf('site:A1'),
  siteB1: idOf('site:B1'),
  lineA1: idOf('site:A1:line:L1'),
  member: idOf('user:member'),
  operator: idOf('worker:A1:operator'),
  lead: idOf('worker:A1:lead'),
  device: idOf('device:A1:cutting'),
  stationCut: idOf('site:A1:station:CUT-01'),
  stationSew: idOf('site:A1:station:SEW-01'),
  operationCut: idOf('product:operation:CUT'),
  operationSew: idOf('product:operation:SEW'),
  operationPack: idOf('product:operation:PACK'),
}

const MANAGE: Permission[] = ['people.skills.view', 'people.skills.manage', 'people.authorisations.manage']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (grants: Grant[], actorId: string = newId()): SessionContext => ({ audience: 'office', tenantId: T.tenant, actorId, grants })
const managerId = newId()
const SESSIONS: Record<string, SessionContext> = {
  manager: office([grant(MANAGE)], managerId),
  viewer: office([grant(['people.skills.view'])]),
  companyB: office([grant(MANAGE, [T.companyB])]),
  // The seed member's account is E2's record: never a decision about yourself.
  member: office([grant(MANAGE)], T.member),
  supervisor: office([grant([...(templateOf('floor_supervisor')?.permissions ?? [])])]),
  floorOperator: { audience: 'floor', tenantId: T.tenant, actorId: T.operator, siteId: T.siteA1, deviceId: T.device, grants: [grant(['floor.work'], [T.companyA], [T.siteA1])] },
  floorLead: { audience: 'floor', tenantId: T.tenant, actorId: T.lead, siteId: T.siteA1, deviceId: T.device, grants: [grant(['floor.work', 'floor.lead'], [T.companyA], [T.siteA1])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH'
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const run = randomBytes(4).toString('hex')
let keys = 0
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `t-${run}-${++keys}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const pathsOf = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
const today = () => businessDate(new Date())
const auditOf = (action: string) => admin('SELECT "recordType", "recordId", "actorId", before, after, reason FROM "AuditLog" WHERE action = $1 ORDER BY at, id', [action])
const eventsOf = (type: string) => admin('SELECT payload FROM "OutboxEvent" WHERE type = $1 ORDER BY "occurredAt", id', [type])
const levelOf = (employeeId: string, skillId: string) => admin('SELECT id, level, since::text, "traineeUntil"::text, "signedOffOn"::text, "trainerEmployeeId", "assessedById", "removedAt", version FROM "EmployeeSkill" WHERE "employeeId" = $1 AND "skillId" = $2 AND "removedAt" IS NULL', [employeeId, skillId])

let keeper: { browser: Browser; secret: string }

beforeAll(async () => {
  h = await startHarness('people_skills')
  await seedCore({ db: h.database, namespace: NS })
  production = await seedProduction({ db: h.database, namespace: NS })
  people = await seedPeople({ db: h.database, namespace: NS })
  skills = await seedSkills({ db: h.database, namespace: NS })
  // The keeper of the matrix signs trainees off: a custom role with the skills permissions, with two-factor.
  const tenant: TestTenant = { id: T.tenant, slug: NS, companies: [{ id: T.companyA, code: 'A' }, { id: T.companyB, code: 'B' }] }
  const user = await addUser(h, tenant, { email: 'skills.keeper@example.com' })
  const roleId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T.tenant, actorId: user.id }, async (client) => {
    await client.role.create({ data: { id: roleId, key: 'custom.skills', name: 'Skills keeper', permissions: MANAGE, grains: [], requireMfa: false, audience: 'OFFICE' } })
    await client.roleAssignment.create({ data: { id: newId(), userId: user.id, roleId, allCompanies: true, companyIds: [], siteIds: [], validFrom: new Date('2026-10-01T00:00:00.000Z') } })
  })
  const browser = new Browser(h.app)
  const answer = await browser.signIn(tenant.slug, user.email, user.password)
  if (answer.body.status !== 'signed_in') throw new Error(`sign-in: ${answer.status} ${JSON.stringify(answer.body)}`)
  keeper = { browser, secret: await enrolTotp(h, browser) }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, clock: h.clock, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('the lists of factory-domain', () => {
  it('are the factory-db enums, value for value', () => {
    expect([...SKILL_KINDS].sort()).toEqual(Object.values(SkillKind).sort())
    expect([...SKILL_LEVELS].sort()).toEqual(Object.values(SkillLevel).sort())
  })
})

describe('the skills (MES-241)', () => {
  let qc: Json
  it('lists the active skills in the matrix order; adds a company skill about an operation, renames, archives and restores it', async () => {
    const list = await ok('viewer', 'GET', '/people/skills')
    expect(list.skills.map((skill: Json) => skill.code)).toEqual(['SEED-SK-SEW-ASM', 'SEED-SK-CUT-LEA', 'SEED-SK-POST-BED', 'SEED-SK-WALKING-FOOT', 'SEED-SK-PATTERN'])
    expect(list).toMatchObject({ canManage: false })
    const qcOperation = idOf('product:operation:QC')
    qc = (await ok('manager', 'POST', '/people/skills', { companyId: T.companyA, code: 'a-qc', name: 'Final check', nameI18n: { it: 'Controllo finale' }, kind: 'OPERATION', operationId: qcOperation, sortOrder: 6 }, 201)).skill
    expect(qc).toMatchObject({ code: 'A-QC', companyId: T.companyA, kind: 'OPERATION', operation: { id: qcOperation }, nameI18n: { it: 'Controllo finale' }, status: 'ACTIVE', version: 1 })
    expect(pathsOf(await no('manager', 'POST', '/people/skills', { companyId: T.companyA, code: 'A-QC', name: 'Again', kind: 'GENERAL' }, 409))).toEqual(['refusal/CODE_TAKEN', 'body/code'])
    expect(pathsOf(await no('manager', 'POST', '/people/skills', { code: 'X1', name: 'Wrong', kind: 'MACHINE', operationId: qcOperation }, 400))).toEqual(['body/operationId', 'body/machineClassId'])
    // A skill of the whole group needs a grant over every company.
    expect((await call('companyB', 'POST', '/people/skills', { code: 'GROUP-1', name: 'Group skill', kind: 'GENERAL' })).statusCode).toBe(403)
    const renamed = await ok('manager', 'PATCH', `/people/skills/${qc.id}`, { version: 1, name: 'Final garment check' })
    expect(renamed).toMatchObject({ changed: true, skill: { name: 'Final garment check', version: 2 } })
    expect((await call('manager', 'PATCH', `/people/skills/${qc.id}`, { version: 1, name: 'Stale' })).statusCode).toBe(409)
    const archived = await ok('manager', 'POST', `/people/skills/${qc.id}/archive`, { version: 2 })
    expect(archived).toMatchObject({ changed: true, skill: { status: 'ARCHIVED' } })
    expect((await ok('viewer', 'GET', '/people/skills')).skills.map((skill: Json) => skill.code)).not.toContain('A-QC')
    // An archived skill takes no new level.
    expect(pathsOf(await no('manager', 'POST', '/people/skills/levels', { employeeId: people.employeeIds.e1, skillId: qc.id, level: 'CAN_DO' }, 409))).toEqual(['refusal/SKILL_ARCHIVED', 'body/skillId'])
    qc = (await ok('manager', 'POST', `/people/skills/${qc.id}/restore`, { version: 3 })).skill
    expect(qc.status).toBe('ACTIVE')
    expect((await eventsOf('skill.changed')).map((row) => row.payload.change)).toEqual(['CREATED', 'EDITED', 'ARCHIVED', 'RESTORED'])
    // Company B's keeper does not see company A's skill.
    expect((await ok('companyB', 'GET', '/people/skills')).skills.map((skill: Json) => skill.code)).not.toContain('A-QC')
  })

  it('a level is a person\'s judgement: set, the same level writes nothing, a change names who assessed it again (MES-281)', async () => {
    const set = await ok('manager', 'POST', '/people/skills/levels', { employeeId: people.employeeIds.e1, skillId: qc.id, level: 'CAN_DO' })
    expect(set).toMatchObject({ changed: true, level: { level: 'CAN_DO', since: today(), trainee: 'NONE', version: 1 } })
    const same = await ok('manager', 'POST', '/people/skills/levels', { employeeId: people.employeeIds.e1, skillId: qc.id, level: 'CAN_DO', version: 1 })
    expect(same).toMatchObject({ changed: false })
    expect(pathsOf(await no('manager', 'POST', '/people/skills/levels', { employeeId: people.employeeIds.e1, skillId: qc.id, level: 'EXPERT' }, 409))).toEqual([])
    expect((await call('manager', 'POST', '/people/skills/levels', { employeeId: people.employeeIds.e1, skillId: qc.id, level: 'EXPERT', version: 9 })).statusCode).toBe(409)
    const [before] = await levelOf(people.employeeIds.e1, qc.id)
    const changed = await ok('manager', 'POST', '/people/skills/levels', { employeeId: people.employeeIds.e1, skillId: qc.id, level: 'EXPERT', version: 1 })
    expect(changed).toMatchObject({ changed: true, level: { level: 'EXPERT', version: 2 } })
    const [after] = await levelOf(people.employeeIds.e1, qc.id)
    expect(after!.assessedById).toBe(managerId)
    expect(after!.version).toBe(before!.version + 1)
    expect((await auditOf('people.setSkillLevel')).map((row) => [row.before?.level ?? null, row.after.level])).toEqual([[null, 'CAN_DO'], ['CAN_DO', 'EXPERT']])
    expect((await eventsOf('employee_skill.changed')).map((row) => row.payload.change)).toEqual(['SET', 'CHANGED'])
    // A level is held from today or earlier; a person decides about another person; the skill of the person's company.
    expect(pathsOf(await no('manager', 'POST', '/people/skills/levels', { employeeId: people.employeeIds.e2, skillId: skills.skillIds.pattern, level: 'CAN_DO', since: addDays(today(), 1) }, 409))).toEqual(['refusal/SINCE_IN_FUTURE', 'body/since'])
    expect(pathsOf(await no('member', 'POST', '/people/skills/levels', { employeeId: people.employeeIds.e2, skillId: skills.skillIds.pattern, level: 'EXPERT' }, 409))).toEqual(['refusal/SELF_DECISION'])
    expect(pathsOf(await no('manager', 'POST', '/people/skills/levels', { employeeId: people.employeeIds.eb1, skillId: qc.id, level: 'CAN_DO' }, 409))).toEqual(['refusal/SKILL_OTHER_COMPANY', 'body/skillId'])
    expect(pathsOf(await no('manager', 'POST', '/people/skills/levels', { employeeId: people.employeeIds.e5, skillId: skills.skillIds.pattern, level: 'CAN_DO' }, 409))).toEqual(['refusal/EMPLOYEE_LEFT', 'body/employeeId'])
    // The walls: a viewer may not write, company B does not reach company A's people.
    expect((await call('viewer', 'POST', '/people/skills/levels', { employeeId: people.employeeIds.e1, skillId: skills.skillIds.pattern, level: 'CAN_DO' })).statusCode).toBe(403)
    expect((await call('companyB', 'POST', '/people/skills/levels', { employeeId: people.employeeIds.e1, skillId: skills.skillIds.pattern, level: 'CAN_DO' })).statusCode).toBe(404)
  })

  it('a trainee period is given and moved, never cleared while open; a removed level stays on record and a new one may follow', async () => {
    const until = addDays(today(), 30)
    const trainee = await ok('manager', 'POST', '/people/skills/levels', { employeeId: people.employeeIds.e2, skillId: skills.skillIds.pattern, level: 'LEARNING', traineeUntil: until })
    expect(trainee.level).toMatchObject({ level: 'LEARNING', trainee: 'TRAINEE', traineeUntil: until })
    const moved = await ok('manager', 'POST', '/people/skills/levels', { employeeId: people.employeeIds.e2, skillId: skills.skillIds.pattern, level: 'LEARNING', traineeUntil: addDays(until, 7), version: 1 })
    expect(moved.level).toMatchObject({ traineeUntil: addDays(until, 7), version: 2 })
    expect(pathsOf(await no('manager', 'POST', '/people/skills/levels', { employeeId: people.employeeIds.e2, skillId: skills.skillIds.pattern, level: 'LEARNING', traineeUntil: null, version: 2 }, 409))).toEqual(['refusal/TRAINEE_OPEN', 'body/traineeUntil'])
    const removed = await ok('manager', 'POST', `/people/skills/levels/${trainee.level.id}/remove`, { version: 2, reason: 'Moved to the cutting room (made up)' })
    expect(removed.level).toMatchObject({ removeReason: 'Moved to the cutting room (made up)' })
    expect(removed.level.removedAt).not.toBeNull()
    expect(pathsOf(await no('manager', 'POST', `/people/skills/levels/${trainee.level.id}/remove`, { version: 3, reason: 'Again' }, 409))).toEqual(['refusal/LEVEL_REMOVED'])
    const again = await ok('manager', 'POST', '/people/skills/levels', { employeeId: people.employeeIds.e2, skillId: skills.skillIds.pattern, level: 'CAN_DO' })
    expect(again.level.id).not.toBe(trainee.level.id)
    expect((await admin('SELECT count(*)::int AS n FROM "EmployeeSkill" WHERE "employeeId" = $1 AND "skillId" = $2', [people.employeeIds.e2, skills.skillIds.pattern]))[0]!.n).toBe(2)
  })
})

describe('trainees and their sign-off (MES-244)', () => {
  it('a sign-off is a signing act with a Trainer of the skill; it ends the trainee status once and may raise the level', async () => {
    const levelId = skills.levelIds.e3Trainee
    const body = { version: 1, trainerEmployeeId: people.employeeIds.e2, level: 'CAN_DO' }
    h.clock.advance(6 * 60_000)
    const noCode = await keeper.browser.post(`/people/skills/levels/${levelId}/sign-off`, body)
    expect(noCode.status).toBe(403)
    expect(noCode.body.error.issues?.[0]?.path).toBe('stepUp')
    await stepUp(h, keeper.browser, keeper.secret)
    // E1 can do sewing but is no Trainer of it.
    const notTrainer = await keeper.browser.post(`/people/skills/levels/${levelId}/sign-off`, { ...body, trainerEmployeeId: people.employeeIds.e1 })
    expect(notTrainer.status).toBe(409)
    expect(notTrainer.body.error.issues.map((issue: Json) => issue.path)).toEqual(['refusal/TRAINER_NOT_TRAINER', 'body/trainerEmployeeId'])
    const signed = await keeper.browser.post(`/people/skills/levels/${levelId}/sign-off`, body)
    expect(signed.status, JSON.stringify(signed.body)).toBe(200)
    expect(signed.body.level).toMatchObject({ level: 'CAN_DO', trainee: 'SIGNED_OFF', signedOffOn: today(), trainer: { employeeId: people.employeeIds.e2, name: 'Seed Employee Two' } })
    const [row] = await levelOf(people.employeeIds.e3, skills.skillIds.sew)
    expect(row).toMatchObject({ signedOffOn: today(), trainerEmployeeId: people.employeeIds.e2, level: 'CAN_DO' })
    const again = await keeper.browser.post(`/people/skills/levels/${levelId}/sign-off`, { ...body, version: row!.version })
    expect(again.status).toBe(409)
    expect(again.body.error.issues.map((issue: Json) => issue.path)).toEqual(['refusal/SIGNED_OFF'])
    expect((await eventsOf('employee_skill.changed')).at(-1)!.payload).toMatchObject({ levelId, change: 'SIGNED_OFF', trainee: false, level: 'CAN_DO' })
    // A level with no trainee period has nobody to sign off.
    await stepUp(h, keeper.browser, keeper.secret)
    const notTrainee = await keeper.browser.post(`/people/skills/levels/${skills.levelIds.e1Sew}/sign-off`, { version: 1 })
    expect(notTrainee.body.error.issues.map((issue: Json) => issue.path)).toEqual(['refusal/NOT_A_TRAINEE'])
  })
})

describe('machine authorisations (MES-246)', () => {
  const pressClass = idOf('plant:class:CLICKING_PRESS')
  it('authorises a person on a class of machine from today; one in force; an ended one is closed by the new one; revoked is final', async () => {
    const first = await ok('manager', 'POST', '/people/skills/authorisations', { employeeId: people.employeeIds.e1, machineClassId: pressClass }, 201)
    expect(first).toMatchObject({ words: 'Can work on Clicking press machines from today.', authorisation: { state: 'AUTHORISED', authorisedOn: today(), validUntil: null, machineClass: { code: 'CLICKING_PRESS' } } })
    expect(pathsOf(await no('manager', 'POST', '/people/skills/authorisations', { employeeId: people.employeeIds.e1, machineClassId: pressClass }, 409))).toEqual(['refusal/AUTHORISATION_OPEN', 'body/machineClassId'])
    // E3 had one that ended yesterday (made up, written as the office would).
    const endedId = newId()
    await h.database.withScope({ audience: 'office', tenantId: T.tenant, actorId: newId() }, (client) =>
      client.machineAuthorisation.create({ data: { id: endedId, siteId: T.siteA1, employeeId: people.employeeIds.e3, machineClassId: pressClass, authorisedOn: new Date(`${addDays(today(), -30)}T00:00:00.000Z`), validUntil: new Date(`${addDays(today(), -1)}T00:00:00.000Z`), authorisedById: newId() } }),
    )
    const renewed = await ok('manager', 'POST', '/people/skills/authorisations', { employeeId: people.employeeIds.e3, machineClassId: pressClass, validUntil: addDays(today(), 90) }, 201)
    expect(renewed.authorisation).toMatchObject({ state: 'AUTHORISED', validUntil: addDays(today(), 90) })
    const [closed] = await admin('SELECT "revokedAt", "revokeReason" FROM "MachineAuthorisation" WHERE id = $1', [endedId])
    expect(closed!.revokeReason).toBe(`Ended on ${addDays(today(), -1)}: authorised again from ${today()}.`)
    const shorter = await ok('manager', 'POST', `/people/skills/authorisations/${renewed.authorisation.id}/valid-until`, { version: 1, validUntil: addDays(today(), 10) })
    expect(shorter.authorisation).toMatchObject({ validUntil: addDays(today(), 10), version: 2 })
    expect(pathsOf(await no('manager', 'POST', `/people/skills/authorisations/${renewed.authorisation.id}/valid-until`, { version: 2, validUntil: addDays(today(), -1) }, 400))).toEqual(['body/validUntil'])
    const revoked = await ok('manager', 'POST', `/people/skills/authorisations/${renewed.authorisation.id}/revoke`, { version: 2, reason: 'Hand injury risk retraining (made up)' })
    expect(revoked.authorisation).toMatchObject({ state: 'REVOKED', revokeReason: 'Hand injury risk retraining (made up)' })
    expect(pathsOf(await no('manager', 'POST', `/people/skills/authorisations/${renewed.authorisation.id}/valid-until`, { version: 3, validUntil: null }, 409))).toEqual(['refusal/AUTHORISATION_REVOKED'])
    expect((await eventsOf('machine_authorisation.changed')).map((row) => row.payload.change)).toEqual(['AUTHORISED', 'ENDED', 'AUTHORISED', 'VALIDITY_CHANGED', 'REVOKED'])
    expect((await auditOf('people.authoriseMachine')).every((row) => row.recordType === 'MachineAuthorisation')).toBe(true)
    // Never yourself, never another company's person, never without the right.
    expect(pathsOf(await no('member', 'POST', '/people/skills/authorisations', { employeeId: people.employeeIds.e2, machineClassId: pressClass }, 409))).toEqual(['refusal/SELF_DECISION'])
    expect((await call('companyB', 'POST', '/people/skills/authorisations', { employeeId: people.employeeIds.e1, machineClassId: pressClass })).statusCode).toBe(404)
    expect((await call('viewer', 'POST', '/people/skills/authorisations', { employeeId: people.employeeIds.e2, machineClassId: pressClass })).statusCode).toBe(403)
  })
})

describe('the qualification check (MES-024, MES-246)', () => {
  it('dispatch\'s pre-check: qualified, not qualified (a missing skill warns by the default rule), a kept class holds without its authorisation', async () => {
    // E1 at the cutting station on the cutting operation: signed off in cutting, authorised on the press (kept at A1 now).
    const e1 = (await ok('viewer', 'GET', `/people/skills/check?employeeId=${people.employeeIds.e1}&workOrderOperationId=${production.operationIds.cut}&stationId=${T.stationCut}`)).check
    expect(e1).toMatchObject({ outcome: 'QUALIFIED', decision: 'ALLOW', person: { name: 'Seed Employee One' }, operation: { code: 'SEED-CUT-LEA', workOrderOperationId: production.operationIds.cut }, rule: { mode: 'WARN', isDefault: true } })
    expect(e1.machines.map((machine: Json) => machine.machineClass.code).sort()).toEqual(['CLICKING_PRESS', 'CUTTING_TABLE'])
    expect(e1.requirements.filter((requirement: Json) => requirement.kind === 'AUTHORISATION').map((requirement: Json) => [requirement.code, requirement.state])).toEqual(
      expect.arrayContaining([['CLICKING_PRESS', 'AUTHORISED'], ['CUTTING_TABLE', 'NOT_KEPT']]),
    )
    // E2 there: no cutting level (WARN) and no press authorisation (always held, never overridden).
    const e2 = (await ok('viewer', 'GET', `/people/skills/check?employeeId=${people.employeeIds.e2}&operationId=${T.operationCut}&stationId=${T.stationCut}`)).check
    expect(e2).toMatchObject({ outcome: 'NOT_QUALIFIED', decision: 'HOLD', overridable: false })
    expect(e2.findings.map((finding: Json) => [finding.code, finding.mode, finding.overridable])).toEqual([['NO_SKILL', 'WARN', true], ['NOT_AUTHORISED', 'STRICT', false]])
    // E2 on sewing at the sewing station: a Trainer; the lockstitch is kept at no site of company A.
    expect((await ok('viewer', 'GET', `/people/skills/check?employeeId=${people.employeeIds.e2}&operationId=${T.operationSew}&stationId=${T.stationSew}`)).check).toMatchObject({ outcome: 'QUALIFIED', decision: 'ALLOW' })
    // Packing keeps no skill: nothing to check.
    expect((await ok('viewer', 'GET', `/people/skills/check?employeeId=${people.employeeIds.e2}&operationId=${T.operationPack}`)).check).toMatchObject({ outcome: 'NOT_CHECKED', decision: 'ALLOW' })
    // A floor worker by id; the walls; one person, named once.
    expect((await ok('viewer', 'GET', `/people/skills/check?workerId=${T.operator}&operationId=${T.operationSew}`)).check).toMatchObject({ person: { employeeId: people.employeeIds.e1, workerId: T.operator }, outcome: 'QUALIFIED' })
    expect((await call('companyB', 'GET', `/people/skills/check?employeeId=${people.employeeIds.e1}&operationId=${T.operationSew}`)).statusCode).toBe(404)
    expect((await call('viewer', 'GET', `/people/skills/check?employeeId=${people.employeeIds.e1}&workerId=${T.operator}&operationId=${T.operationSew}`)).statusCode).toBe(400)
  })

  it('dispatch assigns with it: ALLOW, WARN with a reason, HOLD refused in words; the tablet\'s guard', async () => {
    const context = { audience: 'office' as const, tenantId: T.tenant, actorId: newId(), grants: [grant(MANAGE)], requestId: newId() }
    await withContextClient(h.database, context, async (db) => {
      const warn = await qualificationCheck(db, { employeeId: people.employeeIds.e2, operationId: T.operationCut })
      expect(warn.decision).toBe('WARN')
      expect(() => assertAssignable(warn, '')).toThrow(/Give the reason to assign anyway/)
      expect(assertAssignable(warn, 'Covers the cutting room today (made up)')).toEqual({ reason: 'Covers the cutting room today (made up)', codes: ['NO_SKILL'] })
      expect(qualificationGuard(warn)).toMatchObject({ mode: 'WARN', overridable: false })
      const held = await qualificationCheck(db, { employeeId: people.employeeIds.e2, operationId: T.operationCut, stationId: T.stationCut })
      let refusal: Json | null = null
      try {
        assertAssignable(held, 'any')
      } catch (error) {
        refusal = error as Json
      }
      expect(refusal?.issues?.[0]?.path).toBe('refusal/NOT_AUTHORISED')
      expect(qualificationGuard(held)).toMatchObject({ mode: 'STRICT', overridable: false })
      expect(assertAssignable(await qualificationCheck(db, { employeeId: people.employeeIds.e1, operationId: T.operationSew }), null)).toBeNull()
    })
  })

  it('the tablet: the signed-in worker at the device\'s station, in the floor\'s own scope (floor names only); a team leader checks another worker', async () => {
    const mine = await ok('floorOperator', 'GET', `/people/skills/floor/check?workOrderOperationId=${production.operationIds.cut}`)
    expect(mine).toMatchObject({ stationId: T.stationCut, guard: null, check: { outcome: 'QUALIFIED', person: { name: 'Seed Worker A1-1', workerId: T.operator } } })
    const lead = await ok('floorLead', 'GET', `/people/skills/floor/check?workOrderOperationId=${production.operationIds.cut}`)
    expect(lead).toMatchObject({ check: { decision: 'HOLD', person: { name: 'Seed Worker A1-2' } }, guard: { mode: 'STRICT', overridable: false } })
    expect((await ok('floorLead', 'GET', `/people/skills/floor/check?workerId=${T.operator}&operationId=${T.operationCut}`)).check.person.workerId).toBe(T.operator)
    expect((await call('floorOperator', 'GET', `/people/skills/floor/check?workerId=${T.lead}&operationId=${T.operationCut}`)).statusCode).toBe(403)
    expect((await call('viewer', 'GET', `/people/skills/floor/check?operationId=${T.operationCut}`)).statusCode).toBe(403)
  })

  it('the loan dialog: "Can do n of m operations on line L1"', async () => {
    const line = await ok('viewer', 'GET', `/people/skills/line-check?employeeId=${people.employeeIds.e1}&lineId=${T.lineA1}`)
    expect(line).toMatchObject({ line: { code: 'L1' }, kept: 1, canDo: 1, message: expect.stringMatching(/^Can do 1 of 1 operations on line L1/) })
    expect((await ok('viewer', 'GET', `/people/skills/line-check?employeeId=${people.employeeIds.e4}&lineId=${T.lineA1}`)).canDo).toBe(0)
    expect((await call('companyB', 'GET', `/people/skills/line-check?employeeId=${people.employeeIds.e1}&lineId=${T.lineA1}`)).statusCode).toBe(404)
  })
})

describe('the matrix, a person\'s skills and one cell (MES-241)', () => {
  it('rows are the active people grouped line › team, cells the levels and authorisations in force; tiles count cells; nothing ranks people', async () => {
    const matrix = await ok('viewer', 'GET', '/people/skills/matrix')
    expect(matrix.rows.map((row: Json) => row.name)).toEqual(expect.arrayContaining(['Seed Employee One', 'Seed Employee Two', 'Seed Agency Worker', 'Seed Employee B One']))
    expect(matrix.rows.map((row: Json) => row.name)).not.toContain('Seed Former Employee')
    const e1 = matrix.rows.find((row: Json) => row.employeeId === people.employeeIds.e1)
    expect(e1.levels.map((cell: Json) => cell.skillId)).toEqual(expect.arrayContaining([skills.skillIds.sew, skills.skillIds.cut, skills.skillIds.postBed]))
    expect(e1.authorisations.map((cell: Json) => cell.state)).toEqual(['AUTHORISED', 'AUTHORISED'])
    expect(matrix.machineClasses.find((machineClass: Json) => machineClass.code === 'CLICKING_PRESS')).toMatchObject({ keptAtSites: [T.siteA1] })
    expect(Object.keys(matrix.tiles).sort()).toEqual(['authorisationsEnding', 'trainees', 'traineesOverdue'])
    // No per-person figure: a row carries names, its line and team, its cells and what the reader may do.
    for (const row of matrix.rows) expect(Object.keys(row).sort()).toEqual(['authorisations', 'canAuthorise', 'canManage', 'companyId', 'displayName', 'employeeId', 'levels', 'line', 'name', 'siteId', 'team'])
    const team = await ok('viewer', 'GET', `/people/skills/matrix?siteId=${T.siteA1}&teamId=${people.teamIds.a}`)
    expect(team.rows.map((row: Json) => row.team?.code)).toEqual(['L1-A', 'L1-A', 'L1-A'])
    expect((await ok('companyB', 'GET', '/people/skills/matrix')).rows.map((row: Json) => row.name)).toEqual(['Seed Employee B One'])
    const machinesOnly = await ok('viewer', 'GET', '/people/skills/matrix?show=MACHINES')
    expect(machinesOnly.skills).toEqual([])
    expect((await ok('viewer', 'GET', '/people/skills/matrix?q=agency')).rows.map((row: Json) => row.name)).toEqual(['Seed Agency Worker'])
    expect(matrix.rows.find((row: Json) => row.employeeId === people.employeeIds.e1)).toMatchObject({ canManage: false, canAuthorise: false })
    expect((await ok('supervisor', 'GET', '/people/skills/matrix')).rows.find((row: Json) => row.employeeId === people.employeeIds.e1)).toMatchObject({ canManage: true, canAuthorise: true })
  })

  it("the employee record's tab and one cell's history (who decided, when)", async () => {
    const record = await ok('viewer', 'GET', `/people/employees/${people.employeeIds.e3}/skills`)
    expect(record.levels.map((level: Json) => [level.skill.code, level.level, level.trainee])).toEqual([['SEED-SK-SEW-ASM', 'CAN_DO', 'SIGNED_OFF']])
    expect(record.history.authorisations.map((row: Json) => row.revokeReason)).toEqual(expect.arrayContaining([`Ended on ${addDays(today(), -1)}: authorised again from ${today()}.`, 'Hand injury risk retraining (made up)']))
    expect(record.employee).toMatchObject({ name: 'Seed Agency Worker', status: 'ACTIVE' })
    const cell = await ok('viewer', 'GET', `/people/skills/cell?employeeId=${people.employeeIds.e1}&skillId=${(await ok('viewer', 'GET', '/people/skills?status=ALL')).skills.find((skill: Json) => skill.code === 'A-QC').id}`)
    expect(cell.history.map((entry: Json) => entry.action)).toEqual(['people.setSkillLevel', 'people.setSkillLevel'])
    expect(cell.history[0].after).toMatchObject({ level: 'EXPERT' })
    expect((await call('viewer', 'GET', `/people/skills/cell?employeeId=${people.employeeIds.e1}`)).statusCode).toBe(400)
    expect((await call('companyB', 'GET', `/people/employees/${people.employeeIds.e1}/skills`)).statusCode).toBe(404)
  })
})
