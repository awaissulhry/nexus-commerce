import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedPeople, type PeopleSeed } from '../seed/people'
import { seed as seedSkills, type SkillsSeed } from '../seed/skills'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * The people schema (W2b schema wave 4/7, B-W2b-06) beyond the generated isolation tests, on a database built from the
 * migrations and seeded, through the real login and the scoped client, and as the owner (the …_people_w2b_guards rules
 * hold for every login):
 *   - the seed is idempotent; the floor reads its site's people without their names, codes, dates or account, never the
 *     legal gate or a leaver case; the portal reads nothing;
 *   - an employee (agency, left, end date, never deleted, company fixed, the agency an organisation); one office account
 *     per person across the employee and its floor workers (at commit);
 *   - teams: one team and one lead at a time, a membership deleted only before it began, a team archived only when
 *     empty; loans never overlap, only their end moves, deleted only before they begin;
 *   - leavers: one OPEN case per person, DONE only with every step done or skipped, cancelled only until the last day,
 *     closed cases and their steps frozen, a skipped step names who and why;
 *   - people settings (the minimum group size, the rounding, the role keys);
 *   - the legal gate: OFF by default (no row in force), switched on only with the worker notice in force and a stored
 *     impact assessment, one in force per site and purpose, leads only where the basis covers them, frozen once off;
 *   - skills: what a skill is about; a level names who assessed it, again when it changes; a sign-off is set once; a
 *     removed level and a revoked authorisation are frozen but follow the person to another site; one in force each;
 *   - the org tree: an area is archived only without active lines; a line goes only into an active area.
 * The refusals are check_violation (SQLSTATE 23514), read in their words.
 */

const NS = 'people-w2b'
const DENIED = /permission denied/
const UNIQUE = /unique|duplicate key/i
let db: MigratedDatabase
let factory: FactoryDatabase
let core: CoreSeed
let people: PeopleSeed
let skills: SkillsSeed

const key = (name: string): string => seedUuid(NS, name)
const companyA = key('company:A')
const siteA1 = key('site:A1')
const lineA1 = key('site:A1:line:L1')
const tablet = key('device:A1:cutting')
const P1 = key('party:P1')
const P4 = key('party:P4')
const memberId = key('user:member')
const ownerId = key('actor')

const office = (): FactoryScope => ({ audience: 'office', tenantId: core.tenantId, actorId: core.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: core.tenantId, actorId: tablet, siteId: siteA1 })
const partner = (): FactoryScope => ({ audience: 'partner', tenantId: core.tenantId, actorId: randomUUID(), partyId: P1 })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const TABLES = ['OrgArea', 'Employee', 'Team', 'TeamMember', 'LineLoan', 'LeaverCase', 'LeaverStep', 'PeopleSettings', 'PeopleLegalGate', 'Skill', 'EmployeeSkill', 'MachineAuthorisation'] as const
async function counts(): Promise<number[]> {
  const result: number[] = []
  for (const table of TABLES) result.push(Number((await admin(`SELECT count(*) AS n FROM "${table}" WHERE "tenantId" = $1`, [core.tenantId]))[0]!.n))
  return result
}
/** A day as YYYY-MM-DD, `days` from today (UTC; the rules count in Europe/Rome, so the tests keep a margin of days). */
const dayFrom = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)

/** A new ACTIVE employee of company A on plant A1, inserted through the office scope. */
async function newEmployee(extra: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  const row = { firstName: 'Test', lastName: 'Person', displayName: 'Test P.', startDate: '2020-01-06', ...extra }
  const columns = Object.keys(row)
  await run(
    office(),
    `INSERT INTO "Employee" (id, "companyId", "siteId", ${columns.map((column) => `"${column}"`).join(', ')}) VALUES ($1::uuid, $2::uuid, $3::uuid, ${columns.map((column, index) => `$${index + 4}${column === 'startDate' || column === 'endDate' ? '::date' : column.endsWith('Id') ? '::uuid' : ''}`).join(', ')})`,
    id,
    companyA,
    siteA1,
    ...columns.map((column) => (row as Record<string, unknown>)[column]),
  )
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('people_w2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  core = await seedCore({ db: factory, namespace: NS })
  skills = await seedSkills({ db: factory, namespace: NS })
  people = await seedPeople({ db: factory, namespace: NS })
}, 240_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the seed and the walls', () => {
  it('is idempotent: a second run inserts nothing, and no purpose of people data is switched on anywhere', async () => {
    const before = await counts()
    expect(before).toEqual([3, 6, 2, 5, 1, 2, 13, 2, 1, 5, 7, 4])
    await seedSkills({ db: factory, namespace: NS })
    expect(await counts()).toEqual(before)
    expect(await admin('SELECT count(*)::int AS n FROM "PeopleLegalGate" WHERE "switchedOffAt" IS NULL')).toEqual([{ n: 0 }])
    expect(await admin('SELECT count(*)::int AS n FROM "Worker" WHERE "tenantId" = $1 AND "employeeId" IS NOT NULL', [core.tenantId])).toEqual([{ n: 3 }])
  })

  it('lets the floor read its site’s people without their names, codes, dates or account; never the gate or a leaver case', async () => {
    const rows = await sql(floor(), 'SELECT id::text AS id, "displayName", status::text AS status FROM "Employee" ORDER BY "displayName"')
    expect(rows.map((row) => row.displayName)).toEqual(['Seed Agency A1-3', 'Seed Former A1-5', 'Seed Office A-4', 'Seed Worker A1-1', 'Seed Worker A1-2'])
    for (const column of ['firstName', 'lastName', 'employeeCode', 'startDate', 'endDate', 'userId', 'agencyPartyId', 'kind', 'jobRole']) {
      await expect(sql(floor(), `SELECT "${column}" FROM "Employee" LIMIT 1`)).rejects.toThrow(DENIED)
    }
    await expect(sql(floor(), 'SELECT "assessedById" FROM "EmployeeSkill" LIMIT 1')).rejects.toThrow(DENIED)
    await expect(sql(floor(), 'SELECT reason FROM "LineLoan" LIMIT 1')).rejects.toThrow(DENIED)
    expect((await sql(floor(), 'SELECT level::text AS level FROM "EmployeeSkill" WHERE "removedAt" IS NULL')).length).toBe(5)
    for (const table of ['PeopleLegalGate', 'LeaverCase', 'LeaverStep']) await expect(sql(floor(), `SELECT 1 FROM "${table}" LIMIT 1`)).rejects.toThrow(DENIED)
    for (const table of TABLES) await expect(sql(partner(), `SELECT 1 FROM "${table}" LIMIT 1`)).rejects.toThrow(DENIED)
    // The floor writes nothing here.
    await expect(run(floor(), 'UPDATE "Employee" SET "displayName" = "displayName"')).rejects.toThrow(DENIED)
    await expect(run(floor(), 'UPDATE "EmployeeSkill" SET level = level')).rejects.toThrow(DENIED)
  })
})

describe('employees', () => {
  it('keeps an employee to what the work needs, for every login', async () => {
    const e = people.employeeIds
    await expect(newEmployee({ kind: 'AGENCY' })).rejects.toThrow(/names an agency exactly when they are an AGENCY worker/)
    await expect(newEmployee({ kind: 'AGENCY', agencyPartyId: key('party:P2') })).rejects.toThrow(/an agency worker has the contract's end date/)
    await expect(newEmployee({ kind: 'AGENCY', agencyPartyId: P4, endDate: '2027-01-31' })).rejects.toThrow(/the agency of employee .* is an organisation of their company or of the whole group/)
    await expect(newEmployee({ endDate: '2019-12-31' })).rejects.toThrow(/ends \(2019-12-31\) on or after they start/)
    await expect(newEmployee({ status: 'LEFT', endDate: dayFrom(10) })).rejects.toThrow(/is LEFT only once their end date has come/)
    await expect(newEmployee({ firstName: '  ' })).rejects.toThrow(/has a first name, a last name and a name shown on the floor/)
    await expect(newEmployee({ weeklyMinutes: 6000 })).rejects.toThrow(/weekly minutes .* are above 0 and at most 4800/)
    await expect(newEmployee({ locale: 'Italian' })).rejects.toThrow(/is an ISO 639 code/)
    const agency = await newEmployee({ kind: 'AGENCY', agencyPartyId: key('party:P2'), endDate: '2027-01-31' })
    expect(agency).toBeTruthy()
    await expect(run(office(), `UPDATE "Employee" SET "companyId" = $2::uuid WHERE id = $1::uuid`, e.e1, key('company:B'))).rejects.toThrow(/the company and creation of employee .* never change/)
    await expect(run(office(), 'DELETE FROM "Employee" WHERE id = $1::uuid', e.e1)).rejects.toThrow(DENIED)
    await expect(admin('DELETE FROM "Employee" WHERE id = $1', [e.e1])).rejects.toThrow(/is never deleted; a leaver is LEFT/)
    await expect(admin('TRUNCATE "Employee" CASCADE')).rejects.toThrow(/TRUNCATE on "Employee" is refused/)
    // An office account is linked to one employee.
    await expect(run(office(), `UPDATE "Employee" SET "userId" = $2::uuid WHERE id = $1::uuid`, e.e1, memberId)).rejects.toThrow(UNIQUE)
  })

  it('gives one person one office account across their employee record and their floor workers (at commit)', async () => {
    const e = people.employeeIds
    const lead = key('worker:A1:lead')
    // E2 is the seed member's record; its worker naming the owner's account instead is refused when the command commits.
    await expect(run(office(), `UPDATE "Worker" SET "userId" = $2::uuid WHERE id = $1::uuid`, lead, ownerId)).rejects.toThrow(/name different office accounts; one person has one record/)
    // In one transaction both may change, in either order: the employee first, then the worker.
    await as(office(), (client) =>
      client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`UPDATE "Employee" SET "userId" = NULL WHERE id = $1::uuid`, e.e2)
        await tx.$executeRawUnsafe(`UPDATE "Worker" SET "userId" = $2::uuid WHERE id = $1::uuid`, lead, memberId)
        await tx.$executeRawUnsafe(`UPDATE "Employee" SET "userId" = $2::uuid WHERE id = $1::uuid`, e.e2, memberId)
      }),
    )
    await expect(run(office(), `UPDATE "Employee" SET "userId" = $2::uuid WHERE id = $1::uuid`, e.e2, ownerId)).rejects.toThrow(/one of their floor workers name different office accounts/)
    await run(office(), `UPDATE "Worker" SET "userId" = NULL WHERE id = $1::uuid`, lead)
    // A worker links only to an employee of its own company (the reference).
    await expect(run(office(), `UPDATE "Worker" SET "employeeId" = $2::uuid WHERE id = $1::uuid`, key('worker:B1:lead'), e.e1)).rejects.toThrow(/foreign key/)
  })
})

describe('teams and loans', () => {
  it('puts a person in one team at a time, a team under one lead at a time, and ends memberships rather than deleting them', async () => {
    const e = people.employeeIds
    const team = people.teamIds.a
    const join = (employeeId: string, since: string, isLead = false) =>
      run(office(), `INSERT INTO "TeamMember" (id, "siteId", "teamId", "employeeId", "isLead", since) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::date)`, randomUUID(), siteA1, team, employeeId, isLead, since)
    await expect(join(e.e1, '2026-01-01')).rejects.toThrow(UNIQUE)
    await expect(join(e.e4, '2026-01-01', true)).rejects.toThrow(UNIQUE)
    await expect(join(e.e5, '2026-08-01')).rejects.toThrow(/joins team .* only while both are active/)
    await expect(join(key('people:employee:B1:1'), '2026-01-01')).rejects.toThrow(/works for another company than team/)
    const [old] = await admin('SELECT id::text AS id FROM "TeamMember" WHERE "employeeId" = $1 AND until IS NULL', [e.e1])
    await expect(run(office(), 'DELETE FROM "TeamMember" WHERE id = $1::uuid', old!.id)).rejects.toThrow(/began on .*; it is ended \(its last day\), never deleted/)
    await expect(run(office(), `UPDATE "TeamMember" SET since = '2020-01-01' WHERE id = $1::uuid`, old!.id)).rejects.toThrow(/keeps its team, person and start/)
    await expect(run(office(), `UPDATE "TeamMember" SET until = '2020-01-01' WHERE id = $1::uuid`, old!.id)).rejects.toThrow(/ends \(2020-01-01\) on or after it starts/)
    // A move: E4 joins from a day ahead, then the mistake is deleted (it has not begun).
    const ahead = dayFrom(10)
    expect(await join(e.e4, ahead)).toBe(1)
    const [planned] = await admin('SELECT id::text AS id FROM "TeamMember" WHERE "employeeId" = $1 AND since = $2::date', [e.e4, ahead])
    await expect(run(office(), `UPDATE "TeamMember" SET "isLead" = true, until = $2::date WHERE id = $1::uuid`, planned!.id, ahead)).rejects.toThrow(/the lead of a team is set on a membership without an end/)
    expect(await run(office(), 'DELETE FROM "TeamMember" WHERE id = $1::uuid', planned!.id)).toBe(1)
    // The team is archived only once nobody is in it.
    await expect(run(office(), `UPDATE "Team" SET status = 'ARCHIVED' WHERE id = $1::uuid`, team)).rejects.toThrow(/still has people in it/)
    await expect(admin('DELETE FROM "Team" WHERE id = $1', [team])).rejects.toThrow(/is archived, never deleted/)
  })

  it('never lets two loans of one person overlap; only the end moves; a loan is deleted only before it begins', async () => {
    const e = people.employeeIds
    // Far from the seeded loan (2026-11-03) and from today: 1000 days ahead.
    const at = (hours: number) => new Date(Date.now() + 1000 * 86_400_000 + hours * 3_600_000).toISOString()
    const lend = (employeeId: string, from: string, to: string, extra = '') =>
      run(
        office(),
        `INSERT INTO "LineLoan" (id, "siteId", "employeeId", "toLineId", "startsAt", "endsAt", reason${extra ? ', "fromLineId"' : ''}) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz, $6::timestamptz, 'Peak on line 1 (test)'${extra ? `, '${extra}'::uuid` : ''})`,
        randomUUID(),
        siteA1,
        employeeId,
        lineA1,
        from,
        to,
      )
    expect(await lend(e.e4, at(48), at(52))).toBe(1)
    await expect(lend(e.e4, at(50), at(54))).rejects.toThrow(/is already lent at that time; two loans of one person never overlap/)
    expect(await lend(e.e4, at(52), at(56))).toBe(1)
    await expect(lend(e.e1, at(60), at(59))).rejects.toThrow(/ends after it starts/)
    await expect(lend(e.e1, at(60), at(64), lineA1)).rejects.toThrow(/goes to another line than the one the person comes from/)
    await expect(lend(e.e5, at(60), at(64))).rejects.toThrow(/is lent only while active/)
    const [planned] = await admin('SELECT id::text AS id FROM "LineLoan" WHERE "employeeId" = $1 AND "startsAt" > now() + interval \'999 days\' ORDER BY "startsAt" LIMIT 1', [e.e4])
    await expect(run(office(), `UPDATE "LineLoan" SET "endsAt" = $2::timestamptz WHERE id = $1::uuid`, planned!.id, at(53))).rejects.toThrow(/never overlap/)
    await expect(run(office(), `UPDATE "LineLoan" SET reason = 'Other' WHERE id = $1::uuid`, planned!.id)).rejects.toThrow(/only its end moves/)
    expect(await run(office(), 'DELETE FROM "LineLoan" WHERE id = $1::uuid', planned!.id)).toBe(1)
    // A loan that has begun is ended earlier, never deleted.
    const begun = randomUUID()
    await admin(`INSERT INTO "LineLoan" (id, "tenantId", "siteId", "employeeId", "toLineId", "startsAt", "endsAt", reason) VALUES ($1, $2, $3, $4, $5, now() - interval '2 hours', now() + interval '2 hours', 'Under way (test)')`, [begun, core.tenantId, siteA1, e.e1, lineA1])
    await expect(run(office(), 'DELETE FROM "LineLoan" WHERE id = $1::uuid', begun)).rejects.toThrow(/has begun; it is ended earlier, never deleted/)
    expect(await run(office(), `UPDATE "LineLoan" SET "endsAt" = now() WHERE id = $1::uuid`, begun)).toBe(1)
  })
})

describe('leavers', () => {
  it('keeps one OPEN case per person, closes it only when every step is done or skipped, then freezes it', async () => {
    const e = people.employeeIds
    const open = people.caseIds.open
    const start = (employeeId: string, lastDay: string) =>
      run(office(), `INSERT INTO "LeaverCase" (id, "employeeId", "lastWorkingDay", "startedAt", "startedById") VALUES ($1::uuid, $2::uuid, $3::date, now(), $4::uuid)`, randomUUID(), employeeId, lastDay, ownerId)
    await expect(start(e.e4, '2026-12-15')).rejects.toThrow(UNIQUE)
    await expect(start(e.e5, '2026-12-15')).rejects.toThrow(/has left; leaver steps start for an active person/)
    await expect(run(office(), `UPDATE "LeaverCase" SET status = 'DONE', "closedAt" = now() WHERE id = $1::uuid`, open)).rejects.toThrow(/done only when every one of its steps is done or skipped/)
    // A skipped step names who and why; the system ticks an automatic step without a person, a person ticks the others.
    const steps = await admin('SELECT id::text AS id, kind::text AS kind FROM "LeaverStep" WHERE "caseId" = $1 AND status = \'OPEN\' ORDER BY seq', [open])
    const byKind = Object.fromEntries(steps.map((step) => [step.kind, step.id as string]))
    await expect(run(office(), `UPDATE "LeaverStep" SET status = 'SKIPPED', "doneAt" = now() WHERE id = $1::uuid`, byKind.EXIT_VISIT)).rejects.toThrow(/SKIPPED \(when, who and why: a person decides\)/)
    await expect(run(office(), `UPDATE "LeaverStep" SET status = 'DONE', "doneAt" = now() WHERE id = $1::uuid`, byKind.WORK_HANDED_OVER)).rejects.toThrow(/DONE \(when, and who unless the system ticked it\)/)
    await expect(run(office(), `UPDATE "LeaverStep" SET kind = 'BADGE_OFF' WHERE id = $1::uuid`, byKind.EXIT_VISIT)).rejects.toThrow(/keeps its case, kind and place/)
    await expect(run(office(), `UPDATE "LeaverStep" SET "recordType" = 'PayrollExport' WHERE id = $1::uuid`, byKind.PAYROLL_FLAGGED)).rejects.toThrow(/by a record type and id, both or neither/)
    await expect(admin('DELETE FROM "LeaverStep" WHERE id = $1', [byKind.EXIT_VISIT])).rejects.toThrow(/is never deleted; a step not needed is SKIPPED/)
    for (const [kind, id] of Object.entries(byKind)) {
      if (kind === 'EXIT_VISIT') await run(office(), `UPDATE "LeaverStep" SET status = 'SKIPPED', "doneAt" = now(), "doneById" = $2::uuid, "skipReason" = 'The health plan asks for none (test)' WHERE id = $1::uuid`, id, ownerId)
      else if (kind === 'WORK_HANDED_OVER') await run(office(), `UPDATE "LeaverStep" SET status = 'DONE', "doneAt" = now(), "doneById" = $2::uuid WHERE id = $1::uuid`, id, ownerId)
      else await run(office(), `UPDATE "LeaverStep" SET status = 'DONE', "doneAt" = now(), "recordType" = 'PayrollExport', "recordId" = $2::uuid WHERE id = $1::uuid`, id, randomUUID())
    }
    expect(await run(office(), `UPDATE "LeaverCase" SET status = 'DONE', "closedAt" = now() WHERE id = $1::uuid`, open)).toBe(1)
    await expect(run(office(), `UPDATE "LeaverCase" SET "lastWorkingDay" = '2026-12-01' WHERE id = $1::uuid`, open)).rejects.toThrow(/is DONE; it never changes again/)
    await expect(run(office(), `UPDATE "LeaverStep" SET status = 'OPEN', "doneAt" = NULL, "doneById" = NULL, "skipReason" = NULL WHERE id = $1::uuid`, byKind.EXIT_VISIT)).rejects.toThrow(/its steps no longer change/)
    await expect(admin('DELETE FROM "LeaverCase" WHERE id = $1', [open])).rejects.toThrow(/is never deleted/)
  })

  it('cancels a case only until the last working day, with who and why', async () => {
    const recent = await newEmployee()
    const soon = await newEmployee()
    const caseOf = async (employeeId: string, lastDay: string) => {
      const id = randomUUID()
      await run(office(), `INSERT INTO "LeaverCase" (id, "employeeId", "lastWorkingDay", "startedAt", "startedById") VALUES ($1::uuid, $2::uuid, $3::date, now(), $4::uuid)`, id, employeeId, lastDay, ownerId)
      return id
    }
    const past = await caseOf(recent, dayFrom(-3))
    const ahead = await caseOf(soon, dayFrom(5))
    const cancel = (id: string, reason: string | null = 'Stays with us (test)') =>
      run(office(), `UPDATE "LeaverCase" SET status = 'CANCELLED', "cancelledAt" = now(), "cancelledById" = $2::uuid, "cancelReason" = $3 WHERE id = $1::uuid`, id, ownerId, reason)
    await expect(cancel(past)).rejects.toThrow(/is cancelled only until the last working day/)
    await expect(cancel(ahead, ' ')).rejects.toThrow(/CANCELLED \(when, who and why\)/)
    expect(await cancel(ahead)).toBe(1)
    await expect(run(office(), `UPDATE "LeaverCase" SET status = 'OPEN', "cancelledAt" = NULL, "cancelledById" = NULL, "cancelReason" = NULL WHERE id = $1::uuid`, ahead)).rejects.toThrow(/is CANCELLED; it never changes again/)
    await expect(caseOf(soon, '2019-12-31')).rejects.toThrow(/on or after the person's first day/)
  })
})

describe('people settings and the legal gate', () => {
  it('keeps the people settings inside the rules (groups of 3 at least, rounding 0, 5 or 15, role keys once)', async () => {
    const set = (assignments: string) => run(office(), `UPDATE "PeopleSettings" SET ${assignments} WHERE id = $1::uuid`, companyA)
    await expect(set('"minimumGroupSize" = 2')).rejects.toThrow(/minimum group size .* is 3 or more/)
    await expect(set('"roundingMinutes" = 10')).rejects.toThrow(/round clock events to 0, 5 or 15 minutes/)
    await expect(set('"autoClockOutAfterMinutes" = 721')).rejects.toThrow(/0 to 720 minutes after the shift/)
    await expect(set(`"figureRoleKeys" = ARRAY['hr', 'hr']`)).rejects.toThrow(/by their keys .*, each once/)
    await expect(set(`"figureRoleKeys" = ARRAY['HR Team']`)).rejects.toThrow(/by their keys/)
    expect(await set(`"figureRoleKeys" = ARRAY['hr'], "autoClockOutAfterMinutes" = 30, "roundingMinutes" = 5`)).toBe(1)
    await expect(admin('DELETE FROM "PeopleSettings" WHERE id = $1', [companyA])).rejects.toThrow(/are changed, never deleted/)
  })

  it('switches a purpose on only with the worker notice in force and a stored impact assessment, one at a time, and freezes it once off', async () => {
    const notice = key('privacy:notice:A:WORKER_FLOOR:1')
    const draftNotice = `00000000${key('privacy:notice:A:WORKER_FLOOR:2').slice(8)}`
    const dpia = key('privacy:dpia:A:1')
    const draftDpia = `00000000${key('privacy:dpia:A:2').slice(8)}`
    const switchOn = (purpose: string, options: { notice?: string; dpia?: string; covers?: boolean; leads?: boolean; basis?: string } = {}) =>
      run(
        office(),
        `INSERT INTO "PeopleLegalGate" (id, "companyId", "siteId", purpose, basis, "basisReference", "basisCoversLeads", "leadsSeeFigures", "noticeId", "dpiaId", "switchedOnAt", "switchedOnById")
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::"PeoplePurpose", $5::"MonitoringBasis", 'SAMPLE agreement RSU 2026/3', $6, $7, $8::uuid, $9::uuid, now(), $10::uuid)`,
        randomUUID(),
        companyA,
        siteA1,
        purpose,
        options.basis ?? 'UNION_AGREEMENT',
        options.covers ?? false,
        options.leads ?? false,
        options.notice ?? notice,
        options.dpia ?? dpia,
        ownerId,
      )
    await expect(switchOn('ATTENDANCE', { notice: draftNotice })).rejects.toThrow(/with the company's worker notice in force/)
    await expect(switchOn('ATTENDANCE', { notice: key('privacy:notice:A:OFFICE_STAFF:1') })).rejects.toThrow(/with the company's worker notice in force/)
    await expect(switchOn('ATTENDANCE', { dpia: draftDpia })).rejects.toThrow(/with the company's stored impact assessment/)
    await expect(switchOn('ATTENDANCE', { covers: true })).rejects.toThrow(/covers leads only for PERFORMANCE/)
    await expect(switchOn('PERFORMANCE', { covers: true, basis: 'NOT_REQUIRED' })).rejects.toThrow(/covers leads only for PERFORMANCE, on a union agreement/)
    await expect(switchOn('PERFORMANCE', { leads: true })).rejects.toThrow(/leads see one person's figures only where the recorded basis covers leads/)
    expect(await switchOn('PERFORMANCE', { covers: true })).toBe(1)
    await expect(switchOn('PERFORMANCE')).rejects.toThrow(UNIQUE)
    const [gate] = await admin('SELECT id::text AS id FROM "PeopleLegalGate" WHERE purpose = \'PERFORMANCE\' AND "switchedOffAt" IS NULL')
    // While on: who sees the figures changes; the basis does not (a new basis is a new record).
    expect(await run(office(), `UPDATE "PeopleLegalGate" SET "leadsSeeFigures" = true WHERE id = $1::uuid`, gate!.id)).toBe(1)
    await expect(run(office(), `UPDATE "PeopleLegalGate" SET "basisReference" = 'Another' WHERE id = $1::uuid`, gate!.id)).rejects.toThrow(/a new basis is a new record/)
    await expect(run(office(), `UPDATE "PeopleLegalGate" SET "switchedOffAt" = now() WHERE id = $1::uuid`, gate!.id)).rejects.toThrow(/switched off with when, who and why/)
    expect(await run(office(), `UPDATE "PeopleLegalGate" SET "switchedOffAt" = now(), "switchedOffById" = $2::uuid, "switchOffReason" = 'The agreement expired (test)' WHERE id = $1::uuid`, gate!.id, ownerId)).toBe(1)
    await expect(run(office(), `UPDATE "PeopleLegalGate" SET "leadsSeeFigures" = false WHERE id = $1::uuid`, gate!.id)).rejects.toThrow(/was switched off; it never changes again/)
    await expect(admin('DELETE FROM "PeopleLegalGate" WHERE id = $1', [gate!.id])).rejects.toThrow(/is the record of a decision; it is switched off, never deleted/)
    // OFF again everywhere: the default.
    expect(await admin('SELECT count(*)::int AS n FROM "PeopleLegalGate" WHERE "tenantId" = $1 AND "switchedOffAt" IS NULL', [core.tenantId])).toEqual([{ n: 0 }])
  })
})

describe('skills and machine authorisations', () => {
  it('says what a skill is about, and keeps it', async () => {
    const add = (kind: string, operationId: string | null, machineClassId: string | null) =>
      run(office(), `INSERT INTO "Skill" (id, code, name, kind, "operationId", "machineClassId") VALUES ($1::uuid, $2, 'Test skill', $3::"SkillKind", $4::uuid, $5::uuid)`, randomUUID(), `TEST-${randomUUID().slice(0, 6)}`, kind, operationId, machineClassId)
    await expect(add('OPERATION', null, null)).rejects.toThrow(/is about one operation \(OPERATION\), one class of machine \(MACHINE\) or neither \(GENERAL\)/)
    await expect(add('GENERAL', key('product:operation:SEW'), null)).rejects.toThrow(/is about one operation/)
    expect(await add('GENERAL', null, null)).toBe(1)
    await expect(run(office(), `UPDATE "Skill" SET code = 'OTHER' WHERE id = $1::uuid`, skills.skillIds.sew)).rejects.toThrow(/keeps its company, code, kind and what it is about/)
  })

  it('has a person decide every level: who assessed it, again when it changes; a sign-off once; one level in force', async () => {
    const level = skills.levelIds.e1Sew
    await expect(run(office(), `UPDATE "EmployeeSkill" SET level = 'EXPERT' WHERE id = $1::uuid`, level)).rejects.toThrow(/changes only with who assessed it again and when \(a person decides; MES-281\)/)
    expect(await run(office(), `UPDATE "EmployeeSkill" SET level = 'EXPERT', "assessedAt" = now(), "assessedById" = $2::uuid WHERE id = $1::uuid`, level, memberId)).toBe(1)
    await expect(run(office(), `UPDATE "EmployeeSkill" SET "assessedById" = NULL WHERE id = $1::uuid`, level)).rejects.toThrow(/null value|not-null/)
    await expect(
      run(office(), `INSERT INTO "EmployeeSkill" (id, "siteId", "employeeId", "skillId", level, since, "assessedAt", "assessedById") VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'CAN_DO', '2026-01-01', now(), $5::uuid)`, randomUUID(), siteA1, people.employeeIds.e1, skills.skillIds.sew, ownerId),
    ).rejects.toThrow(UNIQUE)
    // A trainee: signed off with the day and who (and a trainer who is someone else), once.
    const trainee = skills.levelIds.e3Trainee
    await expect(run(office(), `UPDATE "EmployeeSkill" SET "signedOffOn" = '2026-11-20', "signedOffById" = $2::uuid, "trainerEmployeeId" = "employeeId" WHERE id = $1::uuid`, trainee, memberId)).rejects.toThrow(/signs off a trainee with the day and who/)
    expect(await run(office(), `UPDATE "EmployeeSkill" SET "signedOffOn" = '2026-11-20', "signedOffById" = $2::uuid, "trainerEmployeeId" = $3::uuid WHERE id = $1::uuid`, trainee, memberId, people.employeeIds.e2)).toBe(1)
    await expect(run(office(), `UPDATE "EmployeeSkill" SET "traineeUntil" = '2027-01-31' WHERE id = $1::uuid`, trainee)).rejects.toThrow(/was signed off; the sign-off and the trainee period never change/)
    // Removed: frozen, with who and why.
    await expect(run(office(), `UPDATE "EmployeeSkill" SET "removedAt" = now() WHERE id = $1::uuid`, level)).rejects.toThrow(/is removed with when, who and why/)
    expect(await run(office(), `UPDATE "EmployeeSkill" SET "removedAt" = now(), "removedById" = $2::uuid, "removeReason" = 'Moved to cutting (test)' WHERE id = $1::uuid`, level, ownerId)).toBe(1)
    await expect(run(office(), `UPDATE "EmployeeSkill" SET level = 'TRAINER', "assessedAt" = now() WHERE id = $1::uuid`, level)).rejects.toThrow(/was removed; it never changes again/)
    await expect(admin('DELETE FROM "EmployeeSkill" WHERE id = $1', [level])).rejects.toThrow(/is removed, never deleted/)
  })

  it('authorises one class of machine per person at a time, freezes a revoked one, and takes both to the person’s new site', async () => {
    const e = people.employeeIds
    const lockstitch = `00000000${key('plant:class:LOCKSTITCH').slice(8)}`
    const authorise = (employeeId: string, classId: string) =>
      run(office(), `INSERT INTO "MachineAuthorisation" (id, "siteId", "employeeId", "machineClassId", "authorisedOn", "authorisedById") VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, '2026-10-01', $5::uuid)`, randomUUID(), siteA1, employeeId, classId, ownerId)
    await expect(authorise(e.e1, key('plant:class:POST_BED'))).rejects.toThrow(UNIQUE)
    await expect(authorise(e.e5, lockstitch)).rejects.toThrow(/an active person is authorised on an active class of machine/)
    expect(await authorise(e.e3, lockstitch)).toBe(1)
    const live = skills.authorisationIds.e1PostBed
    expect(await run(office(), `UPDATE "MachineAuthorisation" SET "validUntil" = '2027-12-31' WHERE id = $1::uuid`, live)).toBe(1)
    await expect(run(office(), `UPDATE "MachineAuthorisation" SET "authorisedById" = $2::uuid WHERE id = $1::uuid`, live, memberId)).rejects.toThrow(/keeps its person, class, start and who authorised it/)
    const revoked = skills.authorisationIds.revoked
    await expect(run(office(), `UPDATE "MachineAuthorisation" SET "validUntil" = '2027-12-31' WHERE id = $1::uuid`, revoked)).rejects.toThrow(/was revoked; it never changes again/)
    // E5 moves to a second plant of company A: the removed level and the revoked authorisation follow (ON UPDATE CASCADE).
    const siteA2 = randomUUID()
    await run(office(), `INSERT INTO "Site" (id, "companyId", code, name, kind) VALUES ($1::uuid, $2::uuid, $3, 'Test plant A2', 'PLANT')`, siteA2, companyA, `A2-${siteA2.slice(0, 4)}`)
    expect(await run(office(), `UPDATE "Employee" SET "siteId" = $2::uuid, "homeLineId" = NULL WHERE id = $1::uuid`, e.e5, siteA2)).toBe(1)
    expect(await admin('SELECT DISTINCT "siteId"::text AS site FROM "MachineAuthorisation" WHERE "employeeId" = $1', [e.e5])).toEqual([{ site: siteA2 }])
    expect(await admin('SELECT DISTINCT "siteId"::text AS site FROM "EmployeeSkill" WHERE "employeeId" = $1', [e.e5])).toEqual([{ site: siteA2 }])
    // A row's site is always the person's (the reference).
    await expect(run(office(), `UPDATE "EmployeeSkill" SET "siteId" = $2::uuid WHERE id = $1::uuid`, skills.levelIds.e3Trainee, siteA2)).rejects.toThrow(/foreign key/)
  })
})

describe('the org tree', () => {
  it('archives an area only without active lines, and puts a line only into an active area of its site', async () => {
    const sewing = people.areaIds.sewing
    const cutting = people.areaIds.cutting
    await expect(run(office(), `UPDATE "OrgArea" SET status = 'ARCHIVED' WHERE id = $1::uuid`, sewing)).rejects.toThrow(/still has active lines/)
    expect(await run(office(), `UPDATE "OrgArea" SET status = 'ARCHIVED' WHERE id = $1::uuid`, cutting)).toBe(1)
    await expect(run(office(), `UPDATE "Line" SET "areaId" = $2::uuid WHERE id = $1::uuid`, lineA1, cutting)).rejects.toThrow(/is archived; line .* goes into an active area/)
    await expect(run(office(), `UPDATE "Line" SET "areaId" = $2::uuid WHERE id = $1::uuid`, lineA1, people.areaIds.mainB)).rejects.toThrow(/foreign key/)
    await expect(admin('DELETE FROM "OrgArea" WHERE id = $1', [cutting])).rejects.toThrow(/is archived, never deleted/)
  })
})
